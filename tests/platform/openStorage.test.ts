/**
 * openStorage 探测与降级路径（Review Focus #3）。
 *
 * IndexedDB 不可用的三种形态都必须降级 memoryStore、kind 可判别、不静默：
 * A. 全局 indexedDB 不存在；B. 构造性异常——open() 同步抛错（部分隐私模式）；
 * C. 打开被拒——request.onerror 触发。可用时返回 idb 实现。
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '@platform/storage';
import { makeSave } from './storageContract';

const realIndexedDB = globalThis.indexedDB;

afterEach(() => {
  globalThis.indexedDB = realIndexedDB;
  vi.restoreAllMocks();
});

describe('openStorage 降级', () => {
  it('A. indexedDB 全局缺失 → memory，且 save/load 照常工作', async () => {
    // @ts-expect-error 故意模拟浏览器缺失该全局
    delete globalThis.indexedDB;
    const store = await openStorage('pxfc-fallback-a');
    expect(store.kind).toBe('memory');
    await store.save(makeSave(1761955200000));
    await expect(store.load()).resolves.toEqual(makeSave(1761955200000));
  });

  it('B. open() 同步抛错 → memory', async () => {
    const boom = Object.create(IDBFactory.prototype);
    boom.open = () => {
      throw new DOMException('The user has denied permission', 'SecurityError');
    };
    globalThis.indexedDB = boom as IDBFactory;

    const store = await openStorage('pxfc-fallback-b');
    expect(store.kind).toBe('memory');
    await store.save(makeSave(1761955200000));
    await expect(store.load()).resolves.toEqual(makeSave(1761955200000));
  });

  it('C. open 请求 onerror（版本冲突类失败）→ memory', async () => {
    const factory = {
      open: () => {
        const req = {
          onerror: null as null | (() => void),
          onsuccess: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
          error: new DOMException('Version change blocked', 'VersionError'),
          result: null,
        };
        // 异步触发 onerror，模拟真实 IDB 事件循环时序
        setTimeout(() => req.onerror?.(), 0);
        return req;
      },
    } as unknown as IDBFactory;
    globalThis.indexedDB = factory;

    const store = await openStorage('pxfc-fallback-c');
    expect(store.kind).toBe('memory');
    await store.save(makeSave(1761955200000));
    await expect(store.load()).resolves.toEqual(makeSave(1761955200000));
  });

  it('可用时正常返回 idb 实现', async () => {
    const store = await openStorage('pxfc-happy-path');
    expect(store.kind).toBe('idb');
    await store.save(makeSave(1761955200000));
    await expect(store.load()).resolves.toEqual(makeSave(1761955200000));
  });
});
