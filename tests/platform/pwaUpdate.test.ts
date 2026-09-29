// @vitest-environment happy-dom
/**
 * tests/platform/pwaUpdate.test.ts —— 「我更新到新版了吗」的探针（D54）。
 *
 * 判别力：
 * - PU#1 没有 SW（开发版/隐私模式）⇒ `unsupported`，不假装"已是最新"；
 * - PU#2 缓存名变了 ⇒ `updated`（**判据必须是缓存名**：我们的 SW 在 install 里就 skipWaiting，
 *   按 `registration.waiting` 判会永远得到"已是最新" —— 首版就是这么错的）；
 * - PU#3 缓存名没变 ⇒ `current`；
 * - PU#4 `update()` 抛错（断网）⇒ 如实说"断网了"，不是"已是最新"；
 * - PU#5 `pageBuild()` 在没有构建戳时回 `'dev'`；
 * - PU#6 `reload()` 抛错也不崩（极端环境）。
 */
import { describe, expect, it, vi } from 'vitest';
import { cachedBuild, checkForUpdate, pageBuild, reloadPage } from '../../src/platform/pwaUpdate';

const sleep0 = () => Promise.resolve();

function cachesOf(...names: string[]): { cacheNames: () => Promise<string[]> } {
  return { cacheNames: () => Promise.resolve(names) };
}

describe('platform/pwaUpdate —— 版本与更新探针（D54）', () => {
  it('PU#1 没有 SW ⇒ unsupported（不假装"已是最新"）', async () => {
    const res = await checkForUpdate({ serviceWorker: null, sleep: sleep0, ...cachesOf('zx-xia-111') });
    expect(res.status).toBe('unsupported');
    expect(res.build).toBe('111');
    expect(res.message).toContain('不用更新');
  });

  it('PU#2 缓存名变了 ⇒ updated；消息里带上新版本号', async () => {
    let names = ['zx-xia-111'];
    const res = await checkForUpdate({
      serviceWorker: { getRegistration: () => Promise.resolve({ update: () => Promise.resolve() }) },
      cacheNames: () => {
        const snapshot = [...names];
        names = ['zx-xia-222']; // update() 之后新 SW 接管、缓存名换掉
        return Promise.resolve(snapshot);
      },
      sleep: sleep0,
    });
    expect(res.status).toBe('updated');
    expect(res.build).toBe('222');
    expect(res.message).toContain('222');
  });

  it('PU#3 缓存名没变 ⇒ current', async () => {
    const res = await checkForUpdate({
      serviceWorker: { getRegistration: () => Promise.resolve({ update: () => Promise.resolve() }) },
      sleep: sleep0,
      waitMs: 200,
      ...cachesOf('zx-xia-111'),
    });
    expect(res.status).toBe('current');
    expect(res.message).toContain('已是最新');
  });

  it('PU#4 update() 抛错（断网）⇒ 如实说，不谎报"已是最新"', async () => {
    const res = await checkForUpdate({
      serviceWorker: {
        getRegistration: () => Promise.resolve({ update: () => Promise.reject(new Error('offline')) }),
      },
      sleep: sleep0,
      ...cachesOf('zx-xia-111'),
    });
    expect(res.status).toBe('current');
    expect(res.message).toContain('断网');
  });

  it('PU#5 没有构建戳 ⇒ pageBuild() 回 dev；caches 整个不存在 ⇒ cachedBuild() 回 null 且不抛', async () => {
    expect(pageBuild()).toBe('dev'); // 测试环境没有注入 __ZX_XIA_BUILD__
    // happy-dom 里根本没有 `caches` 全局 —— 这条正好覆盖"环境不支持"那条分支
    expect(typeof (globalThis as { caches?: unknown }).caches).toBe('undefined');
    await expect(cachedBuild()).resolves.toBeNull();
  });

  it('PU#6 reload() 抛错也不崩（极端环境）', () => {
    const spy = vi.spyOn(window.location, 'reload').mockImplementation(() => {
      throw new Error('nope');
    });
    expect(() => reloadPage()).not.toThrow();
    spy.mockRestore();
  });
});
