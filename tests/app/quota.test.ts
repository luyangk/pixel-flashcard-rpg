/**
 * tests/app/quota.test.ts —— Plan 6 · T4：LLM 用量两本账（新知识 200 张/天、问答判定 300 次/天）。
 *
 * 判别力（每条都写清"坏实现为何必红"）：
 * - Q#2/Q#3 **到顶就是到顶**：把 `granted` 算成 `want`（或忽略上限）的实现必红——
 *   额度是给玩家的承诺（"一天 200 张"），算错等于承诺说谎；
 * - Q#5 **跨天读时归零**：靠定时器/启动时清零的实现在"整夜挂着页面"或"跨天不重启"时必红
 *   （本模块不读时钟、不装定时器，日期由入参给）；
 * - Q#6 脏值消毒：存档来自用户设备，`cards: -5` / `1.5` / `NaN` 都要按 0 处理且输出永不含 NaN；
 * - Q#7 `planJudge` 第 301 次**拒绝且不改账**（先加再判、或加了才发现超限的实现必红）；
 * - Q#9 日界跟随时区入参（用宿主本地时区的实现会在 UTC+8 的跨午夜时刻算错）。
 */
import { describe, expect, it } from 'vitest';
import type { LlmQuota } from '@core/types';
import { localDayString } from '@core/reviewLedger';
import {
  DAILY_CARD_CAP,
  DAILY_JUDGE_CAP,
  PER_REQUEST_CARD_CAP,
  normalizeQuota,
  planCharge,
  planJudge,
  remainingCards,
  remainingJudges,
} from '../../src/app/quota';

/** 2026-10-01 12:00 UTC+8（= 04:00Z）——与日界测试同一个基准时刻。 */
const NOON_CST = Date.UTC(2026, 9, 1, 4, 0, 0);
const TZ_CST = 480; // UTC+8
const TZ_UTC = 0;

function quota(over: Partial<LlmQuota> = {}): LlmQuota {
  return { day: localDayString(NOON_CST, TZ_CST), cards: 0, judges: 0, ...over };
}

