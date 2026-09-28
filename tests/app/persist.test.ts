/**
 * persist.ts —— Plan 3 · T4 PersistenceCoordinator：攒批落盘 + 崩溃一致性。
 *
 * 两条红线在此兑现（brief verbatim）：
 * - RF#1 写放大：debounce 窗内 mutate×N 只触发一次 store 写（spy 计数断言钉死），
 *   maxBatchMs（默认 5000）超时自动落盘——移动端配额与耗电的保护面；
 * - RF#2 崩溃一致性：flush 之前丢弃 coordinator = 回滚到最后一次 flush，
 *   恢复后 validateSave 过（半途状态永不入存储是唯一的持久真相来源）。
 *
 * 另三项本任务专属义务：
 * - save reject（配额模拟）→ dirty 保持、flush 返回 false、错误经返回值上抛给 UI 层
 *   （console 之外不落——断言 console.error/warn/log spy 零调用）；
 * - 落盘前 structuredClone + validateSave 自检：内存对象被外部 mutate 不影响已存值
 *   （N-5 推广，独立于 memoryStore 自身的写入拷贝）；
 * - settleAndRecord 编排点（R-T3-p3-b / M-2 的落库义务）：settleFight 的
 *   {cards,exp,won} → mutate 写 cards / progress.exp / meta.plays，用例钉
 *   "打完一局 → flush → load 后 progress.exp>0 且 levelFromExp 前进"。
 *
 * 时间纪律：vi.useFakeTimers + 注入 now（opts.now），全程不碰真实时钟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Deck, SaveFile, Sm2Params, SourceInfo, SRSState, Stability } from '@core/types';
import type { Rng } from '@core/rng';
import { GRADES } from '@core/sm2';
import { createBattle, answer, type BattleState } from '@core/battle';
import { domainReviewCount } from '@core/reviewLedger';
import { validateSave } from '@core/saveMigrate';
import { deriveStats, victoryExp } from '@core/stats';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { startFight, answerCurrent, type FightView } from '../../src/app/battleFlow';
import { levelFromExp, playerStatsFor, settleFight } from '../../src/app/growth';
import type { FlushResult } from '../../src/app/persist';
import {
  createCoordinator,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_BATCH_MS,
  SaveReadOnlyError,
  type Coordinator,
} from '../../src/app/persist';

// —— 仿真锚点：全部时间由测试显式注入，coordinator 不读时钟 ——
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0); // tz=+480 → 本地日键 2026-10-26
const TZ = 480; // UTC+8
/**
 * 夹具参数（喂 settleFight 的 deps.params）。firstInterval=1 天**有意与种子档默认不同**：
 * 本文件只验 persist 的落库编排，SRS 推进的具体间隔属 core/sm2 的职责（其缺省是
 * 10/60 亚日小数）；用天级参数可让 stability 晋升落在可读区间，与本仓其余 app 层
 * 夹具（growth.test.ts:32 同值）保持一致。它不代表产品默认——见 PC#1 的 SEED_PARAMS。
 */
const PARAMS: Sm2Params = { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 };
/**
 * 种子档默认参数（PC#1 的期望）。与 src/core/sm2.ts FALLBACK_PARAMS 逐字同值：
 * 全仓生产代码里 Sm2Params 只有两处字面量（core/sm2 的兜底、persist 的种子），
 * 二者必须同源；firstInterval=1 只出现在测试夹具中，不是任何产品默认。
 */
const SEED_PARAMS: Sm2Params = { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 };
/** rng≡0.5 → uniform(0.9,1.1) 恰为 1.0，伤害无浮动。 */
const HALF: Rng = () => 0.5;

interface CardOpts {
  stability?: Stability;
  due?: number;
  deckId?: string;
  source?: SourceInfo | undefined;
  lapses?: number;
  reps?: number;
  interval?: number;
  days?: string[];
}

function makeCard(id: string, over: CardOpts = {}): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: over.interval ?? (over.stability === 'review' || over.stability === 'mastered' ? 10 : 0),
    reps: over.reps ?? 3,
    lapses: over.lapses ?? 0,
    due: over.due ?? 0,
    stability: over.stability ?? 'review',
    effectiveReviewDays: over.days ?? [],
  };
  return { id, deckId: over.deckId ?? 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [], source: over.source };
}

function manualSource(createdAt = NOW): SourceInfo {
  return { type: 'manual', createdAt };
}

/** 一份整包合法的存档（validateSave 过的形状），供 seedStore 预置。 */
function makeSave(cards: Card[], over: Partial<SaveFile> = {}): SaveFile {
  const decks: Deck[] = [{ id: 'deck-a', name: '领域A', isPreset: true }];
  return {
    schemaVersion: 1,
    decks,
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: PARAMS,
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
    },
    meta: { savedAt: NOW, plays: 0 },
    ...over,
  };
}

async function seedStore(store: GameStorage, save: SaveFile): Promise<void> {
  await store.save(save);
}

/** store 包一层写计数 spy（RF#1 的唯一取证手段）。 */
function wrapStore(inner: GameStorage): { store: GameStorage; saves: () => number; loaded: () => number } {
  let saveCount = 0;
  let loadCount = 0;
  const store: GameStorage = {
    kind: inner.kind,
    async load() {
      loadCount += 1;
      return inner.load();
    },
    async save(f: SaveFile) {
      saveCount += 1;
      return inner.save(f);
    },
    async clear() {
      return inner.clear();
    },
  };
  return { store, saves: () => saveCount, loaded: () => loadCount };
}

/** 失败型存储（配额模拟）：save 一律 reject，load/clear 透传底层。 */
function failingStore(inner: GameStorage, message = 'QuotaExceededError: 存储空间不足'): GameStorage {
  return {
    kind: inner.kind,
    load: () => inner.load(),
    clear: () => inner.clear(),
    save: () => Promise.reject(new Error(message)),
  };
}

/**
 * 可控时钟：tick(ms) 同时推进 fake timers 与注入的 now。
 *
 * `setSystemTime(start)` 是这条时间纪律成立的前提，不是可省的配置：
 * vi.useFakeTimers() 会接管 Date.now，但**起点默认取真实时刻**。本文件起点 NOW 是
 * 2026-10-26（晚于跑测试那一刻约 28 天），若不对齐，宿主时间轴（setTimeout 挂在
 * 这条轴上）与注入 now 就差了约 2.4e9 毫秒——persist 按注入时钟算出的等待时长
 * （几百到几千毫秒）在宿主轴上早已被"跨过"，定时器随时可能在任意微任务交接处抢跑，
 * debounce/maxBatch 的窗口边界因此不可复现（RF1#2/#3/#4、Q#4、CT#2 全部失准）。
 * 对齐后两把时钟同源同起点，advanceTimersByTime(n) 恰等于注入时钟走 n 毫秒。
 */
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

/** 排干微任务队列（mutate 的 fn 是 async，落账需要一次 microtask 交接）。 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/**
 * 失败原因提取（判别联合收窄用）：tsconfig strict 下 FlushResult 是
 * {ok:true} | {ok:false;reason} 联合，直接读 .reason 不过 typecheck
 *（接管轮补跑 verify 时暴露：此前只跑过 npm test，漏了类型门）。
 * 调用点均已先断言 ok===false，故此处的成功分支取值只为类型完整。
 */
