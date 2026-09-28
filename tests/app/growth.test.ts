/**
 * growth.ts —— Plan 3 · T3 全库口径属性派生 + 复习落账链。
 *
 * PRD §6.5 装配红线在此兑现：
 * - N-1（口径红线）：vit/spi 恒按**全库**计数，与本场池子集无关。G#2 构造
 *   「池内口径 ≠ 全库口径」的对照样本钉死——若实现改按池算，两个断言必炸其一；
 * - N-2（结算红线）：settleFight 只对**已消耗回合**（slice(0, idx)）走 applyReview，
 *   未答卡 SRS 零推进（GS#4 提前杀 / GS#5 打满），且 exp 按释放子集计；
 * - R-T4-d（第二钉）：复习必须经 reviewFlow.applyReview 单一入口——每参与卡
 *   domainReviewCount 恰 +1、SRS reps 同步推进（GS#3 端到端）。
 */
import { describe, expect, it } from 'vitest';
import type { Card, Deck, SaveFile, Sm2Params, SourceInfo, SRSState, Stability } from '@core/types';
import type { Rng } from '@core/rng';
import { GRADES } from '@core/sm2';
import { domainReviewCount } from '@core/reviewLedger';
import { createBattle, answer } from '@core/battle';
import { deriveStats, victoryExp } from '@core/stats';
import { startFight, answerCurrent, type FightView } from '../../src/app/battleFlow';
import {
  levelFromExp,
  playerStatsFor,
  releaseSubset,
  settleFight,
  spiCount,
  vitCount,
} from '../../src/app/growth';

// —— 仿真锚点：全部时间由测试显式注入，growth 不读时钟 ——
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0); // tz=+480 → 本地日键 2026-10-26
const TZ = 480; // UTC+8
const PARAMS: Sm2Params = { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 };
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

function manual(createdAt = NOW): SourceInfo {
  return { type: 'manual', createdAt };
}

function makeSave(cards: Card[], over: Partial<SaveFile['settings']> = {}): SaveFile {
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
      ...over,
    },
    meta: { savedAt: NOW, plays: 0 },
  };
}

/** 类型守卫：把 startFight 返回值收窄到成功面。 */
function ok(view: FightView | { error: string; message: string }): FightView {
  if ('state' in view) return view;
  throw new Error(`startFight 意外失败：${JSON.stringify(view)}`);
}

/** 在视图上依序作答 n 个回合（grade 默认 good）。 */
function play(v: FightView, n: number, grade = GRADES.good): FightView {
  let out = v;
  for (let i = 0; i < n && out.state.phase === 'answering'; i++) {
    out = answerCurrent(out, grade, { rng: HALF });
  }
  return out;
}

