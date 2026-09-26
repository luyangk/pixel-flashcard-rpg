/**
 * 有效复习计数（Boss 触发口径）—— "间隔 ≥1 天才计一次" 的日历日账本。
 *
 * 领域语义：一张卡在同一天里刷十次，对卷灵 Boss 只算一次修行；跨过本地午夜再碰它才算第二次。
 * 因此本模块的唯一时间原语是「本地日历日键」，而不是时间差。
 *
 * 约束：
 * - 零平台依赖：不调用系统时钟，也不读宿主时区。nowMs 与 tzOffsetMin 一律由调用方传入
 *   （tzOffsetMin = -new Date().getTimezoneOffset()，UTC+8 为 +480）。
 * - 不可变：recordEffectiveReview 返回新 Card / 新 SRSState / 新 days 数组，绝不改动入参。
 * - 域外输入防御：存档可能携带脏 days 或非有限时间戳，一律消毒回落，输出永不含 NaN，永不抛异常。
 */

import type { Card, SRSState } from './types';

/** 账本滚动上限：保留最近 400 个日历日（约一年余），超出即丢弃最旧条目。 */
export const MAX_EFFECTIVE_DAYS = 400;

/** 合法日历日键的形状：YYYY-MM-DD，月/日零填充。用于甄别外部数据。
 *  （Task 6 R-T6-c 起导出：saveMigrate 校验器复用同一口径，避免双份定义漂移。） */
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 任意数值的时间戳校验：非有限（NaN/±Infinity）或类型不符回落 0。 */
function timeOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Number.isFinite(fallback) ? fallback : 0;
}

/** 偏移分钟校验：非有限回落 0（视作 UTC）。允许负值（UTC−x 一侧）。 */
function offsetOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 由时间戳 + 分钟偏移得到本地日历日键 `YYYY-MM-DD`。
 *
 * 实现要点：把「本地墙上时间」平移到同一瞬间的 UTC 表示，再用 toISOString 切片取日期。
 * 全程只用 UTC getter，不触碰宿主的本地时区设置——偏移完全由入参决定。
 * 跨午夜的两次打卡因此必然落到两个键上（Review Focus #1）。
 */
export function localDayString(nowMs: number, tzOffsetMin: number): string {
  const t = timeOr(nowMs, 0);
  const shifted = t + offsetOr(tzOffsetMin) * 60_000;
  // shifted 溢出到 Date 可表示范围之外时，toISOString 会抛 RangeError；
  // 这里钳制到安全区间，保证「永不抛异常」。
  const SAFE_MAX = 8_640_000_000_000_000;
  const clamped = Math.max(-SAFE_MAX, Math.min(SAFE_MAX, shifted));
  return new Date(clamped).toISOString().slice(0, 10);
}

/** 升序、去重、裁剪到最近 MAX_EFFECTIVE_DAYS 条。纯函数，不改入参数组。 */
function normalizeDays(days: readonly string[]): string[] {
  const unique = Array.from(new Set(days));
  unique.sort(); // YYYY-MM-DD 定长零填充 → 字典序即时间序
  const overflow = unique.length - MAX_EFFECTIVE_DAYS;
  return overflow > 0 ? unique.slice(overflow) : unique;
}

/** 消毒外部传入的 days 集：剔除非字符串、非日历日形状的条目。 */
function sanitizeDays(days: unknown): string[] {
  if (!Array.isArray(days)) return [];
  return days.filter((d): d is string => typeof d === 'string' && DAY_KEY_RE.test(d));
}

/**
 * 记一次有效复习：若当日不在 effectiveReviewDays 则追加，返回新 Card。
 *
 * 同日重复调用结果不变（幂等，Review Focus #5）；入参与其 srs、days 数组均不被改动。
 * 除 days 之外的字段原样透传——本函数只管记账，不碰 SM-2 状态。
 *
 * 本字段唯一写入者（R-T4-c）：sm2.review 只透传不追加，日键一律由本函数按本地日历产生，
 * 因此 Boss 计数在任意时区下都不会被同日双计。
 * 消毒写回（I-1）：只要剔过非法条目就强制写回，即使归一化后内容与入参逐项相等——
 * 对同一存档形态必须给出确定行为，不把清洗责任推给存档校验层。
 */
export function recordEffectiveReview(card: Card, nowMs: number, tzOffsetMin: number): Card {
  if (card == null || typeof card !== 'object') return card;
  const key = localDayString(nowMs, tzOffsetMin);
  const raw = card.srs?.effectiveReviewDays;
  const cur = sanitizeDays(raw);
  // 原始数组里被消毒剔掉过条目 → 无论内容是否等价都必须写回，否则垃圾永久留在账本上、
  // 持续给 Boss 计数灌水（I-1）。长度比对即可判定：sanitizeDays 只做过滤，不增不减合法项。
  const sanitizedAway = Array.isArray(raw) && raw.length !== cur.length;
  if (cur.includes(key)) {
    // 已记过：归一化以修复存档里的乱序/重复/超长；仅当「既没消毒掉东西、也没归一化改动」
    // 时才复用入参引用（供上层脏检查短路）。
    const normalized = normalizeDays(cur);
    if (!sanitizedAway && sameSequence(normalized, cur)) return card;
    return { ...card, srs: { ...(card.srs as SRSState), effectiveReviewDays: normalized } };
  }
  const srs: SRSState = {
    ...(card.srs as SRSState),
    effectiveReviewDays: normalizeDays([...cur, key]),
  };
  return { ...card, srs };
}

/** 长度与逐项是否完全一致（用于避免无谓的对象分配）。 */
function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 领域总有效复习数 = Σ 每张卡的 effectiveReviewDays.length。 */
export function domainReviewCount(deckCards: Card[]): number {
  if (!Array.isArray(deckCards)) return 0;
  let total = 0;
  for (const c of deckCards) {
    const days = c?.srs?.effectiveReviewDays;
    if (Array.isArray(days)) total += days.length;
  }
  return total;
}

/**
 * 卷灵是否已被唤醒。threshold 取自 Settings.bossThresholdTier（15|30|50）。
 * count ≥ threshold 即为 true；非法阈值保守地判为未触发。
 */
export function bossReady(deckCards: Card[], threshold: 15 | 30 | 50): boolean {
  // 阈值必须是有限非负数；NaN / ±Infinity / 负数 / 非数值一律判为未触发。
  // 注意不能复用 timeOr 之类的「回落」写法：把非法值回落成 0 会让 count >= 0 恒真，
  // Boss 凭空现身——这里保守失败比误唤醒更合适。
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) return false;
  return domainReviewCount(deckCards) >= threshold;
}
