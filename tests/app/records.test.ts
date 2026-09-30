/**
 * tests/app/records.test.ts —— 个人纪录（D57）。
 *
 * 判别力：
 * - RC#1 四个维度各自算对：等级取自 exp、已掌握看 srs.stability、自建卡看 source.type、
 *   复习天数取**所有卡账本的并集**（只看一张卡的实现必红）；
 * - RC#2 连续天数的边界：今天/昨天都算"还在连着"，断一天就归零；空账本 = 0；
 * - RC#3 最长连续：**从账本现算**（不落 `progress.bestStreak` 字段 —— 那是复查后的裁定）；
 * - RC#4 脏数据不崩：非数组 cards / 脏 source / 脏天数一律消毒。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, SaveFile } from '@core/types';
import { computeRecords } from '../../src/app/records';

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0); // 2026-10-27（tz +480 ⇒ 本地 12:00）
const TZ = 480;
const TODAY = '2026-10-27';

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id,
    deckId: 'd1',
    front: `q-${id}`,
    back: `a-${id}`,
    tags: [],
    srs: {
      ease: 2.5,
      interval: 10,
      reps: 1,
      lapses: 0,
      due: NOW,
      stability: 'new',
      effectiveReviewDays: [],
    },
    ...over,
  };
}

function saveOf(cards: Card[], over: Partial<SaveFile['settings']> = {}): SaveFile {
  return {
    schemaVersion: 1,
    decks: [{ id: 'd1', name: '甲', isPreset: true }],
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
      answerMode: 'choice',
      llmQuota: { day: '', cards: 0, judges: 0 },
      ...over,
    },
    meta: { savedAt: NOW, plays: 0 },
  };
}

afterEach(() => {
  // 无 DOM 依赖，nothing to clean
});

describe('app/records —— 个人纪录（D57）', () => {
  it('RC#1 四个维度各自算对（复习天数取**并集**）', () => {
    const save = saveOf(
      [
        card('a', { srs: { ...card('x').srs, stability: 'mastered', effectiveReviewDays: ['2026-10-25', '2026-10-26', '2026-10-27'] } }),
        card('b', { srs: { ...card('x').srs, stability: 'mastered', effectiveReviewDays: ['2026-10-25', '2026-10-26', '2026-10-27'] } }),
        card('c', { source: { type: 'llm', createdAt: NOW }, srs: { ...card('x').srs, effectiveReviewDays: [] } }),
        card('d', { source: { type: 'manual', createdAt: NOW } }),
        // 预置卡**不算**"我自己添的"（否则重置后每个人开局就有 30 张"自建卡"）
        card('e', { source: { type: 'preset', createdAt: NOW } }),
      ],
      { progress: { exp: 120 } },
    );
    const rec = computeRecords(save, TODAY);
    expect(rec.exp).toBe(120);
    expect(rec.level).toBeGreaterThanOrEqual(1);
    expect(rec.mastered).toBe(2);
    expect(rec.selfMade).toBe(2); // llm + manual；预置不算自建
    expect(rec.reviewDays).toBe(3); // 25/26/27 的并集（只看一张卡会得 2）
  });

  it('RC#2 连续天数：今天或昨天起算都算连着；断一天归零', () => {
    const days = (list: string[]): Card =>
      card('x', { srs: { ...card('x').srs, effectiveReviewDays: list } });
    // 今天 + 昨天 + 前天 ⇒ 3
    expect(computeRecords(saveOf([days(['2026-10-25', '2026-10-26', '2026-10-27'])]), TODAY).streak).toBe(3);
    // 昨天 + 前天（今天还没复习）⇒ 仍算 2（今天还没过去，不许断）
    expect(computeRecords(saveOf([days(['2026-10-25', '2026-10-26'])]), TODAY).streak).toBe(2);
    // 只有前天 ⇒ 断了 ⇒ 0
    expect(computeRecords(saveOf([days(['2026-10-25'])]), TODAY).streak).toBe(0);
    // 空账本 ⇒ 0
    expect(computeRecords(saveOf([card('x')]), TODAY).streak).toBe(0);
  });

  it('RC#3 最长连续取"账本内最长的一段"，且至少等于当前连续', () => {
    const days = (list: string[]): Card => card('x', { srs: { ...card('x').srs, effectiveReviewDays: list } });
    // 一段 3 天（已断）+ 当前 2 天 ⇒ 最长 3、当前 2
    const rec = computeRecords(
      saveOf([days(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-26', '2026-10-27'])]),
      TODAY,
    );
    expect(rec.streak).toBe(2);
    expect(rec.bestStreak).toBe(3);
    // 当前连续就是最长的一段 ⇒ 两者相等
    const rec2 = computeRecords(saveOf([days(['2026-10-25', '2026-10-26', '2026-10-27'])]), TODAY);
    expect(rec2.streak).toBe(3);
    expect(rec2.bestStreak).toBe(3);
  });

  it('RC#4 脏数据不崩：脏 source / 脏天数 / 非数组 cards', () => {
    const dirty = saveOf([
      card('a', { source: { type: 'martian' } as never, srs: { ...card('x').srs, effectiveReviewDays: ['假的', 42] as never } }),
    ]);
    const rec = computeRecords(dirty, TODAY);
    expect(rec.selfMade).toBe(0);
    expect(rec.reviewDays).toBe(0);
    expect(Number.isFinite(rec.level)).toBe(true);

    const broken = { ...dirty, cards: 'nope' } as unknown as SaveFile;
    expect(() => computeRecords(broken, TODAY)).not.toThrow();
  });
});
