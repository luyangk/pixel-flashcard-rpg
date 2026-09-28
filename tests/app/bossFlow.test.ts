/**
 * tests/app/bossFlow.test.ts —— Plan 4 · T8：卷灵门槛 / 净化落账 / 三幕里程碑 / 称号。
 *
 * 判别力（每条对着"旧实现会怎样红"）：
 * - BF#1 引导领域特调 15：把 tier 设成 50 的实现在生活常识上仍必须达标 ⇒ 按全局档判的实现必红；
 * - BF#3 已净化的不重写：重战刷新时间戳的实现必红（codex 的"新者前"排序会因此抖动）；
 * - BF#5 里程碑只前进：可回退（`arcSeen = act`）的实现会在"已看第二幕后看第一幕"时红；
 * - BF#6 超长/空称号**不写脏值**而是回落默认模板：直接写用户原串的实现必红。
 */
import { describe, expect, it } from 'vitest';
import type { Card, Deck, SaveFile, Stability, SRSState } from '@core/types';
import { createMemoryStorage } from '@platform/memoryStore';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import {
  ARC_MILESTONES,
  BOSS_NAME_MAX,
  GUIDE_DECK_ID,
  actsUnlockedBy,
  bossFightParams,
  bossGateForDeck,
  bossGates,
  bossNameOf,
  defaultBossName,
  markArcSeen,
  markPurified,
  normalizeBossName,
  purifiedCount,
  readyGates,
  setBossName,
  thresholdForDeck,
} from '../../src/app/bossFlow';

const NOW = Date.UTC(2026, 9, 27, 6, 0, 0);

/** 有效期天数：Boss 计数口径 = Σ effectiveReviewDays.length（reviewLedger）。 */
function days(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`2026-09-${String((i % 28) + 1).padStart(2, '0')}`);
  return out;
}

