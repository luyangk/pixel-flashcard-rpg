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
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
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
    expect(s.lastError?.code).toBe('invalid-size'); // 码供 T7 分流，文案供上屏
    expect(s.lastError?.message).toContain('设置');
  });

  it('GC#4 空库 → lastError 含"还没有卡片"（与 invalid-size 分流），且不抛', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([], clock);
    await ctrl.intent({ type: 'startFight', size: 15 });
    const s = ctrl.snapshot();
    expect(s.lastError?.code).toBe('no-cards');
    expect(s.lastError?.message).toContain('还没有卡片');
  });

  it('GC#4b 序章：skipPrologue / seenPrologue 均落 menu，并把 story.prologueSeen 写实（T6 接线，R-T6-p4-a）', async () => {
    const clock = fakeClock(NOW);
    const { ctrl, coord, store } = await makeController([makeCard('c0')], clock);
    expect(coord.snapshot().settings.story.prologueSeen).toBe(false); // 新档：序章没看过

    await ctrl.intent({ type: 'skipPrologue' });
    expect(ctrl.snapshot().screen).toBe('menu');
    // 判别力：T3 的"管道先建、直达 menu"空实现下这一位恒为 false ⇒ 必红
    expect(coord.snapshot().settings.story.prologueSeen).toBe(true);

    // 两 intent 语义合并（跳过 = 看完 = 以后别再给我看），重复派发不改变结论
    await ctrl.intent({ type: 'seenPrologue' });
    expect(ctrl.snapshot().screen).toBe('menu');
    expect(coord.snapshot().settings.story.prologueSeen).toBe(true);

    await coord.flush();
    expect((await store.load())?.settings.story).toEqual({ prologueSeen: true, beatIndex: 0, arcSeen: 0 });
  });

  it('GC#5 deckIds 指向空集合 → insufficient-cards 文案报缺口', async () => {
    const clock = fakeClock(NOW);
    const { ctrl } = await makeController([makeCard('c0'), makeCard('c1')], clock);
    await ctrl.intent({ type: 'startFight', size: 5, deckIds: ['nope'] });
    expect(ctrl.snapshot().lastError?.code).toBe('insufficient-cards');
    expect(ctrl.snapshot().lastError?.message).toContain('还差');
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
    // 等级三字段（T7 result 屏显示"进境几级"的数据源）：L1 新号打完首胜通常不升级
    expect(snap.lastResult?.levelBefore).toBe(1);
    expect(snap.lastResult?.levelAfter).toBeGreaterThanOrEqual(1);
    expect(snap.lastResult?.leveledUp).toBe(snap.lastResult!.levelAfter > snap.lastResult!.levelBefore);
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
    // 显式指定 encounter 档：本用例要验的是"弃战不落账"，**不能让第一击就打穿**。
    // （不指定的话首战会走 tutorial 档，HP 只有 6 点，一击致命会让这一局提前结算——
    //  那是另一个用例的事，见 GC#T5-1。）
    await ctrl.intent({ type: 'startFight', size: 2, difficulty: 'encounter' });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    await ctrl.intent({ type: 'toMenu' });
    expect(ctrl.snapshot().screen).toBe('menu');
    expect(ctrl.snapshot().fight).toBeNull();
    expect(JSON.stringify(coord.snapshot().cards.map((c) => c.srs.reps))).toBe(before);
    expect(coord.snapshot().settings.leaderboard).toHaveLength(0);
  });

  it('GC#T5-1 首战自动走教学局（tutorial）：敌血系数 0.3；打过一局后回到 encounter', async () => {
    const clock = fakeClock(NOW);
    const cards = Array.from({ length: 10 }, (_, i) => makeCard(`c${i}`));
    const { ctrl, coord } = await makeController(cards, clock);
    expect(coord.snapshot().meta.plays).toBe(0); // 从未打过

    await ctrl.intent({ type: 'startFight', size: 10 });
    const first = ctrl.snapshot().fight!;
    expect(first.difficulty).toBe('tutorial');
    expect(first.state.enemyHp).toBe(30); // ceil(10×10×0.3)
    expect(first.state.enemyPower).toBe(7); // 反击与遭遇战同档（教学局只是更脆）

    // 打完这一局（判负也算"打过"）：下一场自动回到正常遭遇战
    for (let i = 0; i < 10; i++) {
      if (ctrl.snapshot().screen !== 'fight') break;
      await ctrl.intent({ type: 'answer', grade: GRADES.again });
    }
    expect(coord.snapshot().meta.plays).toBe(1);
    await ctrl.intent({ type: 'toMenu' });
    await ctrl.intent({ type: 'startFight', size: 10 });
    expect(ctrl.snapshot().fight?.difficulty).toBe('encounter');
    expect(ctrl.snapshot().fight?.state.enemyHp).toBe(70); // ceil(10×10×0.7)
  });

  it('GC#T5-2 教学局只降敌血：结算仍按遭遇战记账（kind=encounter、经验 21 而非 boss 档）', async () => {
    const clock = fakeClock(NOW);
    const cards = Array.from({ length: 10 }, (_, i) => makeCard(`c${i}`, 'review'));
    const { ctrl, coord } = await makeController(cards, clock);
    await ctrl.intent({ type: 'startFight', size: 10 });
    expect(ctrl.snapshot().fight?.difficulty).toBe('tutorial');
    for (let i = 0; i < 10; i++) {
      if (ctrl.snapshot().screen !== 'fight') break;
      await ctrl.intent({ type: 'answer', grade: GRADES.good });
    }
    const res = ctrl.snapshot().lastResult!;
    expect(res.won).toBe(true);
    expect(res.expGained).toBe(21); // 遭遇战档（round(30×0.7)），不是 boss 的 45
    const board = coord.snapshot().settings.leaderboard ?? [];
    expect(board[0].kind).toBe('encounter'); // 教学局不是另一类战斗
  });

  it('GC#9b 终局同帧两次 answer：第二次被相位守卫拦下，exp/plays/榜单只记一次（C-1 回归钉）', async () => {
    const clock = fakeClock(NOW);
    const cards = [makeCard('c0'), makeCard('c1'), makeCard('c2')];
    const { ctrl, coord } = await makeController(cards, clock);
    await ctrl.intent({ type: 'startFight', size: 3 });
    // 打到终局（won 提前击杀：idx 停在池内，正是旧守卫失效的形状）
    while (ctrl.snapshot().screen === 'fight') {
      await ctrl.intent({ type: 'answer', grade: GRADES.good });
    }
    const after = {
      exp: coord.snapshot().settings.progress.exp,
      plays: coord.snapshot().meta.plays,
      runs: (coord.snapshot().settings.leaderboard ?? []).length,
      reps: JSON.stringify(coord.snapshot().cards.map((c) => c.srs.reps)),
    };
    // 同帧再来两次 answer：必须完全是 no-op（相位守卫 + answerCurrent 空卡短路双保险）
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    const now2 = {
      exp: coord.snapshot().settings.progress.exp,
      plays: coord.snapshot().meta.plays,
      runs: (coord.snapshot().settings.leaderboard ?? []).length,
      reps: JSON.stringify(coord.snapshot().cards.map((c) => c.srs.reps)),
    };
    expect(now2).toEqual(after);
    // 反向证明这条用例真能抓 C-1：终局 idx 确实还在池内（否则守卫是多余的）
    const f = ctrl.snapshot().fight!;
    expect(f.state.idx).toBeLessThan(f.pool.length);
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
  /**
   * 只读 Coordinator 的**受控 fake**（评审 I-2 指出：坏档路线只能造出空种子档，
   * 永远走不到"有卡却在只读态"的 settle 拒绝面）。接口注入使这条路可达。
   *
   * 关键设计（二轮评审修正）：启动态 `readOnly()` **返回 false**，写面才抛
   * SaveReadOnlyError——模拟的是"磁盘中途变成只读"（唯一能走到 guardedWrite 的
   * catch 分支的形状）。若夹具一开始就 readOnly=true，控制器的只读早退会让
   * catch 分支永远不执行，等于没覆盖。
   */
  function makeReadOnlyFake(cards: Card[]): { coord: Coordinator; writes: () => number } {
    let writes = 0;
    // 启动即"看起来可写"（readOnly()===false），只有真正写入时才暴露只读。
    const roActive = (): boolean => false;
    const save = makeSave(cards);
    const throwRO = (): never => {
      const e = new Error('存档不可写（只读态测试夹具）');
      e.name = 'SaveReadOnlyError';
      throw e;
    };
    const coord: Coordinator = {
      mutate: async () => throwRO(),
      flush: async () => false,
      flushDetailed: async () => ({ ok: false, reason: 'read-only' }),
      dirty: () => true,
      lastSavedAt: () => null,
      snapshot: () => save,
      markDirty: throwRO,
      readOnly: () => roActive(),
      settleAndRecord: async () => {
        writes += 1;
        throwRO();
      },
      markExported: async () => false,
    } as unknown as Coordinator;
    return { coord, writes: () => writes };
  }

  it('GC#13 有卡 + 写面抛 SaveReadOnlyError：catch 分支执行 → readOnly 翻真 + notice + 数据零变化', async () => {
    const clock = fakeClock(NOW);
    const cards = [makeCard('c0'), makeCard('c1'), makeCard('c2')];
    const { coord, writes } = makeReadOnlyFake(cards);
    const ctrl = await createGameController({ coord, rng: mulberry32(7), now: clock.now, tzOffsetMin: TZ });

    expect(ctrl.snapshot().readOnly).toBe(false); // 启动可写（见夹具注释）
    await ctrl.intent({ type: 'startFight', size: 3 });
    expect(ctrl.snapshot().screen).toBe('fight'); // 只读不影响建战（纯内存视图）

    while (ctrl.snapshot().screen === 'fight') {
      await ctrl.intent({ type: 'answer', grade: GRADES.good });
    }
    const snap = ctrl.snapshot();
    // ① 异常被折成快照位而非逃逸：屏照常推进到 result，notice 有可上屏提示
    expect(snap.screen).toBe('result');
    expect(snap.readOnly).toBe(true);
    expect(snap.notice).toBe('存档无法读取，本次进度不会保存'); // 与 ui/readOnly.READ_ONLY_TEXT 逐字同源（评审 m-8）
    // ② catch 分支确实执行过（writes 恰 1，见下），且业务数据零变化（夹具的存档未被改）。
    expect(snap.lastResult?.won).toBe(true); // 结算摘要仍产出（内存态可玩）
    expect(coord.snapshot().settings.progress.exp).toBe(0);
    expect(coord.snapshot().settings.leaderboard ?? []).toHaveLength(0);
    expect(coord.snapshot().meta.plays).toBe(0);
    // ③ catch 分支真被执行过：写面恰好被触及一次（settleAndRecord 抛 RO 后，
    //    readOnly 已翻真 ⇒ 后续 recordRun 走早退不再触及写面），且无反复重试。
    expect(writes()).toBe(1);
  });

  it('GC#12（非只读对照）可写会话下同一局正常落库——与 GC#13 构成对照', async () => {
    const clock = fakeClock(NOW);
    const store = createMemoryStorage();
    const good = makeSave([makeCard('c0')]);
    await store.save(good);
    const coord = await createCoordinator(store, { now: clock.now });
    await coord.flush();
    const before = JSON.stringify(await store.load());

    const ctrl = await createGameController({ coord, rng: mulberry32(5), now: clock.now, tzOffsetMin: TZ });
    await ctrl.intent({ type: 'startFight', size: 20, deckIds: ['deck-a'] });
    for (let i = 0; i < 3; i++) {
      if (ctrl.snapshot().screen !== 'fight') break;
      await ctrl.intent({ type: 'answer', grade: GRADES.good });
    }
    expect(ctrl.snapshot().readOnly).toBe(false);
    expect(JSON.stringify(await store.load())).not.toBe(before); // 有写入发生
  });
});

