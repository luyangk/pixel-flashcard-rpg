/**
 * 复习流程单一入口 —— R-T4-d 契约的兑现点。
 *
 * ⚠ 唯一合法复习入口：UI/战斗层完成一次复习后必须且只能经 applyReview 写账本。
 * 直接调用 sm2.review 会推进 SRS 却漏记 Boss 计数；直接调用 recordEffectiveReview
 * 会记账却跳过 SM-2 更新——两者都会让「走完一次复习 → Boss 计数恰 +1」的领域不变量破防。
 * 任何绕过本门的调用路径在终审口径下均视为缺陷。
 *
 * 内部顺序固定（不可调换）：先 review() 得新 SRS，再 recordEffectiveReview() 在其上追加
 * 当日日历日键。返回的新 Card 同时携带新 SRS 与新账本。
 *
 * 约束（与 core 层全局纪律一致）：
 * - 零平台依赖：不调 Date.now()、不读宿主时区；nowMs 与 tzOffsetMin 一律由调用方传入
 *   （tzOffsetMin = -new Date().getTimezoneOffset()，UTC+8 为 +480）。
 * - 不可变：入参 card 及其 srs / effectiveReviewDays 数组绝不被改动。
 * - graded 为入参原样透传；域外档位由 review 内部保守回落 again，二者可能不一致
 *   （消费方勿以 graded 反推 SRS 行为）。
 */

import type { Card, Sm2Params } from './types';
import { review, type Grade } from './sm2';
import { recordEffectiveReview } from './reviewLedger';

/** 一次复习的完整结果：新卡（新 SRS + 新账本）、所用评分、作答时刻。 */
export interface ReviewOutcome {
  card: Card;
  graded: Grade;
  answeredAt: number;
}

/**
 * 走完复习流程：SM-2 更新 → 有效复习记账，两步定序、缺一不可。
 * 参数非法性不在本层重复消毒——review/recordEffectiveReview 各自兜底（域外输入防御）。
 */
export function applyReview(
  card: Card,
  grade: Grade,
  nowMs: number,
  tzOffsetMin: number,
  params: Sm2Params,
  opts: {
    /**
     * 是否把这次复习记进"有效复习日"账本（**Boss 达标口径**，Plan 7 · D46）。
     * 缺省 `true`（既有调用方一字不改）；**木桩练功传 `false`** —— 练功照常推进 SRS，
     * 但推不动卷灵达标（否则木桩成了零风险刷 Boss 的捷径）。
     */
    readonly countEffectiveDay?: boolean;
  } = {},
): ReviewOutcome {
  const reviewedSrs = review(card.srs, grade, nowMs, params);
  const reviewedCard: Card = { ...card, srs: reviewedSrs };
  return {
    card: opts.countEffectiveDay === false ? reviewedCard : recordEffectiveReview(reviewedCard, nowMs, tzOffsetMin),
    graded: grade,
    answeredAt: nowMs,
  };
}
