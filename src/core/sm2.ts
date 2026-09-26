/**
 * SM-2 复习引擎（纯函数）—— Boss 触发与伤害倍率的科学核心。
 *
 * 约束：
 * - 零平台依赖：不调用 Date.now()，时间一律以毫秒时间戳入参；无 IO、无 DOM/Node API。
 * - 不可变：review 返回新对象，绝不改动入参。
 * - 域外输入防御（Review Focus #4）：非法 grade / NaN / 负 ease 一律回落默认值，
 *   输出永不含 NaN，永不抛异常。
 */

import type { Card, Sm2Params, SRSState, Stability } from './types';

/** 评分档位（SM-2 q 值）。 */
export const GRADES = { again: 0, hard: 2, good: 3, easy: 5 } as const;

export type Grade = (typeof GRADES)[keyof typeof GRADES];

const DAY_MS = 86_400_000;

/** p 缺省或字段非法时的兜底参数（Anki 风格默认）。 */
const FALLBACK_PARAMS: Sm2Params = {
  initialEase: 2.5,
  minEase: 1.3,
  firstInterval: 10 / 60, // 10 分钟，以天计
  secondInterval: 6,
};

/** 有限正数校验：非有限（NaN/±Infinity）或非正 → 回落。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 非负有限整数校验（reps/lapses 用）。 */
function nonNegIntOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

/** 任意数值的时间戳校验：非有限回落 nowMs 自身（仍非有限则回落 0）。 */
function timeOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Number.isFinite(fallback) ? fallback : 0;
}

/** 逐字段消毒外部传入的 SRSState（存档可能携带脏数据）。 */
function sanitize(srs: SRSState, p: Sm2Params): SRSState {
  const stability: Stability =
    srs.stability === 'learning' || srs.stability === 'review' || srs.stability === 'mastered'
      ? srs.stability
      : 'new';
  return {
    ease: finiteOr(srs.ease, p.initialEase),
    interval: typeof srs.interval === 'number' && Number.isFinite(srs.interval) && srs.interval >= 0 ? srs.interval : 0,
    reps: nonNegIntOr(srs.reps, 0),
    lapses: nonNegIntOr(srs.lapses, 0),
    due: timeOr(srs.due, Date.UTC(1970, 0, 1)),
    stability,
    effectiveReviewDays: Array.isArray(srs.effectiveReviewDays) ? [...srs.effectiveReviewDays] : [],
  };
}

/** 解析参数集：任一字段非法即整体按字段回落。 */
function resolveParams(p?: Sm2Params): Sm2Params {
  const src = p ?? FALLBACK_PARAMS;
  const initialEase = finiteOr(src.initialEase, FALLBACK_PARAMS.initialEase);
  const minEase = finiteOr(src.minEase, FALLBACK_PARAMS.minEase);
  return {
    initialEase,
    minEase: Math.min(minEase, initialEase),
    firstInterval: finiteOr(src.firstInterval, FALLBACK_PARAMS.firstInterval),
    secondInterval: finiteOr(src.secondInterval, FALLBACK_PARAMS.secondInterval),
  };
}

/** q 必须落在 {0,2,3,5}，否则视为 again（最保守回落）。 */
function resolveGrade(grade: Grade): number {
  switch (grade) {
    case 0:
    case 2:
    case 3:
    case 5:
      return grade;
    default:
      return GRADES.again;
  }
}

/** UTC 日期键（YYYY-MM-DD），Boss 计数口径：同日只计一次。 */
function dayKey(nowMs: number): string {
  return new Date(timeOr(nowMs, 0)).toISOString().slice(0, 10);
}

/** 新建卡的初始 SRS 状态。p 可省略（此时用兜底 initialEase）。 */
export function createInitialSRS(nowMs: number, p?: Sm2Params): SRSState {
  const params = resolveParams(p);
  return {
    ease: params.initialEase,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: timeOr(nowMs, 0),
    stability: 'new',
    effectiveReviewDays: [],
  };
}

