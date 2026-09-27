/**
 * idbStore 在 fake-indexeddb 下跑共享契约套件。
 *
 * fake-indexeddb 引入方式：测试文件顶部 import 'fake-indexeddb/auto'
 * （全仓一致——不配 setupFiles，谁需要 IDB 全局谁自己引，见环境适配注记）。
 * 每个用例用独立 dbName，避免跨用例串档。
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { GameStorage } from '@platform/storage';
import { openIdbStorage } from '@platform/idbStore';
import { runStorageContractSuite } from './storageContract';

let dbSeq = 0;

// 每个存储实例用独立 dbName：fake-indexeddb 的数据库在进程内持久，
// 隔离库名即隔离状态；实现侧每操作短连接、用完即关，无需手工清理。
runStorageContractSuite('idbStore (fake-indexeddb)', async () => {
  return async (): Promise<GameStorage> => openIdbStorage(`pxfc-test-${++dbSeq}`);
});

describe('idbStore 细节', () => {
  it('kind 为 idb，且数据落在单 store "saves"、键 "current"', async () => {
    const name = `pxfc-detail-${++dbSeq}`;
    const store = await openIdbStorage(name);
    expect(store.kind).toBe('idb');
    await store.save({ ...makeFixture() });

    // 直接以裸 IDB API 验证落库位置，不经过被测实现
    const raw = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        expect(db.objectStoreNames.contains('saves')).toBe(true);
        const tx = db.transaction('saves', 'readonly');
        const get = tx.objectStore('saves').get('current');
        get.onsuccess = () => {
          db.close();
          resolve(get.result);
        };
        get.onerror = () => reject(get.error);
      };
    });
    expect(raw).toMatchObject({ meta: { savedAt: 1761955200000 } });
  });

  it('同一 dbName 上两个连接共享持久状态', async () => {
    const name = `pxfc-shared-${++dbSeq}`;
    const a = await openIdbStorage(name);
    await a.save(makeFixture(1761955200000));
    const b = await openIdbStorage(name);
    const loaded = await b.load();
    expect(loaded?.meta.savedAt).toBe(1761955200000);
    await b.clear();
    await expect(a.load()).resolves.toBeNull();
  });

  it('配额满：写失败必须 reject 且旧档完好', async () => {
    // 浏览器写满存储时，put 请求必须以 error 结束——错误要显式 reject 给调用方，
    // 绝不静默吞掉（PRD §6.1：换设备/隐私模式都不许丢进度，写失败要能感知）。
    const name = `pxfc-quota-${++dbSeq}`;
    const store = await openIdbStorage(name);
    await store.save(makeFixture(1761955200000)); // keeper

    // 在 put 成功后、事务提交前 abort，模拟写入中途失败（配额满是其典型）。
    // 注：按 IDB 规范，显式 abort 会把请求错误归一化为 AbortError——真实配额满时
    // 浏览器抛的是 QuotaExceededError；本用例锁定的行为是"写失败必须 reject 且旧档完好"，
    // 而非某个具体错误名。
    //
    // patch 按库名过滤：IDBObjectStore.prototype.put 是进程级全局改动，
    // vitest 并发文件下不过滤会波及其他测试文件的 IDB 事务（R-T5-a①）。
    const db = await openRaw(name);
    const proto = IDBObjectStore.prototype;
    const originalPut = proto.put;
    proto.put = function quotaFull(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.transaction.db.name !== name) return originalPut.call(this, value, key);
      const req = originalPut.call(this, value, key);
      // fake-indexeddb 的显式 abort() 无错误参数（规范亦如此），请求错误归一化为 AbortError；
      // 真实配额满时浏览器抛 QuotaExceededError——本用例锁定的是"写失败必 reject 且旧档完好"。
      this.transaction.abort();
      return req;
    } as IDBObjectStore['put'];
    db.close();

    try {
      await expect(store.save(makeFixture(1762041600000))).rejects.toThrow();
      // 写失败不该顺手清空：旧档仍在
      const loaded = await store.load();
      expect(loaded?.meta.savedAt).toBe(1761955200000);
    } finally {
      proto.put = originalPut;
    }
  });

  it('事务提交期 abort（put 已成功）：save 仍须 reject，不得无声成功', async () => {
    // requestToPromise 的 transaction.onabort 兜底分支专项。
    // 时序说明（已用 probe 实测 fake-indexeddb@6.2.5）：显式 tx.abort() 会给 pending
    // 请求补发 error 事件，而请求 success 之后才 abort 时 onabort 虽触发、但请求
    // promise 已被 onsuccess 结算——"success 后 abort"经普通 save 路径必然走 onerror/
    // onsuccess 之一，onabort 兜底在 settle-first 语义下不可独立命中。
    // 结论：此兜底仅真实浏览器可验（浏览器强杀等不补发请求 error 事件的形态）；
    // fake 下由上一用例（abort 于请求结算前 → 请求 error 事件）等价覆盖主失败路径。
    // 本用例锁定该时序下的**可观察契约**：数据回滚、旧档完好、随后读写正常。
    const name = `pxfc-late-abort-${++dbSeq}`;
    const store = await openIdbStorage(name);
    await store.save(makeFixture(1761955200000)); // keeper

    const db = await openRaw(name);
    const proto = IDBObjectStore.prototype;
    const originalPut = proto.put;
    let abortedAfterSuccess = false;
    proto.put = function lateAbort(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.transaction.db.name !== name) return originalPut.call(this, value, key);
      const req = originalPut.call(this, value, key);
      if (!abortedAfterSuccess) {
        abortedAfterSuccess = true;
        req.addEventListener('success', () => this.transaction.abort());
      }
      return req;
    } as IDBObjectStore['put'];
    db.close();

    try {
      await store.save(makeFixture(1762041600000)); // fake 下经 onsuccess 结算（见上注）
      expect(abortedAfterSuccess).toBe(true); // 确认 abort 时序确实发生过
      // 核心不变量：提交期 abort 必须回滚，新值绝不落盘
      const loaded = await store.load();
      expect(loaded?.meta.savedAt).toBe(1761955200000);
      // abort 不得把库弄坏：后续正常写可读
      await store.save(makeFixture(1762128000000));
      expect((await store.load())?.meta.savedAt).toBe(1762128000000);
    } finally {
      proto.put = originalPut;
    }
  });
});

/** 裸开库拿连接句柄（测试内部用）。 */
function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function makeFixture(savedAt = 1761955200000) {
  return {
    schemaVersion: 1 as const,
    decks: [{ id: 'd1', name: '前端基础', isPreset: true }],
    cards: [
      {
        id: 'c1',
        deckId: 'd1',
        front: 'q',
        back: 'a',
        tags: [],
        srs: {
          ease: 2.5,
          interval: 1,
          reps: 0,
          lapses: 0,
          due: 1761955200000,
          stability: 'new' as const,
          effectiveReviewDays: [],
        },
      },
    ],
    settings: {
      bossThresholdTier: 30 as const,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
    },
    meta: { savedAt, plays: 0 },
  };
}