function card(id: string, deckId: string, reviewDays = 0, stability: Stability = 'review'): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due: 0,
    stability,
    effectiveReviewDays: days(reviewDays),
  };
  return { id, deckId, front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

function deck(id: string, name: string, over: Partial<Deck> = {}): Deck {
  return { id, name, isPreset: false, ...over };
}

function save(decks: Deck[], cards: Card[], tier: 15 | 30 | 50 = 30): SaveFile {
  return {
    schemaVersion: 1,
    decks,
    cards,
    settings: {
      bossThresholdTier: tier,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
  };
}

async function makeCoord(seed: SaveFile): Promise<Coordinator> {
  const store = createMemoryStorage();
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
  await coord.mutate((s) => {
    s.decks = seed.decks;
    s.cards = seed.cards;
    s.settings = seed.settings;
  });
  await coord.flush();
  return coord;
}

describe('thresholdForDeck —— 引导领域特调 15', () => {
  it('BF#1 生活常识恒 15（哪怕全局档是 50）；其余领域跟全局档；脏档回落 30', () => {
    expect(thresholdForDeck(GUIDE_DECK_ID, 50)).toBe(15);
    expect(thresholdForDeck(GUIDE_DECK_ID, 30)).toBe(15);
    expect(thresholdForDeck('deck-other', 50)).toBe(50);
    expect(thresholdForDeck('deck-other', 15)).toBe(15);
    expect(thresholdForDeck('deck-other', 'x')).toBe(30);
    expect(thresholdForDeck('deck-other', Number.NaN)).toBe(30);
  });

  it('BF#1b 同样 15 次复习：全局档 50 时只对引导域达标（按全局档判的实现必红）', () => {
    const decks = [deck(GUIDE_DECK_ID, '生活常识'), deck('deck-tang', '唐诗')];
    const cards = [card('g1', GUIDE_DECK_ID, 15), card('t1', 'deck-tang', 15)];
    const gates = bossGates(save(decks, cards, 50));
    expect(gates.find((g) => g.deckId === GUIDE_DECK_ID)).toMatchObject({ threshold: 15, count: 15, ready: true });
    expect(gates.find((g) => g.deckId === 'deck-tang')).toMatchObject({ threshold: 50, count: 15, ready: false });
  });
});

describe('bossGateForDeck / bossGates —— 计数与达标', () => {
  it('BF#2 计数 = 该领域 Σ 有效期天数（不串领域），ready 由 count ≥ threshold 定', () => {
    const decks = [deck('d1', '甲'), deck('d2', '乙')];
    const cards = [card('a', 'd1', 20), card('b', 'd1', 10), card('c', 'd2', 29)];
    const gates = bossGates(save(decks, cards, 30));
    expect(gates.map((g) => `${g.deckId}:${g.count}:${g.ready}`)).toEqual(['d1:30:true', 'd2:29:false']);
    // readyGates 只留达标的（顺序仍按 decks）
    expect(readyGates(save(decks, cards, 30)).map((g) => g.deckId)).toEqual(['d1']);
  });

  it('BF#2b 单领域接口不分组：把别的领域的卡喂进来会算错——调用方必须自己先分好', () => {
    const d = deck('d1', '甲');
    const mixed = [card('a', 'd1', 30), card('b', 'd2', 30)];
    // 这是**刻意的**窄接口：bossGateForDeck 的契约就是"传这个领域的卡"（bossGates 负责分组）
    expect(bossGateForDeck(d, mixed, 30).count).toBe(60);
  });

  it('BF#2c 已净化的领域在 gate 里带出 purifiedAt（codex 据此挑条目）', () => {
    const d = deck('d1', '甲', { purifiedAt: 123 });
    expect(bossGateForDeck(d, [card('a', 'd1', 30)], 30).purifiedAt).toBe(123);
  });
});

describe('markPurified —— 净化落账', () => {
  it('BF#3 首次净化写 purifiedAt；已净化的不重写；未知领域与脏时刻不写', async () => {
    const seed = save([deck('d1', '甲', { purifiedAt: 111 }), deck('d2', '乙')], [], 30);
    const coord = await makeCoord(seed);

    const fresh = await markPurified(coord, ['d1', 'd2'], NOW);
    expect(fresh).toEqual(['d2']); // d1 已净化，不刷新时间戳（重战当练习关）
    expect(coord.snapshot().decks.find((d) => d.id === 'd1')?.purifiedAt).toBe(111);
    expect(coord.snapshot().decks.find((d) => d.id === 'd2')?.purifiedAt).toBe(NOW);
    expect(purifiedCount(coord.snapshot())).toBe(2);

    const before = coord.snapshot().decks.map((d) => d.purifiedAt);
    expect(await markPurified(coord, ['d2'], NOW + 1000)).toEqual([]);
    expect(await markPurified(coord, ['deck-ghost'], NOW)).toEqual([]);
    expect(await markPurified(coord, [], NOW)).toEqual([]);
    expect(coord.snapshot().decks.map((d) => d.purifiedAt)).toEqual(before);
  });

  it('BF#3b 脏时刻对**未净化**的领域也不写（旧断言拿已净化的领域去测 ⇒ 空断言，评审 I-3③）', async () => {
    const coord = await makeCoord(save([deck('fresh', '新领域')], [], 30));
    expect(coord.snapshot().decks[0].purifiedAt).toBeUndefined();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
      expect(await markPurified(coord, ['fresh'], bad)).toEqual([]);
      expect(coord.snapshot().decks[0].purifiedAt).toBeUndefined(); // 真要判的就是这一行
    }
    expect(await markPurified(coord, ['fresh'], NOW)).toEqual(['fresh']); // 合法时刻照常写
  });
});

describe('三幕里程碑（LORE §5.3：净化 3/6/9）', () => {
  it('BF#4 actsUnlockedBy：0–2 → 0 幕，3–5 → 1，6–8 → 2，≥9 → 3', () => {
    expect(ARC_MILESTONES).toEqual([3, 6, 9]);
    expect([0, 1, 2, 3, 5, 6, 8, 9, 12].map(actsUnlockedBy)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('BF#5 markArcSeen 只前进、不回退、不重复写；非法幕数忽略', async () => {
    const coord = await makeCoord(save([deck('d1', '甲')], [], 30));

    expect(await markArcSeen(coord, 1)).toBe(true);
    expect(coord.snapshot().settings.story.arcSeen).toBe(1);
    expect(await markArcSeen(coord, 1)).toBe(false); // 同值不重写（写放大纪律）
    expect(await markArcSeen(coord, 2)).toBe(true);
    expect(await markArcSeen(coord, 1)).toBe(false); // 回退请求被拒
    expect(coord.snapshot().settings.story.arcSeen).toBe(2);
    for (const bad of [0, 4, 1.5, Number.NaN]) expect(await markArcSeen(coord, bad)).toBe(false);
    expect(coord.snapshot().settings.story.arcSeen).toBe(2);
  });
});

describe('卷灵称号', () => {
  it('BF#6 normalizeBossName：空白与超长回落默认模板（绝不写脏值）', () => {
    expect(defaultBossName('唐诗')).toBe('唐诗·卷灵');
    expect(defaultBossName('  木兰辞  ')).toBe('木兰辞·卷灵');
    expect(defaultBossName('')).toBe('无名·卷灵');

    expect(normalizeBossName('  荒原卷灵  ', '唐诗')).toEqual({ ok: true, name: '荒原卷灵' });
    const empty = normalizeBossName('   ', '唐诗');
    expect(empty.ok).toBe(false);
    expect(empty.name).toBe('唐诗·卷灵');
    const long = normalizeBossName('字'.repeat(BOSS_NAME_MAX + 1), '唐诗');
    expect(long.ok).toBe(false);
    expect(long.name).toBe('唐诗·卷灵');
    // 恰好 30 字合法（边界不误杀）
    expect(normalizeBossName('字'.repeat(BOSS_NAME_MAX), '唐诗').ok).toBe(true);
    // 码点计长：emoji 按一个字符算（按 UTF-16 长度会误判成 2）
    expect(normalizeBossName('🐉'.repeat(BOSS_NAME_MAX), '唐诗').ok).toBe(true);
  });

  it('BF#7 setBossName 写入存档；非法输入写默认模板并如实回 ok:false；未知领域不写', async () => {
    const coord = await makeCoord(save([deck('d1', '唐诗')], [], 30));

    expect((await setBossName(coord, 'd1', '荒原卷灵')).ok).toBe(true);
    expect(coord.snapshot().decks[0].bossName).toBe('荒原卷灵');

    const long = await setBossName(coord, 'd1', '字'.repeat(40));
    expect(long.ok).toBe(false);
    expect(coord.snapshot().decks[0].bossName).toBe('唐诗·卷灵'); // 回落默认模板，不留 40 字脏值

    expect((await setBossName(coord, 'deck-ghost', 'x')).ok).toBe(false);
    expect(coord.snapshot().decks).toHaveLength(1);
  });

  it('BF#7b bossNameOf：存档有就用，缺席用默认模板', () => {
    expect(bossNameOf(deck('d1', '唐诗', { bossName: '诗酒卷灵' }))).toBe('诗酒卷灵');
    expect(bossNameOf(deck('d1', '唐诗'))).toBe('唐诗·卷灵');
  });
});

describe('bossFightParams —— 卷灵战的规范参数', () => {
  it('BF#8 单领域 + 池子取 min(卡数,25)；空领域退化为 1（由 startFight 兜底报错）', () => {
    const cards: Card[] = [];
    for (let i = 0; i < 30; i++) cards.push(card(`c${i}`, 'd1'));
    cards.push(card('x', 'd2'));
    expect(bossFightParams(save([deck('d1', '甲')], cards), 'd1')).toEqual({ size: 25, deckIds: ['d1'] });
    expect(bossFightParams(save([deck('d1', '甲')], cards), 'd2')).toEqual({ size: 1, deckIds: ['d2'] });
    expect(bossFightParams(save([deck('d1', '甲')], cards), 'd3')).toEqual({ size: 1, deckIds: ['d3'] });
  });
});
