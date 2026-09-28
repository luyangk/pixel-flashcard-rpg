/**
 * fullSession.smoke.test.ts —— Plan 3 · T8 headless 整局冒烟（DoD1 的可执行证据链）。
 *
 * 「无画面的可玩游戏」在这里被端到端跑一遍：种子档导入 30 张卡 → startFight(size 15)
 * → 逐张 answerCurrent（seeded 70% good / 30% again）→ settleFight 落账 → settleAndRecord
 * → flush()&&!dirty() → 备份导出 → 重开 coordinator 恢复 → 断言 SRS / domainReviewCount /
 * leaderboard / exp 全链一致 → exportBackup→parseBackup 往返无损 → 导回空环境。
 *
 * 时间纪律（全局约束）：全程无真实时钟——vi.useFakeTimers + vi.setSystemTime 冻结宿主轴，
 * coordinator 的 now 由 platform/clock 注入（与生产同一条缝），时区由 platform/env mock 固定为
 * UTC+8。因此断言里的每个时间戳都是可复算的常量，不存在"跑得快慢影响结果"。
 *
 * 用例编号：
 * - SM#1 整局链路（种子导入 → 开战 → 逐张作答 → 结算落账 → 战绩榜 → 刷新 → 重建恢复
 *   → 备份往返 → 导回空环境）——DoD1 的主证据；
 * - SM#2 备份提醒闸门闭环 + 他机 meta.lastExportedAt 的剔除（R-T7-p3-a 的 app 层取证）；
 * - SM#3 导入/导出编排守卫（T5 M5 / R-T6-p3-b）；
 * - SM#4 假记忆演出固定 1–2 张（T6 顾虑②③）；
 * - SM#5/SM#6 机器化门禁（R-P3-b 的 Date.now( 扫描 + R-T7-p3-e-1 的常量单一权威）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, SaveFile } from '@core/types';
import { mulberry32 } from '@core/rng';
import { GRADES, type Grade } from '@core/sm2';
import { MAX_TIME_MS, importAndSave, validateSave } from '@core/saveMigrate';
import { domainReviewCount, localDayString } from '@core/reviewLedger';
import { victoryExp } from '@core/stats';
import { scoreRun } from '@core/leaderboard';
import { createMemoryStorage } from '@platform/memoryStore';
import { now as clockNow } from '@platform/clock';
import { tzOffsetMin } from '@platform/env';
import { startFight, answerCurrent, type FightError, type FightView } from '../../src/app/battleFlow';
import { playerStatsFor, settleFight } from '../../src/app/growth';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import { recordRun, buildRunInput } from '../../src/app/results';
import { backupReminderDue, exportBackup, parseBackup } from '../../src/app/backup';
import { pickFakes } from '../../src/app/fakeMemory';
import { exportBackupText, importBackupText } from '../../src/app/transfer';
// 复用 core purity 守卫的注释剥离器（R-P3-b 的扫描必须是"代码里没有"，不是"文本里没有"）
import { collectTs, stripComments } from '../../scripts/check-core-purity';

// —— 仿真锚点：2026-10-26T04:00Z，UTC+8 下本地日键为 2026-10-26（与仓内既有夹具同源）——
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 86_400_000;
const TZ = 480; // UTC+8（platform/env mock 后的固定值）

// 时区单点 mock：宿主时区随 CI/开发机漂移，而 reviewFlow 的日键口径依赖它——
// 固定成 UTC+8 后，本文件所有日键断言都是常量（warehouse 其余 app 测试同口径）。
vi.mock('@platform/env', () => ({ tzOffsetMin: () => 480 }));

/** 一份整包合法的存档（validateSave / parseBackup 都能接受的最小形状）。 */
function makeSave(cards: Card[] = [], over: Partial<SaveFile> = {}): SaveFile {
  return {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '领域A', isPreset: true }],
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 整局夹具
// ---------------------------------------------------------------------------

