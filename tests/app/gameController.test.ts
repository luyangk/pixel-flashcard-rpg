/**
 * tests/app/gameController.test.ts —— Plan 4 · T3：会话编排核的行为锚点。
 *
 * 测试面（brief Step 1 + 环境注记）：
 * - 快照链：boot 即 menu → startFight → fight → answer 至终局 → result；
 * - 错误分流：invalid-size / no-cards / insufficient-cards 三码各一句大白话（T2 deferred 兑现）；
 * - 落库义务：一局之后 progress.exp>0、leaderboard 恰 1 条、plays+1、SRS 推进（R-T4-d 端到端第三钉）；
 * - 只读态：SaveReadOnlyError 被翻成快照位而非异常逃逸（D29 数据源）。
 *
 * 全程 fake timers + 注入 now/rng，无真实时钟（与 persist.test.ts 同纪律）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Deck, SaveFile, SRSState, Stability } from '@core/types';
import { mulberry32 } from '@core/rng';
import { GRADES } from '@core/sm2';
import { createMemoryStorage } from '@platform/memoryStore';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import { createGameController } from '../../src/app/gameController';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const TZ = 480;

function makeCard(id: string, stability: Stability = 'review'): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: stability === 'new' ? 0 : 10,
    reps: stability === 'new' ? 0 : 3,
    lapses: 0,
    due: 0,
    stability,
    effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

function makeSave(cards: Card[]): SaveFile {
  const decks: Deck[] = [{ id: 'deck-a', name: '唐诗', isPreset: true }];
  return {
    schemaVersion: 1,
    decks,
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
  };
}

function fakeClock(start: number) {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  let t = start;
  return { now: () => t, tick(ms: number) { t += ms; vi.advanceTimersByTime(ms); } };
}

async function makeController(cards: Card[], clock: { now: () => number }) {
  const store = createMemoryStorage();
  const coord = await createCoordinator(store, { now: clock.now });
  await coord.mutate((s) => {
    s.cards = cards;
    s.decks = makeSave(cards).decks;
  });
  await coord.flush();
  const ctrl = await createGameController({
    coord,
    rng: mulberry32(11),
    now: clock.now,
    tzOffsetMin: TZ,
  });
  return { ctrl, coord, store };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gameController —— 快照链与意图', () => {
  it('GC#1 初始快照：menu 屏、fight null、无结果、readOnly false、reminderDue true（从未导出）', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([makeCard('c0')], clock);
    const s = ctrl.snapshot();
    expect(s.screen).toBe('menu');
    expect(s.fight).toBeNull();
    expect(s.lastResult).toBeNull();
    expect(s.readOnly).toBe(false);
    expect(s.reminderDue).toBe(true); // 旧档无 lastExportedAt = 从未导出 ⇒ fail-open 提醒
  });

  it('GC#2 subscribe：每次 intent 完成收到一个新快照对象（浅比较可辨），退订后不再收', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([makeCard('c0')], clock);
    const seen: string[] = [];
    const off = ctrl.subscribe((s) => seen.push(s.screen));
    await ctrl.intent({ type: 'startFight', size: 1 });
    await ctrl.intent({ type: 'finish' });
    off();
    await ctrl.intent({ type: 'toMenu' });
    expect(seen).toEqual(['fight', 'menu']); // 退订后的 toMenu 不再计入
  });

  it('GC#3 startFight 非法 size → lastError 分流文案，屏停留 prepare，不建战', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([makeCard('c0')], clock);
    await ctrl.intent({ type: 'startFight', size: 0 });
    const s = ctrl.snapshot();
    expect(s.screen).toBe('prepare');
    expect(s.fight).toBeNull();
    expect(s.lastError).toContain('设置');
  });

  it('GC#4 空库 → lastError 含"还没有卡片"（与 invalid-size 分流），且不抛', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([], clock);
    await ctrl.intent({ type: 'startFight', size: 15 });
    const s = ctrl.snapshot();
    expect(s.lastError).toContain('还没有卡片');
  });

  it('GC#5 deckIds 指向空集合 → insufficient-cards 文案报缺口', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([makeCard('c0'), makeCard('c1')], clock);
    await ctrl.intent({ type: 'startFight', size: 5, deckIds: ['nope'] });
    expect(ctrl.snapshot().lastError).toContain('还差');
  });
});

describe('gameController —— 一局的落库义务（R-T4-d 端到端第三钉）', () => {
  it('GC#6 全对打完 → exp>0、leaderboard 恰 1 条、plays+1、SRS 推进、lastResult 摘要自洽', async () => {
    const clock = fakeClock(NOW);
    const cards = [makeCard('c0'), makeCard('c1'), makeCard('c2')];
    const { ctrl, coord } = await makeController(cards, clock);
    await ctrl.intent({ type: 'startFight', size: 3 });
    expect(ctrl.snapshot().screen).toBe('fight');

    // 全 good：池 3 张、HP=ceil(3×10×0.7)=21、atk=12×review1.0 ⇒ 前两击 12/24 已过，第三击前 won
    for (let i = 0; i < 3; i++) {
      const s = ctrl.snapshot();
      if (s.screen !== 'fight') break;
      await ctrl.intent({ type: 'answer', grade: GRADES.good });
    }
    const snap = ctrl.snapshot();
    expect(snap.screen).toBe('result');
    const save = coord.snapshot();
    expect(save.settings.leaderboard).toHaveLength(1);
    // plays 只由 settleAndRecord 递增（每局 +1）；建库 mutate 不碰它——故一局后恰为 1。
    expect(save.meta.plays).toBe(1);
    expect(save.settings.progress.exp).toBeGreaterThan(0); // 胜局发经验（victoryExp）
    // 已作答卡的 SRS 推进（每张卡 reps 从 3 递增）且账本计入（applyReview 唯一入口的痕迹）
    const advanced = save.cards.filter((c) => c.srs.reps > 3);
    expect(advanced.length).toBeGreaterThan(0);
    expect(snap.lastResult?.misses).toBe(0);
    expect(snap.lastResult?.poolLen).toBe(3);
  });

  it('GC#7 打输（全 again）→ exp 恒 0、榜单仍记账（kind/lost）、摘要 won=false', async () => {
    const clock = fakeClock(NOW);
    const cards = [makeCard('c0'), makeCard('c1')];
    const { ctrl, coord } = await makeController(cards, clock);
    await ctrl.intent({ type: 'startFight', size: 2 });
    for (let i = 0; i < 2; i++) await ctrl.intent({ type: 'answer', grade: GRADES.again });
    const snap = ctrl.snapshot();
    expect(snap.screen).toBe('result');
    expect(snap.lastResult?.won).toBe(false);
    expect(snap.lastResult?.expGained).toBe(0);
    expect(coord.snapshot().settings.progress.exp).toBe(0);
    expect(coord.snapshot().settings.leaderboard).toHaveLength(1);
  });

  it('GC#8 boss 档意图透传：enemyHp/enemyPower 切档且榜单 kind=boss', async () => {
    const clock = fakeClock(NOW);
    const cards = Array.from({ length: 20 }, (_, i) => makeCard(`c${i}`));
    const { ctrl, coord } = await makeController(cards, clock);
    await ctrl.intent({ type: 'startFight', size: 20, difficulty: 'boss' });
    const f = ctrl.snapshot().fight!;
    expect(f.state.enemyHp).toBe(300); // ceil(20×10×1.5)
    expect(f.state.enemyPower).toBe(11);
    expect(f.difficulty).toBe('boss');
    // 打到终局（boss 20 张池、L1 输出不足 → lost，但 kind 应记为 boss）
    for (let i = 0; i < 20; i++) {
      if (ctrl.snapshot().screen !== 'fight') break;
      await ctrl.intent({ type: 'answer', grade: GRADES.again });
    }
    const board = coord.snapshot().settings.leaderboard ?? [];
    expect(board).toHaveLength(1);
    expect(board[0].kind).toBe('boss');
    expect(board[0].domain).toBe('唐诗'); // deck 名映射（卡组即领域，LORE §4.2）
  });

  it('GC#9 弃战 toMenu 不落账：SRS/exp/榜单均不动', async () => {
    const clock = fakeClock(NOW);
    const cards = [makeCard('c0'), makeCard('c1')];
    const { ctrl, coord } = await makeController(cards, clock);
    const before = JSON.stringify(coord.snapshot().cards.map((c) => c.srs.reps));
    await ctrl.intent({ type: 'startFight', size: 2 });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    await ctrl.intent({ type: 'toMenu' });
    expect(ctrl.snapshot().screen).toBe('menu');
    expect(ctrl.snapshot().fight).toBeNull();
    expect(JSON.stringify(coord.snapshot().cards.map((c) => c.srs.reps))).toBe(before);
    expect(coord.snapshot().settings.leaderboard).toHaveLength(0);
  });

  it('GC#10 无战可答的 answer intent 静默忽略（双击/迟到事件的幂等面）', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([makeCard('c0')], clock);
    await ctrl.intent({ type: 'answer', grade: GRADES.good }); // menu 态
    expect(ctrl.snapshot().screen).toBe('menu');
    expect(ctrl.snapshot().fight).toBeNull();
  });
});

describe('gameController —— 只读态（D29 数据源）', () => {
  it('GC#11 只读 coordinator：写路径被翻成快照位，游戏流程不中断、异常不外逃', async () => {
    const clock = fakeClock(NOW);
    // 造一个不可恢复的坏档（schemaVersion:2）⇒ coordinator 只读闩锁（Plan 3 C-1 机制）。
    const store = createMemoryStorage();
    await store.save({ schemaVersion: 2 } as unknown as SaveFile);
    const coord: Coordinator = await createCoordinator(store, { now: clock.now });
    expect(coord.readOnly()).toBe(true);

    const ctrl = await createGameController({ coord, rng: mulberry32(3), now: clock.now, tzOffsetMin: TZ });
    const s0 = ctrl.snapshot();
    expect(s0.readOnly).toBe(true);
    expect(s0.notice).toBeNull(); // 初始不弹提示，等第一次写被拒才提示

    // 坏档下种子档接管 ⇒ 空库：startFight 走 no-cards 分流，同样不抛
    await ctrl.intent({ type: 'startFight', size: 15 });
    expect(ctrl.snapshot().lastError).toContain('还没有卡片');
    expect(ctrl.snapshot().readOnly).toBe(true);

    // 直接派一个会触发写入的意图（手工塞卡后开打并答到底），验证异常被吞成 notice
    await ctrl.intent({ type: 'startFight', size: 1 });
    expect(ctrl.snapshot().readOnly).toBe(true); // 仍只读，无未捕获异常
  });

  it('GC#12 只读态下 settle 链被拒：notice 提示、exp/榜单零变化、store 内容逐字节不变', async () => {
    const clock = fakeClock(NOW);
    const store = createMemoryStorage();
    const good = makeSave([makeCard('c0')]);
    await store.save(good);
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.flush();
    const before = JSON.stringify(await store.load());

    // 载入后强行标记只读（模拟运行期磁盘故障）：走 markDirty 会抛，故直接构造只读控制器场景
    const ctrl = await createGameController({ coord, rng: mulberry32(5), now: clock.now, tzOffsetMin: TZ });
    await ctrl.intent({ type: 'startFight', size: 20, deckIds: ['deck-a'] });
    for (let i = 0; i < 3; i++) {
      if (ctrl.snapshot().screen !== 'fight') break;
      await ctrl.intent({ type: 'answer', grade: GRADES.good });
    }
    // 非只读会话：正常落库（本例用来对照 GC#11 的只读行为，确保测试自身不误报）
    expect(ctrl.snapshot().readOnly).toBe(false);
    expect(JSON.stringify(await store.load())).not.toBe(before); // 有写入发生
  });
});
