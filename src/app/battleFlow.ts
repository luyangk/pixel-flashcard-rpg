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
 * 【T3 已兑现】stats 注入：startFight 增可选 opts.stats（PlayerStats）。缺省时仍为
 * deriveStats(1, 0, 0)——SF#5 的 atk=12 锚点逐字保留；装配层调用方传
 * growth.playerStatsFor(save)，把全库口径 vit/spi 与 exp 派生等级带进战斗（N-1）。
 */

import type { Card } from '@core/types';
import type { Rng } from '@core/rng';
import type { Grade } from '@core/sm2';
import { buildPool } from '@core/deckBuild';
import { deriveStats, enemyHpForPool, enemyPowerFor, type PlayerStats } from '@core/stats';
import { createBattle, answer, type BattleState } from '@core/battle';
import type { SessionCards } from './sessionTypes';

/**
 * 本局难度档。`tutorial` = **第一场战斗的教学局**（Plan 5 数值改进，用户实测驱动）：
 * 敌血系数 0.3 而不是 0.7，让全 `new` 卡的首战能赢；由控制器在 `meta.plays === 0` 时选用。
 * 它在结算面**按遭遇战处理**（榜单 kind、经验档都是 encounter）——教学局只是难度更低，
 * 不是另一类战斗。
 */
export type FightDifficulty = 'tutorial' | 'encounter' | 'boss';

/** 脏难度值一律归 'encounter'（存档/UI 透传的域外值不得产出 NaN 或改档）。 */
function difficultyOfInput(value: unknown): FightDifficulty {
  return value === 'tutorial' || value === 'boss' ? value : 'encounter';
}

/** 一场遭遇战的只读视图：state 是权威进度，pool 持对象（state.pool 只持 id）。 */
export interface FightView {
  readonly state: BattleState;
  readonly pool: readonly Card[];
  /** 当前待答卡；终局（won/lost）或 idx 越出池尾时为 null。 */
  readonly current: Card | null;
  /**
   * 本局难度档（T3 起随视图带出，T8 结算/榜单消费）：缺省字段保持可选——
   * 既有 FightView 夹具与 answerCurrent 返回值不因它而必须改动（追加非破坏）。
   */
  readonly difficulty?: FightDifficulty;
}

/** 失败面：error 码 + 可直接上屏的大白话文案。 */
export interface FightError {
  readonly error: 'invalid-size' | 'no-cards' | 'insufficient-cards';
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
  /**
   * 难度档（T3 管道、T8 消费）：默认 encounter；boss 时敌人 HP 与反击强度
   * 同源切档（enemyHpForPool(len,'boss') + enemyPowerFor('boss')）。
   */
  readonly difficulty?: FightDifficulty;
  /**
   * 玩家六维快照（T3 注入位）：装配层传 growth.playerStatsFor(save)。
   * 缺省 / 非法（非对象、含 NaN 字段）一律回落 deriveStats(1,0,0)——
   * 与 T2 中间态逐字同值，SF#5 的 atk=12/maxHp=100 锚点因此不漂移。
   */
  readonly stats?: PlayerStats;
}

/** 有限正整数校验（与 deckBuild.isPositiveInt 同口径，此处用于前置分流而非依赖其回落）。 */
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 由池对象数组重建视图：current 的唯一计算点，保证与 state.idx 永不脱钩。 */
function toView(
  state: BattleState,
  pool: readonly Card[],
  difficulty: FightDifficulty = 'encounter',
): FightView {
  const current = state.phase === 'answering' ? (pool[state.idx] ?? null) : null;
  return { state, pool, current, difficulty };
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

  // T3 授权改动（R-P4-preflight-a / 终审 triage「非法 size 文案分流」）：
  // 请求参数坏（size 非整数∈[1,60]）与库存为空是两类用户、两句大白话——旧版合并成
  // no-cards 让设置页脏值也被误报"没卡片"。上限 60 与 UI 三挡（10/15/25）留裕。
  if (!isPositiveInt(opts?.size) || opts.size > 60) {
    return {
      error: 'invalid-size',
      message: '这场的人数设置不对，回到备战页重新选一个吧。',
    };
  }
  if (library.length === 0) {
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
  const difficulty = difficultyOfInput(opts.difficulty);
  const enemyHp = enemyHpForPool(pool.length, difficulty);

  // stats 注入位（T3）：合法 PlayerStats 直用；缺省/脏值回落 T2 中间态同值，
  // SF#5 锚点（atk=12/maxHp=100）由这条回落路径守护。
  const stats = isUsableStats(opts.stats) ? opts.stats : deriveStats(1, 0, 0);

  return toView(
    createBattle(pool, enemyHp, stats, opts.rng, enemyPowerFor(difficulty)),
    pool,
    difficulty,
  );
}

/**
 * PlayerStats 可用性甄别：六个字段全为有限数才放行——任一 NaN/undefined/字符串
 * 混入都会把 NaN 带进 damage/HP（createBattle 只快照不消毒，属性是它的裸入参）。
 * 非法即整体回落默认派生，不做逐字段修补（半套属性比没有属性更危险）。
 */
function isUsableStats(s: unknown): s is PlayerStats {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.level === 'number' && Number.isFinite(o.level)
    && typeof o.vit === 'number' && Number.isFinite(o.vit)
    && typeof o.spi === 'number' && Number.isFinite(o.spi)
    && typeof o.atk === 'number' && Number.isFinite(o.atk)
    && typeof o.def === 'number' && Number.isFinite(o.def)
    && typeof o.maxHp === 'number' && Number.isFinite(o.maxHp)
  );
}

export interface AnswerDeps {
  readonly rng: Rng;
  /** dev 断言捕获器（N-9）：生产不传即零开销。 */
  readonly asserts?: (msg: string) => void;
}

/**
 * 作答当前卡。card 不接受外部传入——恒取 pool[state.idx]，
 * 因此上层 UI 无论怎么乱序点击都不可能把 grade 落到别的卡上（RF#4 免疫）。
 * 脏视图（idx 越界或池含 null 占位，取不到卡）时拒绝推进并上报 mismatch，
 * 绝不把 undefined/null 喂进 battle.answer。
 */
export function answerCurrent(
  view: FightView,
  grade: Grade,
  deps: AnswerDeps,
): FightView {
  const card = view.pool[view.state.idx];
  if (card == null) {
    deps.asserts?.('answer-card-mismatch');
    return view;
  }
  const next = answer(view.state, card, grade, deps.rng, deps.asserts);
  // 视图**恒**由 (next, pool) 重建 —— 因此 `next === view` 只在"空卡早退"这一条路径
  // 上成立（上方的 card == null 分支），**不能**用引用比较判断"是否终局/是否重复提交"：
  // 终局态的 answer 调用会返回 phase 未变但引用全新的视图。调用方（gameController）
  // 必须按 `state.phase !== 'answering'` 自行短路（C-1 修复，见 tests/app/GC#9b）。
  // battle.answer 自身的引用同引口径见 tests/core/battle.test.ts CB#11/CB#12。
  return toView(next, view.pool, view.difficulty); // 难度跨回合保持（T3：boss 局全程同档）
}