/**
 * 30 张"CSV/预置导入"后的全库卡片。口径说明（每条都是为了让断言可复算）：
 * - stability='mastered' + interval=10：单卡伤害 round(atk×1.5×[0.9,1.1]) ≈ 16–20，
 *   15 张池对 enemyHp=105 是**可赢**的局——本冒烟要跑通胜利路径（victoryExp / N-2 的
 *   "won 后剩余卡零推进"），输局不覆盖这些分支；
 * - effectiveReviewDays=[] 且 due=0：开战前 domainReviewCount 恒 0、全部到期，
 *   于是"打完一局后 >0"是一条真断言（不是被夹具预置值满足的恒真式）；
 * - back 含数字、且词表能命中：假记忆两种规则都有素材可篡改（SM#4）。
 */
function makeLibrary(count: number, deckId = 'deck-a'): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    cards.push({
      id: `card-${String(i + 1).padStart(2, '0')}`,
      deckId,
      front: `第 ${i + 1} 题：它离我们多远？`,
      back: `第 ${i + 1} 题答案：${i + 3} 亿公里，约 ${i + 2} 秒`,
      tags: ['天文', '导入'],
      source: { type: 'preset', createdAt: NOW },
      srs: {
        ease: 2.5,
        interval: 10,
        reps: 5,
        lapses: 0,
        due: 0, // 全部到期：buildPool 的智能段因此有 12 张可选
        stability: 'mastered',
        effectiveReviewDays: [],
      },
    });
  }
  return cards;
}

/** 假记忆词表（命中 back 里的"公里/秒"）。 */
const WORD_TABLE = new Map([
  ['公里', '英里'],
  ['秒', '分钟'],
]);

/** startFight 的失败面是返回值——冒烟里把它当断言失败处理（数据流不该在这断）。 */
function expectView(v: FightView | FightError): FightView {
  if ('error' in v) throw new Error(`startFight 失败：${v.error} —— ${v.message}`);
  return v;
}

/** 推进假时钟：定时器与 Date 同步前进（coordinator 的 debounce/maxBatch 窗据此到期）。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** 一次完整会话的全部产物（供 SM#1/SM#2 共用，避免两处各跑一遍不同口径）。 */
interface SessionRun {
  readonly store: ReturnType<typeof createMemoryStorage>;
  readonly coord: Coordinator;
  readonly view: FightView;
  readonly answered: number;
  readonly seed: Card[];
  readonly settleExp: number;
  readonly mismatches: string[];
  readonly grades: Map<string, Grade>;
}

/**
 * 跑完"导入 → 开战 → 逐张作答 → 结算落账 → 记战绩榜 → 收口落盘"。
 * 全程注入 now / rng：池抽取、伤害浮动、评分策略各用一个独立 seeded 流。
 */
async function runSession(): Promise<SessionRun> {
  const seed = makeLibrary(30);
  const store = createMemoryStorage();
  // ① 种子档：经**真实导入路径**落进空存储（模拟 CSV/备份导入后的 cards[]）
  expect(await importAndSave(JSON.stringify(makeSave(seed)), store)).toEqual({ ok: true });

  // ② coordinator 首次装配（生产线：now 传 platform/clock）
  const coord = await createCoordinator(store, { now: clockNow, debounceMs: 500, maxBatchMs: 5000 });

  // ③ 开战：size 15，池抽取用独立 seeded 流
  const poolRng = mulberry32(0x5eed_0001);
  const view0 = expectView(startFight(coord.snapshot(), {
    size: 15,
    rng: poolRng,
    nowMs: clockNow(),
    stats: playerStatsFor(coord.snapshot()),
  }));

  // ④ 逐张作答：seeded 70% good / 30% again；每张记下评分供结算同源消费
  const gradeRng = mulberry32(0x5eed_0002);
  const battleRng = mulberry32(0x5eed_0003);
  const grades = new Map<string, Grade>();
  const mismatches: string[] = [];
  let view = view0;
  let answered = 0;
  while (view.current !== null) {
    const card = view.current;
    const grade: Grade = gradeRng() < 0.7 ? GRADES.good : GRADES.again;
    grades.set(card.id, grade);
    view = answerCurrent(view, grade, { rng: battleRng, asserts: (m) => mismatches.push(m) });
    answered += 1;
    await advance(120); // 真实节奏：作答之间推进假时钟（debounce 窗会自然到期）
  }
  expect(answered).toBe(view.state.idx); // idx 恒 +1：已作答数即权威进度

  // ⑤ 结算落账（唯一入口 settleFight → coordinator.settleAndRecord）
  const settle = settleFight(coord.snapshot().cards, view, {
    gradeOf: (c) => grades.get(c.id) ?? GRADES.again,
    nowMs: clockNow(),
    tzOffsetMin: tzOffsetMin(),
    params: coord.snapshot().settings.sm2Params,
  });
  await coord.settleAndRecord(settle);

  // ⑥ 战绩榜落盘
  await recordRun(coord, view, view.state, {
    nowMs: clockNow(),
    domain: 'deck-a',
    kind: 'encounter',
    level: playerStatsFor(coord.snapshot()).level,
  });

  return { store, coord, view, answered, seed, settleExp: settle.exp, mismatches, grades };
}

