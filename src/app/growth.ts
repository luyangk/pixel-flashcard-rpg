/**
 * growth.ts —— Plan 3 · T3 全库口径属性派生 + 复习落账链（PRD §6.5 红线 N-1/N-2 兑现点）。
 *
 * 「记住多少 = 多强」在此变成代码：
 * - vitCount/spiCount 恒以**整个库**为依据计数（N-1）——本场池子集、主题筛选都
 *   不得改变玩家六维。若按池算，换个小池就能"卸下"体力/精神，口号即破功；
 * - settleFight 只对**已消耗回合**（pool.slice(0, idx)）走 applyReview（N-2）——
 *   won-with-overkill 时剩余作废卡 SRS 零推进，未答的题不该被系统偷偷复习过；
 * - 复习落账的唯一入口是 core/reviewFlow.applyReview（R-T4-d）：本模块只决定
 *   "哪些卡、什么评分、几点落账"，两步定序的细节不在这里重复。
 *
 * 时间口径：nowMs / tzOffsetMin / params 一律 deps 注入（与 reviewFlow 同纪律），
 * src/app 层不读时钟——真实调用方从 platform/clock 取值传入。
 * 不可变：所有函数返回新数组/新对象，绝不改动入参 cards。
 */

import type { Card, SaveFile, Sm2Params, Stability } from '@core/types';
import type { Grade } from '@core/sm2';
import { applyReview } from '@core/reviewFlow';
import { deriveStats, applyExp, victoryExp, type PlayerStats } from '@core/stats';
import type { BattleState } from '@core/battle';
import type { FightView } from './battleFlow';

// ---------------------------------------------------------------------------
// N-1 全库口径计数
// ---------------------------------------------------------------------------

/**
 * 稳定性显式秩表（T3 接管修复）：曾经用字符串比较 `stability >= 'review'` 表达
 * "≥ review"——字典序下 'mastered' < 'review'（'a' < 'e'），mastered 卡被整体漏计，
 * vit/spi 偏低并沿 settleFight 的 exp 断言二次引爆（G#1–G#4 / GS#4 / GS#6 六红）。
 * 序关系是数据不是巧合，必须写成秩表；新增 Stability 成员时在此登记秩
 * （dev 断言可选：编译期 Record<Stability,…> 的穷尽性已是第一道闸）。
 * 未知/非字符串一律 -1，永不计入。
 */
const STABILITY_RANK: Record<Stability, number> = { new: 0, learning: 1, review: 2, mastered: 3 };

/** 秩取数：表外成员 / 非字符串回落 -1（低于一切合法档 ⇒ 不计入任何门槛）。 */
function rank(stability: unknown): number {
  return typeof stability === 'string' && Object.prototype.hasOwnProperty.call(STABILITY_RANK, stability)
    ? STABILITY_RANK[stability as Stability]
    : -1;
}

/** spi 来源白名单（§6.4）：只有玩家亲手做/让 LLM 生成的卡给精神——预置/热点/领域卡是公共资产。 */
const SPIRIT_SOURCE_TYPES = new Set(['manual', 'llm']);

/** spi 的遗忘次数上限：lapses ≤ 2 才算"合格自建卡"（brief verbatim）。 */
const SPIRIT_LAPSE_MAX = 2;

/** vit = 全库已入脑卡数：stability ∈ {review, mastered}（秩 ≥ review）。非数组回落空集。 */
export function vitCount(cards: readonly Card[]): number {
  if (!Array.isArray(cards)) return 0;
  let n = 0;
  for (const c of cards) {
    const stability = c?.srs?.stability;
    if (rank(stability) >= rank('review')) n += 1;
  }
  return n;
}

/**
 * spi = 全库合格自建卡数：source.type ∈ {manual, llm} && stability ≥ 'review'（秩比较）
 * && lapses ≤ 2。无 source（预置导入前的裸卡）不计——缺溯源即无从判断"自建"。
 */
