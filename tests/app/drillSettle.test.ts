/**
 * tests/app/drillSettle.test.ts —— Plan 7 · T2：木桩练功的结算分叉。
 *
 * 这一组守的是 D46 的四条口径（每一条都写清"坏实现为何必红"）：
 * - DS#1 drill **不计 plays、不进榜单**（照走正常结算 ⇒ 榜单里会多出练功记录、局数虚高）；
 * - DS#2 drill **不进"有效复习日"账本**（SRS 照常涨，但卷灵达标推不动 ⇒ 木桩不能当刷 Boss 的捷径）；
 * - DS#3 drill 经验 = 遭遇战的 **1/20**（且至少 1 点：全零经验会让"练了一晚上"毫无痕迹）；
 * - DS#4 drill 不参与"首战教学局"（meta.plays===0 时练功仍是遭遇战参数）；
 * - DS#5 显式卡池（勾选结果）**原样成池**，不经过 80/20 抽样；空数组 ⇒ 与 no-cards 同一条引导。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SaveFile, SRSState } from '@core/types';
import { GRADES } from '@core/sm2';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import { createGameController } from '../../src/app/gameController';
import { drillExpGained } from '../../src/app/growth';

const NOW = Date.UTC(2026, 10, 1, 4, 0, 0);
const TZ = 480;

function srs(over: Partial<SRSState> = {}): SRSState {
  return { ease: 2.5, interval: 10, reps: 3, lapses: 0, due: 0, stability: 'review', effectiveReviewDays: [], ...over };
}
function card(id: string, over: Partial<Card> = {}): Card {
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, tags: [], srs: srs(), ...over };
}
function save(cards: Card[]): SaveFile {
  return {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '唐诗', isPreset: true }],
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
    },
    meta: { savedAt: NOW, plays: 0 },
  };
}

async function makeRig(seed: SaveFile): Promise<{ coord: Coordinator; store: GameStorage['load'] extends never ? never : GameStorage }> {
  const store = createMemoryStorage();
  await store.save(seed);
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
  return { coord, store };
}

describe('drillExpGained —— 1/20（Plan 7 · T2）', () => {
  it('DS#3b 遭遇战 21 点 ⇒ 1 点；0/NaN ⇒ 也至少 1 点（练了就有痕迹）', () => {
    expect(drillExpGained(21)).toBe(1);
    expect(drillExpGained(0)).toBe(1);
    expect(drillExpGained(Number.NaN)).toBe(1);
    expect(drillExpGained(200)).toBe(10);
    expect(drillExpGained(-5)).toBe(1);
  });
});

describe('木桩练功的结算（Plan 7 · T2）', () => {
  async function drillRig(cards = [card('c1'), card('c2'), card('c3')]) {
    const rig = await makeRig(save(cards));
    const ctrl = await createGameController({ coord: rig.coord, rng: () => 0.5, now: () => NOW, tzOffsetMin: TZ });
    return { ...rig, ctrl };
  }

  it('DS#1 练完一圈：不计 plays、不进榜单、但 SRS 真的涨了', async () => {
    const { ctrl, coord } = await drillRig();
    await ctrl.intent({ type: 'startFight', size: 3, cardIds: ['c1', 'c2', 'c3'], mode: 'drill' });
    expect(ctrl.snapshot().fight?.state.mode).toBe('drill');
    for (let i = 0; i < 3; i += 1) await ctrl.intent({ type: 'answer', grade: GRADES.good });

    const snap = ctrl.snapshot();
    expect(snap.fight?.state.phase).toBe('cleared');
    expect(snap.lastResult?.mode).toBe('drill');
    expect(snap.lastResult?.expGained).toBe(1); // 1/20
    expect(coord.snapshot().meta.plays).toBe(0); // ← 不计局数
    expect(coord.snapshot().settings.leaderboard ?? []).toHaveLength(0); // ← 不进榜单
    expect(coord.snapshot().settings.progress.exp).toBe(1); // 经验照发
    // SRS 真的推进了（reps +1 之类）：练了就是练了
    const c1 = coord.snapshot().cards.find((c) => c.id === 'c1');
    expect(c1?.srs.reps).toBeGreaterThan(3);
  });

  it('DS#2 **不进有效复习日**：练完一圈 days 仍是空的（推不动卷灵达标）', async () => {
    const { ctrl, coord } = await drillRig();
    await ctrl.intent({ type: 'startFight', size: 2, cardIds: ['c1', 'c2'], mode: 'drill' });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    for (const c of coord.snapshot().cards) {
      expect(c.srs.effectiveReviewDays).toEqual([]);
    }
  });

  it('DS#2b 同一张卡在**正常遭遇战**里照旧计入有效复习日（对照组，防"一刀切成不计"）', async () => {
    const { ctrl, coord } = await drillRig();
    await ctrl.intent({ type: 'startFight', size: 1, deckIds: ['deck-a'], difficulty: 'encounter' });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    const days = coord.snapshot().cards.flatMap((c) => c.srs.effectiveReviewDays);
    expect(days.length).toBeGreaterThan(0);
  });

  it('DS#4 首战（plays=0）跑 drill ⇒ 难度仍是 encounter，不是 tutorial', async () => {
    const { ctrl } = await drillRig();
    await ctrl.intent({ type: 'startFight', size: 2, cardIds: ['c1', 'c2'], mode: 'drill' });
    expect(ctrl.snapshot().fight?.difficulty).toBe('encounter');
  });

  it('DS#5 显式卡池原样成池（不抽样）；空数组走 no-cards 引导', async () => {
    const { ctrl } = await drillRig([card('c1'), card('c2'), card('c3'), card('c4'), card('c5')]);
    await ctrl.intent({ type: 'startFight', size: 2, cardIds: ['c3'], mode: 'drill' });
    expect(ctrl.snapshot().fight?.pool.map((c) => c.id)).toEqual(['c3']);

    await ctrl.intent({ type: 'toMenu' });
    await ctrl.intent({ type: 'startFight', size: 2, cardIds: [], mode: 'drill' });
    // 空勾选落到"筛后 0 张"那条引导（UI 侧本来就会禁用 0 勾选的按钮，这里是纵深防御）；
    // 计划文档里"空数组 ⇒ no-cards"的措辞已按实测更正为 insufficient-cards。
    expect(ctrl.snapshot().lastError?.code).toBe('insufficient-cards');
    expect(ctrl.snapshot().screen).toBe('prepare');
  });
});
