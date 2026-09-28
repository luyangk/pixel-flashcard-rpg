/**
 * transfer.ts —— Plan 3 Final Fix Wave · I-1/I-2 生产编排（导入/导出的最后一米）。
 *
 * 这两条 I 项的病灶相同：守卫与纯函数都在、测试也绿，但**生产路径上无人调用**——
 * `importAndSave` 消费不了 backup 信封（顶层 {format,version,exportedAt,save} 会被
 * "schemaVersion 应为 1，实际为 undefined"拒），而 `exportBackupText` 收裸 SaveFile、
 * 既不收口也不记 lastExportedAt。本文件钉的是"装配层真的把这些件接上了"，
 * 而不是"这些件单独可用"。
 *
 * 时间纪律：与 persist/backup 同规格——nowMs 一律注入，本文件与 transfer.ts 都不读宿主时钟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, SaveFile } from '@core/types';
import { importAndSave } from '@core/saveMigrate';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { backupReminderDue, exportBackup, parseBackup } from '../../src/app/backup';
import { createCoordinator } from '../../src/app/persist';
import { exportAndMark, importBackupAndSave } from '../../src/app/transfer';

const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 86_400_000;

function makeCard(id: string, deckId = 'deck-a'): Card {
  return {
    id,
    deckId,
    front: `q-${id}`,
    back: `a-${id}`,
    srs: {
      ease: 2.5,
      interval: 10,
      reps: 3,
      lapses: 0,
      due: NOW,
      stability: 'review',
      effectiveReviewDays: [],
    },
    tags: [],
    source: undefined,
  };
}

function makeSave(cards: Card[], over: Partial<SaveFile> = {}): SaveFile {
  return {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '领域A', isPreset: true }],
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW - 1000, plays: 0 },
    ...over,
  };
}

/** 写计数 spy：I-1 的"零写入"必须由存储侧的写次数取证，而不是靠读回来的值猜。 */
function wrapStore(inner: GameStorage): { store: GameStorage; saves: () => number } {
  let saveCount = 0;
  return {
    store: {
      kind: inner.kind,
      load: () => inner.load(),
      clear: () => inner.clear(),
      save: (f: SaveFile) => {
        saveCount += 1;
        return inner.save(f);
      },
    },
    saves: () => saveCount,
  };
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

/** 三段可控存储：hold 让下一次 save 卡在 await 上，复现"落盘在途、内存已变"窗口。 */
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
// I-1 —— importBackupAndSave：信封 → 迁移 → 校验 → 落盘（生产落点）
// ---------------------------------------------------------------------------

describe('Final Fix Wave · I-1 importBackupAndSave 生产落点', () => {
  it('I1#1 合法信封经生产路径往返落盘成功（并反证裸 importAndSave 消费不了信封）', async () => {
    const src = makeSave([makeCard('c1'), makeCard('c2')], { meta: { savedAt: NOW - 1000, plays: 5 } });
    const text = exportBackup(src, NOW - 3 * DAY);

    // 反证：裸 importAndSave 直接吃信封必被拒（顶层是信封，不是 SaveFile）——
    // 这正是 I-1 说的"最后一米无生产落点"：判它坏档的 reason 指向 schemaVersion。
    const bare = createMemoryStorage();
    const bareResult = await importAndSave(text, bare);
    expect(bareResult.ok).toBe(false);
    if (!bareResult.ok) expect(bareResult.reason).toContain('schemaVersion');
    expect(await bare.load()).toBeNull(); // 失败不落盘

    // 生产编排：同一串文本经 importBackupAndSave 落盘成功
    const raw = createMemoryStorage();
    const { store, saves } = wrapStore(raw);
    const r = await importBackupAndSave(text, store);
    expect(r.ok).toBe(true);
    expect(saves()).toBe(1);

    const loaded = (await raw.load())!;
    expect(loaded.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(loaded.meta.plays).toBe(5);
    expect(loaded.schemaVersion).toBe(1);
  });

  it('I1#2 外来 lastExportedAt 在**生产路径**上被剔除：闸门视作从未导出', async () => {
    const foreign = makeSave([makeCard('f1')], {
      meta: { savedAt: NOW - 5 * DAY, plays: 9, lastExportedAt: NOW - 2 * DAY },
    });
    const text = exportBackup(foreign, NOW - 2 * DAY);

    // 解析层忠于文件：字段仍在（不越权改写用户的备份内容）
    const parsed = parseBackup(text, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save.meta.lastExportedAt).toBe(NOW - 2 * DAY);

    // 落库层剔除：本机的导出史不能由别人的时刻代表（R-T7-p3-a）
    const raw = createMemoryStorage();
    const r = await importBackupAndSave(text, raw);
    expect(r.ok).toBe(true);
    const loaded = (await raw.load())!;
    expect('lastExportedAt' in loaded.meta).toBe(false);
    expect(loaded.meta.plays).toBe(9); // 剔除的只是导出史，进度保真
    // fail-open 方向：视作从未导出 ⇒ 提醒照响
    expect(backupReminderDue(loaded.meta.lastExportedAt ?? null, NOW)).toBe(true);
  });

  it('I1#3 旧备份信封（内层缺 progress）经生产路径也能落盘：迁移在信封内层生效', async () => {
    const legacy = makeSave([makeCard('old-1')], { meta: { savedAt: NOW - 20 * DAY, plays: 2 } });
    delete (legacy.settings as { progress?: unknown }).progress;
    const text = exportBackup(legacy, NOW - 20 * DAY);

    const raw = createMemoryStorage();
    expect((await importBackupAndSave(text, raw)).ok).toBe(true);
    const loaded = (await raw.load())!;
    expect(loaded.settings.progress).toEqual({ exp: 0 }); // migrateSave 补默认
    expect(loaded.meta.plays).toBe(2);
    expect(loaded.cards.map((c) => c.id)).toEqual(['old-1']);
  });

  it('I1#4 畸形串 / 畸形存档一律 ok:false，且 store 零写入（ok:false 不得有副作用）', async () => {
    // ① 畸形串：随手粘进来的东西 ② 裸存档（不是信封）③ 信封完好但内层存档坏（悬空 deckId）
    const orphan = makeSave([makeCard('orphan', 'nope')]);
    const cases: string[] = [
      '',
      '   ',
      '{',
      '这不是 JSON，只是随手粘的一段话',
      '[]',
      '{"format":"other"}',
      JSON.stringify(makeSave([makeCard('bare-1')])), // 裸存档：信封层拦下
      exportBackup(orphan, NOW), // 信封层过、存档层拒（cards[0].deckId 悬空）
    ];
    for (const text of cases) {
      const raw = createMemoryStorage();
      const { store, saves } = wrapStore(raw);
      const r = await importBackupAndSave(text, store);
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(r.reason!.length).toBeGreaterThan(0);
      expect(saves()).toBe(0); // 零写入
      expect(await raw.load()).toBeNull(); // 存储原样（空）
    }
  });

  it('I1#5 换机全链（生产路径闭环）：机器A exportAndMark 出的信封 → 机器B importBackupAndSave，导出史不留痕', async () => {
    const clock = useFakeClock(NOW);
    // 机器 A：打了一局（plays=9），并在 2 天前成功导出过一次（持久位已落）
    const machineA = createMemoryStorage();
    await machineA.save(makeSave([makeCard('m1')], { meta: { savedAt: NOW - 5 * DAY, plays: 9 } }));
    const coordA = await createCoordinator(machineA, { now: clock.now });
    expect((await exportAndMark(coordA, NOW - 2 * DAY)).ok).toBe(true);
    // 再导一次：这次的快照里带着 A 的导出史（用户真实会经历的"重复导出"）
    const again = await exportAndMark(coordA, NOW - 2 * DAY);
    expect(again.ok).toBe(true);
    const text = again.text!;
    const parsedA = parseBackup(text, NOW);
    expect(parsedA.ok).toBe(true);
    if (!parsedA.ok) return;
    expect(parsedA.save.meta.lastExportedAt).toBe(NOW - 2 * DAY); // 文件里确实带着 A 的导出史

    // 机器 B：换机导入（生产落点），剔除他机导出史
    const machineB = createMemoryStorage();
    expect((await importBackupAndSave(text, machineB)).ok).toBe(true);
    const loadedB = (await machineB.load())!;
    expect('lastExportedAt' in loadedB.meta).toBe(false);
    expect(loadedB.meta.plays).toBe(9); // 进度保真
    expect(loadedB.cards.map((c) => c.id)).toEqual(['m1']);
    // 本机视作"从未导出" ⇒ 提醒照响（不被别人的时刻静默关掉）
    expect(backupReminderDue(loadedB.meta.lastExportedAt ?? null, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-2 —— exportAndMark：收口 → 信封 → 记时（BK#26 的持久收口在此成为生产事实）
// ---------------------------------------------------------------------------

describe('Final Fix Wave · I-2 exportAndMark 生产编排', () => {
  it('I2#1 正常路径：文本产出 + lastExportedAt 落进存储 + 闸门翻 false + 导出即持久快照', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const coord = await createCoordinator(raw, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 3; // 悬着未落盘的改动：导出前的收口必须把它带走
    });

    const r = await exportAndMark(coord, clock.now());
    expect(r.ok).toBe(true);
    const text = r.text!;
    expect(typeof text).toBe('string');

    const stored = (await raw.load())!;
    // ① 收口的成果：导出的就是存储里那一份（plays=3 已落盘）
    const parsed = parseBackup(text, clock.now());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save.meta.plays).toBe(3);
    expect(parsed.save.meta.savedAt).toBe(stored.meta.savedAt);
    expect(parsed.save.cards.map((c) => c.id)).toEqual(stored.cards.map((c) => c.id));

    // ② 记时经生产路径闭合：内存 + 存储都有，dirty 归净
    expect(coord.snapshot().meta.lastExportedAt).toBe(clock.now());
    expect(stored.meta.lastExportedAt).toBe(clock.now());
    expect(coord.dirty()).toBe(false);
    // ③ 闸门翻 false（这就是"7 天提醒"的喂入方在生产路径上的取证）
    expect(backupReminderDue(stored.meta.lastExportedAt ?? null, clock.now())).toBe(false);
    expect(backupReminderDue(stored.meta.lastExportedAt ?? null, clock.now() + 7 * DAY)).toBe(true);
  });

  it('I2#2 在途脏时收口不成立：不产出文本、不记录 lastExportedAt（BK#26 的生产落点）', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('a1')]));
    const staged = stagedStore(raw);
    const coord = await createCoordinator(staged.store, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 1;
    });
    staged.hold();
    const flushing = coord.flush(); // 认领 plays=1，停在 store.save
    await drainMicrotasks();
    expect(staged.pending()).toBe(true);

    await coord.mutate((s) => {
      s.meta.plays = 42; // 在途那批：既不在本次快照里，也还没落盘
    });
    const exporting = exportAndMark(coord, clock.now());
    await drainMicrotasks();
    await staged.release();

    // flush()===true 只承诺"被认领的那批已写"——只信它就会在此刻把未落盘的 42 认作已备份
    expect(await flushing).toBe(true);
    expect(coord.dirty()).toBe(true);

    const r = await exporting;
    expect(r.ok).toBe(false);
    expect(r.text).toBeUndefined(); // 收口不成立就不产出文件
    expect(r.reason).toContain('导出没能完成');
    expect(coord.snapshot().meta.lastExportedAt).toBeUndefined();
    const stored = (await raw.load())!;
    expect('lastExportedAt' in stored.meta).toBe(false);
    expect(stored.meta.plays).toBe(1); // 存储里只有被认领的那批
  });

  it('I2#3 只读态（存档不可读）拒绝导出：不把种子档当"你的备份"发出去', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save({ schemaVersion: 2 } as unknown as SaveFile);
    const before = JSON.stringify(await raw.load());
    const coord = await createCoordinator(raw, { now: clock.now });
    expect(coord.readOnly()).toBe(true);

    const r = await exportAndMark(coord, clock.now());
    expect(r.ok).toBe(false);
    expect(r.text).toBeUndefined();
    expect(r.reason).toContain('导出没能完成');
    expect(JSON.stringify(await raw.load())).toBe(before);
  });
});
