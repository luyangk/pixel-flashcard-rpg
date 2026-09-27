/**
 * 确定性回合制战斗状态机（Plan 2 · T4；Plan 3 · T2 修订 N-8/N-9）—— 玩法心脏，纯函数零平台依赖。
 *
 * 规则（brief verbatim）：
 * - answer 时 grade ≥ GRADES.good → damage = attack × damageMultiplier(card.srs.stability)
 *   × uniform(rng, 0.9, 1.1)，enemyHp -= round(damage)，事件 damage；
 * - grade < good → miss 事件、零伤害、敌人不反击（答错仅空转）；
 * - idx 恒 +1；idx === pool.length 时 enemyHp ≤ 0 → won，否则 lost；
 * - enemyHp 先归零 → 立即 won（剩余卡作废，log 记 end）；
 * - 玩家掉血路径本版不存在，但保留 playerHp 字段（假记忆演出与后续机制预留）。
 *
 * 【N-8】'ready' 相位已删除，BattlePhase 收窄为 'answering'|'won'|'lost'。理由：
 * createBattle 自 Plan 2 起即直落 'answering'，全仓无任何读/写 'ready' 的路径——它是死分支
 * 成员，留着会让上层（src/app/battleFlow）误以为存在"待开始"中间态而写出永不成立的分支。
 * 会话层的阶段机（sessionTypes.Phase：menu/preparing/fighting/result）才是"未开战"的表达位。
 * createBattle 行为不变（校验、初始 state 逐字同前）。
 *
 * 【N-9】answer 新增可选尾参 asserts：dev 断言回调（默认 undefined ⇒ 零开销、零行为变化）。
 * core 层不可用 import.meta.env.DEV（那是构建期全局，会破坏纯 core），故由调用方注入捕获器。
 * 语义：传入 card.id ≠ pool[state.idx] 即为「答非当前卡」的时序违规 —— 上报
 * 'answer-card-mismatch' 并拒绝推进（返回同一引用）。装配层 battleFlow.answerCurrent 恒取
 * pool[idx] 作为 card，正常路径不可能触发；此断言只为钉住绕过编排直调 battle.answer 的违规面。
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

/** N-8：无 'ready' 成员——建战即出第一张题卡。 */
export type BattlePhase = 'answering' | 'won' | 'lost';

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
 * asserts（N-9）为可选 dev 断言回调：不传时零开销、行为与 Plan 2 完全一致。
 */
export function answer(
  state: BattleState,
  card: Card,
  grade: Grade,
  rng: Rng,
  asserts?: (msg: string) => void,
): BattleState {
  if (state.phase !== 'answering') return state;

  // N-9 dev 断言：入参 card 必须是当前题卡 pool[idx]。越界（脏 state）同样视为违规。
  // 放在幂等短路之后：终局后传入任意剩余卡是合法调用面（作废卡不该触发告警）。
  if (asserts !== undefined) {
    const currentId = state.pool[state.idx];
    if (currentId === undefined || card.id !== currentId) {
      asserts('answer-card-mismatch');
      return state; // 拒绝推进：idx/log/enemyHp 一律原样
    }
  }

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
