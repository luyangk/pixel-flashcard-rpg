import { describe, expect, it } from 'vitest';
import type { Card, SRSState } from '@core/types';
import {
  bossReady,
  domainReviewCount,
  localDayString,
  MAX_EFFECTIVE_DAYS,
  recordEffectiveReview,
} from '@core/reviewLedger';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const TZ = 480; // UTC+8：调用方传 new Date().getTimezoneOffset() 的相反数

/** 本地（UTC+8）日历时刻 → 毫秒戳。month 为 1-12，hour/min 为该时区下的墙上时间。 */
function atTZ(year: number, month: number, day: number, hour = 0, min = 0): number {
  return Date.UTC(year, month - 1, day, hour, min) - TZ * MIN;
}

// 锚点：本地 2025-11-01 00:00（= 2025-10-31T16:00Z）。用 UTC 日键会差一天。
const T0 = atTZ(2025, 11, 1);

/** 构造带任意 effectiveReviewDays 的卡。 */
function card(id: string, days: string[] = [], over: Partial<SRSState> = {}): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 1,
    reps: 1,
    lapses: 0,
    due: T0,
    stability: 'review',
    effectiveReviewDays: days,
    ...over,
  };
  return { id, deckId: 'deck-a', front: 'f', back: 'b', srs, tags: [] };
}

