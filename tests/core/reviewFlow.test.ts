/**
 * reviewFlow.applyReview —— R-T4-d 端到端契约：「走完一次复习 → Boss 计数恰 +1」。
 * 从此 UI/战斗层只经这一个门写账本。
 */
import { describe, expect, it } from 'vitest';
import type { Card, Sm2Params, SRSState } from '@core/types';
import { GRADES, review } from '@core/sm2';
import { domainReviewCount, localDayString } from '@core/reviewLedger';
import { applyReview } from '@core/reviewFlow';

const DAY = 86_400_000;
const MIN = 60_000;
const TZ = 480; // UTC+8：tzOffsetMin = -getTimezoneOffset()

const P: Sm2Params = {
  initialEase: 2.5,
  minEase: 1.3,
  firstInterval: 10 / 60,
  secondInterval: 6,
};

/** 本地（UTC+8）日历时刻 → 毫秒戳。 */
function atTZ(year: number, month: number, day: number, hour = 0, min = 0): number {
  return Date.UTC(year, month - 1, day, hour, min) - TZ * MIN;
}

// 锚点：本地 2025-11-01 00:00
const T0 = atTZ(2025, 11, 1);

/** 初始空账本的到期卡。 */
function freshCard(id = 'c1'): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: T0,
    stability: 'new',
    effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: 'f', back: 'b', srs, tags: [] };
}

describe('applyReview —— 唯一合法复习入口（R-T4-d）', () => {
  it('RF#1 走完一次复习：domainReviewCount([out.card]) 恰为 1', () => {
    const card = freshCard();
    const out = applyReview(card, GRADES.good, T0, TZ, P);
    expect(domainReviewCount([out.card])).toBe(1);
    expect(out.card.srs.effectiveReviewDays).toEqual([localDayString(T0, TZ)]);
  });

  it('同日第二次仍计 1（幂等）；跨日后每个新日历日各 +1', () => {
    let card = freshCard();
    card = applyReview(card, GRADES.good, T0, TZ, P).card;
    expect(domainReviewCount([card])).toBe(1);
    // 同日晚些时候再复习一次：SRS 前进，但 Boss 计数不动
    const sameDayLater = T0 + 20 * 3600_000;
    card = applyReview(card, GRADES.easy, sameDayLater, TZ, P).card;
    expect(domainReviewCount([card])).toBe(1);
    expect(card.srs.reps).toBe(2); // SM-2 侧照常推进——只有账本幂等
    // 次日：+1
    card = applyReview(card, GRADES.again, T0 + DAY, TZ, P).card;
    expect(domainReviewCount([card])).toBe(2);
    // 大后天，hard 档：再 +1
    card = applyReview(card, GRADES.hard, T0 + 3 * DAY, TZ, P).card;
    expect(domainReviewCount([card])).toBe(3);
    expect(card.srs.effectiveReviewDays).toEqual([
      localDayString(T0, TZ),
      localDayString(T0 + DAY, TZ),
      localDayString(T0 + 3 * DAY, TZ),
    ]);
  });

  it('四档 grade 全部记入当日账本（again 也计有效复习）', () => {
    for (const g of [GRADES.again, GRADES.hard, GRADES.good, GRADES.easy] as const) {
      const out = applyReview(freshCard(), g, T0, TZ, P);
      expect(domainReviewCount([out.card])).toBe(1);
    }
  });

  it('返回的 card 同时携带新 SRS 与新账本（内部顺序：先 review 再记账）', () => {
    const card = freshCard();
    const out = applyReview(card, GRADES.good, T0, TZ, P);
    // 与直接调 review 的结果逐字段一致（除账本外），证明 review 先行且未被篡改
    const expectedSrs = review(card.srs, GRADES.good, T0, P);
    expect(out.card.srs.ease).toBe(expectedSrs.ease);
    expect(out.card.srs.interval).toBe(expectedSrs.interval);
    expect(out.card.srs.reps).toBe(expectedSrs.reps);
    expect(out.card.srs.lapses).toBe(expectedSrs.lapses);
    expect(out.card.srs.due).toBe(expectedSrs.due);
    expect(out.card.srs.stability).toBe(expectedSrs.stability);
    // 账本键由传入的 tzOffset 产生，而非 review 后的 due
    expect(out.card.srs.effectiveReviewDays).toEqual([localDayString(T0, TZ)]);
    expect(out.answeredAt).toBe(T0);
    expect(out.graded).toBe(GRADES.good);
  });

  it('不可变性：入参 card 及其 srs、days 数组引用与内容均不变', () => {
    const card = freshCard();
    const daysRef = card.srs.effectiveReviewDays;
    const srsRef = card.srs;
    const snapshot = JSON.parse(JSON.stringify(card));
    const out = applyReview(card, GRADES.easy, T0, TZ, P);
    expect(card).toEqual(snapshot);
    expect(card.srs).toBe(srsRef);
    expect(card.srs.effectiveReviewDays).toBe(daysRef);
    expect(daysRef).toEqual([]);
    // 返回值是新引用
    expect(out.card).not.toBe(card);
    expect(out.card.srs).not.toBe(srsRef);
    expect(out.card.srs.effectiveReviewDays).not.toBe(daysRef);
  });

  it('多卡领域计数：每张卡各走一次 → 计数恰为卡数', () => {
    const a = applyReview(freshCard('a'), GRADES.good, T0, TZ, P).card;
    const b = applyReview(freshCard('b'), GRADES.again, T0, TZ, P).card;
    const c = applyReview(freshCard('c'), GRADES.hard, T0 + DAY, TZ, P).card;
    expect(domainReviewCount([a, b, c])).toBe(3);
  });

  it('时区偏移透传：同一瞬间在 UTC−5 与 UTC+8 下记不同日键', () => {
    const utcNoon = Date.UTC(2025, 10, 1, 23, 30); // UTC 23:30
    const west = applyReview(freshCard(), GRADES.good, utcNoon, -300, P).card;
    const east = applyReview(freshCard(), GRADES.good, utcNoon, TZ, P).card;
    expect(west.srs.effectiveReviewDays).toEqual(['2025-11-01']);
    expect(east.srs.effectiveReviewDays).toEqual(['2025-11-02']);
  });

  it('已有账本上追加不破坏既有条目（升序归一化保持）', () => {
    const card = freshCard();
    card.srs.effectiveReviewDays = [localDayString(T0 - DAY, TZ)];
    const out = applyReview(card, GRADES.good, T0, TZ, P);
    expect(out.card.srs.effectiveReviewDays).toEqual([
      localDayString(T0 - DAY, TZ),
      localDayString(T0, TZ),
    ]);
  });
});
