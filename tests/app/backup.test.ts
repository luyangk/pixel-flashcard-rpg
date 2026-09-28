/**
 * backup.ts —— Plan 3 · T5 备份信封 + 7 天提醒闸门（PRD §6.1 / DoD5）。
 *
 * 纯本地架构（无后端、无账号）下，导出 JSON 是用户数据保全的唯一手段；
 * 本文件钉死三件事：
 * - **信封往返无损**：exportBackup→parseBackup 与原 save deepEqual（DoD5「导出→清环境→导入后进度完整」）；
 * - **失败分层可读**：畸形输入一律 ok:false，且 reason 明确落在"信封层"还是"存档层"
 *   （信封层 = 这不是本应用导出的文件；存档层 = 备份里的存档内容坏了，带 JSON 路径）；
 * - **N-3 显式迁移时机**：内层旧档（缺 settings.battle / settings.progress）必须**先经
 *   migrateSave 升形再校验**——否则 v2.1 前的旧备份会被"缺 battle"整包拒，用户历史进度
 *   就此打不开（RF#4 的反面）。
 *
 * 另附两条装配面契约的取证：
 * - 提醒闸门的入参来源（lastExportedAt）：null = 从未导出；导出成功后的更新使 due 由 true 翻 false
 *   （与 Task 4 的 meta 集成一小例，持久位归属见 report）；
 * - 导出前"我的改动此刻已持久"只能用 `flush() && !dirty()`（R-T4-p3-d）——只信 flush() 的
 *   boolean 会把在途 mutate 的那批当成已落盘。
 *
 * 时间纪律：全部时间由测试显式注入；backup.ts 与 persist.ts 同规格——不读宿主时钟。
 * 测试辅助（useFakeClock / wrapStore / drainMicrotasks）与 tests/app/persist.test.ts 同思路，
 * 但本文件自带、不跨文件 import（各任务的测试互不依赖，避免一处重构牵连两处红灯）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Deck, SaveFile, Sm2Params, SRSState, Stability } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { validateSave } from '@core/saveMigrate';
import type { RunRecord } from '@core/leaderboard';
import {
  ENVELOPE_ERROR_PREFIX,
  SAVE_ERROR_PREFIX,
  backupReminderDue,
  exportBackup,
  parseBackup,
  type BackupParseResult,
} from '../../src/app/backup';
import { createCoordinator } from '../../src/app/persist';

/**
 * T6 捎带 item 4 的**唯一 mock 面**（真实内部 bug 无法由 JSON 文本构造：parseBackup 只吃
 * 字符串，migrateSave 的入参必然是 JSON 纯数据，validateSave 那条 "非校验信号原样上抛"
 * 的路径在纯数据下不可达）。故用可触发的故障开关包一层：默认**透传真实现**，
 * 只有置位的那一次抛非迁移前缀的异常——validateSave 等其余导出全部来自实际模块。
 */
let migrateFault: Error | null = null;
vi.mock('@core/saveMigrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/saveMigrate')>();
  return {
    ...actual,
    migrateSave: (raw: unknown) => {
      if (migrateFault !== null) {
        const fault = migrateFault;
        migrateFault = null; // 一次性：只污染被测那一次调用
        throw fault;
      }
      return actual.migrateSave(raw);
    },
  };
});

// —— 仿真锚点：全部时间由测试显式注入 ——
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 86_400_000;
const FORMAT = 'zx-xia-backup';

const PARAMS: Sm2Params = { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 };

interface CardOpts {
  stability?: Stability;
  deckId?: string;
}

function makeCard(id: string, over: CardOpts = {}): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: over.stability === 'review' || over.stability === 'mastered' ? 10 : 0,
    reps: 3,
    lapses: 0,
    due: NOW,
    stability: over.stability ?? 'review',
    effectiveReviewDays: [],
  };
  return {
    id,
    deckId: over.deckId ?? 'deck-a',
    front: `q-${id}`,
    back: `a-${id}`,
    srs,
    tags: ['t1'],
  };
}