describe('localDayString —— 日历日口径（Review Focus #1）', () => {
  it('同一本地日内两次取值同键；跨午夜即换键', () => {
    expect(localDayString(T0, TZ)).toBe('2025-11-01');
    expect(localDayString(T0 + 23 * HOUR + 59 * MIN, TZ)).toBe('2025-11-01');
    expect(localDayString(T0 + DAY, TZ)).toBe('2025-11-02');
  });

  it('23:59 与次日 00:01 判为不同日历日（tzOffset=480）', () => {
    const beforeMidnight = atTZ(2025, 11, 1, 23, 59); // 2025-11-01T15:59Z
    const afterMidnight = atTZ(2025, 11, 2, 0, 1); // 2025-11-01T16:01Z
    expect(afterMidnight - beforeMidnight).toBe(2 * MIN); // 仅隔两分钟
    const d1 = localDayString(beforeMidnight, TZ);
    const d2 = localDayString(afterMidnight, TZ);
    expect(d1).toBe('2025-11-01');
    expect(d2).toBe('2025-11-02');
    expect(d1).not.toBe(d2);
    // 反证：若按 UTC 日键切，这两个戳会落在同一天——正是 Boss 计数的误判来源。
    expect(new Date(beforeMidnight).toISOString().slice(0, 10)).toBe(
      new Date(afterMidnight).toISOString().slice(0, 10),
    );
  });

  it('输出零填充 YYYY-MM-DD，含月/年边界进位', () => {
    expect(localDayString(atTZ(2026, 1, 1, 0, 0), TZ)).toBe('2026-01-01');
    expect(localDayString(atTZ(2025, 12, 31, 23, 59), TZ)).toBe('2025-12-31');
    expect(localDayString(atTZ(2026, 3, 1, 0, 0), TZ)).toBe('2026-03-01');
    expect(localDayString(T0, TZ)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('偏移方向符合 getTimezoneOffset 约定：UTC−5 取 −300', () => {
    const utcNoon = Date.UTC(2025, 10, 1, 12, 0); // 2025-11-01T12:00Z
    expect(localDayString(utcNoon, -300)).toBe('2025-11-01'); // 当地 07:00
    expect(localDayString(utcNoon, 0)).toBe('2025-11-01');
    const lateUtc = Date.UTC(2025, 10, 1, 23, 30); // 2025-11-01T23:30Z
    expect(localDayString(lateUtc, TZ)).toBe('2025-11-02'); // 当地已是次日 07:30
    expect(localDayString(lateUtc, -300)).toBe('2025-11-01'); // 当地 18:30
  });

  it('非有限入参回落为确定值，不抛异常、不产出 NaN', () => {
    expect(() => localDayString(Number.NaN, TZ)).not.toThrow();
    expect(localDayString(Number.NaN, TZ)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localDayString(T0, Number.NaN)).toBe(localDayString(T0, 0));
    expect(localDayString(T0, Number.POSITIVE_INFINITY)).toBe(localDayString(T0, 0));
    expect(localDayString(T0, undefined as unknown as number)).toBe(localDayString(T0, 0));
  });
});

describe('recordEffectiveReview —— 同日幂等（Review Focus #5）', () => {
  it('同日两次 record 计数仍为 1', () => {
    const once = recordEffectiveReview(card('c1'), T0 + HOUR, TZ);
    const twice = recordEffectiveReview(once, T0 + 5 * HOUR, TZ);
    expect(twice.srs.effectiveReviewDays).toEqual(['2025-11-01']);
    expect(domainReviewCount([twice])).toBe(1);
  });

  it('同 deck 同 day 反复 record 结果不变（幂等，含乱序输入）', () => {
    const base = card('c1', ['2025-10-30', '2025-11-01']);
    const a = recordEffectiveReview(base, atTZ(2025, 11, 1, 9, 0), TZ);
    const b = recordEffectiveReview(a, atTZ(2025, 11, 1, 23, 59), TZ);
    const c = recordEffectiveReview(b, atTZ(2025, 10, 30, 0, 0), TZ);
    expect(c.srs.effectiveReviewDays).toEqual(a.srs.effectiveReviewDays);
    expect(c.srs.effectiveReviewDays).toEqual(['2025-10-30', '2025-11-01']);
  });

  it('跨日 +1', () => {
    const one = recordEffectiveReview(card('c1'), T0, TZ);
    const two = recordEffectiveReview(one, T0 + DAY, TZ);
    expect(two.srs.effectiveReviewDays).toEqual(['2025-11-01', '2025-11-02']);
    expect(domainReviewCount([two])).toBe(2);
    expect(recordEffectiveReview(two, T0 + 2 * DAY, TZ).srs.effectiveReviewDays).toHaveLength(3);
  });

  it('乱序 days 数组经 record 后仍升序且去重', () => {
    const messy = card('c1', [
      '2025-11-03',
      '2025-11-01',
      '2025-11-02',
      '2025-11-01', // 存档里已有的重复项
      '2025-10-31',
    ]);
    const out = recordEffectiveReview(messy, atTZ(2025, 11, 2, 12, 0), TZ);
    expect(out.srs.effectiveReviewDays).toEqual([
      '2025-10-31',
      '2025-11-01',
      '2025-11-02',
      '2025-11-03',
    ]);
    const sorted = [...out.srs.effectiveReviewDays].sort();
    expect(out.srs.effectiveReviewDays).toEqual(sorted);
  });

  it('上限滚动保留最近 400 条，丢弃最旧', () => {
    const days: string[] = [];
    for (let i = 0; i < MAX_EFFECTIVE_DAYS; i++) {
      days.push(localDayString(atTZ(2024, 1, 1) + i * DAY, TZ));
    }
    expect(days).toHaveLength(400);
    const oldest = days[0];
    const newest = days[days.length - 1];
    const out = recordEffectiveReview(card('c1', days), atTZ(2025, 3, 1, 8, 0), TZ);
    expect(out.srs.effectiveReviewDays).toHaveLength(MAX_EFFECTIVE_DAYS);
    expect(out.srs.effectiveReviewDays).not.toContain(oldest);
    expect(out.srs.effectiveReviewDays).toContain(newest);
    expect(out.srs.effectiveReviewDays[out.srs.effectiveReviewDays.length - 1]).toBe('2025-03-01');
    const sorted = [...out.srs.effectiveReviewDays].sort();
    expect(out.srs.effectiveReviewDays).toEqual(sorted);
    // 已满且当日已记录 → 长度不变（不会因裁剪而抖动）
    const again = recordEffectiveReview(out, atTZ(2025, 3, 1, 20, 0), TZ);
    expect(again.srs.effectiveReviewDays).toEqual(out.srs.effectiveReviewDays);
  });

  it('同日重复 record 返回同一引用（幂等，供上层做缓存/脏检查）', () => {
    const once = recordEffectiveReview(card('c1'), T0 + HOUR, TZ);
    expect(recordEffectiveReview(once, T0 + 5 * HOUR, TZ)).toBe(once);
    // 已归一化的干净账本，重复记账不产生新对象
    const clean = card('c2', ['2025-10-30', '2025-11-01']);
    expect(recordEffectiveReview(clean, atTZ(2025, 11, 1, 23, 59), TZ)).toBe(clean);
  });

  it('同日路径也写回消毒结果：脏账本不被灌水（I-1）', () => {
    // 存档里混入三条非法条目 + 一条合法且正是今天。同日 record 命中「已记过」分支，
    // 若该分支只比内容不查消毒痕迹，垃圾会被原样留在账本上、把 Boss 计数灌水。
    const dirty = card('c1', ['garbage', '', 'junk', '2025-11-01']);
    expect(domainReviewCount([dirty])).toBe(4); // 污染态：length 虚高为 4
    const out = recordEffectiveReview(dirty, atTZ(2025, 11, 1, 9, 0), TZ);
    expect(out.srs.effectiveReviewDays).toEqual(['2025-11-01']); // 垃圾被洗掉
    expect(domainReviewCount([out])).toBe(1); // 计数回到正确值
    expect(out).not.toBe(dirty); // 必须写回，不能因「内容等价」而早退
  });

  it('同日与换日两条路径对同一脏输入产生相同 domainReviewCount（I-1）', () => {
    const junk = ['garbage', '', 'junk', '2025-11-01'];
    const sameDay = recordEffectiveReview(card('a', [...junk]), atTZ(2025, 11, 1, 9, 0), TZ);
    const nextDay = recordEffectiveReview(card('b', [...junk]), atTZ(2025, 11, 2, 9, 0), TZ);
    // 同日：只剩消毒后的 1 条；换日：消毒后 1 条 + 新的一天 = 2 条
    expect(domainReviewCount([sameDay])).toBe(1);
    expect(nextDay.srs.effectiveReviewDays).toEqual(['2025-11-01', '2025-11-02']);
    // 关键一致性：两路径产出的数组都不含任何垃圾条目，且都已升序去重
    for (const c of [sameDay, nextDay]) {
      expect(c.srs.effectiveReviewDays.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
      expect(new Set(c.srs.effectiveReviewDays).size).toBe(c.srs.effectiveReviewDays.length);
    }
    // 干净账本走同日路径仍保持引用相等（不因 I-1 修复而抖动）
    const clean = card('c', ['2025-11-01']);
    expect(recordEffectiveReview(clean, atTZ(2025, 11, 1, 23, 59), TZ)).toBe(clean);
  });

  it('不改入参：返回新对象与新数组', () => {
    const days = ['2025-10-30'];
    const input = card('c1', days);
    const snapshot = JSON.parse(JSON.stringify(input)) as Card;
    const out = recordEffectiveReview(input, T0, TZ);
    expect(input).toEqual(snapshot);
    expect(days).toEqual(['2025-10-30']);
    expect(out).not.toBe(input);
    expect(out.srs).not.toBe(input.srs);
    expect(out.srs.effectiveReviewDays).not.toBe(input.srs.effectiveReviewDays);
    // 其余字段原样透传
    expect(out.id).toBe(input.id);
    expect(out.deckId).toBe(input.deckId);
    expect(out.front).toBe(input.front);
    expect(out.back).toBe(input.back);
    expect(out.tags).toBe(input.tags);
    expect(out.source).toBeUndefined();
    expect(out.srs.ease).toBe(input.srs.ease);
    expect(out.srs.due).toBe(input.srs.due);
    expect(out.srs.stability).toBe(input.srs.stability);
  });

  it('域外输入不炸：坏 days / 缺失 srs / NaN 时间戳均回落为合法态', () => {
    const hostile = card('c1', undefined as unknown as string[]);
    expect(() => recordEffectiveReview(hostile, T0, TZ)).not.toThrow();
    expect(recordEffectiveReview(hostile, T0, TZ).srs.effectiveReviewDays).toEqual(['2025-11-01']);

    const junk = card('c1', [null, '', 'x', '2025-11-02'] as unknown as string[]);
    expect(recordEffectiveReview(junk, atTZ(2025, 11, 3), TZ).srs.effectiveReviewDays).toEqual([
      '2025-11-02',
      '2025-11-03',
    ]);

    const noSrs = { id: 'n', deckId: 'd', front: 'f', back: 'b', tags: [] } as unknown as Card;
    expect(recordEffectiveReview(noSrs, T0, TZ).srs.effectiveReviewDays).toEqual(['2025-11-01']);

    const nanOut = recordEffectiveReview(card('c1'), Number.NaN, TZ);
    expect(nanOut.srs.effectiveReviewDays).toHaveLength(1);
    expect(nanOut.srs.effectiveReviewDays[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(recordEffectiveReview(null as unknown as Card, T0, TZ)).toBeNull();
  });
});

describe('domainReviewCount', () => {
  it('Σ 每张卡的 effectiveReviewDays.length', () => {
    const a = card('a', ['2025-11-01', '2025-11-02']);
    const b = card('b', ['2025-11-01']);
    const c = card('c', []);
    expect(domainReviewCount([a, b, c])).toBe(3);
  });

  it('空牌组为 0；缺字段/脏数据按 0 计', () => {
    expect(domainReviewCount([])).toBe(0);
    expect(domainReviewCount(undefined as unknown as Card[])).toBe(0);
    const dirty = card('d', undefined as unknown as string[]);
    expect(domainReviewCount([dirty, null as unknown as Card])).toBe(0);
  });

  it('同一张卡重复出现在数组中会重复计入（调用方负责传入唯一集合）', () => {
    const a = card('a', ['2025-11-01']);
    expect(domainReviewCount([a, a])).toBe(2);
  });
});

describe('bossReady —— 阈值边界', () => {
  /** 造 n 个不同日历日的有效复习（单卡）。 */
  function cardsWithDays(n: number): Card[] {
    const days: string[] = [];
    for (let i = 0; i < n; i++) days.push(localDayString(T0 + i * DAY, TZ));
    return [card('solo', days)];
  }

  it('count = threshold−1 为 false，count = threshold 为 true', () => {
    for (const t of [15, 30, 50] as const) {
      expect(domainReviewCount(cardsWithDays(t - 1))).toBe(t - 1);
      expect(bossReady(cardsWithDays(t - 1), t)).toBe(false);
      expect(bossReady(cardsWithDays(t), t)).toBe(true);
      expect(bossReady(cardsWithDays(t + 1), t)).toBe(true);
    }
  });

  it('阈值 0 恒为 ready；空牌组在未触发档为 false', () => {
    expect(bossReady([], 0 as 15)).toBe(true);
    expect(bossReady([], 15)).toBe(false);
    expect(bossReady([], 50)).toBe(false);
  });

  it('非法 threshold 保守回落为不触发', () => {
    const many = cardsWithDays(400);
    expect(bossReady(many, Number.NaN as unknown as 15)).toBe(false);
    expect(bossReady(many, -5 as unknown as 15)).toBe(false);
    expect(bossReady(many, undefined as unknown as 15)).toBe(false);
  });

  it('跨卡累计（领域总量，而非单卡最高）驱动触发', () => {
    const half = 8;
    const a = card('a', Array.from({ length: half }, (_, i) => localDayString(T0 + i * DAY, TZ)));
    const b = card('b', Array.from({ length: half }, (_, i) => localDayString(T0 + i * DAY, TZ)));
    expect(domainReviewCount([a, b])).toBe(16);
    expect(bossReady([a], 15)).toBe(false);
    expect(bossReady([a, b], 15)).toBe(true);
  });
});

describe('与 sm2.review 的组合语义（跨模块日键边界）', () => {
  it('本地午夜前 1 分钟 review + 午夜后 record：两个模块给出不同日历日', async () => {
    const { review, createInitialSRS, GRADES } = await import('@core/sm2');
    const p = { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 };
    const beforeMidnight = atTZ(2025, 11, 1, 23, 59); // 2025-11-01T15:59Z
    const afterMidnight = atTZ(2025, 11, 2, 0, 1); // 2025-11-01T16:01Z

    const start = card('c1', []);
    const srs = review(start.srs, GRADES.good, beforeMidnight, p);
    expect(srs.effectiveReviewDays).toEqual(['2025-11-01']); // sm2 的 UTC 日键在此恰好一致

    const recorded = recordEffectiveReview({ ...start, srs }, afterMidnight, TZ);
    // 本模块按本地日判为次日，故追加；sm2 若在同一瞬间记录会给 '2025-11-01'。
    expect(recorded.srs.effectiveReviewDays).toEqual(['2025-11-01', '2025-11-02']);
  });

  it('已知边界：sm2 用 UTC 日键，UTC+8 的 00:00–08:00 会记成前一天（统一口径待裁决）', async () => {
    const { review, GRADES } = await import('@core/sm2');
    const p = { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 };
    const earlyMorning = atTZ(2025, 11, 1, 3, 0); // 本地 03:00 = 2025-10-31T19:00Z
    const srs = review(card('c1', []).srs, GRADES.good, earlyMorning, p);
    expect(srs.effectiveReviewDays).toEqual(['2025-10-31']); // sm2 的 UTC 视角
    expect(localDayString(earlyMorning, TZ)).toBe('2025-11-01'); // 本模块的本地视角
    // 事实锁定（非期望不变量）：同一瞬间两个模块相差一天。
    // 后果：上层若对一次复习既调 sm2.review 又调 recordEffectiveReview，
    // 在本地 00:00–08:00 窗口内（占一天 33%）会把同一天计成两天，Boss 提前现身。
    // 修法属跨任务决策——改 sm2.dayKey 会动已交付的 Task 3 行为与其测试锚点
    // （sm2.test.ts 的 T0 恰为 UTC 午夜），故留给 controller 裁决，见 task-4-report.md。
  });

  it('同一 tzOffset 下连续两次 record 恒幂等（账本自身不依赖 sm2）', () => {
    let c = card('c1', []);
    for (let i = 0; i < 5; i++) c = recordEffectiveReview(c, T0 + i * HOUR, TZ);
    expect(c.srs.effectiveReviewDays).toEqual(['2025-11-01']);
  });
});


