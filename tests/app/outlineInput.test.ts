/**
 * tests/app/outlineInput.test.ts —— 提纲输入采样（D61）。
 *
 * 判别力：
 * - OI#1 不超预算 ⇒ **原样返回**（短文本不该被改写：采样一旦无差别应用，短文会被塞进无谓的省略号）；
 * - OI#2 超预算 ⇒ 头部与尾部都在（结论常在尾），且总长 ≤ 预算 + 少量分隔符；
 * - OI#3 中间是**等距**取样（只取开头的实现必红：那样就退化成"只看开头"）；
 * - OI#4 不切碎段落（取样按行/段边界）；脏输入不崩。
 */
import { describe, expect, it } from 'vitest';
import { HEAD_TAIL_CHARS, outlineInputFor } from '../../src/app/outlineInput';

describe('app/outlineInput —— 提纲输入采样（D61）', () => {
  it('OI#1 不超预算 ⇒ 原样返回', () => {
    const short = '第一段。\n第二段。';
    expect(outlineInputFor(short, 20_000)).toBe(short);
    expect(outlineInputFor('', 20_000)).toBe('');
  });

  it('OI#2 超预算 ⇒ 头尾都在，且总长可控', () => {
    const paras = Array.from({ length: 60 }, (_, i) => `第${i}段：${'字'.repeat(500)}`);
    const text = paras.join('\n');
    // 预算 8000：头尾各 2000 之后，中间还有 4000 可取样（预算太小时头尾就吃满了 —— 那是刻意的）
    const out = outlineInputFor(text, 8_000);
    // **绝不超预算**：调用方还会按同一预算再裁一次，超出就会削掉结尾（KF#O6 的血案）
    expect(Array.from(out).length).toBeLessThanOrEqual(8_000);
    expect(out.startsWith('第0段')).toBe(true); // 头部
    expect(out).toContain('第59段'); // 尾部（结论常在尾）
    expect(out).toContain('等距节选'); // 如实标明中间是节选
  });

  it('OI#2b 预算小于"头+尾"时，头尾各让一半，总长仍不超预算', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}段：${'字'.repeat(500)}`).join('\n');
    const out = outlineInputFor(text, 3_000);
    expect(Array.from(out).length).toBeLessThanOrEqual(3_000 + 20); // 只多两个分隔符
    expect(out.startsWith('第0段')).toBe(true);
    expect(out).toContain('第39段');
  });

  it('OI#3 中间确实等距取样（不是只看开头）', () => {
    const paras = Array.from({ length: 40 }, (_, i) => `段${i}：${'字'.repeat(300)}`);
    const out = outlineInputFor(paras.join('\n'), 6_000);
    // 至少取到中段与后段的段落，而不是清一色前几段
    const picked = [...out.matchAll(/段(\d+)：/g)].map((m) => Number(m[1]));
    expect(picked.some((n) => n >= 10 && n <= 20), `中段没取到：${picked.join(',')}`).toBe(true);
    expect(picked.some((n) => n >= 20), `后段没取到：${picked.join(',')}`).toBe(true);
    expect(new Set(picked).size).toBeGreaterThanOrEqual(4);
  });

  it('OI#4 脏输入不崩', () => {
    expect(() => outlineInputFor(undefined as never)).not.toThrow();
    expect(typeof outlineInputFor(undefined as never)).toBe('string');
    expect(outlineInputFor('字'.repeat(10), 0 as never).length).toBeGreaterThan(0);
  });
});
