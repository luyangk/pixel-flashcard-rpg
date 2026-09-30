/**
 * progressGuide.ts —— **进度说明的派生口径**（D63）。
 *
 * ## 为什么要有这个文件
 * 玩家原话："我光看 app 无法理解这些状态，也无法理解当前进度、后续差多少"。
 * 解法不是"多写几句文案"，而是**让说明与规则共用同一个口径** —— 否则迟早出现
 * "屏上说还差 3 次、代码里其实还差 5 次"这类最难查的谎话。
 *
 * 所以这里只做三件事，全部是既有 core 函数的**求和 / 求差 / 取词**：
 * - 经验：`expToNext` 累加成"到某级的累计需求"，再求差（与 `applyExp` 同口径）；
 * - 卷灵：`domainReviewCount` 与阈值求差（与 `bossReady` 同口径）；
 * - 卡片状态：`sm2.promoteStability` 的**真实阈值**翻成大白话。
 *
 * 零 DOM、零时钟、零随机：给它存档里的字段，它给屏幕上的字。
 */
import type { Card } from './types';
import { expToNext } from './stats';
import { bossReady, domainReviewCount } from './reviewLedger';
import { MASTERED_MIN_DAYS, REVIEW_MIN_DAYS } from './sm2';

/** 卷灵阈值档位（与 settings.bossThresholdTier 同域）。 */
export type BossTier = 15 | 30 | 50;

/** 已掌握的真实门槛（`sm2.promoteStability`：interval ≥ 7 天）——**说明与规则共用这一个数**。 */
export const MASTERED_INTERVAL_DAYS = 7;

/** 升到"复习"档的真实门槛：interval ≥ 1 天（且 reps ≥ 1）。 */
export const REVIEW_INTERVAL_DAYS = 1;

/**
 * 升到 `level` 级**累计**需要多少经验（L1 = 0）。
 *
 * 为什么是累计：`applyExp` 消费的是**总经验**（`levelFromExp` 也是从总经验反推等级），
 * 所以"还差多少"必须拿累计需求求差 —— 只报"下一级要 100"会让高等级玩家永远算不对。
 */
export function expToLevelTotal(level: number): number {
  const target = Number.isInteger(level) && level > 1 ? level : 1;
  let total = 0;
  for (let lv = 1; lv < target; lv += 1) total += expToNext(lv);
  return total;
}

/** 当前等级与总经验 → 距下一级还差多少经验（≥0，恒为整数）。 */
export function expGapToNextLevel(level: number, totalExp: number): number {
  const safeLevel = Number.isInteger(level) && level >= 1 ? level : 1;
  const safeExp = typeof totalExp === 'number' && Number.isFinite(totalExp) && totalExp > 0 ? Math.floor(totalExp) : 0;
  return Math.max(0, expToLevelTotal(safeLevel + 1) - safeExp);
}

export interface BossProgress {
  /** 本领域累计的**有效复习次数**（按天计，见 `reviewLedger`）。 */
  readonly count: number;
  readonly threshold: number;
  /** 还差几次有效复习（达标为 0）。 */
  readonly remaining: number;
  readonly ready: boolean;
}

/** 卷灵进度：X / Y / 还差 Z / 是否已就绪（与 `bossReady` 同一口径）。 */
export function bossProgress(deckCards: readonly Card[] | null, tier: BossTier): BossProgress {
  const threshold = (typeof tier === 'number' && Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 15) as number;
  const cards = Array.isArray(deckCards) ? (deckCards as readonly Card[]) : [];
  const count = domainReviewCount(cards as Card[]);
  return {
    count,
    threshold,
    remaining: Math.max(0, threshold - count),
    ready: bossReady(cards as Card[], threshold as BossTier),
  };
}

export interface CardStatusHint {
  /** 屏上用的短标签（与练功/战斗屏的既有词一致）。 */
  readonly label: string;
  /** 一句话说清"这张卡现在处于什么、还差什么"。 */
  readonly hint: string;
}

/**
 * 一张卡的状态大白话（D63）。
 *
 * 阈值全部来自 `sm2.promoteStability` 的真实规则：interval ≥ 7 天 ⇒ 已掌握；
 * reps ≥ 1 且 interval ≥ 1 天 ⇒ 复习；否则在学；没答过 ⇒ 初识。
 */
export function cardStatusHint(card: Card | null | undefined): CardStatusHint {
  const srs = card?.srs;
  const stability = srs?.stability;
  const interval = typeof srs?.interval === 'number' && Number.isFinite(srs.interval) ? srs.interval : 0;
  const days = Math.max(0, Math.round(interval * 10) / 10);
  const dayCount = Array.isArray(srs?.effectiveReviewDays) ? srs.effectiveReviewDays.length : 0;

  /**
   * D64：**间隔够了但天数不够**是最容易被误解的一种状态（玩家问过"为什么昨天刚建的卡今天就已掌握"）。
   * 这种事必须直说差在天数上，不能只报"间隔 15 天"让人以为已经掌握了。
   */
  if (interval >= MASTERED_INTERVAL_DAYS && dayCount < MASTERED_MIN_DAYS) {
    const need = MASTERED_MIN_DAYS - dayCount;
    return {
      label: '复习',
      hint: `间隔 ${days} 天已够，但只跨过 ${dayCount} 天 —— 再隔天复习 ${need} 次才算「已掌握」`,
    };
  }
  if (interval >= REVIEW_INTERVAL_DAYS && dayCount < REVIEW_MIN_DAYS) {
    return {
      label: '在学',
      hint: `间隔 ${days} 天已够，但只跨过 ${dayCount} 天 —— 明天再复习一次才算「复习」`,
    };
  }
  if (stability === 'mastered') {
    return {
      label: '已掌握',
      hint: `间隔 ${days} 天、已跨过 ${dayCount} 天 —— 隔几天回来复习一次就能稳住`,
    };
  }
  if (stability === 'review') {
    return {
      label: '复习',
      hint: `间隔 ${days} 天 → 到 ${MASTERED_INTERVAL_DAYS} 天、并跨过 ${MASTERED_MIN_DAYS} 天算「已掌握」`,
    };
  }
  if (stability === 'learning') {
    return {
      label: '在学',
      hint: `间隔 ${days} 天 → 到 ${REVIEW_INTERVAL_DAYS} 天算「复习」，再到 ${MASTERED_INTERVAL_DAYS} 天（且跨 ${MASTERED_MIN_DAYS} 天）算「已掌握」`,
    };
  }
  return { label: '初识', hint: '还没答过 —— 答对一次就开始记间隔' };
}

/** 一句总说明（练功屏顶部的《状态怎么升》用；与上面四档逐字同源）。 */
export function stabilityExplainer(): readonly { readonly label: string; readonly text: string }[] {
  return [
    { label: '初识', text: '刚入库，还没答过。答对一次就开始累积间隔。' },
    { label: '在学', text: `答过但间隔还不到 ${REVIEW_INTERVAL_DAYS} 天。连续答对，间隔会变长。` },
    { label: '复习', text: `间隔到了 ${REVIEW_INTERVAL_DAYS} 天以上、且跨过 ${REVIEW_MIN_DAYS} 个复习日。继续答对，间隔接着变长。` },
    {
      label: '已掌握',
      text: `间隔到 ${MASTERED_INTERVAL_DAYS} 天以上、且跨过 ${MASTERED_MIN_DAYS} 个复习日 —— 也就是"隔几天回来还记得"。同一天里练很多次会让间隔变长，但不算掌握（参战时已掌握的卡还能加更多经验）。`,
    },
  ];
}
