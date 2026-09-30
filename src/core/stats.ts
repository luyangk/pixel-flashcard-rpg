/**
 * 属性体系与敌人 HP 反推（Plan 2 · T5）—— PRD §6.5 数值基线的唯一落点，
 * 也是 T7 headless 平衡模拟的数据源。纯函数零平台依赖。
 *
 * 常数 verbatim（§6.5 / D27）：
 * - DIFFICULTY = { encounter: 0.7, boss: 1.5 }；BASE_CARD_DAMAGE = 10；
 * - enemyHpForPool = ceil(poolSize × BASE_CARD_DAMAGE × DIFFICULTY[d])；
 * - expToNext(L) = ceil(100 × L^1.3)；
 * - victoryExp = round(30 × 难度系数 + 5 × 池内 mastered 张数)；
 * - atk = 10 + level*2 + floor(spi/8)；def = 5 + level*2 + floor(vit/10)；
 *   maxHp = 100 + (level-1)*10。
 *
 * 语义裁决（R-P2-a verbatim）：vit = 已入脑卡数（stability ∈ {review,mastered}）、
 * spi = 合格自建卡数（§6.4 口径）——两者均由调用方算好传入，本层不查 stability。
 *
 * 数值事实（T4 报告预警采纳）：BASE_CARD_DAMAGE 是 HP 生成常数、不是伤害上界。
 * 全 good 池平均单卡伤 = atk×1.0 > 基准 10（L1 无精神加成时 atk=12），两者解耦是
 * 有意的——这正是 §6.5「理论全对必胜且余量约 30%」的来源，不要试图"对齐"。
 *
 * 约束：core 层禁 Date.now()/DOM/Node/Math.random；不可变；域外输入抛错或消毒，
 * 输出永不含 NaN。
 */

import type { Card } from './types';
import { gateStabilityByDays } from './sm2';

/** 玩家六维（§6.5 属性映射的完整快照）。 */
export interface PlayerStats {
  readonly level: number;
  /** 体力 = 已入脑卡数（review+mastered），调用方传入。 */
  readonly vit: number;
  /** 精神 = 合格自建卡数（§6.4 口径），调用方传入。 */
  readonly spi: number;
  readonly atk: number;
  readonly def: number;
  readonly maxHp: number;
}

/** 难度系数（§6.5 verbatim）。 */
/**
 * 敌人 HP 系数（按池长反推：`enemyHpForPool = ceil(池长 × BASE_CARD_DAMAGE × 系数)`）。
 *
 * `tutorial`（Plan 5 数值改进，用户实测驱动）：**第一场战斗**用的"教学局"档。
 * 起因：新手期存在一个数学上不可能赢的门槛——每张卡分摊的敌血恒为
 * `BASE_CARD_DAMAGE × 系数`（与池长无关！），遭遇战是 7 点/张；而 `new` 卡
 * 每击只有 `atk × 0.1`（L1 时 1 点），`learning` 也只有 6 点 ⇒ **背过一遍仍赢不了**。
 * 用户"玩了两轮都失败"正是撞在这个断崖上。
 * 教学局把系数降到 0.3（= 3 点/张），配合 `damageMult(new)` 提到 0.3（每击 4）⇒ 首战必胜
 * 但每击只有 3–4 点、十击刚好打穿，手感是"险胜"而非碾压；且**只作用于第一场**
 * （`meta.plays === 0` 时由控制器选用），之后立刻回到正常曲线。
 */
export const DIFFICULTY = { tutorial: 0.3, encounter: 0.7, boss: 1.5 } as const;

/** 基准单卡伤害（§6.5 verbatim）：HP 生成常数，非伤害上界（见头注释）。 */
export const BASE_CARD_DAMAGE = 10;

const BASE_ATK = 10;
const BASE_DEF = 5;
const BASE_HP = 100;
const ATK_SPI_DIV = 8;
const DEF_VIT_DIV = 10;

/** 有限非负整数校验（计数类入参用）：非法回落 0，小数向下取整。 */
function nonNegIntOr(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n >= 0 ? n : 0;
}

/** 等级校验：非有限/小于 1 回落 1（升级态的最小锚点），小数向下取整。 */
function sanitizeLevel(level: number): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 1;
  const n = Math.floor(level);
  return n >= 1 ? n : 1;
}

/** 难度键合法性：运行时脏数据（存档/UI 透传）不得静默产出 NaN。 */
function difficultyOf(difficulty: keyof typeof DIFFICULTY): number {
  const factor = DIFFICULTY[difficulty];
  if (typeof factor !== 'number') throw new Error('invalid-difficulty');
  return factor;
}

