/**
 * results.ts —— Plan 3 · T7 战绩榜落盘接线 + meta.lastExportedAt 持久位。
 *
 * 本文件钉三件事：
 * - **转换器归装配层**（Ruling R-T9-a）：`buildRunInput` 从 FightView/BattleState 组装
 *   RunRecord 的计分入参——这正是 core/leaderboard 明令"不在 core 层预置转换器"的那一半。
 *   逐字段断言，且 miss 计数只认 `kind==='miss'`（amount=0 的 damage 仍是命中，不得误计）。
 * - **落盘闭环**：`recordRun` → scoreRun → rankRuns 截 50 → `settings.leaderboard` →
 *   coordinator 自检 + store。用例从 `store.load()` 读回，证明"落盘"不是内存里的自我感觉。
 * - **R-T5-p3-a 持久位**：`meta.lastExportedAt` 三段式（types 可选 / validate 严检 /
 *   migrate 不补默认）+ 写入路径 `Coordinator.markExported`，使 `backupReminderDue`
 *   有真实喂入方：7 天内 false、7 天外 true、旧档缺席视作从未导出 → true。
 *
 * 时间纪律：一切时刻由测试注入（fake clock），results/persist 自身不读宿主时钟。
 * 用例编号 RB#（buildRunInput）/ RR#（recordRun）/ ME#（markExported + 提醒闭环）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, SaveFile, Sm2Params, SRSState } from '@core/types';
import type { BattleEvent, BattleState } from '@core/battle';
import type { RunRecord } from '@core/leaderboard';
import { scoreRun } from '@core/leaderboard';
import { validateSave } from '@core/saveMigrate';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { backupReminderDue } from '../../src/app/backup';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import { buildRunInput, recordRun } from '../../src/app/results';
import type { FightView } from '../../src/app/battleFlow';

// —— 仿真锚点：全部时间由测试显式注入 ——
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 86_400_000;

const PARAMS: Sm2Params = { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 };

/** buildRunInput/recordRun 的 extras 形状（brief 逐字：nowMs/domain/kind/level）。 */
type Extras = { nowMs: number; domain: string; kind: 'encounter' | 'boss'; level: number };

function makeCard(id: string): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due: NOW,
    stability: 'review',
    effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: ['t1'] };
}

function makeSave(cards: Card[], over: Partial<SaveFile> = {}): SaveFile {
  const base: SaveFile = {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '领域A', isPreset: true }],
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: PARAMS,
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: false, beatIndex: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
  };
  return { ...base, ...over };
}

/** 一份带既有榜单的存档（榜单上限/排序用例的种子）。 */
function saveWithLeaderboard(records: RunRecord[]): SaveFile {
  const save = makeSave([makeCard('lib-1')]);
  save.settings.leaderboard = records;
  return save;
}

/** 榜单行构造：score 由 scoreRun 复算（测试不手填派生值，避免与被测公式同源假绿）。 */
function runRecord(id: string, over: Partial<RunRecord> = {}): RunRecord {
  const merged: RunRecord = {
    id,
    at: NOW,
    result: 'won',
    kind: 'encounter',
    domain: 'deck-a',
    cards: 1,
    misses: 0,
    level: 1,
    score: 0,
    ...over,
  };
  if (over.score === undefined) merged.score = scoreRun(merged);
  return merged;
}

interface ViewOpts {
  pool?: string[];
  idx?: number;
  phase?: BattleState['phase'];
  log?: BattleEvent[];
}

function makeState(o: ViewOpts = {}): BattleState {
  const pool = o.pool ?? ['c1', 'c2', 'c3'];
  const phase = o.phase ?? 'won';
  return {
    phase,
    pool,
    idx: o.idx ?? pool.length,
    enemyHp: phase === 'won' ? 0 : 30,
    playerHp: 100,
    maxPlayerHp: 100,
    atk: 12,
    // 来历：D28——BattleState 扩 def/enemyPower 两字段（反击结算的消费端）。
    def: 7,
    enemyPower: 7,
    log: o.log ?? [],
  };
}