describe('Plan 3 · T8 导入/导出编排守卫', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * T5 评审 M5（R-T5-p3-c：归 T8 守卫）。exportBackup 是刻意不校验入参的纯函数
   * （T5 §顾虑 3 的自述口径），因此脏入参能产出**结构残缺的信封**：
   * `save: undefined` 会被 JSON.stringify 整键丢弃，`nowMs: NaN` 会序列化成 `null`。
   * 这样的文件用户看不见问题、却在导入时被拒——正是"M5 归 UI 守卫"的理由。
   *
   * 用例分两半：先**演示**未守卫时的真实后果（证明守卫不是装饰），再断言编排层
   * （src/app/transfer.exportBackupText）把这两种入参挡在"生成文件"之前。
   */
  it('SM#3a 导出脏入参守卫：不产出缺 save 键 / exportedAt:null 的信封（T5 M5）', () => {
    // ① 未守卫的真实后果：类型层已拦（@ts-expect-error 由 typecheck 强制），
    //    运行期它照样会生成一份"残信封"——这就是要防的东西。
    const degenerate = (() => {
      // @ts-expect-error save 为必填 SaveFile：类型层不接受 undefined
      return exportBackup(undefined, NaN);
    })();
    const raw = JSON.parse(degenerate) as Record<string, unknown>;
    expect('save' in raw).toBe(false); // 缺 save 键（JSON.stringify 丢弃 undefined）
    expect('exportedAt' in raw).toBe(true);
    expect(raw.exportedAt).toBe(null); // NaN → null：导入侧 isTimestamp 必拒

    // ② 编排守卫：脏入参直接失败，绝不落到 exportBackup
    const noSave = exportBackupText(undefined as unknown as SaveFile, NOW);
    expect(noSave.ok).toBe(false);
    if (!noSave.ok) expect(noSave.reason).toContain('存档还没准备好');

    for (const badNow of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      const r = exportBackupText(makeSave(), badNow);
      expect(r.ok).toBe(false);
    }

    // ③ 守卫与信封的接受域同界：合法时刻产出的信封必被 parseBackup 接受（边界值含在内）
    for (const goodNow of [NOW, 0, 8.64e15]) {
      const r = exportBackupText(makeSave(), goodNow);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const parsed = parseBackup(r.text, NOW);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.save).toStrictEqual(makeSave());
      }
    }
  });

  /**
   * R-T6-p3-b：parseBackup 的 doc 明说"唯一的例外是迁移器内部的真 bug，此类原样上抛
   * 不伪装成存档坏了"。UI 直接调它就可能吃到未捕获异常——导入路径必须 try/catch。
   *
   * 用例覆盖两条路径：①真实的畸形串（parseBackup 自身已收敛为信封层 ok:false）；
   * ②模拟那个"原样上抛"的真 bug（注入抛错解析器），断言编排层接住并给出可读 reason。
   */
  it('SM#3b 导入编排 try/catch：畸形串不抛，内部真 bug 也被接住（R-T6-p3-b）', () => {
    // ① 畸形串：用户随手粘进来的东西
    const bad = importBackupText('这不是 JSON，只是随手粘的一段话', NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('JSON');
    // 空串 / 半个信封 / 别的应用的文件 同样只回 reason
    for (const text of ['', '   ', '{', '{"format":"other"}', '[]']) {
      expect(() => importBackupText(text, NOW)).not.toThrow();
      expect(importBackupText(text, NOW).ok).toBe(false);
    }

    // ② 真 bug 路径：parseBackup 会把非迁移前缀的异常原样上抛，编排层必须接住
    const boom = (): never => {
      throw new Error('boom: 迁移器内部错误');
    };
    expect(() => importBackupText('{"format":"zx-xia-backup"}', NOW, boom)).not.toThrow();
    const caught = importBackupText('{"format":"zx-xia-backup"}', NOW, boom);
    expect(caught.ok).toBe(false);
    if (!caught.ok) {
      expect(caught.reason).toContain('导入没能完成');
      expect(caught.reason).toContain('boom');
      expect(caught.reason).toContain('没有被改动'); // 给用户的定心话
    }
  });
});

