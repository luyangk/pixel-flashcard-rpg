// @vitest-environment happy-dom
/**
 * tests/platform/inboxStore.test.ts —— Plan 8 · T5：待读清单（第二个 localStorage 归属）。
 *
 * 为什么需要它：抓取被 CORS 挡住时（公众号/知乎/新闻实测都挡），光提示"请粘正文"会把玩家
 * 刚给的链接丢掉。清单是本机的一个小抽屉：抓不到的链接先放进去，读完回来粘正文即可出箱。
 *
 * 判别力：
 * - IN#2 坏 JSON ⇒ 回空数组（**绝不抛**：一个坏值不该让整屏崩掉）；
 * - IN#3 坏形状逐条剔除（存档/本地存储都是不可信输入）；
 * - IN#4 超过 30 条丢**最旧**的（留最近的才对"待读"有意义）；
 * - IN#5 单条正文按**码点**截断（`.slice` 会劈开代理对）；
 * - IN#6 `url` 只留 http(s)（`javascript:` 不能进清单，否则将来会变成一个可点的坑）；
 * - IN#7 localStorage 抛错（隐私模式/配额满）⇒ load 回 []、save 回 false，都不抛。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INBOX_MAX,
  INBOX_STORAGE_KEY,
  INBOX_TEXT_MAX,
  loadInbox,
  saveInbox,
  clearInbox,
} from '../../src/platform/inboxStore';

beforeEach(() => {
  window.localStorage.clear();
});

function item(id: string, over: Record<string, unknown> = {}) {
  return { id, title: `标题-${id}`, addedAt: 1000, ...over } as never;
}

describe('inboxStore —— 往返与净化', () => {
  it('IN#1 存取往返：字段保真、顺序保持', () => {
    const items = [item('a', { url: 'https://x.example/1' }), item('b', { text: '粘来的正文' })];
    expect(saveInbox(items)).toBe(true);
    const back = loadInbox();
    expect(back.map((i) => i.id)).toEqual(['a', 'b']);
    expect(back[0]?.url).toBe('https://x.example/1');
    expect(back[1]?.text).toBe('粘来的正文');
  });

  it('IN#2 坏 JSON / 空存储 ⇒ []（永不抛）', () => {
    expect(loadInbox()).toEqual([]);
    window.localStorage.setItem(INBOX_STORAGE_KEY, '{不是 JSON');
    expect(loadInbox()).toEqual([]);
    window.localStorage.setItem(INBOX_STORAGE_KEY, '"字符串"');
    expect(loadInbox()).toEqual([]);
  });

  it('IN#3 坏形状逐条剔除：非数组 / 缺 id / 标题空 / addedAt 非有限值', () => {
    window.localStorage.setItem(
      INBOX_STORAGE_KEY,
      JSON.stringify([
        { id: 'ok', title: '正常', addedAt: 5 },
        { id: '', title: '缺 id', addedAt: 5 },
        { id: 'no-title', title: '   ', addedAt: 5 },
        null,
        42,
        { id: 'bad-time', title: '时间脏', addedAt: Number.NaN },
      ]),
    );
    const back = loadInbox();
    expect(back.map((i) => i.id)).toEqual(['ok', 'bad-time']);
    expect(back[1]?.addedAt).toBe(0); // 脏时间回落 0，而不是 NaN
  });

  it('IN#4 超过上限丢最旧的（留最近的）', () => {
    const many = Array.from({ length: INBOX_MAX + 5 }, (_, i) => item(`i${i}`, { addedAt: i }));
    expect(saveInbox(many)).toBe(true);
    const back = loadInbox();
    expect(back).toHaveLength(INBOX_MAX);
    expect(back.some((i) => i.id === 'i0')).toBe(false); // 最旧的被丢掉
    expect(back.some((i) => i.id === `i${INBOX_MAX + 4}`)).toBe(true); // 最新的还在
  });

  it('IN#5 正文按码点截到上限（不劈开代理对）', () => {
    const text = `A${'🐉'.repeat(INBOX_TEXT_MAX + 20)}`;
    expect(saveInbox([item('a', { text })])).toBe(true);
    const back = loadInbox()[0]?.text ?? '';
    expect([...back].length).toBe(INBOX_TEXT_MAX);
    expect(/[\uD800-\uDBFF]$/.test(back)).toBe(false);
  });

  it('IN#6 url 只留 http(s)：javascript:/data:/file: 一律剔除该字段（条目保留）', () => {
    const items = [
      item('a', { url: 'javascript:alert(1)' }),
      item('b', { url: 'data:text/html,x' }),
      item('c', { url: 'https://ok.example/x' }),
    ];
    expect(saveInbox(items)).toBe(true);
    const back = loadInbox();
    expect(back[0]?.url).toBeUndefined();
    expect(back[1]?.url).toBeUndefined();
    expect(back[2]?.url).toBe('https://ok.example/x');
  });

  it('IN#7 localStorage 抛错 ⇒ load 回 []、save 回 false、clear 不抛', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('隐私模式');
      },
    });
    try {
      expect(() => loadInbox()).not.toThrow();
      expect(loadInbox()).toEqual([]);
      expect(saveInbox([item('a')])).toBe(false);
      expect(() => clearInbox()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('IN#7b 配额满（setItem 抛错）⇒ save 回 false，绝不谎报"存进去了"', () => {
    // 判别力：IN#7 只覆盖了"读 getter 就抛"那条路（storageOrNull 会先回 null）；
    // 真正考验 saveInbox 的是"拿得到 storage、但写的时候炸了"（配额满的形态）。
    // 直接 spy 实例方法：happy-dom 的 window.localStorage 未必继承自全局 Storage.prototype
    // （首版 spy 原型没生效 ⇒ 这条用例假绿）
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(saveInbox([item('a')])).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('IN#8 clearInbox 清空', () => {
    saveInbox([item('a')]);
    expect(loadInbox()).toHaveLength(1);
    clearInbox();
    expect(loadInbox()).toEqual([]);
  });
});