/** 手工 FightView（brief Step 1：手工视图，不借 battleFlow 的建战路径，隔离被测面）。 */
function makeView(o: ViewOpts = {}): FightView {
  const state = makeState(o);
  return { state, pool: state.pool.map((id) => makeCard(id)), current: null };
}

function extras(over: Partial<Extras> = {}): Extras {
  return { nowMs: NOW, domain: 'deck-a', kind: 'encounter', level: 4, ...over };
}

/** 便捷：把一个手工视图喂给 buildRunInput（state 参数恒取该视图的权威进度）。 */
function input(o: ViewOpts = {}, over: Partial<Extras> = {}) {
  const view = makeView(o);
  return buildRunInput(view, view.state, extras(over));
}

function useFakeClock(start: number = NOW) {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  let t = start;
  return {
    now: () => t,
    tick(ms: number) {
      t += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/** 三段可控存储：hold 让下一次 save 卡在 await 上，复现"落盘在途"窗口。 */
function stagedStore(inner: GameStorage): {
  store: GameStorage;
  hold: () => void;
  pending: () => boolean;
  release: () => Promise<void>;
} {
  let gate: (() => void) | null = null;
  let holdNext = false;
  const store: GameStorage = {
    kind: inner.kind,
    load: () => inner.load(),
    clear: () => inner.clear(),
    save: async (f) => {
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((res) => {
          gate = res;
        });
      }
      return inner.save(f);
    },
  };
  return {
    store,
    hold: () => {
      holdNext = true;
    },
    pending: () => gate !== null,
    release: async () => {
      holdNext = false;
      const g = gate;
      gate = null;
      g?.();
      await drainMicrotasks();
    },
  };
}

/** 起一个接在指定存储上的 coordinator（有存档则先预置，模拟"旧档在场"）。 */
async function makeCoord(store: GameStorage, clock: { now: () => number }): Promise<Coordinator> {
  return createCoordinator(store, { now: clock.now });
}

/** 便捷：以"单卡池、打完即胜"的手工视图记一局（level 控制分数）。 */
async function recordWin(
  coord: Coordinator,
  over: Partial<Extras> = {},
  o: ViewOpts = {},
): Promise<RunRecord> {
  const view = makeView({ pool: ['c1'], idx: 1, ...o });
  return recordRun(coord, view, view.state, extras(over));
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildRunInput —— BattleState → RunInput 的装配层转换器（R-T9-a 兑现处）
// ---------------------------------------------------------------------------

describe('buildRunInput —— 战斗视图 → 计分入参（装配层转换器）', () => {
  it('RB#1 手工 FightView 逐字段正确：cards=min(idx,池长)、misses 只数 miss、at=nowMs', () => {
    expect(
      input({
        pool: ['c1', 'c2', 'c3'],
        idx: 3,
        phase: 'won',
        log: [
          { kind: 'damage', cardId: 'c1', amount: 12 },
          { kind: 'miss', cardId: 'c2' },
          { kind: 'damage', cardId: 'c3', amount: 30 },
          { kind: 'end' },
        ],
      }),
    ).toEqual({
      at: NOW,
      result: 'won',
      kind: 'encounter',
      domain: 'deck-a',
      cards: 3,
      misses: 1,
      level: 4,
    });
  });

  it('RB#2 miss 计数不误计 amount=0 的 damage（new 卡 0 伤害仍是命中）', () => {
    const got = input({
      idx: 2,
      log: [{ kind: 'damage', cardId: 'c1', amount: 0 }, { kind: 'damage', cardId: 'c2', amount: 7 }],
    });
    expect(got.misses).toBe(0);
  });

  it('RB#3 cards = min(idx, pool.length)：脏 idx 越出池尾时按池长截断，不放大释放面', () => {
    expect(input({ pool: ['c1', 'c2', 'c3'], idx: 9 }).cards).toBe(3);
    expect(input({ pool: ['c1', 'c2', 'c3'], idx: 1 }).cards).toBe(1);
    expect(input({ pool: ['c1', 'c2', 'c3'], idx: 3 }).cards).toBe(3);
  });

  it('RB#4 result 由 phase 判定：won→won，lost/answering/域外→lost（未完局保守）', () => {
    expect(input({ phase: 'won' }).result).toBe('won');
    expect(input({ phase: 'lost' }).result).toBe('lost');
    expect(input({ phase: 'answering' }).result).toBe('lost');
    const view = makeView({ phase: 'won' });
    (view.state as { phase: string }).phase = 'draw'; // 域外枚举：宁保守不虚高
    expect(buildRunInput(view, view.state, extras()).result).toBe('lost');
  });

  it('RB#5 at 来自入参 nowMs：宿主时钟被拨动也不影响（装配层不读钟）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 10 * DAY);
    expect(input({}, { nowMs: NOW }).at).toBe(NOW);
  });

  it('RB#6 纯函数：不改动 view/state/extras 任何一个入参', () => {
    const view = makeView({
      log: [{ kind: 'miss', cardId: 'c1' }, { kind: 'damage', cardId: 'c2', amount: 3 }],
    });
    const e = extras({ kind: 'boss' });
    const beforeView = structuredClone(view);
    const beforeState = structuredClone(view.state);
    const beforeExtras = structuredClone(e);
    buildRunInput(view, view.state, e);
    expect(view).toStrictEqual(beforeView);
    expect(view.state).toStrictEqual(beforeState);
    expect(e).toStrictEqual(beforeExtras);
  });

  it('RB#7 kind 透传：boss 局原样，域外值保守归 encounter', () => {
    expect(input({}, { kind: 'boss' }).kind).toBe('boss');
    const e = extras();
    (e as { kind: string }).kind = 'raid';
    const view = makeView();
    expect(buildRunInput(view, view.state, e).kind).toBe('encounter');
  });

  it('RB#8 脏数值消毒：idx/level 非有限或负数归 0、小数向下取整；非数组池/log 归空；缺 state 保守', () => {
    expect(input({ pool: ['c1', 'c2'], idx: Number.NaN }, { level: Number.NaN })).toMatchObject({
      cards: 0,
      level: 0,
    });
    expect(input({ pool: ['c1', 'c2'], idx: 1 }, { level: -3 }).level).toBe(0);
    expect(input({ idx: -5 }).cards).toBe(0);
    expect(input({ pool: ['c1', 'c2', 'c3'], idx: 2.9 }).cards).toBe(2);
    expect(input({ idx: 1, log: 'oops' as never }).misses).toBe(0);

    const noPool = { state: makeState(), pool: null as never, current: null } as FightView;
    expect(buildRunInput(noPool, noPool.state, extras()).cards).toBe(0);
    // 缺 state：不猜胜负、不放大消耗（保守 lost / cards=0）
    const stray = makeView();
    expect(buildRunInput(stray, null as never, extras())).toMatchObject({ result: 'lost', cards: 0, misses: 0 });
  });

  it('RB#9 脏 domain/nowMs 消毒：空串或非字符串 domain → "unknown"，非法 nowMs → 0（不产 NaN 毒化整包自检）', () => {
    expect(input({}, { domain: '' }).domain).toBe('unknown');
    expect(input({}, { domain: 42 as never }).domain).toBe('unknown');
    expect(input({}, { nowMs: Number.NaN }).at).toBe(0);
    expect(input({}, { nowMs: Number.POSITIVE_INFINITY }).at).toBe(0);
    // 合法（含 1970 前）时间戳原样保留，不误伤
    expect(input({}, { nowMs: -1000 }).at).toBe(-1000);
  });

  it('RB#10 state 参数为权威进度：与 view.state 不一致时以显式传入的 state 为准', () => {
    const stale = makeView({ phase: 'answering', idx: 1 });
    const finished = makeState({ phase: 'won', idx: 3, pool: ['c1', 'c2', 'c3'] });
    const got = buildRunInput(stale, finished, extras());
    expect(got.result).toBe('won');
    expect(got.cards).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// recordRun —— scoreRun → rankRuns(50) → settings.leaderboard → 落盘
// ---------------------------------------------------------------------------

describe('recordRun —— 战绩落盘到 settings.leaderboard', () => {
  it('RR#1 一局落榜：分数按 scoreRun 公式、记录写进 store、validateSave 过', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(saveWithLeaderboard([]));
    const coord = await makeCoord(raw, clock);

    const view = makeView({
      pool: ['c1', 'c2', 'c3'],
      idx: 3,
      phase: 'won',
      log: [{ kind: 'miss', cardId: 'c1' }, { kind: 'damage', cardId: 'c2', amount: 30 }],
    });
    const rec = await recordRun(coord, view, view.state, extras());

    // (3−1)×10 + 4×5 = 40（encounter 无 Boss 加成）
    expect(rec.score).toBe(40);
    expect(typeof rec.id).toBe('string');
    expect(rec.id.length).toBeGreaterThan(0);
    expect(rec.at).toBe(NOW);

    const stored = await raw.load();
    expect(stored).not.toBeNull();
    expect(validateSave(stored).ok).toBe(true);
    expect(stored!.settings.leaderboard).toEqual([rec]);
  });

  it('RR#2 排序：score 降序、同分 at 新者前（落盘后顺序即为榜序）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(saveWithLeaderboard([]));
    const coord = await makeCoord(raw, clock);

    const low = await recordWin(coord, { level: 1 }); // 10 + 5 = 15
    clock.tick(1000);
    const high1 = await recordWin(coord, { level: 5, nowMs: clock.now() }); // 35
    clock.tick(1000);
    const high2 = await recordWin(coord, { level: 5, nowMs: clock.now() }); // 35，同分更新

    expect([low.score, high1.score, high2.score]).toEqual([15, 35, 35]);
    const stored = await raw.load();
    expect(stored!.settings.leaderboard!.map((r) => r.id)).toEqual([high2.id, high1.id, low.id]);
  });

  it('RR#3 上限 50 截尾：高分挤掉末位、低分进不了榜，榜长恒 ≤ 50', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    // 50 条既有记录：score = 10 + 5k，最低 old-0=15、最高 old-49=260
    const existing = Array.from({ length: 50 }, (_, i) =>
      runRecord(`old-${i}`, { cards: 1, misses: 0, level: 1 + i, at: NOW + i }),
    );
    await raw.save(saveWithLeaderboard(existing));
    const coord = await makeCoord(raw, clock);

    const high = await recordWin(coord, { level: 999 });
    let rows = (await raw.load())!.settings.leaderboard!;
    expect(rows).toHaveLength(50);
    expect(rows.map((r) => r.id)).toContain(high.id);
    expect(rows.map((r) => r.id)).not.toContain('old-0'); // 末位被挤掉

    const low = await recordWin(coord, { level: 0 });
    rows = (await raw.load())!.settings.leaderboard!;
    expect(rows).toHaveLength(50);
    expect(low.score).toBe(10);
    expect(rows.map((r) => r.id)).not.toContain(low.id); // 低分不占榜位
    expect(validateSave((await raw.load())!).ok).toBe(true);
  });

  it('RR#4 旧档（settings 无 leaderboard 字段）照样能记：落成单元素榜，不炸不整包拒', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const old = makeSave([makeCard('a1')]);
    delete (old.settings as { leaderboard?: RunRecord[] }).leaderboard;
    await raw.save(old);
    const coord = await makeCoord(raw, clock);
    expect(validateSave(coord.snapshot()).ok).toBe(true);

    const rec = await recordWin(coord, { level: 2 });
    const stored = await raw.load();
    expect(stored!.settings.leaderboard).toEqual([rec]);
    expect(validateSave(stored).ok).toBe(true);
  });

  it('RR#5 返回的 RunRecord 与榜内条目逐字段一致（调用方可直接展示/上屏）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(saveWithLeaderboard([]));
    const coord = await makeCoord(raw, clock);

    const view = makeView({ pool: ['c1', 'c2'], idx: 2 });
    const rec = await recordRun(coord, view, view.state, extras({ kind: 'boss' }));
    const stored = await raw.load();
    expect(stored!.settings.leaderboard![0]).toEqual(rec);
    expect(rec.score).toBe(scoreRun(rec)); // 与 core 公式独立复算口径一致
  });

  it('RR#6 lost 局也认账（score=0 仍入榜，榜上留痕）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(saveWithLeaderboard([]));
    const coord = await makeCoord(raw, clock);

    const view = makeView({ phase: 'lost', pool: ['c1', 'c2'], idx: 2 });
    const rec = await recordRun(coord, view, view.state, extras());
    expect(rec.result).toBe('lost');
    expect(rec.score).toBe(0);
    expect((await raw.load())!.settings.leaderboard).toEqual([rec]);
  });

  it('RR#7 R-T4-p3-d 收口：await recordRun 返回即"这次改动已持久"（flush 成功且无脏）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(saveWithLeaderboard([]));
    const coord = await makeCoord(raw, clock);

    const rec = await recordWin(coord);
    expect(await coord.flush()).toBe(true);
    expect(coord.dirty()).toBe(false);
    expect((await raw.load())!.settings.leaderboard).toEqual([rec]);
  });

  it('RR#8 在途写未落时 recordRun 不返回：store 未写前不得假装"已持久"', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(saveWithLeaderboard([]));
    const staged = stagedStore(raw);
    const coord = await makeCoord(staged.store, clock);

    staged.hold();
    const pending = recordWin(coord);
    await drainMicrotasks();
    expect(staged.pending()).toBe(true); // 写卡在 store.save 上，recordRun 仍在等

    await staged.release();
    const rec = await pending;
    expect((await raw.load())!.settings.leaderboard).toEqual([rec]);
    expect(coord.dirty()).toBe(false);
  });

  it('RR#9 id 由记录内容确定性派生：同参同 id、时间不同则不同（不引入随机源/计数器）', async () => {
    const clock = useFakeClock(NOW);
    const rawA = createMemoryStorage();
    const rawB = createMemoryStorage();
    await rawA.save(saveWithLeaderboard([]));
    await rawB.save(saveWithLeaderboard([]));
    const coordA = await makeCoord(rawA, clock);
    const coordB = await makeCoord(rawB, clock);

    const a = await recordWin(coordA);
    const b = await recordWin(coordB); // 另一份存储、同一时刻同一视图
    expect(a.id).toBe(b.id);
    clock.tick(1);
    const c = await recordWin(coordA, { nowMs: clock.now() });
    expect(c.id).not.toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// R-T5-p3-a：meta.lastExportedAt 持久位 + 7 天提醒闸门的真实喂入方
// ---------------------------------------------------------------------------

describe('markExported / meta.lastExportedAt —— 7 天备份提醒闭环（R-T5-p3-a）', () => {
  it('ME#1 markExported 经 mutate 落盘 meta.lastExportedAt，重建 coordinator 后存活', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const coord = await makeCoord(raw, clock);

    // M-2：返回值就是"有没有记上并落净"——true 不再只是"调用没报错"
    expect(await coord.markExported(clock.now())).toBe(true);
    expect(coord.dirty()).toBe(false); // 写入路径自带持久收口
    const stored = await raw.load();
    expect(stored!.meta.lastExportedAt).toBe(NOW);
    expect(validateSave(stored).ok).toBe(true);

    const revived = await createCoordinator(raw, { now: clock.now });
    expect(revived.snapshot().meta.lastExportedAt).toBe(NOW);
  });

  it('ME#2 闸门喂真实数据：7 天内 false、恰好 7 天 / 更久 true', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const coord = await makeCoord(raw, clock);
    await coord.markExported(clock.now());

    const last = (await raw.load())!.meta.lastExportedAt ?? null;
    expect(last).toBe(NOW);
    expect(backupReminderDue(last, NOW)).toBe(false); // 刚导出
    expect(backupReminderDue(last, NOW + 7 * DAY - 1)).toBe(false); // 差 1ms 到 7 天
    expect(backupReminderDue(last, NOW + 7 * DAY)).toBe(true); // 满 7 天：提醒
    expect(backupReminderDue(last, NOW + 30 * DAY)).toBe(true);
  });

  it('ME#3 旧档缺席该字段：迁移后仍合法，闸门视作"从未导出"→ true', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const legacy = makeSave([makeCard('a1')]);
    legacy.meta.savedAt = NOW - 30 * DAY; // 很久以前保存过，但从未导出
    await raw.save(legacy);
    const coord = await makeCoord(raw, clock);

    const snap = coord.snapshot();
    expect('lastExportedAt' in snap.meta).toBe(false);
    expect(validateSave(snap).ok).toBe(true);
    expect(backupReminderDue(snap.meta.lastExportedAt ?? null, clock.now())).toBe(true);
  });

  it('ME#4 非法时刻 fail-closed：不写脏值、不标脏、不毒化整包自检（含 I1 的 1e300 上界）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const seeded = makeSave([makeCard('a1')]);
    seeded.meta.plays = 1;
    await raw.save(seeded);
    const coord = await makeCoord(raw, clock);

    // 非法域三档：非有限 / 负值 / **超上界**。超上界是 T7 评审判 I1 实证的漏网档：
    // 修复前 markExported(1e300) 会把 1e300 写进权威位 ⇒ 此后 validateSave 整包拒 ⇒
    // dirty 恒 true、flush() 恒 false、无关改动也永久落不了盘（自检失败无自愈路径）。
    // M-2：非法域五档一律返回 false（"没记上"必须能被调用方判定，而不是静默 void）
    expect(await coord.markExported(Number.NaN)).toBe(false);
    expect(await coord.markExported(-1)).toBe(false);
    expect(await coord.markExported(Number.POSITIVE_INFINITY)).toBe(false);
    expect(await coord.markExported(1e300)).toBe(false);
    expect(await coord.markExported(8.64e15 + 1)).toBe(false); // 越界 1ms 也不得放行（守卫与存储域严格同界）
    expect(coord.snapshot().meta.lastExportedAt).toBeUndefined();
    expect('lastExportedAt' in coord.snapshot().meta).toBe(false); // fail-closed：字段根本没被写
    expect(coord.dirty()).toBe(false);
    expect(validateSave(coord.snapshot()).ok).toBe(true);

    // I1 的回归证据：非法调用之后，**无关改动照样能落盘**（毒化未发生）
    await coord.mutate((s) => {
      s.meta.plays = 99;
    });
    expect(await coord.flush()).toBe(true);
    expect(coord.dirty()).toBe(false);
    expect((await raw.load())!.meta.plays).toBe(99);

    // 后续合法调用仍能正常工作（脏值没有被写进权威位）
    expect(await coord.markExported(clock.now())).toBe(true);
    expect(coord.snapshot().meta.lastExportedAt).toBe(NOW);
  });

  it('ME#6 上界边界：8.64e15 合法可写（与 validateSave 同域），且落盘后能读回', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const coord = await makeCoord(raw, clock);

    expect(await coord.markExported(8.64e15)).toBe(true); // Date 可表示范围的上界本身：合法
    expect(coord.dirty()).toBe(false);
    expect(validateSave(coord.snapshot()).ok).toBe(true);
    expect((await raw.load())!.meta.lastExportedAt).toBe(8.64e15);
  });

  it('ME#5 markExported 不碰业务数据：plays/榜单/进度/cards 逐字原样（savedAt 归既有落盘刷新）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const seeded = makeSave([makeCard('a1')]);
    seeded.meta.savedAt = NOW - 1000;
    seeded.meta.plays = 7;
    seeded.settings.leaderboard = [runRecord('keep-1')];
    await raw.save(seeded);
    const coord = await makeCoord(raw, clock);
    const before = structuredClone(coord.snapshot());

    await coord.markExported(clock.now());

    const after = coord.snapshot();
    expect(after.settings).toStrictEqual(before.settings);
    expect(after.cards).toStrictEqual(before.cards);
    expect(after.meta.plays).toBe(7);
    expect(after.meta.lastExportedAt).toBe(NOW);
    // savedAt 由落盘路径统一刷新（persist 既有行为），不是 markExported 的副作用
    expect(after.meta.savedAt).toBe(NOW);
  });
});
