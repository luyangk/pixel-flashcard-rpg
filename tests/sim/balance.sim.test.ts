/**
 * 数值平衡 headless 模拟器（Plan 2 · T7）——「测试即产物」：本文件不建 src 导出面，
 * 模拟逻辑全部内联，跑在 vitest（node 环境）里。消费 buildPool → enemyHpForPool →
 * deriveStats → createBattle → answer 全链，把 PRD §6.5 的设计承诺变成锁死的回归性质。
 *
 * D28 起 battle 有反击段：每回合命中 dmg+retal 两掷、miss 仅 retal 一掷——本文件的
 * rng 消耗序注释与全部曲线数字已按新规则重录（Plan 4 · T2，数据见 task-2-report.md）。
 *
 * 两条 RF#5 性质（口径按 controller 裁决 R-T7-b 落定，见文末注记）：
 * - 性质 A「全对必胜」：50 seed × 全 good 作答 → 断言 50/50 won。**硬闸**，任何常数
 *   漂移破坏它都会在这里红；
 * - 性质 B「错 40% 必败」：**不硬断言**。brief Step 1 已预告该曲线余量大、B 大概率跑出
 *   "未败"——实测 miss=0.40 胜率 14%（非 0%），这是 §6.5 常数决定的规格属性而非实现 bug。
 *   本文件把 miss∈{0.3,0.4} 的最小失败率钉为回归基线（下界断言），常数被动时立刻可见。
 *
 * 确定性契约：固定 seed 集（1..50）、固定仿真时钟 SIM_NOW、rng 显式注入——所有
 * buildPool 调用必须显式传 nowMs（R-T6-a）；同一次运行内复跑逐字段全等（SIM#D 钉）。
 * 本文件只 import core 模块，不触碰平台层（src/platform/*、DOM、Node API）。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState, Stability } from '@core/types';
import { mulberry32, uniform } from '@core/rng';
import { GRADES, damageMultiplier, type Grade } from '@core/sm2';
import { deriveStats, enemyHpForPool, enemyPowerFor, victoryExp } from '@core/stats';
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
  /** D28（T2 re-baseline）：终局剩余气血与败因区分（死亡 vs 池尽）。 */
  readonly hpLeft: number;
  readonly died: boolean;
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
  // D28：反击强度经 createBattle 第 5 参显式接线（与 T3 startFight 的真实用法同形）。
  let state = createBattle(
    pool,
    enemyHp,
    deriveStats(PLAYER_LEVEL, vitCount, SPIRIT_COUNT),
    rng,
    enemyPowerFor('encounter'),
  );
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
    hpLeft: state.playerHp,
    died: state.playerHp <= 0,
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

  it('SIM#0b 预推导锚点：L1 atk=12、HP(encounter)=ceil(len×10×0.7)、倍率表均值≈0.90', () => {
    expect(deriveStats(PLAYER_LEVEL, 0, SPIRIT_COUNT).atk).toBe(12); // 探针级事实复现
    expect(enemyHpForPool(15, 'encounter')).toBe(105); // 7/张 × 15
    const avgMult = CORPUS.reduce((s, c) => s + damageMultiplier(c.srs), 0) / CORPUS.length;
    // Plan 5 数值改进后：0.3×0.2+0.7×0.2+1.0×0.4+1.5×0.2 = 0.90（原 0.82）
    expect(avgMult).toBeCloseTo(0.9, 5);
    expect(Math.round(12 * avgMult)).toBe(11); // 期望单卡伤 ≈10.8→round 11 vs HP 基准 7/张
  });
});

