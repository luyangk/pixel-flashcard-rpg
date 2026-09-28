/**
 * quota.ts —— Plan 6 · T4：LLM 用量两本账（纯编排，无副作用）。
 *
 * ## 为什么是"两本账"，为什么放在 app 层
 * - **新知识（卡）200 张/天**：采新卡与卡组页的「AI 辅建卡」**共用这一本**（D45）——
 *   两者都在让模型造新卡、都在花玩家的钱，分开记等于给闸门留一个绕开的入口。
 * - **问答判定 300 次/天**：另一本。判定是每张卡一次的小请求，量级差得远，
 *   混在一起会让"今天还能生成几张"变得没法解释。
 * 两本账的**计数**存在存档（`settings.llmQuota`），本模块只负责"读时判定 + 发放"：
 * 不读时钟（`nowMs`/`tzOffsetMin` 全由调用方注入）、不写存档、不装定时器。
 *
 * ## 为什么"读时归零"
 * 跨天靠比较本地日界键，而不是定时器清零 —— 手机上页面经常整夜挂着不刷新，
 * 定时器/启动时清零都会出现"明明过了午夜却还说额度用完"。读时判定没有这个缝。
 *
 * ## 为什么到顶要"拒绝"而不是"截断"
 * 额度是对玩家的承诺（"一天 200 张"）。悄悄只给一部分、还报成功，是承诺说谎：
 * 调用方据 `granted/refused` 如实告诉玩家"今天只剩 3 张，剩下 17 张明天再来"。
 */
import type { LlmQuota } from '@core/types';
import { localDayString } from '@core/reviewLedger';

/** 每天可生成的新知识卡上限（含 AI 辅建卡，合并记账）。 */
export const DAILY_CARD_CAP = 200;
/** 单次生成的卡数上限（与 core/llmParse 的 CARDS_MAX 同量级；长文分块后仍封顶）。 */
export const PER_REQUEST_CARD_CAP = 20;
/** 每天问答判定的次数上限（到顶回落成玩家自评，不锁复习）。 */
export const DAILY_JUDGE_CAP = 300;

/** 非负整数消毒：负数/小数/NaN/非数值一律回落 0，输出永不含 NaN。 */
function nonNegInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/** 目标张数消毒：非有限/负数 ⇒ 0；先夹单次上限（整数）。 */
function wantedCards(want: unknown): number {
  if (typeof want !== 'number' || !Number.isFinite(want) || want <= 0) return 0;
  return Math.min(Math.floor(want), PER_REQUEST_CARD_CAP);
}

/**
 * 把存档里的额度读成"今天的账"：日界不同 ⇒ 两本账都归零；脏值就地消毒。
 * **不改入参**（返回新对象）。
 */
export function normalizeQuota(
  q: LlmQuota | undefined,
  nowMs: number,
  tzOffsetMin: number,
): LlmQuota {
  const today = localDayString(nowMs, tzOffsetMin);
  const day = q && typeof q.day === 'string' ? q.day : '';
  if (day !== today) return { day: today, cards: 0, judges: 0 };
  return { day: today, cards: nonNegInt(q?.cards), judges: nonNegInt(q?.judges) };
}

/** 今天还能生成几张新卡。 */
export function remainingCards(q: LlmQuota | undefined, nowMs: number, tzOffsetMin: number): number {
  const now = normalizeQuota(q, nowMs, tzOffsetMin);
  return Math.max(0, DAILY_CARD_CAP - now.cards);
}

/** 今天还能判定几次问答。 */
export function remainingJudges(q: LlmQuota | undefined, nowMs: number, tzOffsetMin: number): number {
  const now = normalizeQuota(q, nowMs, tzOffsetMin);
  return Math.max(0, DAILY_JUDGE_CAP - now.judges);
}

/**
 * 申请生成 `want` 张卡：先夹单次上限，再按当日余额发放。
 * 返回**尚未落盘**的新账（由装配层写回存档）与 `granted/refused` 两个可上屏的数。
 */
export function planCharge(
  q: LlmQuota | undefined,
  want: unknown,
  nowMs: number,
  tzOffsetMin: number,
): { readonly quota: LlmQuota; readonly granted: number; readonly refused: number } {
  const now = normalizeQuota(q, nowMs, tzOffsetMin);
  // 两级夹：① 单次上限（决定这次最多生成几张）② 当日余额（决定今天还能不能生成）。
  const asked = wantedCards(want);
  const rawWant = typeof want === 'number' && Number.isFinite(want) && want > 0 ? Math.floor(want) : 0;
  const left = Math.max(0, DAILY_CARD_CAP - now.cards);
  const granted = Math.min(asked, left);
  // refused 报的是**相对玩家原始要求**没拿到的数量（"你要 50 张，只给了 20"），便于如实上屏
  const refused = Math.max(0, rawWant - granted);
  return {
    quota: { day: now.day, cards: now.cards + granted, judges: now.judges },
    granted,
    refused,
  };
}

/**
 * 申请一次问答判定：到顶即拒（`allowed:false` 且**账目不动** —— 先加再判会让第 301 次
 * 白白吃掉一次额度）。调用方据 `allowed` 决定"让 AI 判"还是"回落玩家自评"。
 */
export function planJudge(
  q: LlmQuota | undefined,
  nowMs: number,
  tzOffsetMin: number,
): { readonly quota: LlmQuota; readonly allowed: boolean } {
  const now = normalizeQuota(q, nowMs, tzOffsetMin);
  if (now.judges >= DAILY_JUDGE_CAP) return { quota: now, allowed: false };
  return { quota: { day: now.day, cards: now.cards, judges: now.judges + 1 }, allowed: true };
}
