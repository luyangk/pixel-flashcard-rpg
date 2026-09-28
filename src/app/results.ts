/**
 * results.ts —— Plan 3 · T7 战绩榜落盘接线（RunRecord 组装归位 + 7 天备份提醒持久位）。
 *
 * ## 为什么转换器住在这里（Ruling R-T9-a 的兑现处）
 * core/leaderboard 只拥有「怎么算分、怎么排名」两个纯派生口径，其文件头明令
 * 「BattleState→RunRecord 的组装属上层装配职责（Plan 3），本层不预置转换器」。
 * 本模块就是那一半：把战斗视图（FightView/BattleState）翻译成计分入参，
 * 再经 scoreRun → rankRuns → coordinator 落进 settings.leaderboard。
 *
 * ## 关键口径（brief 逐字 + 未言明处的裁决）
 * - `cards = min(idx, pool.length)`：idx 是"已作答数"（battle.answer 恒 +1），池长是上界；
 *   脏 idx 越出池尾时按池长截断，绝不放大"这局打了多少张"的账（与 growth 释放子集同口径）。
 * - `misses = log 中 kind==='miss' 的条数`：**不按"没有伤害"反推**——stability=new 的卡
 *   命中（damage）也可能是 amount=0，误计会让玩家白白丢分。
 * - `result` 由 phase 判定：仅 phase==='won' 记 won；'lost'、'answering' 及任何域外
 *   phase 一律保守 'lost'（"宁保守不虚高"——未完局不得当作胜利入榜）。
 * - `at = extras.nowMs`：时间一律入参注入，本模块与 persist 同纪律，不读宿主时钟。
 * - `kind`：只有 'boss' 走 Boss 加成，域外值保守归 'encounter'（少给分，不虚高）。
 *
 * ## 脏入参的消毒边界（fail-closed 但**不毒化整包自检**）
 * 任一字段若原样写进存档，validateSave 会整包拒，连累所有其它改动永远落不了盘。
 * 故 buildRunInput 逐字段消毒：idx/level 非有限或负 → 0、小数向下取整（scoreRun 同款），
 * 池/log 非数组 → 空，domain 空串或非字符串 → 'unknown'，nowMs 非法 → 0。
 * 这是"装配层绝不把脏值交给存储"的既有分工（见 persist 落盘自检、growth 逐字段消毒）。
 *
 * ## 落盘语义（R-T4-p3-d）
 * recordRun 与 markExported 都在 mutate 之后用 `flush() && !dirty()` 收口：
 * 返回即"这次改动已在存储里"。flush() 的 true 只承诺"被认领的那批已写"，在途 mutate
 * 的那批还没写，故必须循环到 dirty() 归假（步数上限防并发自旋）。写失败（配额满等）
 * 不抛出：权威位与 dirty 由 coordinator 保持，退避窗会自然重试，调用方拿到的是记录本身。
 *
 * 边界：榜单是**展示派生数据**——截 50（LEADERBOARD_LIMIT）后低分会被挤出榜外，
 * 此时 recordRun 仍返回这条记录（调用方可显示"本局 40 分，未进前 50"）。
 */

import type { RunRecord, RunInput } from '@core/leaderboard';
import { rankRuns, scoreRun } from '@core/leaderboard';
import type { BattleState } from '@core/battle';
import type { Coordinator } from './persist';
import type { FightView } from './battleFlow';

/** 榜单上限（brief verbatim：rankRuns 截 50）。 */
const LEADERBOARD_LIMIT = 50;

/** flushToClean 的步数上限（与 persist 同护栏；正常路径一轮即净）。 */
const MAX_FLUSH_ROUNDS = 5;

/** 域值缺失时的占位（validateSave 要求 domain 非空串，空串会毒化整包自检）。 */
const UNKNOWN_DOMAIN = 'unknown';

/**
 * buildRunInput 的入参扩展面（brief：extras 含 nowMs/domain/kind/level）。
 * 不导出类型别名：Produces 面保持 brief 的两个函数，消费方按结构传字面量即可。
 */
interface RunExtras {
  nowMs: number;
  domain: string;
  kind: 'encounter' | 'boss';
  level: number;
}

/** Date 可表示时间戳范围（与 saveMigrate.requireTimestamp 同域）。 */
const MAX_TIME_MS = 8.64e15;