// ---------------------------------------------------------------------------
// SM#1 —— 整局链路（DoD1 主证据）
// ---------------------------------------------------------------------------

describe('Plan 3 · T8 headless 整局冒烟', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('SM#1 导入→开战→逐张作答→结算落账→刷新→重建恢复→备份往返，全链一致', async () => {
    const run = await runSession();
    const { coord, view, seed, answered, settleExp, mismatches } = run;

    // —— 时间纪律自证：全程无真实时钟（注入的 now 恰好停在假时钟上）——
    expect(tzOffsetMin()).toBe(TZ); // env mock 生效（否则日键断言会随宿主时区漂移）
    const DAY_KEY = localDayString(clockNow(), TZ);
    expect(DAY_KEY).toBe('2026-10-26');

    // —— 战斗终局：赢了，且没有一次"答非当前卡"（N-9 装配层免疫）——
    expect(view.state.phase).toBe('won');
    expect(mismatches).toEqual([]);
    expect(answered).toBeGreaterThan(0);
    // 评分策略自证：每张恰好记一次分，且 70/30 两条分支都真的走到了
    // （否则"seeded 70% good/30% again"只是一句注释）
    expect(run.grades.size).toBe(answered);
    const goodCount = [...run.grades.values()].filter((g) => g === GRADES.good).length;
    expect(goodCount).toBeGreaterThan(0);
    expect(answered - goodCount).toBeGreaterThan(0);

    // —— R-T4-p3-d：flush() && !dirty() 才算"我的改动已持久"——
    expect(await coord.flush()).toBe(true);
    expect(coord.dirty()).toBe(false);
    const flushed = structuredClone(coord.snapshot());

    // —— 重开 coordinator 同 store 恢复：内存权威对象与存储逐键一致 ——
    const coord2 = await createCoordinator(run.store, { now: clockNow });
    expect(coord2.dirty()).toBe(false); // 恢复即净：没有悬空改动凭空出现
    expect(coord2.snapshot()).toEqual(flushed);
    expect(await coord2.flush()).toBe(true);

    const after = coord2.snapshot();
    // 存储里的备份 = 内存权威对象（崩溃一致性：store 永远只有"某次成功 flush 的完整快照"）
    expect(await run.store.load()).toEqual(after);

    // —— N-2：只有"被作答过的池前缀"推进 SRS，won 后的作废卡零推进 ——
    const poolIds = view.pool.map((c) => c.id);
    const consumedCount = Math.min(view.state.idx, poolIds.length);
    const consumed = new Set(poolIds.slice(0, consumedCount));
    expect(consumed.size).toBe(consumedCount); // 池内无重复 id（buildPool 不变量）
    const seedById = new Map(seed.map((c) => [c.id, c]));
    expect(after.cards).toHaveLength(seed.length); // 全库不动：不是"只留参战卡"
    for (const card of after.cards) {
      const before = seedById.get(card.id)!;
      if (consumed.has(card.id)) {
        expect(card.srs.effectiveReviewDays).toEqual([DAY_KEY]); // 记了今天这一次
        expect(card.srs.due).not.toBe(before.srs.due); // 下次到期已重排
      } else {
        // 未作答/被作废的卡：SRS 逐字段原样（"未答的题不该被系统偷偷复习过"）
        expect(card.srs).toEqual(before.srs);
      }
    }

    // —— 领域有效复习数 = 消耗张数（每张恰好一个日键）——
    expect(domainReviewCount(after.cards)).toBe(consumedCount);
    expect(domainReviewCount(after.cards)).toBeGreaterThan(0);

    // —— exp 入账：victoryExp(释放子集) ——
    const released = view.pool.slice(0, consumedCount);
    expect(settleExp).toBe(victoryExp(released, 'encounter'));
    expect(settleExp).toBeGreaterThan(0);
    expect(after.settings.progress.exp).toBe(settleExp);
    expect(playerStatsFor(after).level).toBeGreaterThanOrEqual(1);
    expect(after.meta.plays).toBe(1);

    // —— 战绩榜：一局一条，且与 buildRunInput/scoreRun 同源 ——
    const board = after.settings.leaderboard ?? [];
    expect(board).toHaveLength(1);
    const expectedInput = buildRunInput(view, view.state, {
      nowMs: clockNow(), domain: 'deck-a', kind: 'encounter', level: playerStatsFor(after).level,
    });
    expect(board[0].result).toBe('won');
    expect(board[0].score).toBe(scoreRun(expectedInput));
    expect(board[0].score).toBeGreaterThan(0);
    expect(board[0].cards).toBe(consumedCount);
    expect(board[0].misses).toBeLessThanOrEqual(consumedCount);
    expect(validateSave(after).ok).toBe(true);

    // —— 备份导出 → 解析：无损往返 ——
    const exported = exportBackupText(after, clockNow());
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = parseBackup(exported.text, clockNow());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save).toStrictEqual(after); // 逐键无损（含榜单行内九字段与全部 SRS）
    expect(parsed.sinceLastBackupDays).toBe(0);

    // —— DoD5：导出 → 空环境 → 导入，进度完整 ——
    const fresh = createMemoryStorage();
    expect(await importAndSave(JSON.stringify(parsed.save), fresh)).toEqual({ ok: true });
    const restored = await fresh.load();
    expect(restored).toEqual(after);
    expect(validateSave(restored).ok).toBe(true);
    const restoredLibrary = restored as SaveFile;
    expect(domainReviewCount(restoredLibrary.cards)).toBe(consumedCount);
    expect(restoredLibrary.settings.progress.exp).toBe(settleExp);
    expect(restoredLibrary.settings.leaderboard?.[0]?.score).toBe(board[0].score);
  });

  it('SM#2 备份提醒闸门闭环：markExported 落位存活；他机 lastExportedAt 导入即剔除（R-T7-p3-a）', async () => {
    const run = await runSession();
    // ① 导出成功后记时：唯一生产写入位 coordinator.markExported（M-2：返回 true = 已记上并落净）
    expect(await run.coord.markExported(clockNow())).toBe(true);
    expect(run.coord.dirty()).toBe(false);
    const stored = await run.store.load();
    expect(stored?.meta.lastExportedAt).toBe(clockNow());
    // 重建 coordinator：持久位存活（不是只活在内存里）
    const revived = await createCoordinator(run.store, { now: clockNow });
    expect(revived.snapshot().meta.lastExportedAt).toBe(clockNow());

    // ② 闸门边界：<7 天不提醒、满 7 天提醒（闭区间）
    const last = revived.snapshot().meta.lastExportedAt ?? null;
    expect(backupReminderDue(last, clockNow() + 6 * DAY)).toBe(false);
    expect(backupReminderDue(last, clockNow() + 7 * DAY)).toBe(true);

    // ③ 他机档：含别处写下的 lastExportedAt。parseBackup 忠于文件（字段仍在），
    //    但 importAndSave 落库时剔除——本机的导出史不能由别人的时刻代表。
    const foreign = makeSave(makeLibrary(3), {
      meta: { savedAt: NOW - 5 * DAY, plays: 9, lastExportedAt: NOW - 2 * DAY },
    });
    const envelope = exportBackupText(foreign, NOW - 2 * DAY);
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    const parsed = parseBackup(envelope.text, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save.meta.lastExportedAt).toBe(NOW - 2 * DAY); // 解析无损，不越权改写

    const fresh = createMemoryStorage();
    expect(await importAndSave(JSON.stringify(parsed.save), fresh)).toEqual({ ok: true });
    const loaded = await fresh.load();
    expect(loaded !== null && 'lastExportedAt' in loaded.meta).toBe(false);
    expect(loaded?.meta.plays).toBe(9); // 剔除的只是"导出史"，其余进度保真
    // fail-safe 方向：视作"从未导出" ⇒ 提醒照响（宁可多提醒一次，不被别人的时刻静默关掉）
    expect(backupReminderDue(loaded?.meta.lastExportedAt ?? null, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SM#4 —— 假记忆演出（T6 顾虑②③）
// ---------------------------------------------------------------------------

describe('Plan 3 · T8 假记忆演出素材', () => {
  it('SM#4 固定 1–2 张：不依赖素材 id 去重，且每张只篡改答案面', () => {
    const pool = makeLibrary(6);
    const fakes = pickFakes(pool, 2, { rng: mulberry32(0xfa4e_0001), wordTable: WORD_TABLE });
    // T6 顾虑②③：pickFakes 的产出条数取决于池内容（不循环硬凑、不重复用同一张真卡），
    // 故调用方按实际返回长度渲染——本冒烟钉的就是"1–2 张"这个可渲染区间。
    expect(fakes.length).toBeGreaterThanOrEqual(1);
    expect(fakes.length).toBeLessThanOrEqual(2);
    // realCardId/id 批内唯一是 pickFakes 的**结构保证**（每张真卡至多一条），
    // 不是调用方事后去重的结果——这正是 T6 顾虑②要钉的口径。
    expect(new Set(fakes.map((f) => f.realCardId)).size).toBe(fakes.length);
    expect(new Set(fakes.map((f) => f.id)).size).toBe(fakes.length);

    const byId = new Map(pool.map((c) => [c.id, c]));
    for (const f of fakes) {
      const real = byId.get(f.realCardId)!;
      expect(real).toBeDefined();
      expect(f.front).toBe(real.front); // 问题面保真：先认出这张卡
      expect(f.tamperedBack).not.toBe(real.back); // 硬契约：不含真答案
      expect(['number-shift', 'word-swap']).toContain(f.rule);
    }
    // 池空 / 需求 ≤0：空数组而非抛错（演出素材生成不得打断战败流程）
    expect(pickFakes([], 2, { rng: mulberry32(1), wordTable: WORD_TABLE })).toEqual([]);
    expect(pickFakes(pool, 0, { rng: mulberry32(1), wordTable: WORD_TABLE })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SM#5/SM#6 —— 机器化门禁
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = join(ROOT, 'src');

/** 扫描一段源码里的 `Date.now(` **调用**（先剥注释与字符串字面量）。 */
function clockReadsIn(source: string, rel: string): string[] {
  const hits: string[] = [];
  stripComments(source).split('\n').forEach((line, i) => {
    if (/Date\.now\s*\(/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

describe('Plan 3 · T8 机器化门禁', () => {
  it('SM#5 src/** 除 platform/clock.ts 外零 Date.now( 调用（R-P3-b）', () => {
    const files = collectTs(SRC_DIR);
    expect(files.length).toBeGreaterThan(20); // 扫描面自证：不是空集恒真
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel === join('src', 'platform', 'clock.ts')) continue; // 全仓唯一时钟入口
      hits.push(...clockReadsIn(readFileSync(file, 'utf8'), rel));
    }
    // app 层不读宿主钟从此是门禁不是纪律：persist 的 `hostNow = Date.now`（只作双时钟
    // 补偿的函数引用，无调用括号）不在扫描面内，其理由写在 persist.ts 头注释里。
    expect(hits).toEqual([]);

    // 正对照：扫描器对"代码里的调用"确实会命中（防止注释剥离把一切都吞掉变成恒真）
    expect(clockReadsIn('const t = Date.now(); // Date.now( 只活在注释里', 'x.ts'))
      .toEqual(['x.ts:1: const t = Date.now();']);
    // 反证：被豁免的 clock.ts 真身确有且仅有那一处调用
    const clockHits = clockReadsIn(
      readFileSync(join(SRC_DIR, 'platform', 'clock.ts'), 'utf8'),
      'src/platform/clock.ts',
    );
    expect(clockHits).toHaveLength(1);
  });

  it('SM#6 时间戳域单一权威：src/app/** 无 MAX_TIME_MS 本地字面量副本（R-T7-p3-e-1）', () => {
    const appFiles = collectTs(join(SRC_DIR, 'app'));
    expect(appFiles.length).toBeGreaterThan(3);
    const copies: string[] = [];
    for (const file of appFiles) {
      const rel = relative(ROOT, file);
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (/8\.64e15/.test(line)) copies.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(copies).toEqual([]); // persist/results/backup 三处副本已改 import
    expect(MAX_TIME_MS).toBe(8.64e15); // 权威常量仍在 core，值未变
  });
});

