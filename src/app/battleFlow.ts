/**
 * 战斗段编排（Plan 3 · T2）—— 玩家"打一局"的数据流主干，纯函数零 IO。
 *
 * 职责边界：本模块只做「全库视图 → 卡池 → 建战 → 逐题作答」的装配与消毒，
 * 不碰存储、不碰时钟读取（nowMs 由调用方注入）、不做复习落账（T3 growth.settleFight）。
 * src/app 层允许 import core/platform，仍不得触碰 DOM（画面属 Plan 4）。
 *
 * 关键口径：
 * - startFight 的失败是**返回值不是 throw**（RF#3 空库引导语义）：新装玩家 cards=[] 点
 *   "开战"要拿到大白话引导文案（LORE §6 功能文本轨），而不是白屏或异常。
 *   createBattle 自身的 empty-pool/duplicate-card throw 保留在 core 面：startFight 用
 *   buildPool 输出长度做前置守卫把它挡在外面。
 * - answerCurrent **不收 card 参数**：当前卡恒取 view.pool[view.state.idx]，
 *   API 层面免疫 RF#4「答错卡」主路径；mismatch 只在绕过本层直调 battle.answer 时可能，
 *   经可选 asserts 回调捕获并拒绝推进（N-9）。
 * - enemyHp 按**实际池长**反推，不按请求 size：请求 15 实得 8 ⇒ ceil(8×10×0.7)=56，
 *   否则降级池会凭空变硬（stats.enemyHpForPool 的入参义务）。
 *
 * 【刻意中间态】vit/spi 传 0/0、level 固定 1：本任务（T2）尚无 growth.ts，全库口径的
 * vitCount/spiCount 与 levelFromExp 归 T3 落地。届时以 growth.playerStatsFor(save)
 * 替换下方 deriveStats(1, 0, 0) 一行——这是计划内的过渡，不是遗漏（brief 环境适配注记）。
 */

import type { Card } from '@core/types';
import type { Rng } from '@core/rng';
import type { Grade } from '@core/sm2';
import { buildPool } from '@core/deckBuild';
import { deriveStats, enemyHpForPool } from '@core/stats';
import { createBattle, answer, type BattleState } from '@core/battle';
import type { SessionCards } from './sessionTypes';

/** 一场遭遇战的只读视图：state 是权威进度，pool 持对象（state.pool 只持 id）。 */
export interface FightView {
  readonly state: BattleState;
  readonly pool: readonly Card[];
  /** 当前待答卡；终局（won/lost）或 idx 越出池尾时为 null。 */
  readonly current: Card | null;
}

/** 失败面：error 码 + 可直接上屏的大白话文案。 */
export interface FightError {
  readonly error: 'no-cards' | 'insufficient-cards';
  readonly message: string;
}

export interface StartFightOptions {
  /** 请求池规模（合法域 1–正整数；非法一律走 no-cards 引导）。 */
  readonly size: number;
  /** 主题筛选（多选卡组）；undefined = 不限定，空数组 = 命中 0 张。 */
  readonly deckIds?: readonly string[];
  readonly rng: Rng;
  /** 到期判定时钟（毫秒），由调用方从 platform/clock 取；core 层不自读时间。 */
  readonly nowMs: number;
}

/** 有限正整数校验（与 deckBuild.isPositiveInt 同口径，此处用于前置分流而非依赖其回落）。 */
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 由池对象数组重建视图：current 的唯一计算点，保证与 state.idx 永不脱钩。 */
function toView(state: BattleState, pool: readonly Card[]): FightView {
  const current = state.phase === 'answering' ? (pool[state.idx] ?? null) : null;
  return { state, pool, current };
}

/**
 * 开战：消毒 → 配池 → 按实际池长反推 HP → 建战。
 * 永不 throw（createBattle 的 throw 面被池长守卫挡住）。
 */
export function startFight(
  cards: SessionCards,
  opts: StartFightOptions,
): FightView | FightError {
  const library = Array.isArray(cards?.cards) ? cards.cards : [];

  // 空库 / 非法 size：一律给同一句引导——这两类玩家的下一步动作相同（去做卡）。
  // 「还差 N 张」对空库没有意义（N 依赖一个不该被信任的请求值），故不在此分支报数。
  if (!isPositiveInt(opts?.size) || library.length === 0) {
    return {
      error: 'no-cards',
      message: '还没有卡片。先做几张卡再来打这一仗。',
    };
  }

  const pool = buildPool(library, {
    size: opts.size,
    deckIds: opts.deckIds,
    rng: opts.rng,
    nowMs: opts.nowMs,
  });

  if (pool.length === 0) {
    // 库非空但筛后为 0（deckIds 指向空/不存在卡组）：缺口即整个请求量。
    return {
      error: 'insufficient-cards',
      message: `这些卡组里一张能用的都没有，还差 ${opts.size} 张。换个主题或补几张卡。`,
    };
  }

  // 降级放行：可用卡少于请求量。PRD §3 的降级链已把能凑的都凑上了，
  // 敌人 HP 必须跟着实际池长走，否则 8 张卡打 15 张的血量必输。
  // 阈值裁决（brief 未言明处）：仅"筛后 0 张"视为不可战；≥1 张即可开打，
  // 哪怕只有 1 张——单卡池打完即终局，数据流自洽（见 tests/app AC#4）。
  const enemyHp = enemyHpForPool(pool.length, 'encounter');

  // 【刻意中间态】T3 growth.playerStatsFor 接管后替换此行（见头注释）。
  const stats = deriveStats(1, 0, 0);

  return toView(createBattle(pool, enemyHp, stats, opts.rng), pool);
}

export interface AnswerDeps {
  readonly rng: Rng;
  /** dev 断言捕获器（N-9）：生产不传即零开销。 */
  readonly asserts?: (msg: string) => void;
}

/**
 * 作答当前卡。card 不接受外部传入——恒取 pool[state.idx]，
 * 因此上层 UI 无论怎么乱序点击都不可能把 grade 落到别的卡上（RF#4 免疫）。
 * 脏视图（idx 越界取不到卡）时拒绝推进并上报 mismatch，绝不把 undefined 喂进 battle.answer。
 */
export function answerCurrent(
  view: FightView,
  grade: Grade,
  deps: AnswerDeps,
): FightView {
  const card = view.pool[view.state.idx];
  if (card === undefined) {
    deps.asserts?.('answer-card-mismatch');
    return view;
  }
  const next = answer(view.state, card, grade, deps.rng, deps.asserts);
  // battle.answer 在终局/违规时返回同一引用：此时视图无需重建（toView 结果等价）。
  if (next === view.state) return view;
  return toView(next, view.pool);
}
