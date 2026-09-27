/**
 * 数值平衡 headless 模拟器（Plan 2 · T7）——「测试即产物」：本文件不建 src 导出面，
 * 模拟逻辑全部内联，跑在 vitest（node 环境）里。消费 buildPool → enemyHpForPool →
 * deriveStats → createBattle → answer 全链，把 PRD §6.5 的设计承诺变成锁死的回归性质。
 *
 * 两条 RF#5 性质（口径按 controller 裁决 R-T7-b 落定，见文末注记）：
 * - 性质 A「全对必胜」：50 seed × 全 good 作答 → 断言 50/50 won。**硬闸**，任何常数
 *   漂移破坏它都会在这里红；
 * - 性质 B「错 40% 必败」：**不硬断言**。brief Step 1 已预告该曲线余量大、B 大概率跑出
 *   "未败"——实测 miss=0.40 胜率 14%（非 0%），这是 §6.5 常数决定的规格属性而非实现 bug。
 *   本文件把 miss∈{0.3,0.4} 的最小失败率钉为回归基线（下界断言），常数被动时立刻可见。
 *
 * 确定性契约：固定 seed 集（1..50）、固定仿真时钟 SIM_NOW、rng 显式注入——所有
 * buildPool 调用必须显式传 nowMs（R-T6-a）；同一次运行内复跑逐字段全等（SIM#4 钉）。
 * 本文件只 import core 模块，不触碰平台层（src/platform/*、DOM、Node API）。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState, Stability } from '@core/types';
import { mulberry32, uniform } from '@core/rng';
import { GRADES, damageMultiplier, type Grade } from '@core/sm2';
import { deriveStats, enemyHpForPool, victoryExp } from '@core/stats';
import { buildPool } from '@core/deckBuild';
import { createBattle, answer, type BattleState } from '@core/battle';

// —— 仿真锚点（改动任意一条都会移动整条曲线，报告数字即以此为准）——
const SIM_NOW = Date.UTC(2026, 9, 26, 12, 0, 0); // 固定仿真时刻（R-T6-a：nowMs 显式传入）
const DAY = 86_400_000;
const POOL_SIZE = 15; // brief verbatim：buildPool(size15)
const SEEDS: readonly number[] = Array.from({ length: 50 }, (_, i) => i + 1); // seed 1..50
const MISS_RATES: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4]; // 报告曲线扫描点
/** 玩家画像：Lv1 新号（vit 由池内 review+mastered 数现场算，spi=0 无精神加成 → atk=12）。 */
const PLAYER_LEVEL = 1;
const SPIRIT_COUNT = 0;