describe('balance sim —— 性质 A：全对必胜（RF#5 硬闸）', () => {
  it('SIM#A 50 seed 全 good → 50/50 won 且全员存活（D28 re-baseline：survived&&won 双断言）', () => {
    const results = SEEDS.map((seed) => simulate(seed, 0, CORPUS));
    const losers = results.filter((r) => !r.won).map((r) => `${r.phase}`);
    // 一旦红：先查 sim 自身（rng 消耗序 / pool[idx] 取卡错位），再怀疑常数被动。
    expect(losers).toEqual([]);
    expect(results.filter((r) => r.won)).toHaveLength(50);
    // 余量佐证：中位 10 回合打满 105 血（HP 基准 105）——Plan 5 数值改进把低档倍率抬了
    // （new 0.1→0.3、learning 0.5→0.7），语料均值 0.82→0.90 ⇒ 每回合输出更高、收得更快
    // （重录前中位 13 回合）。**这一格是"难度刻度"的可见面**：持续红=常数被动过。
    expect(median(results.map((r) => r.turns))).toBe(10);
    for (const r of results) expect(r.dealt).toBeGreaterThanOrEqual(r.enemyHp);
    // 来历：D28——反击入规则后「必胜」升级为「必胜且不阵亡」。def=7≥power=7 ⇒
    // 承伤被 max(1,·) 下钳到恒 1/回合（round(1×float)≡1）；击杀回合因 won 优先于
    // 承伤而免结反击 ⇒ 精确等式 hpLeft = 100 − (turns−1)。逐 seed 钉该等式才是
    // 防御公式的机器证明（T2 评审 Minor⑤：旧 median(hpLeft)=88 实为回合中位数代理）。
    for (const r of results) {
      expect(r.died).toBe(false);
      expect(r.hpLeft).toBe(100 - (r.turns - 1));
    }
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
  it('SIM#B miss∈{0.3,0.4} 最小失败率为回归基线（Plan 5 重录：当前 50%）', () => {
    const lossRates = [0.3, 0.4].map((mr) => {
      const wins = SEEDS.map((seed) => simulate(seed, mr, CORPUS)).filter((r) => r.won).length;
      return 1 - wins / SEEDS.length;
    });
    const minLoss = Math.min(...lossRates);
    // 判据取下界：失败率不得低于基线 0.50。**重录而非收紧**：
    // - 0.60→0.72 那一次（Plan 4/D28）来源是"每回合多掷一次浮动"的序列重排；
    // - 0.72→0.50 这一次（Plan 5 数值改进）是**刻意的难度下调**：低档倍率抬高后，
    //   错过 30% 时的翻盘面明显变大（实测 miss=0.3 失败率 0.50、miss=0.4 为 0.82）。
    //   这正是用户反馈要的效果（新手期不再被数学门槛卡死），故基线跟着改，而不是收紧断言。
    // 本闸仍容差很薄：DIFFICULTY/BASE_CARD_DAMAGE/damageMultiplier/atk 任何微调都会先在这里红。
    expect(minLoss).toBeGreaterThanOrEqual(0.5);
    // 上界同样钉住（防"调过头"方向漂移）：B 不是必败性质，胜率不该归零。
    expect(minLoss).toBeLessThan(1);
  });

  it('SIM#C 单调性：错误率越高胜率不升（曲线形状是规格的一部分）', () => {
    const rows = MISS_RATES.map((mr) => curveRow(mr).winRate);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeLessThanOrEqual(rows[i - 1]);
    // 中位胜负点在 miss≈0.3 附近翻转（Plan 5 重录的实测曲线：
    // miss 0→1.00、0.1→0.98、0.2→0.82、0.3→0.50、0.4→0.18）。
    // 旧断言写的是"0.3 < 0.5"——数值改进后 0.3 恰好等于 0.50，故改为"不得高于 0.5"
    // （拐点右移是这次调整的直接后果：低档倍率抬高 ⇒ 容错变宽）。
    expect(curveRow(0.2).winRate).toBeGreaterThanOrEqual(0.5);
    expect(curveRow(0.3).winRate).toBeLessThanOrEqual(0.5);
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
 *   A → 硬断言（50/50 won && survived）；B → 双向界定的回归基线（minLoss ∈ [0.72, 1)），
 *   并保留 {0.3,0.4} 扫描与最小失败率计算本身——判据形式不变，只是从"必败"降为"基线"。
 * 未私调任何 spec 常数（BASE_CARD_DAMAGE/DIFFICULTY/浮动区间原样）。
 */

// ---------------------------------------------------------------------------
// D28 · T2 新增：Boss 档分钉（难度分档真实生效 + 既有产品事实申报）
// ---------------------------------------------------------------------------
describe('balance sim —— Boss 档（D28 · SIM#E2）', () => {
  /** boss 画像复用 simulate 的 encounter 路径不可行——此处直接内联 boss 接线。 */
  function simBoss(seed: number): SimResult & { hpMax: number } {
    const rng = mulberry32(seed);
    const pool = buildPool(CORPUS, { size: POOL_SIZE, rng, nowMs: SIM_NOW });
    const enemyHp = enemyHpForPool(pool.length, 'boss');
    const vitCount = pool.filter((c) => c.srs.stability === 'review' || c.srs.stability === 'mastered').length;
    let state = createBattle(
      pool, enemyHp, deriveStats(PLAYER_LEVEL, vitCount, SPIRIT_COUNT), rng, enemyPowerFor('boss'),
    );
    let turns = 0;
    while (state.phase === 'answering') {
      state = answer(state, pool[state.idx], GRADES.good, rng);
      turns += 1;
    }
    return {
      won: state.phase === 'won', phase: state.phase, poolLen: pool.length, enemyHp,
      turns, dealt: enemyHp - Math.max(0, state.enemyHp), voided: pool.length - turns,
      expPool: victoryExp(pool, 'boss'), expReleased: victoryExp(pool.slice(0, turns), 'boss'),
      hpLeft: state.playerHp, died: state.playerHp <= 0, hpMax: state.maxPlayerHp,
    };
  }

  it('SIM#E2 L1 全对打 Boss：无人阵亡但 50/50 池尽而败——败因是输出不足，且承伤显著高于遭遇战', () => {
    const rs = SEEDS.map(simBoss);
    // ① 反击分档生效：def=7、boss power=11 ⇒ base=max(1,4)=4，round(4×U[0.9,1.1))≡4
    //    （浮动域 [3.6,4.4) 恒取整为 4——退化单点，非区间）。Boss 局全部池尽而败，
    //    lost 分支末回合仍结反击 ⇒ 承伤恒 15×4=60、hpLeft 恒 40；对照遭遇战 def≥power
    //    的下钳 1/回合，分档差被精确钉死（T2 评审 I-2：旧注释 ∈{4,5} 与带 [36,44] 不实）。
    for (const r of rs) {
      expect(r.died).toBe(false); // 产品红线：L1 全对不会被打死，只是打不死 Boss
      expect(r.hpLeft).toBe(40); // 恒等式即分档证明（4/回合 × 15 回合）
    }
    // ② 既有产品事实（Plan 2 起即成立，非 D28 引入）：boss HP=ceil(15×10×1.5)=225 远超
    //    本语料池的理论最大输出（按池内 stability 实算 131–169；跨 seed dealt 实测 114–155）
    //    ⇒ L1 新号全对也输。翻盘门槛（T2 评审反事实校准）：atk≈18 才有 1/50 胜、atk≈20 才
    //    23/50——正确打法=领域掌握度堆 atk / 缩池练习关，量化依据供 Plan 5 试玩校准。
    //    若未来调 boss HP 系数走 PRD 修订，此断言随之更新——它的存在就是让该决策有账可查。
    expect(rs.every((r) => r.phase === 'lost')).toBe(true);
    expect(rs.every((r) => r.turns === r.poolLen)).toBe(true);
    // ③ exp 释放口径在 boss 档同样不虚高（全答完 released==pool）。
    for (const r of rs.slice(0, 3)) expect(r.expReleased).toBe(r.expPool);
  });
});
