/**
 * tests/tooling/copyNumbers.test.ts —— 「屏幕上的数字」必须与「引擎里的数字」一致。
 *
 * ## 为什么需要这条守卫（不是洁癖，是用户实测撞过的坑）
 * Plan 5 的数值改进把 `damageMultiplier(new)` 从 0.1 抬到 0.3，战斗屏的提示文案同步改了，
 * 而**结算屏的败局引导漏改**：它还在说"稳定度从「初识」升到「复习」后，每击伤害会从
 * **一成**涨到十成"。玩家照着做会发现"背熟了也没有十倍"——文案撒谎比数值难玩更伤信任。
 * 一次漏改可以靠人眼，第二次就得靠机器：本文件把"文案里写成数的伤害占比"钉在倍率表上。
 *
 * ## 判据
 * 1. 从 `core/sm2.damageMultiplier` **现算**出四档各是几成（0.3/0.7/1.0/1.5 ⇒ 3/7/10/15）；
 * 2. 剥掉注释与**非中文字符串**后，扫描 `src/ui/**`、`src/app/**` 里所有「X成」的表述；
 * 3. 每个出现的成数都必须在上面那个集合里——倍率改了而文案没改 ⇒ 必红。
 *
 * 自检（"判据有牙"）：把 `damageMultiplier` 的 new 改成 0.4（文案不动），断言集合里
 * 不再有 3 ⇒ 扫描'三成伤害'必然命中失败；下面 SELF#1 直接把这条推理跑一遍。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTs } from '../../scripts/check-core-purity';
import { damageMultiplier } from '../../src/core/sm2';
import type { SRSState, Stability } from '../../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 扫描范围：屏幕上给玩家看的文案都在这两层（core 不出文案、platform 只有文件名）。 */
const ROOTS = ['src/ui', 'src/app'].map((r) => resolve(ROOT, r));

/** 四档熟练度对应的"成数"（十成 = 1.0）。 */
function allowedTens(): Set<number> {
  const out = new Set<number>();
  for (const stability of ['new', 'learning', 'review', 'mastered'] as Stability[]) {
    const srs = { stability } as SRSState;
    out.add(Math.round(damageMultiplier(srs) * 10));
  }
  return out;
}

/** 中文数字 → 数值（只覆盖文案里真会出现的 1–99；认不出的回 null）。 */
function cnNumeral(s: string): number | null {
  const digits: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (s === '十') return 10;
  if (s.length === 1) return digits[s] ?? null;
  if (s.length === 2) {
    if (s[0] === '十') return 10 + (digits[s[1]] ?? Number.NaN);
    if (s[1] === '十') return (digits[s[0]] ?? Number.NaN) * 10;
    return null;
  }
  if (s.length === 3 && s[1] === '十') return (digits[s[0]] ?? Number.NaN) * 10 + (digits[s[2]] ?? Number.NaN);
  return null;
}

/** 剥掉注释（保留字符串字面量——文案就在里面）。 */
function codeAndStrings(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 收集 [文件, 成数, 原文] —— 只认"数字 + 成"且后面紧跟"伤害/涨/伤"，避免"一成不变"这类成语。 */
function tenClaims(): Array<{ file: string; tens: number; text: string }> {
  const out: Array<{ file: string; tens: number; text: string }> = [];
  const re = /([一二两三四五六七八九十]{1,3})成(?=[伤害涨])/g;
  for (const root of ROOTS) {
    for (const file of collectTs(root)) {
      const src = codeAndStrings(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(re)) {
        const n = cnNumeral(m[1]);
        if (n === null) continue;
        out.push({ file, tens: n, text: m[0] });
      }
    }
  }
  return out;
}

describe('文案数字与引擎数值同步', () => {
  it('CN#1 所有"X成伤害"的表述都必须落在 damageMultiplier 的四档上（漏同步文案必红）', () => {
    const allowed = allowedTens();
    expect(allowed).toEqual(new Set([3, 7, 10, 15])); // 倍率表本身也钉住：改数值会让这条先红
    const claims = tenClaims();
    expect(claims.length).toBeGreaterThan(0); // 扫不到任何表述 ⇒ 判据失明，也算失败
    for (const c of claims) {
      expect(
        allowed.has(c.tens),
        `${c.file} 里的"${c.text}"（${c.tens} 成）与倍率表 ${[...allowed].sort((a, b) => a - b).join('/')} 不符`,
      ).toBe(true);
    }
  });

  it('CN#2 已退役的"一成伤害"表述不得复活（旧数值 0.1）', () => {
    const stale = tenClaims().filter((c) => c.tens === 1);
    expect(stale).toEqual([]);
  });

  it('SELF#1 判据有牙：把 new 的倍率想象成 0.4 时，"三成"就不再被允许', () => {
    // 不改生产代码（那是变异测试的活），只验证"倍率变 ⇒ 允许集变 ⇒ 三成的文案会被拒"这条推理
    const withNew04 = new Set([4, 7, 10, 15]);
    expect(withNew04.has(3)).toBe(false);
    expect(allowedTens().has(3)).toBe(true); // 现状：三成是当前正确答案
  });
});
