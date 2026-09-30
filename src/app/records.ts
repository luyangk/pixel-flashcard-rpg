/**
 * records.ts —— **个人纪录**（D57）。
 *
 * ## 为什么要它
 * 原来的"本地榜"记的是**每一局**的战绩（`(卡数−失误)×10 + 等级×5 + Boss 50`），玩家看到
 * 「生活常识 · 215 分 · 胜」根本读不出"我练得怎么样"。个人纪录换一个口径：**跟我自己比**，
 * 四个维度：等级 / 经验、已掌握卡数、自建卡数、有效复习天数（含最长连续）。
 *
 * ## 三个维度是"现算"的
 * 等级看 `progress.exp`、已掌握看 `srs.stability`、自建卡看 `source.type` —— 这三个只会增
 * 不会减，所以**不需要任何历史字段**（少一个字段就少一处迁移与一处脏值面）。
 * 只有"最长连续"要说明口径：**从账本现算**（每张卡只留最近 400 天 ≈ 13 个月）。
 * 也就是说超过这个窗口的历史最好成绩不会被记住 —— 这是刻意的取舍：为它加一个存档字段，
 * 代价是每个夹具、每条往返深比对、每次迁移都要跟着改（"逐键无损"那一组用例当场就会红），
 * 而收益只是"一年前的旧纪录"这种极小概率的展示差异。
 */
import type { Card, SaveFile } from '@core/types';
import { DAY_KEY_RE } from '@core/reviewLedger';
import { levelFromExp } from './growth';

export interface PlayerRecords {
  readonly level: number;
  readonly exp: number;
  readonly mastered: number;
  readonly selfMade: number;
  /** 有复习记录的天数（所有卡账本的并集）。 */
  readonly reviewDays: number;
  /** 当前连续天数（今天或昨天还在连着才算）。 */
  readonly streak: number;
  /** 账本窗口内最长的一段连续（至少等于当前连续）。 */
  readonly bestStreak: number;
}

/** 自建卡：手写 / AI 辅建 / 采集 —— 预置卡不算"我自己添的"。 */
const SELF_MADE: readonly string[] = ['manual', 'llm', 'hotspot'];

/** 把一张卡的账本并进集合（脏值就地丢弃）。 */
function collectDays(cards: readonly Card[]): Set<string> {
  const days = new Set<string>();
  for (const c of cards) {
    const list = c?.srs?.effectiveReviewDays;
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (typeof d === 'string' && DAY_KEY_RE.test(d)) days.add(d);
    }
  }
  return days;
}

/** `YYYY-MM-DD` 减一天（只用 UTC 运算：账本键本身就是"本地日"，不再叠时区）。 */
export function prevDayKey(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 当前连续天数：从**今天**或**昨天**往回数（今天还没复习不算断 —— 一天还没过完）。
 * 再往前每断一天就停。
 */
export function streakEndingAt(days: ReadonlySet<string>, today: string): number {
  let cursor = days.has(today) ? today : prevDayKey(today);
  if (!days.has(cursor)) return 0;
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = prevDayKey(cursor);
  }
  return n;
}

/** 账本里最长的一段连续（`bestStreak` 就是它 —— 本项目**没有**这个存档字段，是现算的）。 */
export function longestStreak(days: ReadonlySet<string>): number {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let last: string | null = null;
  for (const d of sorted) {
    run = last !== null && prevDayKey(d) === last ? run + 1 : 1;
    last = d;
    if (run > best) best = run;
  }
  return best;
}

/**
 * 存档 → 个人纪录（纯函数，**永不抛**）。
 *
 * `today` = 本地日历日键（由调用方用 `localDayString(now, tzOffsetMin)` 算好传进来）——
 * 这一层不读时钟，与 core 的纪律一致。
 */
export function computeRecords(save: SaveFile, today: string): PlayerRecords {
  const cards = Array.isArray(save?.cards) ? save.cards : [];
  const expRaw = save?.settings?.progress?.exp;
  const exp = typeof expRaw === 'number' && Number.isFinite(expRaw) && expRaw > 0 ? Math.floor(expRaw) : 0;

  let mastered = 0;
  let selfMade = 0;
  for (const c of cards) {
    if (!c || typeof c !== 'object') continue;
    if (c.srs?.stability === 'mastered') mastered += 1;
    const type = c.source?.type;
    if (typeof type === 'string' && SELF_MADE.includes(type)) selfMade += 1;
  }

  const days = collectDays(cards);
  const streak = streakEndingAt(days, today);
  return {
    level: levelFromExp(exp),
    exp,
    mastered,
    selfMade,
    reviewDays: days.size,
    streak,
    bestStreak: Math.max(longestStreak(days), streak),
  };
}