function reasonOf(r: FlushResult): string {
  return r.ok ? '' : r.reason;
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
// 初始态：load() 优先，null → 种子档
// ---------------------------------------------------------------------------

describe('createCoordinator 初始态 —— load 优先 / null 走种子档', () => {
  it('PC#1 空存储 → 内存种子档 decks=[] cards=[] settings 默认 meta{savedAt:now(),plays:0}，且 validateSave 过', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });

    const snap = coord.snapshot();
    expect(snap.decks).toEqual([]);
    expect(snap.cards).toEqual([]);
    expect(snap.settings.bossThresholdTier).toBe(30);
    expect(snap.settings.sm2Params).toEqual(SEED_PARAMS);
    // 种子参数与 core 兜底同源：亚日 firstInterval 在 sm2 里是设计内形态
    //（saveMigrate.ts:137 明确「<1 天允许小数」），不是被误杀的形状。
    expect(snap.settings.sm2Params.firstInterval).toBeLessThan(1);
    expect(snap.settings.battle).toEqual({ defaultPoolSize: 15 });
    expect(snap.settings.progress).toEqual({ exp: 0 });
    expect(snap.meta).toEqual({ savedAt: NOW, plays: 0 });
    expect(validateSave(snap).ok).toBe(true);
    clock.tick(1234);
    expect(coord.lastSavedAt()).toBeNull(); // 未落盘过
    expect(coord.dirty()).toBe(false); // 种子档本身不算脏
  });

  it('PC#2 种子档首次 mutate 即建引用闭合：新卡 deckId 指向新建的领域卡组', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.cards.push(makeCard('c1'));
    });
    expect(coord.snapshot().decks.map((d) => d.id)).toEqual(['deck-a']);
    expect(validateSave(coord.snapshot()).ok).toBe(true);
  });

  it('PC#3 已有存档 → 以存储内容初始化（非种子），progress 缺席时补默认而非拒绝', async () => {
    const clock = useFakeClock(NOW);
    const seeded = makeSave([makeCard('x1')], { meta: { savedAt: NOW - 500, plays: 7 } });
    // M-1：夹具必须**真删** progress——标题承诺的是"迁移路径"，而 makeSave 自带合法
    // progress 时这条用例只走"已合法新档"分支，迁移承诺无人覆盖（C-1 的根因正由此漏网）。
    delete (seeded.settings as { progress?: unknown }).progress;
    const inner = createMemoryStorage();
    await seedStore(inner, seeded);
    const coord = await createCoordinator(inner, { now: clock.now });
    expect(coord.snapshot().cards.map((c) => c.id)).toEqual(['x1']);
    expect(coord.snapshot().meta.plays).toBe(7);
    expect(coord.snapshot().settings.progress).toEqual({ exp: 0 }); // migrateSave 补的默认
    expect(coord.readOnly()).toBe(false); // 旧档可迁移 ⇒ 不是只读态
    expect(coord.dirty()).toBe(false);
    expect(validateSave(coord.snapshot()).ok).toBe(true);
  });

  it('PC#4 存储里是畸形档（schemaVersion 2）→ 拒绝覆盖灾难：回落种子档并给出 reason', async () => {
    const clock = useFakeClock(NOW);
    const inner = createMemoryStorage();
    await inner.save({ schemaVersion: 2 } as unknown as SaveFile);
    // 用数组收集回调参数（接管轮补跑 typecheck 暴露）：reason 只在闭包里被赋值，
    // strict 流分析视其在同步路径恒为初始 null，写成 let reason: string|null 后
    // 任何 `reason !== null` 判定都会被收窄成 never、取 .length 不过编译。
    // 数组元素访问没有这个问题，且天然能断言"回调至少被调用一次"。
    const reported: string[] = [];
    const coord = await createCoordinator(inner, {
      now: clock.now,
      onRecoverableLoadError: (r) => {
        reported.push(r);
      },
    });
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0].length).toBeGreaterThan(0);
    expect(coord.snapshot().cards).toEqual([]);
    // 关键：不把种子档静默刷回存储——那会毁掉用户唯一的数据副本
    expect(await inner.load()).not.toEqual(coord.snapshot());
  });
});

// ---------------------------------------------------------------------------
// Final Fix Wave · C-1 —— 载入路径走 migrateSave + 只读闩锁
// ---------------------------------------------------------------------------

/**
 * 旧形状档（T3 前，缺 `settings.progress`）：造一份合法档后**真删** progress。
 * 这是 C-1 的复现夹具——载入路径不走 migrateSave 时它会被当成坏档整包拒
 * （validateSave 对 progress 是"缺席整包拒"）。
 */
function legacySaveWithoutProgress(cards: Card[], plays: number, savedAt = NOW - 500): SaveFile {
  const save = makeSave(cards, { meta: { savedAt, plays } });
  delete (save.settings as { progress?: unknown }).progress;
  return save;
}

