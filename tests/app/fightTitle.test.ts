/**
 * tests/app/fightTitle.test.ts —— 遭遇战名字（D58）。
 *
 * 判别力：
 * - FT#1 组合形态：单域只写名字、双域 `A × B`、三域以上 `A / B / C`（把三个领域名用 × 串起来的实现必红）；
 * - FT#2 兜底名**确定性**：同一组合必得同一个雅号（每次随机的实现必红 —— 记录会飘）；
 * - FT#3 不同组合**大概率**不同雅号（全返回同一个的实现必红）；
 * - FT#4 拼出来的名字 ≤24 码点，且形如 `雅号 · 组合`；
 * - FT#5 从模型输出里取雅号：只认 ≤6 码点的汉字/字母数字，标点与换行一律剃掉。
 */
import { describe, expect, it } from 'vitest';
import { comboLabel, composeTitle, fallbackYahao, sanitizeYahao, splitCombo } from '../../src/app/fightTitle';

describe('app/fightTitle —— 组合与雅号（D58）', () => {
  it('FT#1 组合形态：单域 / 双域 / 三域以上', () => {
    expect(comboLabel(['唐诗'])).toBe('唐诗');
    expect(comboLabel(['唐诗', '成语典故'])).toBe('唐诗 × 成语典故');
    expect(comboLabel(['生活常识', '唐诗', 'AI-Agent'])).toBe('生活常识 / 唐诗 / AI-Agent');
    // 脏输入：空串/重复/非字符串一律剔掉
    expect(comboLabel(['唐诗', '唐诗', '', '  ', 42 as never])).toBe('唐诗');
    expect(comboLabel([])).toBe('练功'); // 一个领域名都没有时的兜底
  });

  it('FT#2 兜底名确定性：同组合同雅号', () => {
    const a = fallbackYahao(['唐诗', '成语典故']);
    const b = fallbackYahao(['唐诗', '成语典故']);
    expect(a).toBe(b);
    // 顺序不同 = 不同组合（领域顺序在池里是稳定的，不必刻意归一）
    expect(fallbackYahao(['生活常识'])).toBe(fallbackYahao(['生活常识']));
  });

  it('FT#3 不同组合给出不同雅号（不是所有人都叫同一个）', () => {
    const names = ['唐诗', '成语典故', '生活常识', '英语词根', 'AI-Agent', '机器学习', '历史', '地理'];
    const seen = new Set(names.map((n) => fallbackYahao([n])));
    expect(seen.size).toBeGreaterThanOrEqual(4); // 至少四种不同雅号
  });

  it('FT#4 名字形如 `雅号 · 组合`，且 ≤24 码点', () => {
    const title = composeTitle('长安夜雨', ['唐诗', '成语典故']);
    expect(title).toBe('长安夜雨 · 唐诗 × 成语典故');
    const long = composeTitle('很长的雅号'.repeat(3), ['很长的领域名'.repeat(3), '另一个很长的领域'.repeat(3)]);
    expect(Array.from(long).length).toBeLessThanOrEqual(24);
    expect(long).toContain(' · ');
  });

  it('FT#5 取模型给的雅号：只留 ≤6 码点的汉字/字母数字', () => {
    expect(sanitizeYahao('长安夜雨')).toBe('长安夜雨');
    expect(sanitizeYahao('「长安夜雨」\n')).toBe('长安夜雨');
    expect(sanitizeYahao('长安夜雨·')).toBe('长安夜雨');
    expect(sanitizeYahao('一二三四五六七八')).toBe('一二三四五六'); // 截到 6
    expect(sanitizeYahao('   ')).toBe('');
    expect(sanitizeYahao('夜雨 2.0')).toBe('夜雨20'); // 空格与点被剃掉
  });

  it('FT#6 splitCombo 能把我们拼出来的名字拆回组合（升级雅号时要用）', () => {
    expect(splitCombo('长安夜雨 · 唐诗 × 成语典故')).toBe('唐诗 × 成语典故');
    expect(splitCombo('没有分隔符')).toBe('');
  });
});

/* ------------------------------------------------------------------ 复查 M5：不切出半个领域名 */

/**
 * 判别力（复查发现 M5）：超上限时按**分隔符**裁——能放几个完整领域名就放几个，
 * 放不下丢掉并补「…」。计划自己给的三域样张就超上限，按码点硬切会得到「… / AI-」这种半个名字。
 */
describe('app/fightTitle —— 组合超长的裁法（复查 M5）', () => {
  it('FT#7 三域超长 ⇒ 只出现**完整**的领域名，且以 … 说明被截', () => {
    const title = composeTitle('三域合参', ['生活常识', '唐诗', 'AI-Agent']);
    expect(Array.from(title).length).toBeLessThanOrEqual(24);
    expect(title).toContain('…'); // 截短了就说出来
    // 不许出现被切一半的名字
    expect(title).not.toContain('AI-');
    expect(title).not.toContain('AI-Ag');
    const combo = title.split(' · ')[1];
    for (const piece of combo.replace('…', '').split(/\s*[×/]\s*/).filter((x) => x.length > 0)) {
      expect(['生活常识', '唐诗', 'AI-Agent']).toContain(piece);
    }
  });

  it('FT#8 放得下时一个都不丢（不无故加省略号）', () => {
    const title = composeTitle('长安夜雨', ['唐诗', '成语典故']);
    expect(title).toBe('长安夜雨 · 唐诗 × 成语典故');
    expect(title).not.toContain('…');
  });
});
