/**
 * idbStore —— GameStorage 的 IndexedDB 实现，原生 API 包 promise，零第三方依赖。
 *
 * 布局：库 dbName（默认 'pixel-flashcard'），单 object store `saves`，单键 `'current'`。
 * 并发语义：每个操作开短事务、用完即关连接——不长期持句柄，避免与浏览器
 * 多标签页场景互相 block；双 save 竞态由 IDB 事务排队保证"后发起者胜"
 * （契约测试第 3 条以 meta.savedAt 判别）。
 *
 * 失败路径：open 同步抛错 / request.onerror / versionchange-blocked 一律 reject，
 * 交由 openStorage 降级 memoryStore；读写请求的错误（如配额满）原样抛给调用方，
 * 绝不静默吞掉。
 */

import type { SaveFile } from '@core/types';
import type { GameStorage } from './storage';

const STORE_NAME = 'saves';
const SAVE_KEY = 'current';
const DEFAULT_DB_NAME = 'pixel-flashcard';

/** 打开（必要时建库）并返回 idb 存储实例。任何不可用信号都以 reject 表达。 */
export async function openIdbStorage(dbName: string = DEFAULT_DB_NAME): Promise<GameStorage> {
  const db = await openDatabase(dbName);
  db.close(); // 探测成功即归还句柄；后续每操作自开自闭
  return {
    kind: 'idb',
    async load(): Promise<SaveFile | null> {
      const withDb = await useDb(dbName);
      try {
        return await requestToPromise<SaveFile | undefined>(
          withDb.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(SAVE_KEY),
        ).then((v) => (v === undefined ? null : v));
      } finally {
        withDb.close();
      }
    },
    async save(f: SaveFile): Promise<void> {
      // 深拷贝在进事务前完成：外部 mutate 不得影响已提交值（契约第 4 条）。
      // IDB 结构化克隆本身也隔离数据，此层拷贝让 memory/idb 两实现的快照语义严格一致。
      const snapshot = structuredClone(f);
      const withDb = await useDb(dbName);
      try {
        await requestToPromise(
          withDb.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(snapshot, SAVE_KEY),
        );
      } finally {
        withDb.close();
      }
    },
    async clear(): Promise<void> {
      const withDb = await useDb(dbName);
      try {
        await requestToPromise(
          withDb.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(SAVE_KEY),
        );
      } finally {
        withDb.close();
      }
    },
  };
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName);
    } catch (e) {
      reject(e); // 隐私模式下构造性抛错
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME); // 无 keyPath：out-of-line 键 'current'
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB open failed: ${dbName}`));
    req.onblocked = () => reject(new Error(`IndexedDB open blocked: ${dbName}`));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    // 事务级失败（配额满、浏览器强杀等）可能不经过请求的 error 事件而直接 abort；
    // 监听 transaction.onabort 兜底，保证 save 永不"无声成功"。
    const tx = req.transaction;
    if (tx) {
      tx.onabort = () => {
        reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
      };
    }
  });
}

/** 每次读写自开连接（幂等 open；库已由首次探测建好，秒回）。 */
async function useDb(dbName: string): Promise<IDBDatabase> {
  return openDatabase(dbName);
}