// —— 合成卡组：200 张，stability 分布 new20%/learning20%/review40%/mastered20% ——
// ease/interval/reps 取与阶段自洽的合理值（learning 略低 ease、mastered 长间隔），
// due 用独立种子流填充：约 6 成已到期（智能段优先吃它们）、4 成未到期（走放宽/自选段）。
function makeCard(id: string, stability: Stability, dueOffsetDays: number): Card {
  const srs: SRSState = {
    ease: stability === 'learning' ? 2.3 : 2.5,
    interval: stability === 'new' ? 0 : stability === 'learning' ? 0.17 : stability === 'review' ? 6 : 21,
    reps: stability === 'new' ? 0 : stability === 'learning' ? 1 : stability === 'review' ? 2 : 4,
    lapses: stability === 'learning' ? 1 : 0,
    due: SIM_NOW + dueOffsetDays * DAY,
    stability,
    effectiveReviewDays: [],
  };
  return { id, deckId: 'sim-deck', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

function syntheticCorpus(): Card[] {
  const dist: ReadonlyArray<readonly [Stability, number]> = [
    ['new', 40],
    ['learning', 40],
    ['review', 80],
    ['mastered', 40],
  ];
  const rng = mulberry32(0xc0ffee); // 语料生成与战斗 seed 流完全分离（一次性、确定性）
  const out: Card[] = [];
  for (const [stability, n] of dist) {
    for (let i = 0; i < n; i++) {
      const dueOffset = rng() < 0.6 ? -(1 + Math.floor(rng() * 14)) : 1 + Math.floor(rng() * 10);
      out.push(makeCard(`c${out.length}`, stability, dueOffset));
    }
  }
  return out;
}

const CORPUS = syntheticCorpus();

// —— 单局模拟 ——
interface SimResult {
  readonly won: boolean;
  readonly phase: BattleState['phase'];
  readonly poolLen: number;
  readonly enemyHp: number;
  /** 实际打出回合数（answer 调用次数）。 */
  readonly turns: number;
  /** 对敌人造成的总伤害（溢出部分不计）。 */
  readonly dealt: number;
  /** 提前 won 时被作废的卡数 = poolLen − turns。 */
  readonly voided: number;
  /** victoryExp 池内口径（stats.ts 现状）。 */
  readonly expPool: number;
  /** victoryExp 实际释放口径（只算已作答的前缀，R-T5-b 差异量化用）。 */
  readonly expReleased: number;
}

/**
 * 跑一局：seed 决定 rng 流。消耗序 verbatim：buildPool 自选段每轮 pickWeighted 各掷一次
 * → 战斗内每回合先掷一次 miss 判定（uniform(0,1)），命中再进 answer 掷浮动 uniform(0.9,1.1)
 * ——即 miss 回合消耗 1 掷、命中回合消耗 2 掷。missRate 为每次作答独立掷 miss 的概率
 * （grade 取 again 表达空转）。card 一律从 pool[state.idx] 取——调用侧一致性契约
 * （T4 deferred #2）。
 */
function simulate(seed: number, missRate: number, cards: Card[], size = POOL_SIZE): SimResult {
  const rng = mulberry32(seed);
  const pool = buildPool(cards, { size, rng, nowMs: SIM_NOW }); // R-T6-a：nowMs 必传
  // HP 按实际池长反推（T6 顾虑③采纳）：降级场景 pool.length < size 时不得用请求 size。
  const enemyHp = enemyHpForPool(pool.length, 'encounter');
  const vitCount = pool.filter((c) => c.srs.stability === 'review' || c.srs.stability === 'mastered').length;
  let state = createBattle(pool, enemyHp, deriveStats(PLAYER_LEVEL, vitCount, SPIRIT_COUNT), rng);
  let turns = 0;
  while (state.phase === 'answering') {
    const card = pool[state.idx];
    const grade: Grade = uniform(rng, 0, 1) < missRate ? GRADES.again : GRADES.good;
    state = answer(state, card, grade, rng);
    turns += 1;
  }
  const dealt = enemyHp - Math.max(0, state.enemyHp);
  return {
    won: state.phase === 'won',
    phase: state.phase,
    poolLen: pool.length,
    enemyHp,
    turns,
    dealt,
    voided: pool.length - turns,
    expPool: victoryExp(pool, 'encounter'),
    expReleased: victoryExp(pool.slice(0, turns), 'encounter'),
  };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 曲线表行：winRate × 中位胜局回合数 × 中位总输出。 */
function curveRow(missRate: number): { winRate: number; medTurns: number; medDealt: number } {
  const rs = SEEDS.map((seed) => simulate(seed, missRate, CORPUS));
  return {
    winRate: rs.filter((r) => r.won).length / rs.length,
    medTurns: median(rs.map((r) => r.turns)),
    medDealt: median(rs.map((r) => r.dealt)),
  };
}

describe('balance sim —— 语料与静态锚点', () => {
  it('SIM#0a 合成卡组 200 张、stability 配比 verbatim', () => {
    expect(CORPUS).toHaveLength(200);
    const count = (s: Stability) => CORPUS.filter((c) => c.srs.stability === s).length;
    expect([count('new'), count('learning'), count('review'), count('mastered')]).toEqual([40, 40, 80, 40]);
  });

  it('SIM#0b 预推导锚点：L1 atk=12、HP(encounter)=ceil(len×10×0.7)、倍率表均值≈0.82', () => {
    expect(deriveStats(PLAYER_LEVEL, 0, SPIRIT_COUNT).atk).toBe(12); // 探针级事实复现
    expect(enemyHpForPool(15, 'encounter')).toBe(105); // 7/张 × 15
    const avgMult = CORPUS.reduce((s, c) => s + damageMultiplier(c.srs), 0) / CORPUS.length;
    expect(avgMult).toBeCloseTo(0.82, 5); // 0.1×0.2+0.5×0.2+1.0×0.4+1.5×0.2
    expect(Math.round(12 * avgMult)).toBe(10); // 期望单卡伤 ≈9.8→round 域内 ~10 vs HP 基准 7/张
  });
});

describe('balance sim —— 性质 A：全对必胜（RF#5 硬闸）', () => {
  it('SIM#A 50 seed 全 good → 50/50 won（设计承诺锁死）', () => {
    const results = SEEDS.map((seed) => simulate(seed, 0, CORPUS));
    const losers = results.filter((r) => !r.won).map((r) => `${r.phase}`);
    // 一旦红：先查 sim 自身（rng 消耗序 / pool[idx] 取卡错位），再怀疑常数被动。
    expect(losers).toEqual([]);
    expect(results.filter((r) => r.won)).toHaveLength(50);
    // 余量佐证：中位 13 回合打满 105 血（HP 基准 105），平均留 ~2 张冗余卡。
    expect(median(results.map((r) => r.turns))).toBe(13);
    for (const r of results) expect(r.dealt).toBeGreaterThanOrEqual(r.enemyHp);
  });

  it('SIM#A2 降级场景：小语料按实际池长反推 HP 仍必胜（T6 顾虑③）', () => {
    // 语料仅 8 张（全 review 档）→ pool.length=8 < size=15，HP=ceil(8×10×0.7)=56。
    const small: Card[] = Array.from({ length: 8 }, (_, i) => makeCard(`s${i}`, 'review', -(i + 1)));
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = simulate(seed, 0, small);
      expect(r.poolLen).toBe(8);
      expect(r.enemyHp).toBe(56); // 若误用请求 size 反推会得到 105 → 此局必败，断言即红
      expect(r.won).toBe(true);
    }
  });
});

describe('balance sim —— 性质 B：错 40% 必败（记录实测，不硬断言）', () => {
  it('SIM#B miss∈{0.3,0.4} 最小失败率为回归基线（当前 60%）', () => {
    const lossRates = [0.3, 0.4].map((mr) => {
      const wins = SEEDS.map((seed) => simulate(seed, mr, CORPUS)).filter((r) => r.won).length;
      return 1 - wins / SEEDS.length;
    });
    const minLoss = Math.min(...lossRates);
    // 「B 大概率跑出未败」的实测兑现：miss=0.40 仍有 7/50 翻盘（好池+坏运气组合）。
    // 判据取下界：失败率不得低于基线 0.60——常数被调松（伤害↑/HP↓）会击穿它。
    expect(minLoss).toBeGreaterThanOrEqual(0.6);
    // 上界同样钉住（防"调过头"方向漂移）：B 不是必败性质，胜率不该归零。
    expect(minLoss).toBeLessThan(1);
  });

  it('SIM#C 单调性：错误率越高胜率不升（曲线形状是规格的一部分）', () => {
    const rows = MISS_RATES.map((mr) => curveRow(mr).winRate);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeLessThanOrEqual(rows[i - 1]);
    // 中位胜负点在 miss≈0.2~0.3 之间翻转（产品决策口径：主曲线拐点）。
    expect(curveRow(0.2).winRate).toBeGreaterThanOrEqual(0.5);
    expect(curveRow(0.3).winRate).toBeLessThan(0.5);
  });

  it('SIM#D 确定性：同 seed 复跑逐字段全等（曲线数字可信的前提）', () => {
    // 限定语：本例证的是同进程内 rng 流的纯函数性（mulberry32 无外部状态、simulate 不读
    // 时钟——nowMs 显式传入）。跨进程/跨版本的序列一致性由 mulberry32 的算法定义保证，
    // 不在本测试面内验证。
    for (const seed of [1, 7, 42]) {
      for (const mr of [0, 0.4]) {
        expect(simulate(seed, mr, CORPUS)).toEqual(simulate(seed, mr, CORPUS));
      }
    }
  });

  it('SIM#E victoryExp 口径差异申报（R-T5-b）：池内口径 ≥ 实际释放口径，虚高 ≤ 10', () => {
    const rows = SEEDS.map((seed) => simulate(seed, 0, CORPUS)).filter((r) => r.won);
    for (const r of rows) {
      expect(r.expPool).toBeGreaterThanOrEqual(r.expReleased);
      // 差值 = 5 × 作废段里的 mastered 张数；本曲线下最大 10（2 张作废 mastered）。
      expect(r.expPool - r.expReleased).toBeLessThanOrEqual(10);
    }
    // 完整报告曲线打印（测试即产物：数字进 stdout，同步抄录进 task-7-report.md）。
    const table = MISS_RATES.map((mr) => {
      const { winRate, medTurns, medDealt } = curveRow(mr);
      return `miss=${(mr * 100).toFixed(0).padStart(2)}%  winRate=${(winRate * 100).toFixed(0).padStart(3)}%  medTurns=${String(medTurns).padStart(4)}  medDealt=${medDealt}`;
    });
    console.log('[balance-sim] §6.5 胜率曲线（seed 1..50, size=15, L1 encounter）\n' + table.join('\n'));
  });
});

/*
 * —— 口径注记（R-T7-b，随本报告回报 controller）——
 * brief Step 1 要求「miss 率参数化扫描 {0.3,0.4}，取最小失败率为判据」以验证 B「错 40% 必败」。
 * 实测（本文件 SIM#B/SIM#C）：miss=0.40 胜率 14%（7/50 翻盘），B 作为「必败」硬断言不成立。
 * 这与 brief Step 1 自己的预告一致（"B 大概率跑出未败……是 §6.5 常数决定的规格属性"），
 * 也与预期裁决方向一致（"锁死 A + 记录 B 实测值作为回归基线"）。故本文件落法：
 *   A → 硬断言（50/50 won）；B → 双向界定的回归基线（minLoss ∈ [0.60, 1)），
 *   并保留 {0.3,0.4} 扫描与最小失败率计算本身——判据形式不变，只是从"必败"降为"基线"。
 * 未私调任何 spec 常数（BASE_CARD_DAMAGE/DIFFICULTY/浮动区间原样）。
 */