describe('quota —— 常量与余额', () => {
  it('Q#1 上限值与口径常量（200 张/天、单次 20 张、判定 300 次/天）', () => {
    expect(DAILY_CARD_CAP).toBe(200);
    expect(PER_REQUEST_CARD_CAP).toBe(20);
    expect(DAILY_JUDGE_CAP).toBe(300);
  });

  it('Q#1b 空额度 ⇒ 两本账都是满的', () => {
    expect(remainingCards(undefined, NOON_CST, TZ_CST)).toBe(DAILY_CARD_CAP);
    expect(remainingJudges(undefined, NOON_CST, TZ_CST)).toBe(DAILY_JUDGE_CAP);
  });

  it('Q#2 当天已用满 ⇒ 余额 0，且申请一律被拒', () => {
    const q = quota({ cards: DAILY_CARD_CAP, judges: DAILY_JUDGE_CAP });
    expect(remainingCards(q, NOON_CST, TZ_CST)).toBe(0);
    expect(remainingJudges(q, NOON_CST, TZ_CST)).toBe(0);
    const charged = planCharge(q, 10, NOON_CST, TZ_CST);
    expect(charged.granted).toBe(0);
    expect(charged.refused).toBe(10);
    expect(charged.quota.cards).toBe(DAILY_CARD_CAP); // 被拒时账目不动
    expect(planJudge(q, NOON_CST, TZ_CST).allowed).toBe(false);
  });

  it('Q#3 余额只剩 3 而要 20 ⇒ granted 3 / refused 17（账目精确到 3）', () => {
    const q = quota({ cards: DAILY_CARD_CAP - 3 });
    const charged = planCharge(q, 20, NOON_CST, TZ_CST);
    expect(charged.granted).toBe(3);
    expect(charged.refused).toBe(17);
    expect(charged.quota.cards).toBe(DAILY_CARD_CAP);
    expect(remainingCards(charged.quota, NOON_CST, TZ_CST)).toBe(0);
  });

  it('Q#4 申请 50 张 ⇒ 先夹到单次上限 20，再按余额给', () => {
    const fresh = planCharge(quota(), 50, NOON_CST, TZ_CST);
    expect(fresh.granted).toBe(PER_REQUEST_CARD_CAP);
    expect(fresh.refused).toBe(50 - PER_REQUEST_CARD_CAP);
    const tight = planCharge(quota({ cards: DAILY_CARD_CAP - 5 }), 50, NOON_CST, TZ_CST);
    expect(tight.granted).toBe(5);
    expect(tight.refused).toBe(50 - 5);
  });

  it('Q#5 跨天（day 是昨天）⇒ 两本账都归零，不是只归零一本', () => {
    const yesterday = quota({ day: localDayString(NOON_CST - 86_400_000, TZ_CST), cards: 200, judges: 300 });
    const now = normalizeQuota(yesterday, NOON_CST, TZ_CST);
    expect(now.cards).toBe(0);
    expect(now.judges).toBe(0);
    expect(now.day).toBe(localDayString(NOON_CST, TZ_CST));
    expect(remainingCards(yesterday, NOON_CST, TZ_CST)).toBe(DAILY_CARD_CAP);
    expect(planJudge(yesterday, NOON_CST, TZ_CST).allowed).toBe(true);
  });

  it('Q#6 脏值消毒：负数/小数/NaN/空 day 一律按 0 与今天处理，输出永不含 NaN', () => {
    const dirty = { day: '', cards: -5, judges: Number.NaN } as unknown as LlmQuota;
    const now = normalizeQuota(dirty, NOON_CST, TZ_CST);
    expect(now.cards).toBe(0);
    expect(now.judges).toBe(0);
    expect(now.day).toBe(localDayString(NOON_CST, TZ_CST));

    const fractional = normalizeQuota({ day: now.day, cards: 1.5, judges: 2.7 } as LlmQuota, NOON_CST, TZ_CST);
    expect(fractional.cards).toBe(1);
    expect(fractional.judges).toBe(2);

    // Infinity 也按 0 处理：这本账是**本地成本闸**，不是安全边界 —— 计数器读不出来时
    // 不应该把功能锁死（fail-open），跨天还会自然归零。故这里是"给 5 张"而不是"给 0 张"。
    const absurd = planCharge({ day: now.day, cards: Number.POSITIVE_INFINITY, judges: 0 } as LlmQuota, 5, NOON_CST, TZ_CST);
    expect(Number.isFinite(absurd.quota.cards)).toBe(true);
    expect(absurd.granted).toBe(5);
  });

  it('Q#7 planJudge 第 300 次允许、第 301 次拒绝且账目不动', () => {
    let q: LlmQuota = quota({ judges: DAILY_JUDGE_CAP - 1 });
    const last = planJudge(q, NOON_CST, TZ_CST);
    expect(last.allowed).toBe(true);
    expect(last.quota.judges).toBe(DAILY_JUDGE_CAP);
    q = last.quota;
    const over = planJudge(q, NOON_CST, TZ_CST);
    expect(over.allowed).toBe(false);
    expect(over.quota).toEqual(q); // 被拒时不 +1（先加再判的实现必红）
  });

  it('Q#8 纯函数：同入参同结果，且不改动入参对象', () => {
    const q = quota({ cards: 7, judges: 9 });
    const snapshot = JSON.stringify(q);
    const a = planCharge(q, 4, NOON_CST, TZ_CST);
    const b = planCharge(q, 4, NOON_CST, TZ_CST);
    expect(a).toEqual(b);
    expect(JSON.stringify(q)).toBe(snapshot);
    expect(a.quota).not.toBe(q); // 返回新对象
    const j = planJudge(q, NOON_CST, TZ_CST);
    expect(JSON.stringify(q)).toBe(snapshot);
    expect(j.quota).not.toBe(q);
  });

  it('Q#9 日界跟随时区入参：同一时刻在两个时区可属不同的一天', () => {
    // 2026-09-30 23:30 UTC+8 = 2026-09-30 15:30Z（UTC 仍是 9-30）；再看 UTC+8 的次日 00:30
    const justBeforeMidnightCst = Date.UTC(2026, 9, 1, 15, 30, 0); // 2026-10-01 23:30 CST
    const justAfterMidnightCst = Date.UTC(2026, 9, 1, 16, 30, 0); // 2026-10-02 00:30 CST
    expect(localDayString(justBeforeMidnightCst, TZ_CST)).toBe('2026-10-01');
    expect(localDayString(justAfterMidnightCst, TZ_CST)).toBe('2026-10-02');
    // 同一份"昨天用满"的账：UTC+8 已跨天（归零），UTC 视角还没跨天
    const q: LlmQuota = { day: '2026-10-01', cards: DAILY_CARD_CAP, judges: DAILY_JUDGE_CAP };
    expect(remainingCards(q, justAfterMidnightCst, TZ_CST)).toBe(DAILY_CARD_CAP);
    expect(remainingCards(q, justAfterMidnightCst, TZ_UTC)).toBe(0);
  });

  it('Q#10 非法 want（负数 / NaN / 非整数）⇒ 不发放也不崩', () => {
    for (const want of [-3, Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      const charged = planCharge(quota(), want as number, NOON_CST, TZ_CST);
      expect(Number.isFinite(charged.granted)).toBe(true);
      expect(charged.granted).toBeGreaterThanOrEqual(0);
      expect(charged.granted).toBeLessThanOrEqual(PER_REQUEST_CARD_CAP);
      expect(charged.quota.cards).toBeGreaterThanOrEqual(0);
    }
  });
});
