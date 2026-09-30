/**
 * SM-2 复习引擎（纯函数）—— Boss 触发与伤害倍率的科学核心。
 *
 * 约束：
 * - 零平台依赖：不读取当前时钟、不读宿主时区，时间一律以毫秒时间戳入参；无 IO、无 DOM/Node API。
 * - 不可变：review 返回新对象，绝不改动入参。
 * - effectiveReviewDays 只透传不写入（R-T4-c）：Boss 计数口径的唯一写入者是 reviewLedger。
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

/** easy(5) 档的 ease 增量：Wozniak 原始语义中 q=5 的固定加值（D27，独立常数）。 */
const EASE_BONUS = 0.1;

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

/**
 * 状态标签的**天数闸门**（D64）。
 *
 * ## 为什么需要它
 * 现场问题（玩家原话）："为什么我很多昨天刚建的卡今天都是已掌握状态？"
 * 实测：同一张新卡在**同一天**里练三次（全答对）就会被推到 interval 15 天 —— 而账本里只有 **1 天**。
 * 可"掌握"对人来说意味着"隔了几天还记得"，不是"一天里点得快"。
 * 更糟的是同一件事原本有两套口径：卷灵门槛按**天**算（同一天只算一次），状态标签按 reps 算。
 *
 * ## 口径（与卷灵账本同一种"天"的哲学）
 * - `已掌握` = interval ≥ 7 天 **且** 跨过 ≥ `MASTERED_MIN_DAYS` 个复习日；
 * - `复习`  = interval ≥ 1 天 **且** 跨过 ≥ `REVIEW_MIN_DAYS` 个复习日；
 * - 只**降不升**：闸门永远不会给出比 interval 应得的更高的标签；调度字段（interval/reps/ease/due）一字不动。
 *
 * 于是"一天里练三次"照样让间隔涨（手感、到期时间都不变），但标签会老实说"再隔天复习两次才算掌握"。
 */
export const MASTERED_MIN_DAYS = 3;
export const REVIEW_MIN_DAYS = 2;

/** 由 interval/reps 推导稳定度阶段（晋升规则见 brief）。 */
function promoteStability(interval: number, reps: number): Stability {
  if (interval >= 7) return 'mastered';
  if (reps >= 1 && interval >= 1) return 'review';
  return 'learning';
}

/** 把状态标签按**天数证据**收口（只降不升；见 MASTERED_MIN_DAYS 的说明）。 */
export function gateStabilityByDays(srs: SRSState): SRSState {
  const cur = srs;
  if (cur == null || typeof cur !== 'object') return cur;
  const interval = Number.isFinite(cur.interval) ? cur.interval : 0;
  const days = Array.isArray(cur.effectiveReviewDays) ? cur.effectiveReviewDays.length : 0;
  const allowed: Stability =
    interval >= 7 && days >= MASTERED_MIN_DAYS
      ? 'mastered'
      : interval >= 1 && days >= REVIEW_MIN_DAYS
        ? 'review'
        : interval < (typeof cur.interval === 'number' ? cur.interval : 0)
          ? 'learning'
          : cur.stability === 'new'
            ? 'new'
            : 'learning';
  // interval 应得的"上限"（不含天数要求）—— 闸门只降不升
  const cap: Stability = interval >= 7 ? 'mastered' : cur.reps >= 1 && interval >= 1 ? 'review' : 'learning';
  const rank: Record<Stability, number> = { new: 0, learning: 1, review: 2, mastered: 3 };
  const final = rank[allowed] < rank[cap] ? allowed : cap;
  // new 只在"从没复习过"时保留（reps=0 且没有账本日）
  if (final === 'learning' && cur.reps === 0 && days === 0) {
    return { ...cur, stability: 'new' };
  }
  return final === cur.stability ? cur : { ...cur, stability: final };
}

/**
 * SM-2 标准更新，返回新对象（不可变）。
 * ease′ = D27 门控：q≥easy → +0.1；q≤hard → clamp(ease + Δ(q), minEase, ∞)；good 不变。
 */
export function review(srs: SRSState, grade: Grade, nowMs: number, p: Sm2Params): SRSState {
  const params = resolveParams(p);
  const cur = sanitize(srs, params);
  const t = timeOr(nowMs, cur.due);
  const q = resolveGrade(grade);

  // ease 更新（D27 ΔEF 门控修正）：v1 逐字照抄的 Δ(q) = 0.1 − (5−q)(0.08 + (5−q)·0.02)
  // 在 q=3（good）时得 −0.14，与 Wozniak 原始 SM-2 符号约定相反——原始语义中 good 是
  // 「正确回忆」的中性档，EF 不变；只有 easy 加 EF、again/hard 减 EF。门控写法：
  //   q ≥ easy → +EASE_BONUS（+0.1，即 q=5 代入原 delta 公式的档位值，独立常数）
  //   q ≤ hard → delta(q)（again −0.54 / hard −0.32，原式下调）
  //   good     → 严格不变
  // 用显式数值比较而非符号假设（hard=2 < good=3 < easy=5 的档位序）。
  // 该修正使 good-only 链 EF 恒为 initialEase，间隔锚点回到 brief 的 1→6→15（round(6×2.5)）。
  const deltaOf = (qq: number): number => 0.1 - (5 - qq) * (0.08 + (5 - qq) * 0.02);
  let easeDelta = 0;
  if (q >= GRADES.easy) easeDelta = EASE_BONUS;
  else if (q <= GRADES.hard) easeDelta = deltaOf(q);
  const ease = Math.max(params.minEase, cur.ease + easeDelta);

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
    // D27 门控后 good-only 链 EF 恒为 initialEase，默认参数下锚点即 brief 的 1→6→15。
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

  // effectiveReviewDays 原样透传：日键一律由 reviewLedger.recordEffectiveReview 按调用方
  // 传入的本地偏移产生（R-T4-c，单一写入者）。引擎若自行追加 UTC 日键，在 UTC+8 的
  // 00:00–08:00 窗口会记成前一天，与账本同日双计、把 Boss 提前唤醒。
  return {
    ease,
    interval,
    reps,
    lapses,
    due: t + interval * DAY_MS,
    stability,
    effectiveReviewDays: cur.effectiveReviewDays,
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
  // 【Plan 5 数值改进】低两档上调：new 0.1→0.3、learning 0.5→0.7。
  // 依据（数值推演 + 用户实测）：每张卡分摊的敌血是 `10 × 难度系数`（遭遇战 7 点），
  // 与池长无关；旧值下 L1（atk=12）new=1 点、learning=6 点 ⇒ **两档都赢不了**，
  // 玩家"背过一遍回来还是输"，这就是"两轮都失败"的根因。
  // 新值：new=round(12×0.3)=4、learning=round(12×0.7)=8 ⇒ 前者靠教学局（DIFFICULTY.tutorial）
  // 取胜，后者在正常遭遇战里以 8 > 7 取胜（仍不轻松）。review/mastered 不动：
  // "背熟才有伤害"的阶梯必须保留，否则学习动机就没了。
  switch (srs?.stability) {
    case 'new':
      return 0.3;
    case 'learning':
      return 0.7;
    case 'review':
      return 1.0;
    case 'mastered':
      return 1.5;
    default:
      return 0.3;
  }
}