/**
 * 由等级与两张计数派生完整属性。vit/spi 的口径归调用方（本层不查 card.srs）。
 * 非法入参消毒而非抛错：属性是展示与战斗共用快照，宁回落保守初值也不产 NaN。
 */
export function deriveStats(level: number, masteredCount: number, spiritCount: number): PlayerStats {
  const lv = sanitizeLevel(level);
  const vit = nonNegIntOr(masteredCount);
  const spi = nonNegIntOr(spiritCount);
  return {
    level: lv,
    vit,
    spi,
    atk: BASE_ATK + lv * 2 + Math.floor(spi / ATK_SPI_DIV),
    def: BASE_DEF + lv * 2 + Math.floor(vit / DEF_VIT_DIV),
    maxHp: BASE_HP + (lv - 1) * 10,
  };
}

/**
 * 敌人 HP 由卡池反推：ceil(poolSize × BASE_CARD_DAMAGE × DIFFICULTY[d])。
 * RF#3 边界：poolSize 为 0 / 负数 / 非整数（含 NaN、Infinity）→ throw。
 */
export function enemyHpForPool(poolSize: number, difficulty: keyof typeof DIFFICULTY): number {
  if (typeof poolSize !== 'number' || !Number.isInteger(poolSize) || poolSize < 1) {
    throw new Error('invalid-pool-size');
  }
  const factor = difficultyOf(difficulty);
  return Math.ceil(poolSize * BASE_CARD_DAMAGE * factor);
}

/**
 * 反击强度专用系数（D28）：与 HP 的难度系数**同源但不共用**——boss 档封顶到
 * 1.1（power=11 < good 档基础输出 12），保「全对必胜」红线不被反击磨穿（裁定
 * R-T1-p4-b，PRD §6.5 同步改写；取 HP 系数 1.5→15 会击穿该红线）。
 */
const POWER_FACTOR = { tutorial: 0.7, encounter: 0.7, boss: 1.1 } as const;

/**
 * D28：敌人每回合反击强度，与 HP 同源反推但**与池长解耦**——
 * enemyPower = ceil(BASE_CARD_DAMAGE × POWER_FACTOR[d])（遭遇战 7 / Boss 11）。
 * HP 决定"要打掉多少"，power 决定"每回合挨多少"。未知难度键 throw
 * 'invalid-difficulty'，与 enemyHpForPool 同纪律（difficultyOf 单点把关）。
 */

export function enemyPowerFor(difficulty: keyof typeof DIFFICULTY): number {
  // difficultyOf 单点把关未知键（throw invalid-difficulty），POWER_FACTOR 与
  // DIFFICULTY 同键集——类型层已互锁，取不到值只可能是脏运行时数据。
  difficultyOf(difficulty);
  return Math.ceil(BASE_CARD_DAMAGE * POWER_FACTOR[difficulty]);
}

/** 升到下一级所需经验：ceil(100 × level^1.3)。level 须为正整数，否则 throw。 */
export function expToNext(level: number): number {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) {
    throw new Error('invalid-level');
  }
  return Math.ceil(100 * Math.pow(level, 1.3));
}

/**
 * 胜利经验：round(30 × 难度系数 + 5 × 本场 mastered 释放数)。
 * 「释放数」按 brief 口径计池内 stability === 'mastered' 的张数（不问作答结果，
 * 与 battle 的事件流解耦——本场参战即视为一次输出机会）。
 */
export function victoryExp(poolCards: readonly Card[], difficulty: keyof typeof DIFFICULTY): number {
  const factor = difficultyOf(difficulty);
  let masteredCount = 0;
  for (const c of poolCards) {
    // D64：按**闸门后的标签**数（间隔够但只跨过 1 天的卡不算掌握 —— 否则"同一天练三次"也能多拿经验）
    if (c?.srs != null && gateStabilityByDays(c.srs).stability === 'mastered') masteredCount += 1;
  }
  return Math.round(30 * factor + 5 * masteredCount);
}

/**
 * 消费经验并连续升级：每次跨阈值扣除该级所需、余数滚入下一级（brief：连续升级
 * 消费余数）。exp 为非负有限数即可（允许小数，逐级比较的是累积余数）；
 * 非法入参 → throw。循环以 expToNext 严格递增（≥100）保证终止。
 */
export function applyExp(level: number, exp: number): { level: number; exp: number } {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) {
    throw new Error('invalid-level');
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 0) {
    throw new Error('invalid-exp');
  }
  let lv = level;
  let rest = exp;
  while (rest >= expToNext(lv)) {
    rest -= expToNext(lv);
    lv += 1;
  }
  return { level: lv, exp: rest };
}