/* ------------------------------------------------------------------ 卷灵战（T8） */

describe('gameController —— 卷灵净化 / 经验切档 / 三幕里程碑（T8）', () => {
  /** 三个领域各 1 张卡、各 15 个有效复习日：tier=15 ⇒ 三个卷灵全部达标。 */
  async function bossReadyController() {
    const clock = fakeClock(NOW);
    const store = createMemoryStorage();
    const coord = await createCoordinator(store, { now: clock.now });
    const ids = ['d1', 'd2', 'd3'];
    const days: string[] = [];
    for (let i = 0; i < 15; i++) days.push(`2026-09-${String(i + 1).padStart(2, '0')}`);
    await coord.mutate((save) => {
      save.decks = ids.map((id) => ({ id, name: `领域${id}`, isPreset: false }));
      save.cards = ids.map((id) => {
        const c = makeCard(`card-${id}`, 'review');
        c.deckId = id;
        c.srs.effectiveReviewDays = [...days];
        c.srs.due = 0;
        return c;
      });
      save.settings.bossThresholdTier = 15;
      save.settings.progress.exp = 5000; // 高等级 ⇒ atk 远高于单卡 Boss 的 HP（ceil(1×10×1.5)=15）
    });
    await coord.flush();
    const ctrl = await createGameController({ coord, rng: mulberry32(7), now: clock.now, tzOffsetMin: TZ });
    return { ctrl, coord, clock };
  }

  it('GC#T8-1 boss 胜利 → 净化落账 + 经验按 boss 档（45 而非 21）+ 第 3 个领域净化后解锁第一幕', async () => {
    const { ctrl, coord, clock } = await bossReadyController();

    for (let i = 0; i < 3; i++) {
      const id = `d${i + 1}`;
      await ctrl.intent({ type: 'startFight', size: 1, deckIds: [id], difficulty: 'boss' });
      expect(ctrl.snapshot().fight?.difficulty).toBe('boss');
      await ctrl.intent({ type: 'answer', grade: GRADES.good });

      const s = ctrl.snapshot();
      expect(s.screen).toBe('result');
      expect(s.lastResult?.won).toBe(true);
      // R-T3-p4-b 的兑现：boss 档经验 = round(30×1.5 + 5×0 张 mastered) = 45
      // （硬编码 encounter 的实现这里会得 21 ⇒ 必红）
      expect(s.lastResult?.expGained).toBe(45);
      expect(s.save.decks.find((d) => d.id === id)?.purifiedAt).toBe(clock.now());
      // 里程碑只在净化数跨过 3 时才出现（不是每个 Boss 都推一幕）
      expect(coord.snapshot().settings.story.arcSeen).toBe(i === 2 ? 1 : 0);
      await ctrl.intent({ type: 'finish' });
    }
    expect(coord.snapshot().decks.filter((d) => d.purifiedAt !== undefined)).toHaveLength(3);
  });

  it('GC#T8-1b boss 败局不净化（把 `won &&` 去掉的实现必红——评审 I-3①）', async () => {
    const { ctrl, coord } = await bossReadyController();
    await ctrl.intent({ type: 'startFight', size: 1, deckIds: ['d1'], difficulty: 'boss' });
    // 一路答错：池尽即败（未杀敌）
    while (ctrl.snapshot().screen === 'fight') {
      await ctrl.intent({ type: 'answer', grade: GRADES.again });
    }
    expect(ctrl.snapshot().lastResult?.won).toBe(false);
    expect(coord.snapshot().decks[0].purifiedAt).toBeUndefined();
    expect(coord.snapshot().settings.story.arcSeen).toBe(0);
  });

  it('GC#T8-2 重战已净化的领域：purifiedAt 保持首次时刻（练习关不刷新时间戳）', async () => {
    const { ctrl, coord, clock } = await bossReadyController();
    await ctrl.intent({ type: 'startFight', size: 1, deckIds: ['d1'], difficulty: 'boss' });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    const first = coord.snapshot().decks[0].purifiedAt;
    expect(first).toBe(clock.now());

    clock.tick(60_000);
    await ctrl.intent({ type: 'finish' });
    await ctrl.intent({ type: 'startFight', size: 1, deckIds: ['d1'], difficulty: 'boss' });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    expect(coord.snapshot().decks[0].purifiedAt).toBe(first);
    expect(coord.snapshot().settings.story.arcSeen).toBe(0);
  });

  it('GC#T8-3 遭遇战胜利不净化（难度档是唯一判据，不是"赢了就净化"）', async () => {
    const { ctrl, coord } = await bossReadyController();
    await ctrl.intent({ type: 'startFight', size: 1, deckIds: ['d1'] });
    await ctrl.intent({ type: 'answer', grade: GRADES.good });
    expect(ctrl.snapshot().lastResult?.won).toBe(true);
    expect(ctrl.snapshot().lastResult?.expGained).toBe(21); // 遭遇战口径
    expect(coord.snapshot().decks[0].purifiedAt).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ 序章意图与战局的竞态（T10 接缝） */

describe('gameController —— 序章意图不得踩掉正在进行的战局（T11 评审判 I-4）', () => {
  it('GC#T10-1 seenPrologue 落库期间开战 ⇒ 快照必须停在 fight，不能被折回 menu', async () => {
    const clock = fakeClock(NOW);
    const store = createMemoryStorage();
    const real = await createCoordinator(store, { now: clock.now });
    // 让序章那次落库**慢**下来：真实场景是 debounce 的写口（这里用一个延迟 mutate 复刻）
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const coord: Coordinator = {
      ...real,
      mutate: async (fn) => {
        await gate;
        return real.mutate(fn);
      },
    };
    const ctrl = await createGameController({ coord, rng: mulberry32(3), now: clock.now, tzOffsetMin: TZ });
    // 夹具准备走**未加闸**的 real（闸只用来拖住序章那一次写）
    await real.mutate((s) => {
      s.cards = [makeCard('c0')];
      s.decks = makeSave([makeCard('c0')]).decks;
    });
    await real.flush();

    // 序章收尾派 seenPrologue（挂起在 gate 上）
    const prologue = ctrl.intent({ type: 'seenPrologue' });
    // 玩家"接着"就开了下一局（startFight 不落库，故不会被 gate 挡住）
    await ctrl.intent({ type: 'startFight', size: 1 });
    expect(ctrl.snapshot().screen).toBe('fight');

    release(); // 序章落库这时才完成
    await prologue;

    // 守卫的关键：不能因为序章那条异步路径把屏折回菜单
    expect(ctrl.snapshot().screen).not.toBe('menu');
  });
});