/**
 * 一份整包合法的存档。**有意不放值为 undefined 的可选键**（source/bossName/purifiedAt）：
 * JSON 往返会丢 undefined 值键，夹具带上它们就只能用 toEqual（宽容）而无法用
 * toStrictEqual（严格）钉"逐键无损"——strict 面是本文件的主要证据，夹具配合之。
 */
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
      story: { prologueSeen: false, beatIndex: 0 },
      // T7 起 leaderboard 是当前形状的一部分（可选位，migrateSave 为缺席档补 []）：
      // 夹具带上它，才能让**过 migrateSave 的** toStrictEqual 逐键断言区分"归一化补默认"
      // 与"丢字段"——否则迁移注入的空榜会被读成往返丢键。
      // 实测口径（T7 fix round 1，评审 M2 变异取证）：去掉本行后失败的**恰是 BK#2 与
      // BK#25**（两者都拿夹具档与 migrateSave 产物做严格比对）；**BK#26 不依赖它**——
      // BK#26 的存档来自空存储的种子档（persist 侧自带空榜），压根不经过 migrateSave。
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
    ...over,
  };
}

/** v2.1 前旧档形状：settings 缺 battle / progress（其余合法）。 */
function legacySave(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '领域A', isPreset: true }],
    cards: [makeCard('legacy-1')],
    settings: { bossThresholdTier: 30, sm2Params: PARAMS },
    meta: { savedAt: NOW - 30 * DAY, plays: 4 },
  };
}

/** 手工拼一封"声称是本应用备份"的信封（畸形用例的唯一取证手段）。 */
function envelopeText(patch: Record<string, unknown>): string {
  return JSON.stringify(
    { format: FORMAT, version: 1, exportedAt: NOW, save: makeSave([makeCard('ok-1')]), ...patch },
    null,
    2,
  );
}

function reasonOf(r: BackupParseResult): string {
  return r.ok ? '' : r.reason;
}

/**
 * 分层断言：reason 必须落在指定层（前缀命中）且**不含另一层的前缀**。
 * 只断言"包含某关键词"不足以证明分层——两层都说"存档/备份"时容易假绿，
 * 故两个方向都钉（本文件的核心 Review Focus）。
 */
function expectEnvelopeError(r: BackupParseResult, contains: string): void {
  expect(r.ok).toBe(false);
  const reason = reasonOf(r);
  expect(reason.startsWith(ENVELOPE_ERROR_PREFIX)).toBe(true);
  expect(reason).toContain(contains);
  expect(reason.includes(SAVE_ERROR_PREFIX)).toBe(false);
}

function expectSaveError(r: BackupParseResult, contains: string): void {
  expect(r.ok).toBe(false);
  const reason = reasonOf(r);
  expect(reason.startsWith(SAVE_ERROR_PREFIX)).toBe(true);
  expect(reason).toContain(contains);
  expect(reason.includes(ENVELOPE_ERROR_PREFIX)).toBe(false);
}