describe('Final Fix Wave · C-1（终审 Critical）—— 载入走 migrateSave + 只读闩锁', () => {
  it('C1#1 真缺 progress 的旧档（1 卡 + plays=9）载入：cards/plays 保留，store 逐字节不变', async () => {
    const clock = useFakeClock(NOW);
    const inner = createMemoryStorage();
    const legacy = legacySaveWithoutProgress([makeCard('legacy-1')], 9);
    await seedStore(inner, legacy);
    const before = JSON.stringify(await inner.load());

    const coord = await createCoordinator(inner, { now: clock.now });

    // 修复前：validateSave 整包拒 ⇒ 种子档接管 ⇒ live.cards=0 / live.plays=0（用户的档当场"消失"）
    expect(coord.snapshot().cards.map((c) => c.id)).toEqual(['legacy-1']);
    expect(coord.snapshot().meta.plays).toBe(9);
    expect(coord.snapshot().settings.progress).toEqual({ exp: 0 }); // migrateSave 补默认，不是丢档
    expect(coord.readOnly()).toBe(false); // 可迁移 ⇒ 正常可写
    expect(coord.dirty()).toBe(false);
    // 载入本身不写存储（RF#2：store 里永远只有"某次成功 flush 的完整快照"）
    expect(JSON.stringify(await inner.load())).toBe(before);
  });

  it('C1#2 旧档载入后的"下一次写"只把用户数据写回去（修复前：种子档覆盖 → cards=0/plays=0）', async () => {
    const clock = useFakeClock(NOW);
    const inner = createMemoryStorage();
    await seedStore(inner, legacySaveWithoutProgress([makeCard('legacy-1')], 9));
    const coord = await createCoordinator(inner, { now: clock.now });

    expect(await coord.markExported(clock.now())).toBe(true);
    const stored = (await inner.load())!;
    expect(stored.cards.map((c) => c.id)).toEqual(['legacy-1']); // 修复前 []
    expect(stored.meta.plays).toBe(9); // 修复前 0
    expect(stored.meta.lastExportedAt).toBe(clock.now());
  });

  it('C1#3 不可恢复坏档（schemaVersion:2）→ 种子档接管 + readOnly 闩锁 + store 逐字节不变', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save({ schemaVersion: 2 } as unknown as SaveFile);
    const before = JSON.stringify(await raw.load());
    const { store, saves } = wrapStore(raw);

    const coord = await createCoordinator(store, { now: clock.now });

    // ① 判别位：UI 据此提示"存档无法读取，请勿继续写"
    expect(coord.readOnly()).toBe(true);
    // ② 种子档接管内存（UI 还能开局），但**绝不写回**
    expect(coord.snapshot().cards).toEqual([]);
    expect(coord.dirty()).toBe(false);
    expect(coord.lastSavedAt()).toBeNull();
    // ③ 收口面用失败位（不是抛错）：flush()===false / flushDetailed 带 reason
    expect(await coord.flush()).toBe(false);
    const detailed = await coord.flushDetailed();
    expect(detailed.ok).toBe(false);
    expect(reasonOf(detailed)).toContain('只读');
    // ④ 写入面一律 fail-closed 抛 SaveReadOnlyError（mutate / settleAndRecord / markDirty）
    await expect(coord.mutate((s) => { s.meta.plays = 1; })).rejects.toBeInstanceOf(SaveReadOnlyError);
    await expect(coord.settleAndRecord({ cards: [makeCard('nope')], exp: 5, won: true })).rejects.toBeInstanceOf(SaveReadOnlyError);
    expect(() => coord.markDirty()).toThrow(SaveReadOnlyError);
    // ⑤ markExported 用失败位（它的语义本就是"有没有记上"）
    expect(await coord.markExported(clock.now())).toBe(false);

    // ⑥ 悬着的窗口走完也不写（"存储原样保留"从承诺变成事实）
    clock.tick(DEFAULT_MAX_BATCH_MS + DEFAULT_DEBOUNCE_MS + 1);
    await drainMicrotasks();
    expect(saves()).toBe(0);
    expect(JSON.stringify(await raw.load())).toBe(before); // 逐字节不变（含 schemaVersion:2 原档）
    expect(coord.dirty()).toBe(false);
  });

  it('C1#4 load() 抛错（存储读不出）同样进只读态：不写入、不假装成功', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(legacySaveWithoutProgress([makeCard('survivor')], 3));
    const before = JSON.stringify(await raw.load());
    const store: GameStorage = {
      kind: raw.kind,
      load: () => Promise.reject(new Error('IDB 权限突变')),
      save: (f) => raw.save(f),
      clear: () => raw.clear(),
    };
    const reported: string[] = [];
    const coord = await createCoordinator(store, {
      now: clock.now,
      onRecoverableLoadError: (r) => reported.push(r),
    });
    expect(reported.length).toBe(1);
    expect(coord.readOnly()).toBe(true);
    expect(await coord.flush()).toBe(false);
    expect(JSON.stringify(await raw.load())).toBe(before);
  });

  it('C1#5 正常存档不受只读闩锁波及：readOnly()===false，写入面照旧', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('ok-1')]));
    const coord = await createCoordinator(raw, { now: clock.now });
    expect(coord.readOnly()).toBe(false);
    await coord.mutate((s) => { s.meta.plays = 4; });
    expect(await coord.flush()).toBe(true);
    expect((await raw.load())!.meta.plays).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Final Fix Wave · M-2 —— markExported 的返回值是"有没有记上并落净"
// ---------------------------------------------------------------------------

describe('Final Fix Wave · M-2 —— markExported 不再吞掉收口结果', () => {
  it('M2#1 收口失败（配额满）⇒ 返回 false，脏位保留待退避重试', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const coord = await createCoordinator(failingStore(raw), { now: clock.now });

    expect(await coord.markExported(clock.now())).toBe(false);
    // 权威位里有值，但"已持久"的承诺没兑现 ⇒ dirty 必须留着（Q#4 的退避窗接着兜）
    expect(coord.snapshot().meta.lastExportedAt).toBe(NOW);
    expect(coord.dirty()).toBe(true);
  });

  it('M2#2 成功路径返回 true，且此刻确实已在存储里', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const coord = await createCoordinator(raw, { now: clock.now });

    expect(await coord.markExported(NOW)).toBe(true);
    expect(coord.dirty()).toBe(false);
    expect((await raw.load())!.meta.lastExportedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// RF#1 写放大保护
// ---------------------------------------------------------------------------

describe('RF#1 —— debounce 窗内 mutate×N 只触发一次写', () => {
  it('RF1#1 10 次 mutate：窗内 store.load 仍旧值 / save spy 计数 0；flush 后新值且计数恰 1', async () => {
    const clock = useFakeClock(NOW);
    const seeded = makeSave([makeCard('a1')]);
    const raw = createMemoryStorage();
    await seedStore(raw, seeded);
    const { store, saves } = wrapStore(raw);
    const coord = await createCoordinator(store, { now: clock.now });

    for (let i = 0; i < 10; i++) {
      await coord.mutate((s) => {
        s.meta.plays += 1;
      });
    }
    expect(coord.dirty()).toBe(true);
    expect(saves()).toBe(0);
    expect((await raw.load())!.meta.plays).toBe(0); // 落盘前旧值

    const okFlush = await coord.flush();
    expect(okFlush).toBe(true);
    expect(saves()).toBe(1);
    expect((await raw.load())!.meta.plays).toBe(10);
    expect(coord.dirty()).toBe(false);
    expect(coord.lastSavedAt()).toBe(NOW);
  });

  it('RF1#2 窗内后续 mutate 顺延 debounce：共写 1 次', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    clock.tick(100);
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    clock.tick(100);
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    clock.tick(200);
    await vi.advanceTimersByTimeAsync(500); // debounce 到期
    expect(saves()).toBe(1);
    expect((await store.load())!.meta.plays).toBe(3);
  });

  it('RF1#3 maxBatchMs 超时强制落盘（即便 debounce 仍在顺延）', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now, maxBatchMs: 1000 });
    // debounce 取默认 500：每 200ms 一次 mutate 会把它无限顺延，只有 maxBatch 能逼出写

    for (let step = 0; step < 6; step++) {
      await coord.mutate((s) => {
        s.meta.plays += 1;
      });
      clock.tick(200);
      await vi.advanceTimersByTimeAsync(200); // 每次都落在 debounce(500) 之内
    }
    expect(saves()).toBeGreaterThanOrEqual(1); // 第 ~1000ms 被 maxBatch 逼出一次
    const afterForce = saves();
    await coord.flush();
    expect(saves()).toBeLessThanOrEqual(afterForce + 1); // 强刷后无脏数据，显式 flush 不再重复写
    expect((await store.load())!.meta.plays).toBe(6);
  });

  it('RF1#4 默认 maxBatchMs = 5000：debounce 被连续 mutate 顺延时由 maxBatch 逼出恰一次写', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    expect(DEFAULT_MAX_BATCH_MS).toBe(5000);
    const coord = await createCoordinator(store, { now: clock.now });

    // 来历修正（controller 第三轮接管，probe 实证）：原写法是"mutate → tick(1000) × 3"，
    // 但 tick 步长 1000ms 已超过 debounce(500)，每步都会正常落盘（实测 W1@1000/W2@2000/
    // W3@3000），于是 "saves()===0" 的前提自始不成立——那不是实现抢跑，而是用例把
    // "debounce 到期写"误当成了"必须攒到 maxBatch"。RF1#3 的单推版本与 RF1#1/#2 证明
    // debounce 路径本身正确，故此处改为真正能覆盖 maxBatch 的形状：
    // 每 200ms 一次 mutate（< debounce 500，反复顺延 debounce），直到 25 次后累计 5000ms
    // 触发 maxBatch 上界。锚点语义见 persist.ts 的 batchStartedAt。
    const marks: number[] = [];
    for (let i = 0; i < 25; i++) {
      await coord.mutate((s) => {
        s.meta.plays += 1;
      });
      clock.tick(200);
      await drainMicrotasks();
      marks.push(saves());
    }
    // t=1000 / t=3000 时每窗口都被下一次 mutate 顺延掉 ⇒ 一写未发生
    expect(marks[4]).toBe(0);
    expect(marks[14]).toBe(0);
    // t=5000：maxBatch 上界到点，恰一次写，且写的是全部 25 次变更的合成快照
    expect(marks[24]).toBe(1);
    expect(coord.dirty()).toBe(false);
    expect((await store.load())!.meta.plays).toBe(25);
    expect(coord.lastSavedAt()).toBe(NOW + 5000);

    // 干净状态下继续推进时钟不再有第二次写（省电：无脏不写）
    clock.tick(5000);
    await drainMicrotasks();
    expect(saves()).toBe(1);
  });

  it('RF1#5 无 mutate 时定时器不空转（省电：窗内无脏 ⇒ 无写）', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    await coord.flush();
    expect(saves()).toBe(1);
    clock.tick(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves()).toBe(1); // 干净状态下不再有第二次写
  });

  it('RF1#6 异步 mutate 串行化：fn 顺序即写入顺序，无交错丢更新', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    const p = [1, 2, 3].map((n) =>
      coord.mutate(async (s) => {
        await drainMicrotasks();
        s.meta.plays += n;
      }),
    );
    await Promise.all(p);
    await coord.flush();
    expect((await store.load())!.meta.plays).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// RF#2 崩溃一致性
// ---------------------------------------------------------------------------

describe('RF#2 —— flush 前崩溃 = 回滚到最后一次 flush', () => {
  it('RF2#1 丢弃 coordinator 后重建同一 store：数据回滚且 validateSave 过', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('keep1')]));
    const coord = await createCoordinator(raw, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 5;
    });
    await coord.flush(); // 最后一次成功 flush：plays=5
    // 崩溃前的半途改动（永不落盘）
    await coord.mutate((s) => {
      s.meta.plays = 99;
      s.cards.push(makeCard('ghost'));
    });

    // "崩溃"：丢弃 coordinator 引用，重新在同一 store 上创建
    const revived = await createCoordinator(raw, { now: clock.now });
    const restored = revived.snapshot();
    expect(restored.meta.plays).toBe(5);
    expect(restored.cards.map((c) => c.id)).toEqual(['keep1']);
    expect(validateSave(restored).ok).toBe(true);
    expect(revived.dirty()).toBe(false);
  });

  it('RF2#2 半途状态从不进存储：崩溃时刻 store 内容恒等于某次 flush 的快照', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('k')]));
    const coord = await createCoordinator(raw, { now: clock.now });
    for (let i = 0; i < 20; i++) {
      await coord.mutate((s) => {
        s.meta.plays += 1;
        if (i % 3 === 0) clock.tick(10);
      });
      if (i % 7 === 0) await coord.flush();
      const stored = await raw.load();
      expect(validateSave(stored).ok).toBe(true); // 任何时刻存储都是合法档
    }
    await coord.flush();
    expect((await raw.load())!.meta.plays).toBe(20);
  });

  it('RF2#3 崩溃后重建的 coordinator 继续工作并可再次落盘', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('k')]));
    const a = await createCoordinator(raw, { now: clock.now });
    await a.mutate((s) => {
      s.settings.progress.exp = 40;
    });
    await a.flush();
    const b = await createCoordinator(raw, { now: clock.now });
    expect(b.snapshot().settings.progress.exp).toBe(40);
    await b.mutate((s) => {
      s.settings.progress.exp += 10;
    });
    expect(await b.flush()).toBe(true);
    expect((await raw.load())!.settings.progress.exp).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// save 失败（配额）路径