export function spiCount(cards: readonly Card[]): number {
  if (!Array.isArray(cards)) return 0;
  let n = 0;
  for (const c of cards) {
    const stability = c?.srs?.stability;
    const type = c?.source?.type;
    const lapses = c?.srs?.lapses;
    if (
      typeof type === 'string' && SPIRIT_SOURCE_TYPES.has(type)
      && rank(stability) >= rank('review')
      && typeof lapses === 'number' && Number.isFinite(lapses) && lapses <= SPIRIT_LAPSE_MAX
    ) {
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// exp → level 与六维快照
// ---------------------------------------------------------------------------

/**
 * 累计经验 → 当前等级：从 L1 起逐级消费（applyExp(1, total).level）。
 * settings.progress.exp 约定为非负整数，但此处对脏存档保守消毒：
 * 非有限/负数一律视为 0 → L1（宁给新手强度，不给 NaN 属性）。
 */
export function levelFromExp(totalExp: number): number {
  if (typeof totalExp !== 'number' || !Number.isFinite(totalExp) || totalExp < 0) return 1;
  return applyExp(1, totalExp).level;
}

/**
 * 存档 → 战斗用六维快照（装配层喂 startFight 的唯一 stats 来源）。
 * 三个输入全部取自**整份存档**：exp（等级）、全库 vit、全库 spi——
 * 与任何池子集无关（N-1）。脏 save 逐字段消毒，永不抛。
 */
export function playerStatsFor(save: SaveFile): PlayerStats {
  const cards = Array.isArray(save?.cards) ? save.cards : [];
  const exp = save?.settings?.progress?.exp;
  return deriveStats(levelFromExp(typeof exp === 'number' ? exp : NaN), vitCount(cards), spiCount(cards));
}

// ---------------------------------------------------------------------------
// N-2 释放子集与结算落账
// ---------------------------------------------------------------------------

/**
 * 消耗 / 释放两口径的权威切分（接管修复 #2）。裁决依据，逐字引用：
 * - PRD §6.5 红线②：victoryExp 传**实际释放**子集，"提前 won 会虚高 ≤5×作废 mastered"；
 *   plan3 line 15 verbatim：「won 时 pool.slice(0, idx)，lost 时全池」——brief 与测试标题
 *   （"idx=3 → exp 按 3 张"）都以此为唯一释放口径。battle.answer 的 idx **恒 +1**
 *   （core/battle.ts 头注释，EW#1/IDX#1/CB#11 已评审钉死）：won 于第 N 击时 idx === N，
 *   slice(0, idx) 即"被作答过的卡"全体——击杀击是最后作答的一张，也在释放子集尾格上；
 *   "剩余卡作废"指 pool[idx:] 永不被答的那些（EW#1：won 后 answer 幂等），不含击杀击。
 * - 落账（消耗）面 = log 的 cardId ∪ pool[0..releaseLen)：正常流程二者恒等（每回合
 *   恰一事件、idx 同步 +1）；并集只防脏 log 漏账，min(idx, 池长) 上界防伪造越账。
 * lost 无"最后一击"：池尽即全数登场，消耗 = 释放 = 全池。answering 保守取 slice(0, idx)。
 */
function consumedAndRelease(state: BattleState, pool: readonly Card[]): { consumedIds: Set<string>; released: Card[] } {
  const rawIdx = typeof state?.idx === 'number' && Number.isFinite(state.idx) ? Math.max(0, state.idx) : 0;
  const idx = Math.min(rawIdx, pool.length);
  const phase = state?.phase;
  const releaseLen = phase === 'lost' ? pool.length : idx;
  const released = pool.slice(0, releaseLen);
  const consumedIds = new Set<string>();
  if (Array.isArray(state?.log)) {
    for (const ev of state.log) {
      if (typeof ev?.cardId === 'string') consumedIds.add(ev.cardId);
    }
  }
  for (let i = 0; i < releaseLen; i++) {
    const id = pool[i]?.id;
    if (typeof id === 'string') consumedIds.add(id);
  }
  return { consumedIds, released };
}

/**
 * 释放子集（victoryExp 的计分面）——导出口径与 settleFight 内部严格同源：
 * - won → pool.slice(0, state.idx)（plan3 line 15 verbatim；idx 恒 +1 含终局回合）；
 * - lost → 全池：池尽即全数登场；
 * - answering（未终局视图，理论上不该到这）保守取 slice(0, idx)。
 * 脏输入（非数组池 / 缺 state）回落 []。
 */
export function releaseSubset(pool: readonly Card[], state: BattleState): Card[] {
  if (!Array.isArray(pool)) return [];
  return consumedAndRelease(state as BattleState, pool).released;
}

export interface SettleDeps {
  /** 由卡推评分：装配层把战斗事件/玩家选择映射为 SM-2 档位（本模块不猜评分来源）。 */
  gradeOf: (c: Card) => Grade;
  /** 落账时刻（毫秒）与本地时区偏移分钟（UTC+8 为 +480），调用方注入。 */
  nowMs: number;
  tzOffsetMin: number;
  params: Sm2Params;
}

export interface SettleResult {
  /** 与入参 cards 同长度同顺序的新数组；未参战卡保持原引用。 */
  cards: Card[];
  /** 本场经验：won 才发，按释放子计；lost 恒 0。落库义务在调用方（写进 progress.exp）。 */
  exp: number;
  won: boolean;
}

/**
 * 战斗结算 → 复习落账链（N-2 兑现点）。
 *
 * 消耗 / 释放两口径由 consumedAndRelease 单点切分（裁决全文见该函数注释）：
 * - **消耗**（落账面）：log 的 damage/miss cardId ∪ pool[0..releaseLen)——won 时含
 *   击杀击（玩家用它作答了，SRS 必须推进），lost 时全池；
 * - **释放**（exp 面）：plan3 line 15 verbatim「won 时 pool.slice(0, idx)，lost 时全池」。
 * 每张消耗卡经 applyReview（唯一合法入口）落账；其余卡零推进。
 */
export function settleFight(
  cards: readonly Card[],
  view: FightView,
  deps: SettleDeps,
): SettleResult {
  if (!Array.isArray(cards)) return { cards: [], exp: 0, won: false };
  const state = view?.state;
  const pool = Array.isArray(view?.pool) ? view.pool : [];
  const won = state?.phase === 'won';

  const { consumedIds, released } = consumedAndRelease(state as BattleState, pool);

  const next = cards.map((c) => {
    if (c == null || !consumedIds.has(c.id)) return c; // 未参战/脏项：原样透传，SRS 零推进
    return applyReview(c, deps.gradeOf(c), deps.nowMs, deps.tzOffsetMin, deps.params).card;
  });

  const exp = won ? victoryExp(released, 'encounter') : 0;
  return { cards: next, exp, won };
}