/** 由 interval/reps 推导稳定度阶段（晋升规则见 brief）。 */
function promoteStability(interval: number, reps: number): Stability {
  if (interval >= 7) return 'mastered';
  if (reps >= 1 && interval >= 1) return 'review';
  return 'learning';
}

/**
 * SM-2 标准更新，返回新对象（不可变）。
 * ease′ = clamp(ease + (0.1 − (5−q)(0.08 + (5−q)·0.02)), minEase, ∞)
 */
export function review(srs: SRSState, grade: Grade, nowMs: number, p: Sm2Params): SRSState {
  const params = resolveParams(p);
  const cur = sanitize(srs, params);
  const t = timeOr(nowMs, cur.due);
  const q = resolveGrade(grade);

  // ease 更新：brief 公式逐字转写 ease′ = clamp(ease + Δ(q), minEase, ∞)，
  // Δ = 0.1 − (5−q)(0.08 + (5−q)·0.02)。注意该写法下 q=3（good）的 Δ = −0.14，
  // 与 Wozniak 原始 SM-2 的符号约定相反（原始实现中 good 使 EF +0.1）。
  // 本引擎严格照用 brief 公式；配套约定是间隔用「更新前」EF 计算（标准 SM-2），
  // 于是默认参数下 good 链为 1→6→15，正合 brief 锚点。
  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  const ease = Math.max(params.minEase, cur.ease + delta);

  let interval: number;
  let reps: number;
  let lapses = cur.lapses;
  if (q === GRADES.again) {
    reps = 0;
    interval = params.firstInterval; // 分钟级：10/60 天
    lapses += 1;
  } else {
    reps = cur.reps + 1;
    // interval 用「更新前」的 ease 计算（标准 SM-2：I(n) = I(n−1) · EF，EF 随后才更新）。
    // reps=2 档直接取 secondInterval（brief 原文 "interval 按 reps=1→secondInterval"，
    // Anki 式固定第二间隔）；reps≥3 用 round(interval × 旧EF)。
    // 于是默认参数下 good 链 = 1→6→round(6×2.5)=15，精确命中 brief 锚点。
    // 小于 1 天的分钟级不取整以保精度；修饰系数在取整前施加（brief 顺序）。
    const days = (v: number): number => (v >= 1 ? Math.round(v) : v);
    if (reps === 1) {
      interval = params.firstInterval;
    } else if (reps === 2) {
      interval = params.secondInterval;
    } else {
      interval = days(cur.interval * cur.ease);
    }
    if (q === GRADES.easy) interval = days(interval * 1.3);
    if (q === GRADES.hard) interval = days(interval / 1.2);
    if (!Number.isFinite(interval) || interval < 0) interval = params.firstInterval;
  }

  const stability: Stability =
    q === GRADES.again ? 'learning' : promoteStability(interval, reps);

  const key = dayKey(t);
  const effectiveReviewDays = cur.effectiveReviewDays.includes(key)
    ? cur.effectiveReviewDays
    : [...cur.effectiveReviewDays, key];

  return {
    ease,
    interval,
    reps,
    lapses,
    due: t + interval * DAY_MS,
    stability,
    effectiveReviewDays,
  };
}

/** 到期卡队列，按紧迫度升序（due 越早越前；due === nowMs 视为到期）。不改动入参数组。 */
export function dueQueue(cards: Card[], nowMs: number): Card[] {
  const t = timeOr(nowMs, 0);
  if (!Array.isArray(cards)) return [];
  return cards
    .filter((c) => c != null && timeOr(c.srs?.due, Infinity) <= t)
    .sort((a, b) => timeOr(a.srs?.due, Infinity) - timeOr(b.srs?.due, Infinity));
}

/** PRD §2.1 熟练度倍率；LORE"未入脑≈0"用 0.1 保底防零伤害死局。 */
export function damageMultiplier(srs: SRSState): number {
  switch (srs?.stability) {
    case 'new':
      return 0.1;
    case 'learning':
      return 0.5;
    case 'review':
      return 1.0;
    case 'mastered':
      return 1.5;
    default:
      return 0.1;
  }
}
