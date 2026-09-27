/**
 * 确定性回合制战斗状态机（Plan 2 · T4）—— 玩法心脏，纯函数零平台依赖。
 *
 * 规则（brief verbatim）：
 * - answer 时 grade ≥ GRADES.good → damage = attack × damageMultiplier(card.srs.stability)
 *   × uniform(rng, 0.9, 1.1)，enemyHp -= round(damage)，事件 damage；
 * - grade < good → miss 事件、零伤害、敌人不反击（答错仅空转）；
 * - idx 恒 +1；idx === pool.length 时 enemyHp ≤ 0 → won，否则 lost；
 * - enemyHp 先归零 → 立即 won（剩余卡作废，log 记 end）；
 * - 玩家掉血路径本版不存在，但保留 playerHp 字段（假记忆演出与后续机制预留）。
 *
 * 约束：
 * - core 层禁 Date.now()/DOM/Node/Math.random；一切随机经注入 Rng（本文件不调 Math.random）。
 * - 不可变：每步返回新 BattleState，log 只追加。
 * - 战斗结算产出的复习事件由上层转交 applyReview——battle 本身不调它，保持纯。
 */

import type { Card } from './types';
import { GRADES, damageMultiplier, type Grade } from './sm2';
import type { Rng } from './rng';
import { uniform } from './rng';
import type { PlayerStats } from './stats';

export type BattlePhase = 'ready' | 'answering' | 'won' | 'lost';

export interface BattleState {
  readonly phase: BattlePhase;
  readonly pool: readonly string[];
  readonly idx: number;
  readonly enemyHp: number;
  readonly playerHp: number;
  readonly maxPlayerHp: number;
  /** 建战时快照的玩家攻击力：answer 只拿 BattleState，damage 公式需要 attack。 */
  readonly atk: number;
  readonly log: readonly BattleEvent[];
}

export interface BattleEvent {
  readonly kind: 'damage' | 'miss' | 'end';
  readonly cardId?: string;
  readonly amount?: number;
}

/**
 * 战斗所需的最小玩家属性形状（T5 对齐义务，已兑现）：权威定义在 stats.ts 的
 * PlayerStats（level/vit/spi/atk/def/maxHp 全必填），本文件只消费 atk 与 maxHp。
 * 别名保留 BattlePlayerStats 导出名以兼容既有引用面；createBattle 内 def 无消费点，
 * 可选→必填零逻辑改动。
 */
export type BattlePlayerStats = PlayerStats;

/**
 * 建战：校验池并落初始态。
 * RF#2：重复 cardId → throw Error('duplicate-card')；空池 → throw Error('empty-pool')。
 */
export function createBattle(
  poolCards: readonly Card[],
  enemyHp: number,
  playerStats: BattlePlayerStats,
  _rng: Rng, // 初始态无随机消耗；形参保留以固定调用签名（seed 由上层持有贯穿战斗）
): BattleState {
  if (poolCards.length === 0) throw new Error('empty-pool');
  const seen = new Set<string>();
  for (const c of poolCards) {
    if (seen.has(c.id)) throw new Error('duplicate-card');
    seen.add(c.id);
  }
  return {
    phase: 'answering',
    pool: poolCards.map((c) => c.id),
    idx: 0,
    enemyHp,
    playerHp: playerStats.maxHp,
    maxPlayerHp: playerStats.maxHp,
    atk: playerStats.atk,
    log: [],
  };
}

/**
 * 作答一卡。非 answering 态幂等返回自身（同一引用）——won/lost 即终局，剩余卡作废。
 */
export function answer(
  state: BattleState,
  card: Card,
  grade: Grade,
  rng: Rng,
): BattleState {
  if (state.phase !== 'answering') return state;

  const idx = state.idx + 1; // 恒 +1，命中与否皆然
  let enemyHp = state.enemyHp;
  const events: BattleEvent[] = [];

  // 命中门槛：brief verbatim「grade ≥ GRADES.good」。档位序 again(0) < hard(2) < good(3)
  // < easy(5)，故 again/hard 走空转、good/easy 走伤害——此口径由 battle.test.ts 的
  // AN#4（hard→miss）与 AN#4b（easy→damage）分别钉住。
  if (grade >= GRADES.good) {
    // 命中：attack × 熟练度倍率 × [0.9,1.1] 浮动，round 后扣血。
    // 倍率取入参 card 的 srs.stability（answer 持 Card 数据；stability=new 时
    // 0.1×atk 取整可为 0——amount=0 的 damage 事件仍算命中）。
    const damage = Math.round(
      state.atk * damageMultiplier(card.srs) * uniform(rng, 0.9, 1.1),
    );
    enemyHp = state.enemyHp - damage;
    events.push({ kind: 'damage', cardId: card.id, amount: damage });
  } else {
    // 空转：零伤害且敌人不反击（本版玩家掉血路径不存在）。
    events.push({ kind: 'miss', cardId: card.id });
  }

  let phase: BattlePhase = state.phase;
  if (enemyHp <= 0) {
    // enemyHp 先归零 → 立即 won（含池尽同时归零的情形），剩余卡作废。
    phase = 'won';
    events.push({ kind: 'end' });
  } else if (idx === state.pool.length) {
    // 卡池耗尽而敌人尚存 → lost。
    phase = 'lost';
    events.push({ kind: 'end' });
  }

  return {
    ...state,
    phase,
    idx,
    enemyHp,
    log: [...state.log, ...events],
  };
}