// ---------------------------------------------------------------------------

describe('save reject（配额模拟）—— dirty 保持 / 返回 false / 错误经返回值上抛', () => {
  it('Q#1 配额满：flush 返回 false、dirty 保持 true、lastSavedAt 不变', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('q')]));
    const coord = await createCoordinator(failingStore(raw), { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(await coord.flush()).toBe(false);
    expect(coord.dirty()).toBe(true);
    expect(coord.lastSavedAt()).toBeNull();
    expect((await raw.load())!.meta.plays).toBe(0); // 旧档完好
  });

  it('Q#2 下次 flush 重试成功（错误一次性消费，不吞改动的权威位）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    let failNext = true;
    const store: GameStorage = {
      kind: 'memory',
      load: () => raw.load(),
      clear: () => raw.clear(),
      save: (f) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('quota'));
        }
        return raw.save(f);
      },
    };
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays = 3;
    });
    expect(await coord.flush()).toBe(false);
    expect(coord.dirty()).toBe(true);
    expect(await coord.flush()).toBe(true);
    expect(coord.dirty()).toBe(false);
    expect(coord.lastSavedAt()).toBe(NOW);
    expect((await raw.load())!.meta.plays).toBe(3);
  });

  it('Q#3 错误经返回值上抛给 UI 层，console 之外不落（spy 零调用）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const coord = await createCoordinator(failingStore(raw, 'QuotaExceededError'), { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    const result = await coord.flushDetailed();
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('QuotaExceededError');
    expect(await coord.flush()).toBe(false); // boolean 面同样判别失败
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('Q#4 配额失败后 debounce 定时器退避重排，最终自愈落盘', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    let broken = true;
    const store: GameStorage = {
      kind: 'memory',
      load: () => raw.load(),
      clear: () => raw.clear(),
      save: (f) => (broken ? Promise.reject(new Error('quota')) : raw.save(f)),
    };
    const coord = await createCoordinator(store, { now: clock.now, maxBatchMs: 1000 });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    clock.tick(600);
    await vi.advanceTimersByTimeAsync(600); // debounce → flush 尝试 → reject
    expect(coord.dirty()).toBe(true);
    broken = false;
    clock.tick(2000);
    await vi.advanceTimersByTimeAsync(2000); // 重排的窗口到期 → 自愈
    expect(coord.dirty()).toBe(false);
    expect((await raw.load())!.meta.plays).toBe(1);
  });

  it('Q#5 mutate 自身抛错（fn bug）：错误经 mutate 的 Promise 上抛，且不标脏', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await expect(
      coord.mutate(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(coord.dirty()).toBe(false);
    clock.tick(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 落盘前自检与快照隔离（N-5 推广）
// ---------------------------------------------------------------------------

describe('structuredClone + validateSave 自检 —— 快照隔离', () => {
  it('SN#1 落盘后外部 mutate 内存对象不影响已存值（独立于 store 的写入拷贝）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const spy = { n: 0 };
    const recording: GameStorage = {
      kind: 'memory',
      load: () => raw.load(),
      clear: () => raw.clear(),
      save: async (f) => {
        spy.n += 1;
        // 故意不做深拷贝的接收方：coordinator 若未自行 clone，此处即被后续 mutate 污染
        (recording as unknown as { _held: SaveFile | null })._held = f;
      },
    };
    const coord = await createCoordinator(recording, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays = 2;
    });
    await coord.flush();
    const held = (recording as unknown as { _held: SaveFile })._held;
    expect(held.meta.plays).toBe(2);
    // 外部（越过 mutate）直接改内存对象
    coord.snapshot().meta.plays = 999;
    coord.snapshot().cards.push(makeCard('injected'));
    expect(held.meta.plays).toBe(2);
    expect(held.cards).toHaveLength(0);
  });

  it('SN#2 落盘前对内存对象注入非法形状 → 自检拦下（见 SN#3）；合法路径交给 store 的是 clone 产物', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    let captured: SaveFile | null = null;
    const store: GameStorage = {
      kind: 'memory',
      load: () => raw.load(),
      clear: () => raw.clear(),
      save: async (f) => {
        captured = f;
        await raw.save(f);
      },
    };
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.cards.push(makeCard('c1', { source: manualSource() }));
    });
    await coord.flush();
    expect(captured).not.toBeNull();
    expect(captured!.cards[0]).not.toBe(coord.snapshot().cards[0]); // 无共享引用
    expect(captured!.cards[0]).toEqual(coord.snapshot().cards[0]); // 内容一致
    expect(validateSave(captured).ok).toBe(true);
  });

  it('SN#3a 自检先于写：structuredClone 抛错（不可克隆函数成员）⇒ 不触 store.save、dirty 保持、reason 上抛', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
      (s as unknown as { hook: unknown }).hook = () => {}; // 外部失控塞入函数
    });
    const res = await coord.flushDetailed();
    expect(res.ok).toBe(false);
    expect(coord.dirty()).toBe(true);
    expect(saves()).toBe(0);
    expect(reasonOf(res).length).toBeGreaterThan(0);
  });

  it('SN#3b validateSave 自检拦截悬空 deckId：非法内容从不离开 coordinator', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('ok1')]));
    const { store, saves } = wrapStore(raw);
    const coord = await createCoordinator(store, { now: clock.now });
    // 来历修正（controller 第三轮接管）：基线必须先产生一次**真实**写才有意义。
    // 原写法直接 flushDetailed() 而此刻并不脏，它按设计早退 {ok:true} 且不触 store
    //（"无脏不写"，RF1#5/FL#1 钉住），spy 停在 0 ⇒ 原期望 saves()===1 自始不可能成立。
    // 改为走一次合法 mutate+flush 建立基线，随后用"计数不再增长"表达同一意图。
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    const base = await coord.flushDetailed(); // 合法的真实基线写
    expect(base.ok).toBe(true);
    expect(saves()).toBe(1);
    const baselineWrites = saves();
    // 绕过 mutate 把内存对象改成悬空 deckId（外部失控场景）
    coord.snapshot().cards.push(makeCard('orphan', { deckId: 'nope' }));
    coord.markDirty();
    const bad = await coord.flushDetailed();
    expect(bad.ok).toBe(false);
    expect(reasonOf(bad)).toContain('cards[1].deckId');
    expect(coord.dirty()).toBe(true);
    expect(saves()).toBe(baselineWrites); // 非法内容从未离开 coordinator：计数零增长
    expect((await raw.load())!.cards).toHaveLength(1);
  });

  it('SN#4 snapshot() 返回内部权威对象本体（文档化的受控可变视图）', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    const a = coord.snapshot();
    const b = coord.snapshot();
    expect(a).toBe(b);
  });

  it('SN#5 coordinator 交给 store 的快照与内部权威对象无共享引用，且 validateSave 过', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    let captured: SaveFile | null = null;
    const store: GameStorage = {
      kind: 'memory',
      load: () => raw.load(),
      clear: () => raw.clear(),
      save: async (f) => {
        captured = f;
        await raw.save(f);
      },
    };
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.cards.push(makeCard('c1', { source: manualSource() }));
      s.settings.progress.exp = 5;
    });
    await coord.flush();
    const live = coord.snapshot();
    expect(captured).not.toBeNull();
    expect(captured!.cards[0]).not.toBe(live.cards[0]); // 卡对象不共享
    expect(captured!.settings.progress).not.toBe(live.settings.progress); // 嵌套对象不共享
    expect(captured!.settings.progress.exp).toBe(5);
    expect(validateSave(captured).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flush 语义：幂等 / 并发安全 / lastSavedAt
// ---------------------------------------------------------------------------

describe('flush 语义 —— 无脏不写、并发合流', () => {
  it('FL#1 干净状态下显式 flush 返回 true 但不触 store.save（省电省配额）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('f')]));
    const { store, saves } = wrapStore(raw);
    const coord = await createCoordinator(store, { now: clock.now });
    expect(coord.dirty()).toBe(false);
    expect(await coord.flush()).toBe(true);
    expect(saves()).toBe(0);
  });

  it('FL#2 mutate 后立刻 flush：debounce 定时器被取消，只写一次', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(await coord.flush()).toBe(true);
    clock.tick(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saves()).toBe(1); // 定时器没有二次触发
  });

  it('FL#3 并发 flush 合流为一次写', async () => {
    const clock = useFakeClock(NOW);
    const { store, saves } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    const [a, b] = await Promise.all([coord.flush(), coord.flush()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(saves()).toBe(1);
  });

  it('FL#4 lastSavedAt：初始 null → 成功后等于注入的 now；失败不改', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    let broken = false;
    const store: GameStorage = {
      kind: 'memory',
      load: () => raw.load(),
      clear: () => raw.clear(),
      save: (f) => (broken ? Promise.reject(new Error('quota')) : raw.save(f)),
    };
    const coord = await createCoordinator(store, { now: clock.now });
    expect(coord.lastSavedAt()).toBeNull();
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    broken = true;
    expect(await coord.flush()).toBe(false);
    expect(coord.lastSavedAt()).toBeNull();
    broken = false;
    clock.tick(800);
    expect(await coord.flush()).toBe(true);
    expect(coord.lastSavedAt()).toBe(NOW + 800);
  });

  it('FL#5 meta.savedAt 随每次落盘刷新为注入时钟值', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('m')], { meta: { savedAt: 1, plays: 0 } }));
    const coord = await createCoordinator(raw, { now: clock.now });
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    clock.tick(777);
    await coord.flush();
    expect((await raw.load())!.meta.savedAt).toBe(NOW + 777);
  });
});