/** 有限非负整数消毒：非有限/负 → 0，小数向下取整（scoreRun/leaderboard 同口径）。 */
function nonNegIntOr(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n >= 0 ? n : 0;
}

/** 时间戳消毒：可表示范围内的有限数原样保留（含 1970 前），否则回落 0。 */
function timestampOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS
    ? value
    : 0;
}

/**
 * 战斗视图 → 计分入参（`Omit<RunRecord,'score'|'id'>`，见 @core/leaderboard.RunInput）。
 *
 * `state` 参数是权威进度：调用方可传比 view.state 更新的 state（例如终局事件已处理完的
 * 那一份），池对象与池长恒取 view.pool。纯函数：三个入参一律不改动。
 */
export function buildRunInput(
  view: FightView,
  state: BattleState,
  extras: RunExtras,
): RunInput {
  const s = state as BattleState | undefined;
  const pool = Array.isArray(view?.pool) ? view.pool : [];
  const idx = nonNegIntOr(s?.idx);
  const cards = Math.min(idx, pool.length); // 池长即消耗上界（脏 idx 不得放大账目）
  const log = Array.isArray(s?.log) ? s.log : [];
  let misses = 0;
  for (const event of log) {
    if (event?.kind === 'miss') misses += 1; // 只认显式 miss：amount=0 的 damage 仍是命中
  }
  const domain = extras?.domain;
  return {
    at: timestampOr(extras?.nowMs),
    result: s?.phase === 'won' ? 'won' : 'lost', // 未完局/域外 phase 一律保守 lost
    kind: extras?.kind === 'boss' ? 'boss' : 'encounter',
    domain: typeof domain === 'string' && domain.length > 0 ? domain : UNKNOWN_DOMAIN,
    cards,
    misses,
    level: nonNegIntOr(extras?.level),
  };
}

/**
 * 榜单行 id：由记录内容确定性派生（不含 rng/计数器，故同参同值、可复现）。
 * plan 未规定 id 生成规则；此处选确定性派生的理由：①core 不生成 id，装配层若用
 * 随机源会把"同 seed 同输出"的确定性链断在最后一米；②内容相同的一局在**同一毫秒**
 * 内才是同 id（实战不可能——一局至少数百毫秒），而榜单并无 id 唯一性约束，
 * 撞 id 至多让两行不可区分，不影响排序与计分。
 */
function makeRunId(r: RunInput): string {
  return `run-${r.at}-${r.domain}-${r.kind}-${r.cards}-${r.misses}-${r.level}`;
}

/**
 * "我的改动此刻已持久"收口（R-T4-p3-d）：循环 flush 直到 dirty() 归假。
 * 返回 false = 仍有未落盘改动（写失败或并发不断）——调用方不必重试，coordinator
 * 的退避窗会接着兜。
 */
async function flushToClean(coord: Coordinator): Promise<boolean> {
  for (let i = 0; i < MAX_FLUSH_ROUNDS; i++) {
    if (!(await coord.flush())) return false;
    if (!coord.dirty()) return true;
  }
  return !coord.dirty();
}

/**
 * 记一局：组装 → 计分 → 与既有榜合并排名（截 50）→ 写 settings.leaderboard → 收口落盘。
 *
 * 返回**刚产生的这条记录**（不是排名后它所在的位置）：即使它被前 50 名挤出榜外，
 * 调用方仍可展示本局成绩。落盘失败不抛出（见文件头"落盘语义"）。
 */
export async function recordRun(
  coord: Coordinator,
  view: FightView,
  state: BattleState,
  extras: RunExtras,
): Promise<RunRecord> {
  const input = buildRunInput(view, state, extras);
  const record: RunRecord = {
    id: makeRunId(input),
    at: input.at,
    result: input.result,
    kind: input.kind,
    domain: input.domain,
    cards: input.cards,
    misses: input.misses,
    level: input.level,
    score: scoreRun(input),
  };

  await coord.mutate((save) => {
    // 旧档可能没有 leaderboard 字段（可选位，T7 前形状）——按空榜起算，不报错。
    const existing = Array.isArray(save.settings.leaderboard) ? save.settings.leaderboard : [];
    save.settings.leaderboard = rankRuns([...existing, record], LEADERBOARD_LIMIT);
  });
  await flushToClean(coord);
  return record;
}