/** 按 id 索引卡数组（settleFight 保序，id→新卡映射稳定）。 */
function byId(cards: readonly Card[]): Map<string, Card> {
  return new Map(cards.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------
// vitCount / spiCount —— N-1 全库口径
// ---------------------------------------------------------------------------

describe('vitCount / spiCount —— 全库口径（N-1 红线）', () => {
  /**
   * 混合全库（7 张）：
   * - g0 review 自建        → vit ✓ spi ✓
   * - g1 mastered 自建      → vit ✓ spi ✓
   * - g2 learning 自建      → vit ✗（未入脑）spi ✗（stability < review）
   * - g3 review 预置卡      → vit ✓ spi ✗（source=preset）
   * - g4 review 自建 lapses3→ vit ✓ spi ✗（lapses > 2）
   * - g5 new 自建           → vit ✗ spi ✗
   * - g6 review 无 source   → vit ✓ spi ✗（缺溯源不计精神）
   * 全库口径：vit=5、spi=2。
   * （接管修正：前任注释正确枚举了 5 个 vit ✓，断言却写 4——秩表 bug 下字符串比较
   *   'mastered' < 'review' 恰好漏计 g1 得 4，前任按"错实现的实际输出"写了期望。
   *   brief verbatim「vit = 全库 stability∈{review,mastered}」与 PRD §6.5 均为 5。）
   */
  function mixedLibrary(): Card[] {
    return [
      makeCard('g0', { stability: 'review', source: manual() }),
      makeCard('g1', { stability: 'mastered', source: manual() }),
      makeCard('g2', { stability: 'learning', source: manual() }),
      makeCard('g3', { stability: 'review', source: { type: 'preset', createdAt: NOW } }),
      makeCard('g4', { stability: 'review', source: manual(), lapses: 3 }),
      makeCard('g5', { stability: 'new', source: manual() }),
      makeCard('g6', { stability: 'review' }),
    ];
  }

  it('RF#3续 G#1 混合全库计数正确：vit=5（review+mastered）、spi=2（manual&&≥review&&lapses≤2）', () => {
    expect(vitCount(mixedLibrary())).toBe(5);
    expect(spiCount(mixedLibrary())).toBe(2);
  });

  it('G#2 N-1 钉死：同卡集「池内口径 ≠ 全库口径」，函数取后者', () => {
    const lib = mixedLibrary();
    // 用 buildPool 的真实抽取路径造池（size=3、rng≡0.5 ⇒ 智能段收 g0,g1,g4，自选段补 g2）
    const view = ok(startFight({ decks: [], cards: lib }, { size: 3, rng: HALF, nowMs: NOW }));
    expect(view.pool).toHaveLength(3);
    // 对照样本必须先证明两种口径确实给出不同值，否则"取全库"这个断言是空转。
    // （接管修正：前任拿被 bug 污染的 vit=4 当全库真值——修复后池内 (4,2) 与之巧合相等，
    //   前提断言自我拆台。改用构造性对照：向 lib 追加一张**必不进池**的 mastered 自建卡
    //   g7（智能段满 + 自选段 pickWeighted 恒抽余下最前张），全库 vit 变 6，池内仍 4。）
    const poolVit = view.pool.filter((c) => c.srs.stability === 'review' || c.srs.stability === 'mastered').length;
    const poolSpi = view.pool.filter(
      (c) => (c.source?.type === 'manual' || c.source?.type === 'llm')
        && (c.srs.stability === 'review' || c.srs.stability === 'mastered') && c.srs.lapses <= 2,
    ).length;
    const lib7 = [...lib, makeCard('g7', { stability: 'mastered', source: manual() })];
    const view7 = ok(startFight({ decks: [], cards: lib7 }, { size: 3, rng: HALF, nowMs: NOW }));
    expect(view7.pool.map((c) => c.id)).not.toContain('g7'); // 追加卡确实在池外（对照成立的前提）
    expect([poolVit, poolSpi]).not.toEqual([vitCount(lib7), spiCount(lib7)]); // 两口径确有差
    // 被测函数给的是全库值——与池内容完全无关
    expect(vitCount(lib7)).toBe(6);
    expect(spiCount(lib7)).toBe(3);
    expect(vitCount(lib)).toBe(5);
    expect(spiCount(lib)).toBe(2);
  });

  it('G#3 llm 来源计入 spi；显式秩表取代字典序启发式：learning 永不入 review 门槛', () => {
    // （接管修正：标题原文"heuristic 稳定性比较（非枚举白名单）：interval=1&reps=1 即
    //   review"是被推翻的设计意图——字符串比较连自己的排序都不自洽（字母序
    //   learning < mastered < new < review，'new' > 'review' 反而把新档计进 vit）。
    //   秩表落地后判据只认 Stability 成员本身；l1 的 interval/reps 字段对计数无意义，
    //   保留作反例：数值再像 review，档位不到就是不到。）
    const cards = [
      makeCard('l0', { stability: 'review', source: { type: 'llm', createdAt: NOW } }),
      makeCard('l1', { stability: 'learning', interval: 1, reps: 1, source: manual() }),
    ];
    expect(spiCount(cards)).toBe(1); // l0（llm 来源计入精神）
    expect(vitCount(cards)).toBe(1); // l1 stability='learning' 不入 vit
  });

  it('G#4 脏输入消毒：非数组 / null 项 / 缺 srs 一律忽略，不抛', () => {
    const dirty = [null, undefined, { id: 'x' }, makeCard('ok', { source: manual() })] as unknown as Card[];
    // （接管修正：原期望 0 与下一行 spiCount===1 互斥——'ok' 卡默认 stability='review'，
    //   vit/spi 的稳定性判据同为 rank≥review，不可能 spi 计它而 vit 不计。）
    expect(vitCount(dirty)).toBe(1); // 仅 'ok' 卡（review）入账；null/undefined/{id:'x'} 忽略
    expect(spiCount(dirty)).toBe(1); // 'ok' 卡 review+manual+lapses0
    expect(vitCount(null as unknown as Card[])).toBe(0);
    expect(spiCount(undefined as unknown as Card[])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// levelFromExp / playerStatsFor —— exp→level 与六维快照
// ---------------------------------------------------------------------------

describe('levelFromExp / playerStatsFor', () => {
  it('L#1 经验曲线锚点：0→L1、99→L1、100→L2、347→L3（applyExp 逐级消费）', () => {
    expect(levelFromExp(0)).toBe(1);
    expect(levelFromExp(99)).toBe(1);
    expect(levelFromExp(100)).toBe(2);
    expect(levelFromExp(346)).toBe(2);
    expect(levelFromExp(347)).toBe(3); // expToNext(1)=100 + expToNext(2)=247
  });

  it('L#2 非法 exp（NaN/负/Infinity/非数）保守回落 L1', () => {
    for (const bad of [NaN, -1, -Infinity, Infinity, '100', null, undefined]) {
      expect(levelFromExp(bad as unknown as number)).toBe(1);
    }
  });

  it('P#1 playerStatsFor：全库 vit/spi + exp 等级喂 deriveStats（atk=10+2L+⌊spi/8⌋）', () => {
    const cards = Array.from({ length: 16 }, (_, i) =>
      makeCard(`p${i}`, { stability: 'review', source: manual() }),
    ); // vit=16, spi=16
    const save = makeSave(cards, { progress: { exp: 100 } }); // L2
    expect(playerStatsFor(save)).toEqual({
      level: 2, vit: 16, spi: 16,
      atk: 10 + 2 * 2 + Math.floor(16 / 8), // 16
      def: 5 + 2 * 2 + Math.floor(16 / 10), // 10
      maxHp: 100 + (2 - 1) * 10, // 110
    });
  });

  it('P#2 存档形状消毒：缺 progress / 非对象入参 → L1 vit0 spi0（deriveStats(1,0,0) 同值）', () => {
    const noProgress = makeSave([]);
    delete (noProgress.settings as { progress?: { exp: number } }).progress;
    expect(playerStatsFor(noProgress)).toEqual(deriveStats(1, 0, 0));
    expect(playerStatsFor(null as unknown as SaveFile)).toEqual(deriveStats(1, 0, 0));
    expect(playerStatsFor({} as unknown as SaveFile)).toEqual(deriveStats(1, 0, 0));
  });
});

// ---------------------------------------------------------------------------
// startFight stats 注入 —— SF#5 锚点不漂移 + 全库口径贯通战斗
// ---------------------------------------------------------------------------

describe('startFight —— deps.stats 注入（缺省保持 T2 行为）', () => {
  it('SF-inject#1 缺省路径不漂移：不传 stats ⇒ atk=12/maxHp=100（SF#5 锚点）', () => {
    const cards = Array.from({ length: 3 }, (_, i) => makeCard(`s${i}`, { source: manual() }));
    const view = ok(startFight({ decks: [], cards }, { size: 3, rng: HALF, nowMs: NOW }));
    expect(view.state.atk).toBe(12);
    expect(view.state.maxPlayerHp).toBe(100);
  });

  it('SF-inject#2 注入 playerStatsFor(save) ⇒ state 携带全库口径 atk/maxHp', () => {
    const cards = Array.from({ length: 3 }, (_, i) => makeCard(`s${i}`, { source: manual() }));
    const save = makeSave(cards, { progress: { exp: 100 } }); // L2, vit=3, spi=3
    const stats = playerStatsFor(save);
    const view = ok(startFight({ decks: [], cards }, { size: 3, rng: HALF, nowMs: NOW, stats }));
    expect(stats.atk).toBe(14); // 10 + 2*2 + floor(3/8)
    expect(view.state.atk).toBe(14);
    expect(view.state.maxPlayerHp).toBe(110);
    expect(view.state.playerHp).toBe(110);
  });

  it('SF-inject#3 非法 stats（NaN/字符串）回落 deriveStats(1,0,0)，永不 NaN 入战', () => {
    const cards = [makeCard('s0'), makeCard('s1')];
    for (const junk of [undefined, null, {}, { level: NaN, vit: NaN, spi: NaN, atk: NaN, def: NaN, maxHp: NaN }, 'x']) {
      const view = ok(startFight({ decks: [], cards }, { size: 2, rng: HALF, nowMs: NOW, stats: junk as never }));
      expect(view.state.atk).toBe(12);
      expect(view.state.maxPlayerHp).toBe(100);
    }
  });
});

// ---------------------------------------------------------------------------
// releaseSubset / settleFight —— N-2 结算红线
// ---------------------------------------------------------------------------

describe('releaseSubset / settleFight —— 已消耗回合才落账（N-2）', () => {
  /**
   * 6 张全到期卡（makeCard 默认 stability='review'、interval=10）。
   * 注意：interval 只是 SRS 数据字段——promoteStability 只在 review() 内重推导档位，
   * 夹具里的卡恒为 review（单击伤 = atk×1.0×1.0 = 12），不是 mastered。
   */
  function sixCards(): Card[] {
    return Array.from({ length: 6 }, (_, i) => makeCard(`f${i}`, { source: manual() }));
  }

  /** mastered 版六张（GS#4b 用）：damageMultiplier(mastered)=1.5 ⇒ 单击伤 18。 */
  function sixMastered(): Card[] {
    return Array.from({ length: 6 }, (_, i) => makeCard(`f${i}`, { stability: 'mastered', source: manual() }));
  }

  /**
   * startFight 真实路径：size=6 全库入池且保序——智能段 ceil(6×0.8)=5 张按 dueQueue
   * 升序收 f0..f4（due 同为 0，稳定排序保输入序），自选段 pickWeighted
   * （rng≡0.5 → roll=0.5·1 < w₀）收余下最前张 f5。
   */
  function fightSix(nTurns: number, grade = GRADES.good, cards = sixCards()) {
    const v0 = ok(startFight({ decks: [], cards }, { size: 6, rng: HALF, nowMs: NOW }));
    expect(v0.pool.map((c) => c.id)).toEqual(cards.map((c) => c.id)); // 池=全库同序（本用例族的前提）
    const v = play(v0, nTurns, grade);
    return { cards, view: v };
  }

  it('RS#1 won→pool.slice(0,state.idx)、lost→全池（元素同一性保留）', () => {
    const cards = sixCards();
    const st = createBattle(cards, 1, deriveStats(1, 0, 0), HALF);
    // idx=0 → 空子集（slice 语义：新数组、成员同引用）
    const empty = releaseSubset(cards, st);
    expect(empty).toHaveLength(0);
    expect(Array.isArray(empty)).toBe(true);
    const wonMid = { ...st, phase: 'won' as const, idx: 3 };
    const sub = releaseSubset(cards, wonMid);
    expect(sub).toEqual(cards.slice(0, 3));
    expect(sub[0]).toBe(cards[0]); // 引用级：不复制卡对象
    const lost = { ...st, phase: 'lost' as const, idx: 2 };
    const all = releaseSubset(cards, lost);
    expect(all).toHaveLength(6); // lost → 全池，与 idx 无关
    expect(all.every((c, i) => c === cards[i])).toBe(true);
    // answering 态按 won 规则处理（idx 之前的都已消耗）
    expect(releaseSubset(cards, { ...st, idx: 2 })).toHaveLength(2);
  });

  it('RS#2 脏输入消毒：非数组池 / 缺 state → []，不抛', () => {
    expect(releaseSubset(null as unknown as Card[], { idx: 2 } as never)).toEqual([]);
    expect(releaseSubset([makeCard('z')], null as unknown as Parameters<typeof releaseSubset>[1])).toEqual([]);
  });

  /**
   * lost 场景构造：enemyHp 必须大到 6 个 again 回合（零伤害）也打不完。
   * startFight 的 HP 恒按池长反推（ceil(n×7)），够不着这个形状，故直调 core
   * createBattle 造视图——落账链读的是 FightView 的形状，不挑 state 出身。
   */
  function lostView(cards: Card[]): FightView {
    const st = createBattle(cards, 999, deriveStats(1, 0, 0), HALF);
    let s = st;
    for (const c of cards) s = answer(s, c, GRADES.again, HALF); // 逐张空转到池尽
    return { state: s, pool: cards, current: null };
  }

  it('GS#3 端到端（R-T4-d 第二钉）：每参与卡 domainReviewCount 恰 +1、SRS reps 推进', () => {
    const cards = sixCards();
    expect(domainReviewCount(cards)).toBe(0);
    // good 档走完整场（lost 形态，6 题全消耗）：记账与 SM-2 更新两步缺一不可
    const view = lostView(cards);
    const r = settleFight(cards, view, { gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS });
    expect(domainReviewCount(r.cards)).toBe(6); // 每张参与卡恰 +1（单一入口的直接证据）
    const g0 = byId(r.cards).get('f0')!;
    expect(g0.srs.reps).toBe(4); // SRS 同步推进：3+1
    expect(g0.srs.effectiveReviewDays).toEqual(['2026-10-26']);
    // again 档同样经 applyReview：reps 归零也是"推进"（区别于未答卡的零推进）
    const a = settleFight(cards, lostView(cards), { gradeOf: () => GRADES.again, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS });
    const a0 = byId(a.cards).get('f0')!;
    expect(a0.srs.reps).toBe(0);
    expect(a0.srs.lapses).toBe(1);
    expect(a0.srs.stability).toBe('learning');
    expect(a0.srs.effectiveReviewDays).toEqual(['2026-10-26']);
  });

  it('GS#4 won-with-overkill：提前杀（第 4 击 idx=4）→ exp 按 slice(0,4) 释放子集算、第 5-6 张 SRS 零推进', () => {
    const cards = sixCards();
    // startFight 真实路径 enemyHp=ceil(6×10×0.7)=42；atk=12 ⇒ 每 good 伤 12，第 4 击 won。
    // （接管修正：原断言 idx===3 与 battle.answer 的已评审契约「idx 恒 +1」正面冲突——
    //   EW#1 钉死 won 于第 N 击时 idx===N（单卡池即 idx=1），IDX#1/CB#11 同链。
    //   plan3 line 15 verbatim 释放口径 = pool.slice(0, idx)，含击杀击：它是最后作答的
    //   一张，"剩余作废"只覆盖 pool[idx:]。）
    const { view } = fightSix(4);
    expect(view.state.phase).toBe('won');
    expect(view.state.idx).toBe(4); // 已消耗 4 回合（含击杀击），剩余 2 张作废
    const before = JSON.parse(JSON.stringify(cards)) as Card[];
    const r = settleFight(cards, view, { gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS });
    expect(r.won).toBe(true);
    // victoryExp 的 mastered 判据取**建战时卡状态**（releaseSubset 返回池内原对象，
    // 落账产生的新卡不回灌战斗视图）。makeCard 默认 stability='review'、interval=10——
    // 注意 interval 只是 SRS 数据字段，promoteStability 只在 review() 时重推导档位，
    // 这些卡恒为 review ⇒ masteredCount=0。exp = round(30×0.7 + 5×0) = 21。
    // （接管修正：前任注释"f0..f2 均为 interval=10 → mastered"与自家夹具矛盾——
    //   若真按 mastered 计，won 于第 4 击时 exp=41；其 toBe(36) 在任何自洽实现下都不可达。）
    const subset = releaseSubset(view.pool, view.state);
    expect(subset.map((c) => c.id)).toEqual(['f0', 'f1', 'f2', 'f3']);
    expect(r.exp).toBe(victoryExp(subset, 'encounter'));
    expect(r.exp).toBe(21);
    const next = byId(r.cards);
    for (let i = 0; i < 4; i++) {
      const nc = next.get(`f${i}`)!;
      expect(nc.srs.effectiveReviewDays).toEqual(['2026-10-26']); // 经 applyReview 记账
      expect(nc.srs.reps).toBe(4); // 3+1
    }
    for (let i = 4; i < 6; i++) {
      expect(next.get(`f${i}`)).toEqual(before[i]); // 未答卡逐字段零推进（N-2）
      expect(next.get(`f${i}`)!.srs.effectiveReviewDays).toEqual([]);
    }
    // 不可变：入参数组与其中的卡绝不被改动
    expect(cards.map((c) => c.srs.reps)).toEqual(before.map((b) => b.srs.reps));
  });

  it('GS#4b mastered 版 overkill：第 3 击杀（idx=3）→ exp=round(21+5×3)=36、pool[3..] 零推进', () => {
    // （接管补钉：前任 GS#4 的"exp 按 3 张释放子集 = 36"算术其实指向这个形状——
    //   mastered 单击伤 18，42 HP 恰在第 3 击归零、idx 恒 +1 落 3。它错把 review 夹具
    //   当成 mastered（interval=10 只是数据字段，不重推档位），才造出无解断言。
    //   本用例让原始意图在自洽前提下复活，并守住"作废卡不入 exp"的 N-2 虚高面。）
    const { cards, view } = fightSix(3, GRADES.good, sixMastered());
    expect(view.state.phase).toBe('won');
    expect(view.state.idx).toBe(3);
    const before = JSON.parse(JSON.stringify(cards)) as Card[];
    const r = settleFight(cards, view, {
      gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS,
    });
    const subset = releaseSubset(view.pool, view.state);
    expect(subset.map((c) => c.id)).toEqual(['f0', 'f1', 'f2']);
    expect(r.exp).toBe(victoryExp(subset, 'encounter'));
    expect(r.exp).toBe(36); // round(30×0.7 + 5×3)
    // 作废的 f3..f5 不得进 exp 面：若实现误传全池，mastered 虚高至 51（PRD §6.5 红线②点名）
    expect(victoryExp([...view.pool], 'encounter')).toBe(51);
    expect(r.exp).not.toBe(51);
    const next = byId(r.cards);
    for (let i = 0; i < 3; i++) {
      expect(next.get(`f${i}`)!.srs.effectiveReviewDays).toEqual(['2026-10-26']); // 已作答 ⇒ 落账
    }
    for (let i = 3; i < 6; i++) {
      expect(next.get(`f${i}`)).toEqual(before[i]); // 作废卡逐字段零推进
    }
  });

  it('GS#5 lost 全池落账：打满 6 题敌仍存 → 6 张 SRS 均推进、exp=0', () => {
    const cards = sixCards();
    const v = lostView(cards); // 6 个 again 回合零伤害 → 池尽 lost
    expect(v.state.phase).toBe('lost');
    expect(v.state.idx).toBe(6);
    const r = settleFight(cards, v, { gradeOf: () => GRADES.again, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS });
    expect(r.won).toBe(false);
    expect(r.exp).toBe(0);
    const next = byId(r.cards);
    for (let i = 0; i < 6; i++) {
      const nc = next.get(`f${i}`)!;
      expect(nc.srs.reps).toBe(0); // again：reps 归零也是"推进"（区别于零推进）
      expect(nc.srs.lapses).toBe(1);
      expect(nc.srs.stability).toBe('learning');
      expect(nc.srs.effectiveReviewDays).toEqual(['2026-10-26']);
    }
  });

  it('GS#6 参与卡集合取自战斗视图（log cardId），与外部传入 cards 的顺序解耦', () => {
    const { cards, view } = fightSix(4); // won，第 4 击 idx=4（IDX#1 契约）
    const shuffled = [...cards].reverse(); // 全库以另一顺序传入
    const r = settleFight(shuffled, view, { gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS });
    const consumed = new Set(view.state.log.flatMap((e) => (e.cardId ? [e.cardId] : [])));
    expect(consumed.size).toBe(4);
    for (const c of r.cards) {
      const settled = c.srs.effectiveReviewDays.length === 1;
      expect(settled).toBe(consumed.has(c.id)); // 恰是参战的 4 张被落账
    }
    expect(r.cards).toHaveLength(6); // 保序保长度，未参战卡原引用透传
    expect(r.cards.find((c) => !consumed.has(c.id))).toBe(shuffled.find((c) => !consumed.has(c.id)));
  });

  it('GS#7 幂等短路：同日重复 settleFight → 账本日键不双计（applyReview 语义透传）', () => {
    const { cards, view } = fightSix(4); // won，idx=4（第 4 击击杀）
    const deps = { gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS };
    const once = settleFight(cards, view, deps);
    const twice = settleFight(once.cards, view, deps);
    const f0 = twice.cards.find((c) => c.id === 'f0')!;
    expect(f0.srs.effectiveReviewDays).toEqual(['2026-10-26']); // 仍只有 1 条
    // 但 SRS 数值照常二次推进（幂等只护 Boss 计数口径，见 reviewLedger 头注释）
    expect(f0.srs.reps).toBe(5);
  });

  it('GS#8 终局未开打的视图（idx=0 won 伪造）→ 零落账；won 也照发 exp（子集为空）', () => {
    const cards = sixCards();
    const st = createBattle(cards, 1, deriveStats(1, 0, 0), HALF);
    const forged: FightView = { state: { ...st, phase: 'won', idx: 0 }, pool: cards, current: null };
    const r = settleFight(cards, forged, { gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS });
    expect(r.won).toBe(true);
    expect(r.exp).toBe(victoryExp([], 'encounter')); // round(30×0.7)=21
    expect(r.cards).toEqual(cards); // 每张卡逐字段原样
  });

  it('GS#9 脏输入消毒：非数组 cards / 缺 view → 安全返回，不抛', () => {
    const r = settleFight(null as unknown as Card[], null as unknown as FightView, {
      gradeOf: () => GRADES.good, tzOffsetMin: TZ, nowMs: NOW, params: PARAMS,
    });
    expect(r).toEqual({ cards: [], exp: 0, won: false });
  });
});