// ---------------------------------------------------------------------------
// settleAndRecord 编排点（R-T3-p3-b / M-2 落库义务）
// ---------------------------------------------------------------------------

describe('settleAndRecord —— 战斗结算 exp 回写 progress.exp', () => {
  /** 打满全池（lost 形态）：逐张作答直到 phase !== 'answering'。 */
  function playToLost(cards: Card[]): FightView {
    const st = createBattle(cards, 999, deriveStats(1, 0, 0), HALF);
    let s = st;
    for (const c of cards) s = answer(s, c, GRADES.again, HALF);
    return { state: s, pool: cards, current: null };
  }

  /** 提前击杀（won 形态）：enemyHp 小到 n 击即终局。 */
  function playToWon(cards: Card[], turns: number): FightView {
    const st = createBattle(cards, 1, deriveStats(1, 0, 0), HALF);
    let s = st;
    for (let i = 0; i < turns && s.phase === 'answering'; i++) s = answer(s, cards[i], GRADES.easy, HALF);
    return { state: s, pool: cards, current: null };
  }

  /**
   * 恰好 turns 击取胜（idx===turns）的形状：mastered 单击伤 18，HP 取 18×turns。
   * （第 turns+1 张若存在会打出超额伤害直接 won——FORGE#1 的"池尾还有活卡"前提
   *   必须用这个 HP 精确构造，而不是靠大 HP 池碰运气。）
   */
  function playToWonExact(cards: Card[], turns: number): FightView {
    const perHit = Math.round(12 * 1.5); // atk(L1)=12 × damageMultiplier(mastered)=1.5
    const st = createBattle(cards, perHit * turns, deriveStats(1, 0, 0), HALF);
    let s = st;
    for (let i = 0; i < turns && s.phase === 'answering'; i++) s = answer(s, cards[i], GRADES.easy, HALF);
    expect(s.phase).toBe('won');
    expect(s.idx).toBe(turns);
    return { state: s, pool: cards, current: null };
  }

  it('SR#1 lost 一局：cards 落账写回存档、plays+1、exp 入账为 0', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const library = [makeCard('f0', { source: manualSource() }), makeCard('f1', { source: manualSource() })];
    await seedStore(raw, makeSave(library));
    const coord = await createCoordinator(raw, { now: clock.now });
    const view = playToLost(library);
    const settled = settleFight(coord.snapshot().cards, view, {
      gradeOf: () => GRADES.good,
      nowMs: NOW,
      tzOffsetMin: TZ,
      params: PARAMS,
    });
    expect(settled.won).toBe(false);
    await coord.settleAndRecord(settled);
    expect(await coord.flush()).toBe(true);
    const loaded = (await raw.load())!;
    expect(loaded.meta.plays).toBe(1);
    expect(loaded.settings.progress.exp).toBe(0);
    expect(domainReviewCount(loaded.cards)).toBe(2); // 全池落账已入库
  });

  it('SR#2 won 一局：progress.exp>0 且 levelFromExp 前进（brief 钉死的用例）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const library = Array.from({ length: 4 }, (_, i) =>
      makeCard(`m${i}`, { stability: 'mastered', source: manualSource() }),
    );
    await seedStore(raw, makeSave(library));
    const coord = await createCoordinator(raw, { now: clock.now });
    expect(levelFromExp(coord.snapshot().settings.progress.exp)).toBe(1);
    const view = playToWon(library, 2);
    const settled = settleFight(coord.snapshot().cards, view, {
      gradeOf: () => GRADES.easy,
      nowMs: NOW,
      tzOffsetMin: TZ,
      params: PARAMS,
    });
    expect(settled.won).toBe(true);
    // 释放子集 = slice(0, idx)=2 张 mastered ⇒ round(30×0.7 + 5×2) = 31
    expect(settled.exp).toBe(victoryExp(view.pool.slice(0, view.state.idx), 'encounter'));
    await coord.settleAndRecord(settled);
    await coord.flush();
    const loaded = (await raw.load())!;
    expect(loaded.settings.progress.exp).toBeGreaterThan(0);
    expect(loaded.settings.progress.exp).toBe(settled.exp);
    expect(loaded.meta.plays).toBe(1);
    // L1 需 ceil(100×1^1.3)=100 exp 才升级——单局 31 不足以升级，故用两局累加验证前进
    const settled2 = settleFight(loaded.cards, view, {
      gradeOf: () => GRADES.easy,
      nowMs: NOW,
      tzOffsetMin: TZ,
      params: PARAMS,
    });
    await coord.settleAndRecord(settled2);
    await coord.flush();
    const loaded2 = (await raw.load())!;
    expect(loaded2.settings.progress.exp).toBe(settled.exp + settled2.exp);
    expect(levelFromExp(loaded2.settings.progress.exp)).toBe(1);
    // 补足到阈值：直接经 mutate 灌经验，验证派生等级随库内 exp 前进
    await coord.mutate((s) => {
      s.settings.progress.exp += 200;
    });
    await coord.flush();
    expect(levelFromExp((await raw.load())!.settings.progress.exp)).toBeGreaterThan(1);
  });

  it('SR#3 三局连打：exp 单调累加、每局 plays 递增，中途不写（RF#1 复用）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const library = Array.from({ length: 3 }, (_, i) =>
      makeCard(`w${i}`, { stability: 'mastered', source: manualSource() }),
    );
    await seedStore(raw, makeSave(library));
    const { store, saves } = wrapStore(raw);
    const coord = await createCoordinator(store, { now: clock.now });
    let prevExp = 0;
    for (let g = 0; g < 3; g++) {
      const view = playToWon(library, 3);
      const settled = settleFight(coord.snapshot().cards, view, {
        gradeOf: () => GRADES.easy,
        nowMs: NOW,
        tzOffsetMin: TZ,
        params: PARAMS,
      });
      await coord.settleAndRecord(settled);
      const e = coord.snapshot().settings.progress.exp;
      expect(e).toBeGreaterThan(prevExp);
      prevExp = e;
      expect(coord.snapshot().meta.plays).toBe(g + 1);
    }
    expect(saves()).toBe(0);
    await coord.flush();
    expect(saves()).toBe(1);
    const loaded = (await raw.load())!;
    expect(loaded.meta.plays).toBe(3);
    expect(loaded.settings.progress.exp).toBe(prevExp);
  });

  it('SR#4 结算链端到端（startFight→answerCurrent→settle→flush→重启恢复）：exp 入账且 SRS 一致', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    // 6 张全到期 review 卡；enemyHp=ceil(6×10×0.7)=42，easy 单击伤 round(12×1.0×1.0)=12 ⇒ 第 4 击击杀
    const library = Array.from({ length: 6 }, (_, i) => makeCard(`e${i}`, { source: manualSource() }));
    await seedStore(raw, makeSave(library));
    const coord = await createCoordinator(raw, { now: clock.now });
    const v0 = startFight({ decks: coord.snapshot().decks, cards: coord.snapshot().cards }, {
      size: 6,
      rng: HALF,
      nowMs: NOW,
      stats: playerStatsFor(coord.snapshot()),
    });
    if (!('state' in v0)) throw new Error('startFight 意外失败');
    let v = v0;
    while (v.state.phase === 'answering') v = answerCurrent(v, GRADES.easy, { rng: HALF });
    expect(v.state.phase).toBe('won');
    expect(v.state.idx).toBe(4); // 4 击终局：后两张作废（N-2 的落账面前提）
    const settled = settleFight(coord.snapshot().cards, v, {
      gradeOf: () => GRADES.easy,
      nowMs: NOW,
      tzOffsetMin: TZ,
      params: PARAMS,
    });
    expect(settled.won).toBe(true);
    expect(settled.exp).toBe(victoryExp(v.pool.slice(0, 4), 'encounter'));
    await coord.settleAndRecord(settled);
    await coord.flush();

    const revived = await createCoordinator(raw, { now: clock.now });
    const r = revived.snapshot();
    expect(r.settings.progress.exp).toBe(settled.exp);
    expect(r.settings.progress.exp).toBeGreaterThan(0); // brief 钉死：一局后 load → exp>0
    expect(levelFromExp(r.settings.progress.exp)).toBe(1); // 48 < expToNext(1)=100，等级未动
    expect(r.meta.plays).toBe(1);
    expect(domainReviewCount(r.cards)).toBe(4); // 只有已消耗回合落账（N-2）
    const byId = new Map(r.cards.map((c) => [c.id, c]));
    for (const id of ['e0', 'e1', 'e2', 'e3']) expect(byId.get(id)!.srs.reps).toBe(4);
    for (const id of ['e4', 'e5']) expect(byId.get(id)!.srs.reps).toBe(3); // 作废卡零推进
    expect(validateSave(r).ok).toBe(true);
  });

  it('SR#5 脏结算入参消毒：非数组 cards / 非法 exp → 不落脏值、不抛', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.settleAndRecord({ cards: null as unknown as Card[], exp: NaN, won: true });
    const s = coord.snapshot();
    expect(s.settings.progress.exp).toBe(0); // NaN 消毒为 0：宁可漏发，不写脏权威位
    expect(s.meta.plays).toBe(1); // plays 恒 +1："打过一局"与胜负无关
    expect(s.cards).toEqual([]); // cards 非数组 → 不动库存卡（最保守解）
    expect(await coord.flush()).toBe(true); // 消毒后仍是合法档
  });

  it('SR#5b 负数/小数 exp 增量一律消毒为 0，权威位永不出畸形', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    for (const junk of [-5, 1.5, Infinity, '3' as unknown as number, undefined as unknown as number]) {
      await coord.settleAndRecord({ cards: [], exp: junk, won: true });
    }
    // 1.5 → floor = 1（合法非负整数量纲内的保守取整）；其余畸形一律消毒为 0
    expect(coord.snapshot().settings.progress.exp).toBe(1);
    expect(coord.snapshot().meta.plays).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 接口契约：brief Produces 形状（boolean 返回面）
// ---------------------------------------------------------------------------

describe('Coordinator 契约面 —— brief Produces 逐字对齐', () => {
  it('CT#1 flush()/mutate() 的布尔与 Promise 语义：await coord.flush() === true/false', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await seedStore(raw, makeSave([makeCard('t')]));
    const good = await createCoordinator(raw, { now: clock.now });
    await good.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(await good.flush()).toBe(true);
    expect(await good.flush()).toBe(true); // 干净态 flush 也是成功（无脏即无事可做）

    const bad = await createCoordinator(failingStore(raw), { now: clock.now });
    await bad.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(await bad.flush()).toBe(false);
  });

  it('CT#2 dirty() 随 mutate/flush 翻转；定时器到期自动清脏', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    expect(coord.dirty()).toBe(false);
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(coord.dirty()).toBe(true);
    clock.tick(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(coord.dirty()).toBe(false);
  });

  it('CT#3 Coordinator 可赋值给 brief 声明的最小接口类型（结构兼容性钉）', async () => {
    const clock = useFakeClock(NOW);
    const { store } = wrapStore(createMemoryStorage());
    const coord = await createCoordinator(store, { now: clock.now });
    const minimal: {
      mutate(fn: (save: SaveFile) => void | Promise<void>): Promise<void>;
      flush(): Promise<boolean>;
      dirty(): boolean;
      lastSavedAt(): number | null;
    } = coord;
    await minimal.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(await minimal.flush()).toBe(true);
    expect(minimal.dirty()).toBe(false);
    expect(typeof minimal.lastSavedAt()).toBe('number');
  });

  it('CT#4 落盘后新建 coordinator 复用同一 store，恢复值 deepEqual 期望', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const library = [makeCard('d1', { source: manualSource() }), makeCard('d2')];
    await seedStore(raw, makeSave(library));
    const coord = await createCoordinator(raw, { now: clock.now });
    await coord.mutate((s) => {
      s.settings.progress.exp = 42;
      s.meta.plays = 3;
    });
    await coord.flush();
    const revived = await createCoordinator(raw, { now: clock.now });
    const expected = makeSave(library);
    expected.settings.progress.exp = 42;
    // C-1 起载入走 migrateSave：存储里的档缺 settings.leaderboard（T7 前形状）时补 []。
    // 夹具 makeSave 不带该字段，故期望值必须显式带上这条迁移默认——这不是新行为，
    // 而是"载入路径与 parseBackup 同规格"的可见结果。
    expected.settings.leaderboard = [];
    expected.meta = { savedAt: NOW, plays: 3 };
    expect(revived.snapshot()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// T3 I-1 捎带修复：consumedAndRelease 的 log 侧 cardId 加池前缀下界
// （兑现 growth.ts:121-122「min(idx, 池长) 上界防伪造越账」的承诺）
// ---------------------------------------------------------------------------

describe('I-1 伪造越账：log 里的池外 cardId 不落账', () => {
  /**
   * 恰好 turns 击取胜（idx===turns）的形状：mastered easy 单击伤 round(12×1.5)=18，
   * HP 取 18×turns——第 turns+1 张若存在会打出超额伤害直接 won，"池尾还有活卡"的
   * 前提必须用这个 HP 精确构造，而不是靠大 HP 池碰运气。
   */
  function playToWonExact(cards: Card[], turns: number): FightView {
    const perHit = Math.round(12 * 1.5); // atk(L1)=12 × damageMultiplier(mastered)=1.5
    const st = createBattle(cards, perHit * turns, deriveStats(1, 0, 0), HALF);
    let s = st;
    for (let i = 0; i < turns && s.phase === 'answering'; i++) s = answer(s, cards[i], GRADES.easy, HALF);
    expect(s.phase).toBe('won');
    expect(s.idx).toBe(turns);
    return { state: s, pool: cards, current: null };
  }

  it('FORGE#1 won（idx=2）+ log 混入未参战卡 id → 只有 slice(0,2) 落账', async () => {
    const pool = Array.from({ length: 4 }, (_, i) => makeCard(`p${i}`, { stability: 'mastered', source: manualSource() }));
    const library = [...pool, makeCard('outside-1', { source: manualSource() }), makeCard('outside-2', { source: manualSource() })];
    // HP 恰为两击伤害：第 2 击归零即 won，池尾 p2/p3 确实"从未登场"
    const wonView = playToWonExact(pool, 2);
    const s = wonView.state;
    // 伪造：把两张从未登场（池尾之后 / 根本不在池里）的卡塞进事件流
    const forged: BattleState = {
      ...s,
      log: [
        ...s.log,
        { kind: 'damage', cardId: 'outside-1', amount: 1 },
        { kind: 'damage', cardId: 'outside-2', amount: 1 },
      ],
    };
    const view: FightView = { state: forged, pool, current: null };
    const r = settleFight(library, view, { gradeOf: () => GRADES.easy, nowMs: NOW, tzOffsetMin: TZ, params: PARAMS });
    const byId = new Map(r.cards.map((c) => [c.id, c]));
    expect(byId.get('p0')!.srs.reps).toBe(4); // 已消耗：推进
    expect(byId.get('p1')!.srs.reps).toBe(4);
    expect(byId.get('p2')!.srs).toBe(library.find((c) => c.id === 'p2')!.srs); // 池尾之后：零推进、原引用
    expect(byId.get('p3')!.srs).toBe(library.find((c) => c.id === 'p3')!.srs);
    expect(byId.get('outside-1')!.srs.reps).toBe(3); // 池外伪造 id：不落账
    expect(domainReviewCount(r.cards)).toBe(2);
    expect(r.won).toBe(true);
    expect(r.exp).toBe(victoryExp(pool.slice(0, 2), 'encounter'));
  });

  it('FORGE#2 lost（全池释放）时 log 含池外 id → 仍只按池计', () => {
    const pool = [makeCard('q0', { source: manualSource() }), makeCard('q1', { source: manualSource() })];
    const library = [...pool, makeCard('ghost', { source: manualSource() })];
    const st = createBattle(pool, 999, deriveStats(1, 0, 0), HALF);
    let s = answer(st, pool[0], GRADES.again, HALF);
    s = answer(s, pool[1], GRADES.again, HALF);
    expect(s.phase).toBe('lost');
    const forged: BattleState = { ...s, log: [...s.log, { kind: 'miss', cardId: 'ghost' }] };
    const r = settleFight(library, { state: forged, pool, current: null }, {
      gradeOf: () => GRADES.good,
      nowMs: NOW,
      tzOffsetMin: TZ,
      params: PARAMS,
    });
    const byId = new Map(r.cards.map((c) => [c.id, c]));
    expect(byId.get('q0')!.srs.reps).toBe(4);
    expect(byId.get('q1')!.srs.reps).toBe(4);
    expect(byId.get('ghost')!.srs.reps).toBe(3); // 池外 id 不落账
    expect(r.exp).toBe(0);
  });

  it('FORGE#3 idx 越出池长的脏 state：上界取 min(idx, 池长)，不放大释放面', () => {
    const pool = [makeCard('r0', { source: manualSource() })];
    const st = createBattle(pool, 1, deriveStats(1, 0, 0), HALF);
    const dirty: BattleState = { ...st, phase: 'won', idx: 99, log: [{ kind: 'end' }] };
    const r = settleFight(pool, { state: dirty, pool, current: null }, {
      gradeOf: () => GRADES.easy,
      nowMs: NOW,
      tzOffsetMin: TZ,
      params: PARAMS,
    });
    expect(r.cards[0].srs.reps).toBe(4); // 池内唯一张照常落账
    expect(r.exp).toBe(victoryExp(pool, 'encounter')); // 释放面被钳在池长
  });
});

// ---------------------------------------------------------------------------
// C1（Fix Round 1）：落盘在途时到达的 mutate 不得被静默丢弃
//
// 评审 P6/P6b 实测（BASE f73d185）：live plays=42、store plays=1、flush()===true、
// dirty()===false，空转 60s 无第二次写，销毁重建后 42 蒸发——用户数据静默丢失。
// 根因是 performFlush 在 `await store.save` **之后**才无条件 `dirty=false`：在途
// mutate 已把 dirty 置 true 的那一位被这次清零，armWindow 见 !dirty 随即撤窗，
// 那批改动再无人写。本组用例把窗口钉在「快照已取 / 写未 resolve」之间复现该状态。
// ---------------------------------------------------------------------------

describe('C1 在途 mutate 的批次归属 —— 落盘批次在 await 前认领', () => {
  /**
   * 三段可控存储：hold() 让下一次 save 卡在 await 上（复现"落盘在途"窗口）、
   * failNext() 让下一次 save 抛配额错、release() 放行挂起的那次写。
   * pending()===true 即证明 performFlush 确实停在 store.save 里（而非尚未进入）。
   */
  function stagedStore(inner: GameStorage): {
    store: GameStorage;
    hold: () => void;
    failNext: () => void;
    pending: () => boolean;
    saves: () => number;
    release: () => Promise<void>;
  } {
    let gate: (() => void) | null = null;
    let holdNext = false;
    let failOnce = false;
    let saveCount = 0;
    const store: GameStorage = {
      kind: inner.kind,
      load: () => inner.load(),
      clear: () => inner.clear(),
      save: async (f) => {
        saveCount += 1;
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((res) => {
            gate = res;
          });
        }
        if (failOnce) {
          failOnce = false;
          throw new Error('QuotaExceededError: 模拟配额满');
        }
        return inner.save(f);
      },
    };
    return {
      store,
      hold: () => {
        holdNext = true;
      },
      failNext: () => {
        failOnce = true;
      },
      pending: () => gate !== null,
      saves: () => saveCount,
      release: async () => {
        holdNext = false;
        const g = gate;
        gate = null;
        g?.();
        await drainMicrotasks();
      },
    };
  }

  it('C1a 显式 flush 在途 mutate：dirty 不被清零，随后 flush 把 plays 累加写进 store', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const staged = stagedStore(raw);
    const coord = await createCoordinator(staged.store, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 1;
    });
    staged.hold();
    const flushing = coord.flush(); // 快照已取（clone 同步完成），停在 store.save
    await drainMicrotasks();
    expect(staged.pending()).toBe(true); // 证明确实处在"落盘在途"窗口内

    await coord.mutate((s) => {
      s.meta.plays = 42; // 在途改动：不属于本次已取快照
    });
    expect(coord.snapshot().meta.plays).toBe(42);

    await staged.release();
    expect(await flushing).toBe(true);
    expect((await raw.load())!.meta.plays).toBe(1); // 本次写只含第一批

    // C1 的核心断言：在途那批必须仍被认作"未落盘"，否则静默丢数据
    expect(coord.dirty()).toBe(true);

    expect(await coord.flush()).toBe(true);
    expect((await raw.load())!.meta.plays).toBe(42); // 两批都进了存储，无蒸发
    expect(coord.snapshot().meta.plays).toBe(42);
    expect(coord.dirty()).toBe(false);
  });

  it('C1b 定时器驱动的落盘在途 mutate：不显式 flush，仅靠重排窗口也能落盘', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const staged = stagedStore(raw);
    const coord = await createCoordinator(staged.store, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 1;
    });
    staged.hold();
    clock.tick(DEFAULT_DEBOUNCE_MS); // debounce 到期自动落盘，卡在 store.save
    await drainMicrotasks();
    expect(staged.pending()).toBe(true);

    await coord.mutate((s) => {
      s.meta.plays = 7; // 自动落盘在途中的新改动
    });
    await staged.release();
    expect((await raw.load())!.meta.plays).toBe(1);
    expect(coord.dirty()).toBe(true);

    clock.tick(DEFAULT_DEBOUNCE_MS); // 无需显式 flush：重排的窗口自己到期
    await drainMicrotasks();
    expect(coord.dirty()).toBe(false);
    expect((await raw.load())!.meta.plays).toBe(7);
    expect(staged.saves()).toBe(2);
  });

  it('C1c 在途 mutate 且本次写失败：dirty 保持 true，退避窗把两批一起落盘', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const staged = stagedStore(raw);
    const coord = await createCoordinator(staged.store, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 1;
    });
    staged.hold();
    staged.failNext();
    const flushing = coord.flush();
    await drainMicrotasks();
    expect(staged.pending()).toBe(true);

    await coord.mutate((s) => {
      s.meta.plays = 42;
    });
    await staged.release();
    expect(await flushing).toBe(false); // 写失败面照常上抛
    expect(coord.dirty()).toBe(true); // 失败不得吞掉在途那批
    expect(await raw.load()).toBeNull(); // 存储原样（从未写成功）

    clock.tick(600); // 失败退避窗（完整 debounce）到期后自愈
    await drainMicrotasks();
    expect(coord.dirty()).toBe(false);
    expect((await raw.load())!.meta.plays).toBe(42);
  });
});
