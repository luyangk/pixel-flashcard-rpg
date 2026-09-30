/**
 * tests/core/stabilityDays.test.ts —— 状态标签的**天数闸门**（D64）。
 *
 * 现场问题（玩家原话）："为什么我很多昨天刚建的卡今天都是已掌握状态？"
 * 实测原因：同一张新卡在**同一天**里练三次（全答对）就会被 SM-2 推到 interval 15 天 ——
 * 而账本里只有 **1 天**。可"掌握"对人来说意味着"隔了几天还记得"，不是"一天里点得快"。
 * 更糟的是同一件事有两套口径：卷灵门槛按天算（隔天算一次），状态标签按 reps 算。
 *
 * 判别力：
 * - SD#1 同一天反复练 ⇒ **不出现「已掌握」**（把天数闸门删掉的实现必红）；
 * - SD#2 跨够天数 ⇒ 升到「复习」「已掌握」（闸门不能把进度锁死）；
 * - SD#3 只降不升：闸门永远不给"比间隔应得的更高"的标签（脏存档回读也不能虚高）；
 * - SD#4 间隔/到期时间照旧推进（闸门只管标签，不改调度）。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '@core/types';
import { GRADES, MASTERED_MIN_DAYS, REVIEW_MIN_DAYS, createInitialSRS, gateStabilityByDays } from '@core/sm2';
import { applyReview } from '@core/reviewFlow';

const P = { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 };
const TZ = 480;
const DAY = 86_400_000;

function fresh(at: number): Card {
  return { id: 'c1', deckId: 'd1', front: 'f', back: 'b', tags: [], srs: createInitialSRS(at) };
}

describe('core —— 状态标签的天数闸门（D64）', () => {
  it('SD#1 同一天练三次：间隔上去了，标签**不许**说"已掌握"', () => {
    const day0 = Date.UTC(2026, 9, 29, 4, 0, 0);
    let card = fresh(day0);
    for (let i = 1; i <= 3; i += 1) {
      card = applyReview(card, GRADES.good, day0 + i * 60_000, TZ, P).card;
    }
    expect(card.srs.interval).toBeGreaterThanOrEqual(7); // 间隔确实涨了（调度照旧）
    expect(card.srs.effectiveReviewDays).toHaveLength(1); // 只有一天
    expect(card.srs.stability).not.toBe('mastered'); // 但标签不许虚高
  });

  it('SD#2 跨够天数：复习要 ≥2 天、已掌握要 ≥3 天', () => {
    const day0 = Date.UTC(2026, 9, 29, 4, 0, 0);
    let card = fresh(day0);
    card = applyReview(card, GRADES.good, day0, TZ, P).card; // 第 1 天
    card = applyReview(card, GRADES.good, day0 + DAY, TZ, P).card; // 第 2 天
    expect(card.srs.effectiveReviewDays).toHaveLength(REVIEW_MIN_DAYS);
    expect(card.srs.stability).toBe('review');
    card = applyReview(card, GRADES.good, day0 + 2 * DAY, TZ, P).card; // 第 3 天
    expect(card.srs.effectiveReviewDays).toHaveLength(MASTERED_MIN_DAYS);
    expect(card.srs.stability).toBe('mastered');
  });

  it('SD#3 只降不升：间隔不足时闸门不给更高的标签', () => {
    const srs = { ...createInitialSRS(0), stability: 'mastered' as const, interval: 2, reps: 2, effectiveReviewDays: ['2026-10-01', '2026-10-02', '2026-10-03'] };
    expect(gateStabilityByDays(srs).stability).toBe('review'); // 间隔只有 2 天 ⇒ 最多"复习"
    const thin = { ...srs, interval: 30, effectiveReviewDays: ['2026-10-01'] };
    expect(gateStabilityByDays(thin).stability).toBe('learning'); // 只跨 1 天 ⇒ 连"复习"都不算
  });

  it('SD#4 闸门不改调度字段（interval/reps/ease/due 原样）', () => {
    const srs = { ...createInitialSRS(1234), stability: 'mastered' as const, interval: 30, reps: 5, ease: 2.7, due: 999 };
    const out = gateStabilityByDays(srs);
    expect(out.interval).toBe(30);
    expect(out.reps).toBe(5);
    expect(out.ease).toBe(2.7);
    expect(out.due).toBe(999);
  });
});
