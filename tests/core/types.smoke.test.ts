import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Card,
  Deck,
  SaveFile,
  Settings,
  Sm2Params,
  SourceInfo,
  SRSState,
  Stability,
} from '@core/types';

// 最小合法 SaveFile 字面量：类型正确性由 tsc（npm run typecheck）把关，
// 本用例只做运行时 smoke——确认字段结构按 brief 落地、可被消费。
function makeSaveFile(): SaveFile {
  const srs: SRSState = {
    ease: 2.5,
    interval: 1,
    reps: 0,
    lapses: 0,
    due: 1761955200000,
    stability: 'new',
    effectiveReviewDays: [],
  };
  const source: SourceInfo = { type: 'preset', createdAt: 1761955200000 };
  const card: Card = {
    id: 'c1',
    deckId: 'd1',
    front: '「卷灵」栖息在哪里？',
    back: '未净化的知识领域卡组中',
    source,
    srs,
    tags: ['lore'],
  };
  const deck: Deck = { id: 'd1', name: '前端基础', isPreset: true, bossName: '文档荒废之灵' };
  const sm2Params: Sm2Params = {
    initialEase: 2.5,
    minEase: 1.3,
    firstInterval: 1,
    secondInterval: 6,
  };
  const settings: Settings = {
    bossThresholdTier: 30,
    sm2Params,
    battle: { defaultPoolSize: 15 },
  };
  return {
    schemaVersion: 1,
    decks: [deck],
    cards: [card],
    settings,
    meta: { savedAt: 1761955200000, plays: 0 },
  };
}

describe('core types smoke', () => {
  const save = makeSaveFile();

  it('构造出结构完整的 SaveFile', () => {
    expect(save.schemaVersion).toBe(1);
    expect(save.decks).toHaveLength(1);
    expect(save.cards).toHaveLength(1);
    expect(save.meta.plays).toBe(0);
    expect(typeof save.meta.savedAt).toBe('number');
  });

  it('Card 携带 srs / tags / 可选 source', () => {
    const card = save.cards[0]!;
    expect(card.deckId).toBe(save.decks[0]!.id);
    expect(card.tags).toEqual(['lore']);
    expect(card.source?.type).toBe('preset');
    expect(typeof card.source?.url).toBe('undefined');
  });

  it('SRSState 含 Boss 计数口径字段 effectiveReviewDays', () => {
    const srs = save.cards[0]!.srs;
    expect(Array.isArray(srs.effectiveReviewDays)).toBe(true);
    expect(srs.stability).toBe('new');
  });

  it('Settings 引用 Sm2Params', () => {
    expect(save.settings.bossThresholdTier).toBe(30);
    expect(save.settings.sm2Params.initialEase).toBe(2.5);
    expect(save.settings.sm2Params.minEase).toBe(1.3);
  });

  it('Settings 含 battle.defaultPoolSize（Task 8：默认 15，域 10–25）', () => {
    expect(save.settings.battle.defaultPoolSize).toBe(15);
    expectTypeOf<Settings['battle']['defaultPoolSize']>().toEqualTypeOf<number>();
  });

  it('类型层面：字段归属与联合取值符合 brief 签名', () => {
    expectTypeOf(makeSaveFile).toEqualTypeOf<() => SaveFile>();
    expectTypeOf<SaveFile['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<Stability>().toEqualTypeOf<'new' | 'learning' | 'review' | 'mastered'>();
    expectTypeOf<Settings['bossThresholdTier']>().toEqualTypeOf<15 | 30 | 50>();
    expectTypeOf<SourceInfo['type']>().toEqualTypeOf<'preset' | 'hotspot' | 'domain' | 'manual' | 'llm'>();
    expectTypeOf<Deck['purifiedAt']>().toEqualTypeOf<number | undefined>();
    // 纯类型模块：types.ts 不应引入任何运行时依赖
    expectTypeOf<Card['source']>().toEqualTypeOf<SourceInfo | undefined>();
  });
});
