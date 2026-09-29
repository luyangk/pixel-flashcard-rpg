/**
 * tests/core/sourceItem.test.ts —— 采新卡「来源库」的纯逻辑（D53）。
 *
 * 判别力：
 * - SI#1 没标题 / 没链接的条目必须被丢掉（否则屏上出现点了没反应的条目）；
 * - SI#2 去重按链接（同一个链接出现两次只留一条）；
 * - SI#3 排序：新的在前，**没日期的垫底**（dateMs=0 若参与倒序会冒到最前面）；
 * - SI#4 时间只认带时区的写法（不带时区的一律 0 —— 宁可"日期未知"也不猜）；
 * - SI#5 `planIngest`：正文够长就就地生成（不抓页面），只有标题就去抓链接；
 * - SI#6 上限与截断（标题/正文码点安全）；
 * - SI#7 手填源的校验（名称/链接/类型）。
 */
import { describe, expect, it } from 'vitest';
import {
  ITEM_TEXT_MAX,
  ITEM_TITLE_MAX,
  ITEMS_MAX,
  MIN_INLINE_TEXT,
  parseDateMs,
  planIngest,
  prepareItems,
  usableUrl,
  validateSourceInput,
  type SourceItemDraft,
} from '../../src/core/sourceItem';

function draft(over: Partial<SourceItemDraft> = {}): SourceItemDraft {
  return {
    sourceId: 's',
    sourceName: '某源',
    title: '标题',
    url: 'https://example.com/a',
    dateMs: 1_700_000_000_000,
    text: '',
    ...over,
  };
}

describe('core/sourceItem —— 一条内容的归一化（D53）', () => {
  it('SI#1 没标题或没链接 ⇒ 整条丢掉', () => {
    expect(prepareItems([draft({ title: '   ' })])).toEqual([]);
    expect(prepareItems([draft({ url: '' })])).toEqual([]);
    expect(prepareItems([draft({ url: 'javascript:alert(1)' })])).toEqual([]);
    expect(prepareItems([draft({ url: '/relative/path' })])).toEqual([]);
    expect(prepareItems([draft()])).toHaveLength(1);
  });

  it('SI#2 去重按链接（大小写不敏感），保留先出现的那条', () => {
    const items = prepareItems([
      draft({ title: '先来的', url: 'https://Example.com/a' }),
      draft({ title: '后来的', url: 'https://example.com/A' }),
      draft({ title: '另一条', url: 'https://example.com/b' }),
    ]);
    expect(items.map((i) => i.title)).toEqual(['先来的', '另一条']);
  });

  it('SI#3 新的在前；**没日期的垫底**（不能冒到最前）', () => {
    const items = prepareItems([
      draft({ title: '无日期', dateMs: 0, url: 'https://example.com/d' }),
      draft({ title: '旧的', dateMs: 1_000, url: 'https://example.com/o' }),
      draft({ title: '新的', dateMs: 9_000, url: 'https://example.com/n' }),
    ]);
    expect(items.map((i) => i.title)).toEqual(['新的', '旧的', '无日期']);
  });

  it('SI#4 时间只认带时区的写法；不带时区 ⇒ 0（宁可"日期未知"）', () => {
    expect(parseDateMs('2026-09-22T05:20:54Z')).toBeGreaterThan(0);
    expect(parseDateMs('Tue, 22 Sep 2026 05:20:54 GMT')).toBeGreaterThan(0);
    expect(parseDateMs('2026-09-22T05:20:54+08:00')).toBeGreaterThan(0);
    expect(parseDateMs('2026-09-22T05:20:54')).toBe(0); // 无时区 ⇒ 不猜
    expect(parseDateMs('')).toBe(0);
    expect(parseDateMs('昨天')).toBe(0);
  });

  it('SI#5 planIngest：正文够长就地生成；只有标题就去抓链接', () => {
    const rich = prepareItems([draft({ text: 'x'.repeat(MIN_INLINE_TEXT) })])[0];
    expect(planIngest(rich)).toEqual({ mode: 'text', text: 'x'.repeat(MIN_INLINE_TEXT) });

    const thin = prepareItems([draft({ text: 'x'.repeat(MIN_INLINE_TEXT - 1) })])[0];
    expect(planIngest(thin)).toEqual({ mode: 'url', url: 'https://example.com/a' });
  });

  it('SI#6 上限与截断：条数、标题、正文都有硬上限', () => {
    const many = Array.from({ length: ITEMS_MAX + 5 }, (_, i) =>
      draft({ title: `t${i}`, url: `https://example.com/${i}` }),
    );
    expect(prepareItems(many)).toHaveLength(ITEMS_MAX);
    expect(prepareItems(many, 3)).toHaveLength(3);

    const long = prepareItems([
      draft({ title: '汉'.repeat(ITEM_TITLE_MAX + 10), text: '汉'.repeat(ITEM_TEXT_MAX + 10) }),
    ])[0];
    expect(Array.from(long.title)).toHaveLength(ITEM_TITLE_MAX);
    expect(Array.from(long.text)).toHaveLength(ITEM_TEXT_MAX);
  });

  it('SI#7 usableUrl 只放行 http(s)（相对路径 / data: / javascript: 一律拒绝）', () => {
    expect(usableUrl('https://a.com/x')).toBe('https://a.com/x');
    expect(usableUrl('HTTP://a.com')).toBe('HTTP://a.com');
    expect(usableUrl('data:text/html,x')).toBeNull();
    expect(usableUrl('javascript:1')).toBeNull();
    expect(usableUrl('  ')).toBeNull();
  });

  it('SI#8 校验玩家手填的源：名称/链接/类型三个都得对', () => {
    expect(validateSourceInput({ name: '  ', url: 'https://a.com/f', kind: 'rss' })).toMatchObject({ ok: false });
    expect(validateSourceInput({ name: 'A', url: 'a.com/f', kind: 'rss' })).toMatchObject({ ok: false });
    expect(validateSourceInput({ name: 'A', url: 'https://a.com/f', kind: 'martian' })).toMatchObject({ ok: false });
    const ok = validateSourceInput({ name: '  我的源  ', url: 'https://a.com/feed.xml', kind: 'rss' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.name).toBe('我的源');
      expect(ok.value.id.startsWith('user:')).toBe(true);
      // 玩家自加的源一律按"未核实直连"对待（我们没替他量过 ACAO）
      expect(ok.value.direct).toBe(false);
    }
  });
});
