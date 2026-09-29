// @vitest-environment happy-dom
/**
 * tests/platform/sourceStore.test.ts —— 玩家那份来源库的存取（D53）。
 *
 * 判别力（与 inboxStore 同款纪律，逐条都钉住）：
 * - SS#1 没写过 ⇒ 空库；写进去读回来一致；
 * - SS#2 坏 JSON / 坏形状 / 坏类型一律就地净化（**永不抛**，最坏情况回到内置库）；
 * - SS#3 存储不可用（隐私模式）⇒ 读回空库、写回 false（调用方据此如实提示）；
 * - SS#4 上限：玩家源与墓碑都截断，不许无限长；
 * - SS#5 **绝不存 Key**（LS#3b 同款：这个模块里不该出现 apiKey/Authorization/LLM 存储键）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOVED_MAX,
  SOURCE_STORAGE_KEY,
  USER_SOURCES_MAX,
  clearSources,
  loadSources,
  saveSources,
} from '../../src/platform/sourceStore';
import type { SourceDef } from '../../src/core/sourceItem';

function src(i: number, over: Partial<SourceDef> = {}): SourceDef {
  return {
    id: `user:${i}`,
    name: `源 ${i}`,
    url: `https://example.com/${i}/feed`,
    kind: 'rss',
    direct: false,
    ...over,
  };
}

afterEach(() => {
  localStorage.removeItem(SOURCE_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe('platform/sourceStore —— 玩家来源库（D53）', () => {
  it('SS#1 没写过 ⇒ 空库；写进去读回来一致（含 direct 与 note）', () => {
    expect(loadSources()).toEqual({ added: [], removed: [] });
    const lib = { added: [src(1, { direct: true, note: '自己量过' })], removed: ['deepmind'] };
    expect(saveSources(lib)).toBe(true);
    expect(loadSources()).toEqual(lib);
    clearSources();
    expect(loadSources()).toEqual({ added: [], removed: [] });
  });

  it('SS#2 坏 JSON / 坏形状 / 坏类型就地净化，不抛', () => {
    localStorage.setItem(SOURCE_STORAGE_KEY, '{oops');
    expect(loadSources()).toEqual({ added: [], removed: [] });

    localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(['不是对象']));
    expect(loadSources()).toEqual({ added: [], removed: [] });

    localStorage.setItem(
      SOURCE_STORAGE_KEY,
      JSON.stringify({
        added: [
          { id: 'a', name: '好源', url: 'https://ok.example/feed', kind: 'rss' },
          { id: 'b', name: '类型不认识', url: 'https://x.example/feed', kind: 'martian' },
          { id: 'c', name: '链接不合法', url: 'javascript:1', kind: 'rss' },
          { id: '', name: '没 id', url: 'https://y.example/feed', kind: 'rss' },
          null,
        ],
        removed: ['ok-id', 42, '', 'ok-id'],
      }),
    );
    const lib = loadSources();
    expect(lib.added.map((s) => s.id)).toEqual(['a']);
    // 只有字符串墓碑算数（数字/null/空串都丢掉），重复的墓碑去重
    expect(lib.removed).toEqual(['ok-id']);
  });

  it('SS#3 存储不可用（隐私模式）⇒ 读回空库；写的时候炸（配额满）⇒ 回 false', () => {
    // ① 连 localStorage 这个 getter 就抛（隐私模式）：storageOrNull 回 null
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('隐私模式');
      },
    });
    try {
      expect(() => loadSources()).not.toThrow();
      expect(loadSources()).toEqual({ added: [], removed: [] });
      expect(saveSources({ added: [src(1)], removed: [] })).toBe(false);
      expect(() => clearSources()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }

    // ② 拿得到 storage，但写的时候炸（配额满）——**直接 spy 实例方法**：
    // happy-dom 的 window.localStorage 未必继承全局 Storage.prototype（inboxStore 的
    // IN#7b 就是在这里假绿过一次）。
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(saveSources({ added: [src(1)], removed: [] })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('SS#4 上限：玩家源与墓碑都截断', () => {
    const many = Array.from({ length: USER_SOURCES_MAX + 10 }, (_, i) => src(i));
    const removed = Array.from({ length: REMOVED_MAX + 10 }, (_, i) => `id-${i}`);
    expect(saveSources({ added: many, removed })).toBe(true);
    const lib = loadSources();
    expect(lib.added).toHaveLength(USER_SOURCES_MAX);
    expect(lib.removed).toHaveLength(REMOVED_MAX);
    // 截的是**最旧的**（保留最后 N 个）
    expect(lib.added[0].id).toBe(`user:${many.length - USER_SOURCES_MAX}`);
  });

  it('SS#5 存储键是登记的第三个归属，且这个模块绝不碰 Key', async () => {
    expect(SOURCE_STORAGE_KEY).toBe('zx-xia.sources.v1');
    // 注释里会提到别的存储键（说明"这是第三个归属"），所以**先去注释再查**（与 LS#3b 同款）
    const raw = (await import('node:fs')).readFileSync('src/platform/sourceStore.ts', 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['apiKey', 'Authorization', 'Bearer', 'zx-xia.llm', 'LLM_STORAGE_KEY']) {
      expect(code, `sourceStore 不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});