// —— 与 persist.test.ts 同思路的本地辅助（不跨文件 import） ——

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
  saves: () => number;
} {
  let gate: (() => void) | null = null;
  let holdNext = false;
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
      return inner.save(f);
    },
  };
  return {
    store,
    hold: () => {
      holdNext = true;
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

/**
 * 备份时刻的持久位读取（T7 已按三段式在 meta 落地，R-T5-p3-a；写入路径见 BK#25 的
 * Coordinator.markExported）。缺席即"从未导出"（null），故非数值一律回落 null。
 * T7 前此处借 `SaveFile['meta'] & { lastExportedAt?: number }` 的手工扩展类型表达
 * "未来会有的字段"——持久位落地后直接用真实字段，类型断言随之删除。
 */
function readLastExportedAt(save: SaveFile): number | null {
  const v = save.meta.lastExportedAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  migrateFault = null; // 故障开关不跨用例残留
});

// ---------------------------------------------------------------------------
// 信封往返无损（DoD5）
// ---------------------------------------------------------------------------

describe('exportBackup ⇄ parseBackup —— 往返无损', () => {
  it('BK#1 信封形状逐字：format/version:1/exportedAt/save，且 2 空格缩进', () => {
    const save = makeSave([makeCard('a1')]);
    const text = exportBackup(save, NOW);

    expect(text.startsWith('{\n  "format": "zx-xia-backup"')).toBe(true);
    expect(text).toContain('\n  "exportedAt":');
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['format', 'version', 'exportedAt', 'save']);
    expect(raw.format).toBe('zx-xia-backup');
    expect(raw.version).toBe(1);
    expect(raw.exportedAt).toBe(NOW);
    expect(raw.save).toEqual(save);
  });

  it('BK#2 roundtrip 严格 deepEqual：逐键无损、无 undefined 塌陷，且解析产物与原档零共享引用', () => {
    const save = makeSave([makeCard('a1'), makeCard('b2', { stability: 'mastered' })], {
      meta: { savedAt: NOW - 1234, plays: 9 },
    });
    const parsed = parseBackup(exportBackup(save, NOW), NOW);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save).toStrictEqual(save);
    expect(parsed.save).not.toBe(save);
    expect(parsed.save.cards[0]).not.toBe(save.cards[0]);
    expect(parsed.sinceLastBackupDays).toBe(0);
  });

  it('BK#3 导出是纯函数：不改动入参，且同参同输出（幂等）', () => {
    const save = makeSave([makeCard('a1')]);
    const before = structuredClone(save);
    const t1 = exportBackup(save, NOW);
    const t2 = exportBackup(save, NOW);
    expect(save).toStrictEqual(before);
    expect(t1).toBe(t2);
  });

  it('BK#4 v1 legacy 旧档（缺 battle/progress）经 parse 升形：注入默认值，其余逐字保真', () => {
    const legacy = legacySave();
    const text = JSON.stringify({ format: FORMAT, version: 1, exportedAt: NOW - 10 * DAY, save: legacy }, null, 2);
    const parsed = parseBackup(text, NOW);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // N-3：显式迁移的可见结果——旧档不因缺 battle/progress 被拒，而是补齐后放行
    expect(parsed.save.settings.battle).toEqual({ defaultPoolSize: 15 });
    expect(parsed.save.settings.progress).toEqual({ exp: 0 });
    expect(parsed.save.settings.bossThresholdTier).toBe(30);
    expect(parsed.save.settings.sm2Params).toEqual(PARAMS);
    expect(parsed.save.meta).toEqual({ savedAt: NOW - 30 * DAY, plays: 4 });
    expect(parsed.save.cards).toHaveLength(1);
    expect(validateSave(parsed.save).ok).toBe(true);
    expect(parsed.sinceLastBackupDays).toBe(10);
  });

  it('BK#5 升形后再导出再解析：migrate 幂等可见（第二次解析结果与第一次 deepEqual）', () => {
    const legacy = legacySave();
    const once = parseBackup(envelopeText({ save: legacy }), NOW);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = parseBackup(exportBackup(once.save, NOW), NOW);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.save).toStrictEqual(once.save);
    expect(twice.save.settings.battle).toEqual({ defaultPoolSize: 15 });
  });

  /**
   * BK#5b（T7 fix round 1，评审 M3）：榜单是本存档里**唯一可为非空的对象数组**，
   * 此前所有往返夹具的 leaderboard 恒为 []，"非空榜单能否逐行无损过 JSON 往返"
   * 其实没有覆盖。此处钉两件事：①三行 RunRecord 的九字段逐一保真；
   * ②**顺序原样保留**（导出/导入都不做 rankRuns 重排——排序是 recordRun 的写入侧职责，
   * 导入侧若偷偷重排，用户手里的榜单顺序会在换机后变化）。
   *
   * [T8 订正] 标题与注释原写"两行"，夹具实为三行（r-a/r-b/r-c）——纯改字，行为不变。
   */
  it('BK#5b 非空榜单往返无损：三行 RunRecord 九字段保真，且顺序不被重排', () => {
    const rows: RunRecord[] = [
      // 有意让 at 与 score 都**不**单调：任何"导入时顺手排序"的实现都会露出马脚
      { id: 'r-a', at: NOW - 3 * DAY, result: 'won', kind: 'boss', domain: '领域A', cards: 15, misses: 4, level: 6, score: 190 },
      { id: 'r-b', at: NOW - 1 * DAY, result: 'lost', kind: 'encounter', domain: '领域B', cards: 3, misses: 3, level: 1, score: 0 },
      { id: 'r-c', at: NOW - 5 * DAY, result: 'won', kind: 'encounter', domain: '领域A', cards: 5, misses: 0, level: 2, score: 60 },
    ];
    const save = makeSave([makeCard('rt-1')]);
    save.settings.leaderboard = rows;

    const parsed = parseBackup(exportBackup(save, NOW), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save).toStrictEqual(save); // 逐键无损（含榜单行内九个字段）
    expect(parsed.save.settings.leaderboard).toStrictEqual(rows);
    expect(parsed.save.settings.leaderboard!.map((r) => r.id)).toEqual(['r-a', 'r-b', 'r-c']);
    expect(validateSave(parsed.save).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 失败分层：信封层 vs 存档层
// ---------------------------------------------------------------------------

describe('parseBackup 失败分层 —— 信封层错 vs 存档层错', () => {
  it('BK#6 非 JSON 文本 → 信封层', () => {
    expectEnvelopeError(parseBackup('这不是 JSON，只是随手粘的一段话', NOW), 'JSON');
  });

  it('BK#7 JSON 但顶层不是对象（数组/字符串/null） → 信封层', () => {
    // 断言"实际为 X"这一具体描述，而不是宽泛的"备份文件"——后者被前缀本身满足，是假绿
    expectEnvelopeError(parseBackup('[]', NOW), '实际为 array');
    expectEnvelopeError(parseBackup('"zx-xia-backup"', NOW), '实际为 "zx-xia-backup"');
    expectEnvelopeError(parseBackup('null', NOW), '实际为 null');
    // T6 捎带 item 2 更新：number 不再只回 typeof，而是保留实际值（'42' → 实际为 42）
    expectEnvelopeError(parseBackup('42', NOW), '实际为 42');
  });

  it('BK#8 缺 format 标记 → 信封层', () => {
    expectEnvelopeError(parseBackup(envelopeText({ format: undefined }), NOW), 'format');
  });

  it('BK#9 format 值不是本应用的标记 → 信封层', () => {
    expectEnvelopeError(parseBackup(envelopeText({ format: 'other-backup' }), NOW), 'other-backup');
  });

  it('BK#10 version 2（更新的版本）→ 信封层，且指路升级而非导入', () => {
    const r = parseBackup(envelopeText({ version: 2 }), NOW);
    expectEnvelopeError(r, 'version');
    expect(reasonOf(r)).toContain('升级');
  });

  it('BK#11 version 缺席或形态不对（"1"/0）→ 信封层', () => {
    expectEnvelopeError(parseBackup(envelopeText({ version: undefined }), NOW), 'version');
    expectEnvelopeError(parseBackup(envelopeText({ version: '1' }), NOW), 'version');
    expectEnvelopeError(parseBackup(envelopeText({ version: 0 }), NOW), 'version');
  });

  it('BK#12 exportedAt 缺席/非数值 → 信封层（提醒闸门的数据源不得是 NaN）', () => {
    expectEnvelopeError(parseBackup(envelopeText({ exportedAt: undefined }), NOW), 'exportedAt');
    expectEnvelopeError(parseBackup(envelopeText({ exportedAt: '2026-10-26' }), NOW), 'exportedAt');
    expectEnvelopeError(parseBackup(envelopeText({ exportedAt: null }), NOW), 'exportedAt');
  });

  it('BK#13 缺 save 字段或 save 非对象 → 信封层（信封形状自身的缺失，不说"存档损坏"）', () => {
    expectEnvelopeError(parseBackup(envelopeText({ save: undefined }), NOW), 'save');
    expectEnvelopeError(parseBackup(envelopeText({ save: null }), NOW), 'save');
    expectEnvelopeError(parseBackup(envelopeText({ save: 'oops' }), NOW), 'save');
  });

  it('BK#14 信封合法但存档域外值（ease=-8）→ 存档层，reason 带 JSON 路径', () => {
    const bad = makeSave([makeCard('bad-1')]);
    (bad.cards[0].srs as { ease: number }).ease = -8;
    expectSaveError(parseBackup(envelopeText({ save: bad }), NOW), 'cards[0].srs.ease');
  });

  it('BK#15 存档层其余畸形（悬空 deckId / schemaVersion 2）同样归存档层', () => {
    const orphan = makeSave([makeCard('orphan-1', { deckId: 'nope' })]);
    expectSaveError(parseBackup(envelopeText({ save: orphan }), NOW), 'cards[0].deckId');

    const future = makeSave([makeCard('f-1')]) as unknown as Record<string, unknown>;
    future.schemaVersion = 2;
    expectSaveError(parseBackup(envelopeText({ save: future }), NOW), 'schemaVersion');
  });

  it('BK#16 裸存档（未经信封包裹的历史格式）→ 信封层，不用"存档坏了"误导用户', () => {
    expectEnvelopeError(parseBackup(JSON.stringify(makeSave([makeCard('bare-1')])), NOW), 'format');
  });

  it('BK#17 任一失败路径都不抛异常（UI 只需读 ok/reason）', () => {
    const inputs = ['', '{}', 'null', '[]', envelopeText({ version: 3 }), envelopeText({ save: {} })];
    for (const text of inputs) {
      expect(() => parseBackup(text, NOW)).not.toThrow();
      expect(parseBackup(text, NOW).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// sinceLastBackupDays 语义
// ---------------------------------------------------------------------------

describe('sinceLastBackupDays —— 自备份导出时刻起的天数（向下取整、不为负）', () => {
  const cases: Array<[string, number, number]> = [
    ['刚导出', 0, 0],
    ['不足一天', DAY / 2, 0],
    ['3 天半 → 3', 3.5 * DAY, 3],
    ['恰好 7 天 → 7', 7 * DAY, 7],
    ['未来时间戳（时钟回拨）→ 0，不为负', -2 * DAY, 0],
  ];

  for (const [label, delta, expected] of cases) {
    it(`BK#18 ${label}：${expected}`, () => {
      const text = envelopeText({ exportedAt: NOW });
      const parsed = parseBackup(text, NOW + delta);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.sinceLastBackupDays).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// RF#5 7 天提醒闸门
// ---------------------------------------------------------------------------

describe('backupReminderDue —— null→true / <7d→false / ≥7d→true', () => {
  it('BK#19 从未导出（null）→ true；非有限值按"从未导出"处理（宁可多提醒，不静默失效）', () => {
    expect(backupReminderDue(null, NOW)).toBe(true);
    expect(backupReminderDue(Number.NaN, NOW)).toBe(true);
    expect(backupReminderDue(Number.POSITIVE_INFINITY, NOW)).toBe(true);
  });

  it('BK#20 刚导出 / 6 天 23:59:59 → false（未到 7 天不打扰）', () => {
    expect(backupReminderDue(NOW, NOW)).toBe(false);
    expect(backupReminderDue(NOW - (7 * DAY - 1), NOW)).toBe(false);
  });

  it('BK#21 恰好 7 天与更久 → true（边界闭区间：≥7d 即提醒）', () => {
    expect(backupReminderDue(NOW - 7 * DAY, NOW)).toBe(true);
    expect(backupReminderDue(NOW - 30 * DAY, NOW)).toBe(true);
  });

  it('BK#22 时钟回拨（lastExportedAt 晚于 now）→ false，不因负差值误判', () => {
    expect(backupReminderDue(NOW + 3 * DAY, NOW)).toBe(false);
  });

  it('BK#23 periodDays 参数化：1 天档 25h→true / 23h→false（默认 7 天档同刻为 false）', () => {
    expect(backupReminderDue(NOW - 25 * 3_600_000, NOW, 1)).toBe(true);
    expect(backupReminderDue(NOW - 23 * 3_600_000, NOW, 1)).toBe(false);
    expect(backupReminderDue(NOW - 25 * 3_600_000, NOW)).toBe(false);
  });

  it('BK#24 非法 periodDays（0/负/NaN）回落 7 天档，不把闸门永久打开或关死', () => {
    expect(backupReminderDue(NOW - 1 * DAY, NOW, 0)).toBe(false);
    expect(backupReminderDue(NOW - 8 * DAY, NOW, 0)).toBe(true);
    expect(backupReminderDue(NOW - 1 * DAY, NOW, Number.NaN)).toBe(false);
    expect(backupReminderDue(NOW - 1 * DAY, NOW, -3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 与 Task 4 装配面集成（meta 记录 lastExportedAt + flush 契约）
// ---------------------------------------------------------------------------

describe('装配集成 —— 导出即持久快照 / 导出时刻使 due 翻 false', () => {
  it('BK#25 导出成功 → coordinator 记录 lastExportedAt → due 由 true 翻 false，且该时刻经重建存活', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    await raw.save(makeSave([makeCard('b1')]));
    const coord = await createCoordinator(raw, { now: clock.now });

    // 导出前置条件：必须用 flush() && !dirty() 才是"此刻已持久"（R-T4-p3-d）
    await coord.mutate((s) => {
      s.meta.plays += 1;
    });
    expect(await coord.flush()).toBe(true);
    expect(coord.dirty()).toBe(false);

    const nowMs = clock.now();
    const text = exportBackup(coord.snapshot(), nowMs);
    const roundtrip = parseBackup(text, nowMs);
    expect(roundtrip.ok).toBe(true);
    if (!roundtrip.ok) return;
    expect(roundtrip.save).toStrictEqual(coord.snapshot());

    // 提醒闸门四态在真实时刻轴上的联动
    expect(backupReminderDue(null, nowMs)).toBe(true); // 从未导出：提醒
    expect(backupReminderDue(nowMs, nowMs)).toBe(false); // 刚导出：不打扰
    expect(backupReminderDue(nowMs, nowMs + 7 * DAY)).toBe(true); // 满 7 天：再提醒

    // 导出成功后记录导出时刻：T7 起走真实写入路径 Coordinator.markExported（R-T5-p3-a），
    // 不再由测试手工塞 meta——持久位若没人喂，7 天闸门就是死代码，这条用例正是它的喂入方取证。
    // M-2：返回值是"记上并落净"的判定位（调用方不必再靠 dirty() 反推）
    expect(await coord.markExported(nowMs)).toBe(true);
    expect(coord.dirty()).toBe(false); // markExported 自带 flush()&&!dirty() 收口
    const persisted = await raw.load();
    expect(readLastExportedAt(persisted!)).toBe(nowMs);

    // 重建 coordinator（模拟下次启动）：该时刻经 validateSave + store 往返存活
    const revived = await createCoordinator(raw, { now: clock.now });
    expect(validateSave(revived.snapshot()).ok).toBe(true);
    const carried = readLastExportedAt(revived.snapshot());
    expect(carried).toBe(nowMs);
    expect(backupReminderDue(carried, clock.now())).toBe(false); // 导出后：闸门关闭
    clock.tick(7 * DAY); // 一周不导出
    expect(backupReminderDue(carried, clock.now())).toBe(true); // 到期：重新提醒
  });

  it('BK#26 在途 mutate 时 flush()===true 不等于"已持久"：按 flush()&&!dirty() 收口后导出与 store 一致', async () => {
    const clock = useFakeClock(NOW);
    const raw = createMemoryStorage();
    const staged = stagedStore(raw);
    const coord = await createCoordinator(staged.store, { now: clock.now });

    await coord.mutate((s) => {
      s.meta.plays = 1;
    });
    staged.hold();
    const flushing = coord.flush(); // 快照已取（plays=1），停在 store.save
    await drainMicrotasks();
    expect(staged.pending()).toBe(true);

    await coord.mutate((s) => {
      s.meta.plays = 42; // 在途改动：不属于本次已取快照
    });
    await staged.release();
    expect(await flushing).toBe(true);
    // 只信 boolean 就会在此刻认账为"已持久"——正是 R-T4-p3-d 禁止的口径
    expect(coord.dirty()).toBe(true);

    // 收口：反复 flush 直至无脏（或再 flush 一次），此刻导出才是持久快照
    let guard = 0;
    while (coord.dirty() && guard < 5) {
      expect(await coord.flush()).toBe(true);
      guard += 1;
    }
    expect(coord.dirty()).toBe(false);

    const text = exportBackup(coord.snapshot(), clock.now());
    const parsed = parseBackup(text, clock.now());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save.meta.plays).toBe(42);
    expect(parsed.save).toStrictEqual((await raw.load())!); // 导出的就是存储里那一份
  });
});

// ---------------------------------------------------------------------------
// T6 捎带：T5 评审 Minor 五项（R-T5-p3-c 裁决）
// ---------------------------------------------------------------------------

describe('T6 捎带修复 —— T5 评审 Minor', () => {
  it('BK#27 [item1] version 1.5 走通用畸形文案，不再误报"来自更新的版本，请先升级"', () => {
    const r = parseBackup(envelopeText({ version: 1.5 }), NOW);
    expectEnvelopeError(r, 'version');
    // 1.5 不是"下一代格式"，是畸形值：指路升级会让用户白等一个不存在的版本
    expect(reasonOf(r)).not.toContain('升级');
    // 而真正的下一代（整数 2）仍必须指路升级——收紧不得误伤
    expect(reasonOf(parseBackup(envelopeText({ version: 2 }), NOW))).toContain('升级');
    expect(reasonOf(parseBackup(envelopeText({ version: 99 }), NOW))).toContain('升级');
  });

  it('BK#28 [item2] describeValue 保留 number/boolean 实际值（1e300 不再读成"number"）', () => {
    // 可读 reason 的目的：用户能拿这句话去自己文件里对号入座
    expectEnvelopeError(parseBackup(envelopeText({ exportedAt: 1e300 }), NOW), '实际为 1e+300');
    expectEnvelopeError(parseBackup(envelopeText({ version: 1.5 }), NOW), '实际为 1.5');
    expectEnvelopeError(parseBackup(envelopeText({ exportedAt: true }), NOW), '实际为 true');
    // 原有对 null/undefined/数组/字符串的描述不变（本项只补 number/boolean）
    expectEnvelopeError(parseBackup('[]', NOW), '实际为 array');
    expectEnvelopeError(parseBackup('null', NOW), '实际为 null');
    expectEnvelopeError(parseBackup('"x"', NOW), '实际为 "x"');
  });

  it('BK#29 [item3] nowMs 非有限（NaN/Infinity/undefined）→ true：闸门 fail-open，绝不静默永不提醒', () => {
    // 修复前 NaN - t >= period 恒 false = 静默永不提醒，与模块自述"宁可多提醒一次"矛盾
    expect(backupReminderDue(NOW, Number.NaN)).toBe(true);
    expect(backupReminderDue(NOW, Number.POSITIVE_INFINITY)).toBe(true);
    expect(backupReminderDue(NOW, undefined as unknown as number)).toBe(true);
    // 正常时刻轴不受影响
    expect(backupReminderDue(NOW, NOW)).toBe(false);
    expect(backupReminderDue(NOW - 7 * DAY, NOW)).toBe(true);
  });

  it('BK#30 [item4] migrateSave 抛非迁移前缀异常 → console.warn + 原样上抛，不伪装成"存档内容有问题"', () => {
    const bug = new TypeError('cannot read properties of undefined (reading "cards")');
    migrateFault = bug;
    expect(() => parseBackup(envelopeText({}), NOW)).toThrow(bug);
    expect(console.warn).toHaveBeenCalled();

    // 故障开关一次性：其后仍走真实现（mock 是透传包装，不是替代品）
    expect(parseBackup(envelopeText({}), NOW).ok).toBe(true);
    // 迁移前缀的正常失败仍收敛为存档层 + 可读 reason（收紧不得漏掉既有分层）
    const orphan = makeSave([makeCard('orphan-t6', { deckId: 'nope' })]);
    expectSaveError(parseBackup(envelopeText({ save: orphan }), NOW), 'cards[0].deckId');
  });

  it('BK#31 [item4 反面] 存档层 reason 永不暴露内部异常类名（fail-closed 且用户可读）', () => {
    const orphan = makeSave([makeCard('orphan-t6b', { deckId: 'gone' })]);
    const r = parseBackup(envelopeText({ save: orphan }), NOW);
    expect(reasonOf(r)).not.toContain('TypeError');
    expect(reasonOf(r)).not.toContain('Error:');
  });
});
