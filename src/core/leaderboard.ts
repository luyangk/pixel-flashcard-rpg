/**
 * leaderboard —— 本地战绩榜计分与排序（Plan 2 · T9，PRD §5 首版"本地榜"数据层）。
 *
 * 定位：纯派生层。战斗结算（上层组装）产出一条 RunRecord，本模块负责
 * 「怎么算分」与「怎么排名」两件事；持久化归存储层、榜单页归渲染层（Plan 3）。
 * SaveFile.meta.plays 是总局数计数，榜单记录本身不进 SaveFile——首版按 brief
 * 只做计分/排名的数据层，落盘接线留给装配任务。
 *
 * verbatim 规则（brief）：
 * - scoreRun：won ? (cards − misses)×10 + level×5 + (kind==='boss' ? 50 : 0) : 0，下限 0；
 * - rankRuns：score 降序，同分 at 新者前；limit 默认 20。
 *
 * 约束：core 层禁 Date.now()/DOM/Node/Math.random——at 是调用方注入的时间戳数据，
 * 本文件只比较大小，从不读时钟。消毒风格与 stats.nonNegIntOr 对齐：
 * 非有限数回落 0、小数向下取整、负计数归零（输出永不含 NaN），
 * 但**不改写 result/kind 的语义**——域外枚举视为非 won/非 boss，与"宁保守不虚高"一致。
 *
 * 边界（Ruling R-T9-a）：BattleState→RunRecord 的组装属上层装配职责（Plan 3），
 * 本层不预置转换器——零调用方的契约外便利件即 YAGNI，勿在此重新发明。
 */

/** 单局战绩记录（榜单行）。id/at 由调用方注入，core 不生成也不读时钟。 */
export interface RunRecord {
  id: string;
  at: number;
  result: 'won' | 'lost';
  kind: 'encounter' | 'boss';
  domain: string;
  cards: number;
  misses: number;
  level: number;
  score: number;
  /**
   * 这一局的**名字**（D58，例「长安夜雨 · 唐诗 × 成语典故」）。
   *
   * 可选位：D58 之前的记录没有它 ⇒ 榜单回落到 `domain` 那一个领域名（老记录不因缺它而失效）。
   * 由 `app/fightTitle` 拼出（本地兜底先写，LLM 升级后覆盖）。
   */
  title?: string;
}

/** scoreRun 的入参形状：完整记录去掉派生值（score）与身份（id）。 */
export type RunInput = Omit<RunRecord, 'score' | 'id'>;

/** Boss 局固定加成（brief verbatim）。 */
const BOSS_BONUS = 50;
/** rankRuns 缺省返回条数（brief verbatim：默认 20）。 */
const DEFAULT_LIMIT = 20;

/** 有限非负整数消毒：非有限/负 → 0，小数向下取整（stats.nonNegIntOr 同口径）。 */
function nonNegIntOr(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n >= 0 ? n : 0;
}

/**
 * 计分手算锚点（brief verbatim 公式）：
 * won ? (cards−misses)×10 + level×5 + (boss?50:0) : 0，下限 0。
 * lost 恒 0；倒挂局（misses > cards）经 clamp 也是 0——不产负分。
 * 纯函数：不读改入参对象。
 */
export function scoreRun(r: RunInput): number {
  if (!r || typeof r !== 'object') return 0;
  if (r.result !== 'won') return 0;
  const cards = nonNegIntOr(r.cards);
  const misses = nonNegIntOr(r.misses);
  const level = nonNegIntOr(r.level);
  const raw = (cards - misses) * 10 + level * 5 + (r.kind === 'boss' ? BOSS_BONUS : 0);
  return raw > 0 ? raw : 0; // 下限 0（同时吸收任何意外负值）
}

/** 记录可用性判定：必须是对象且带可比较的数值 score / 时间戳 at（脏行剔除）。 */
function isRankable(v: unknown): v is RunRecord {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.score === 'number' && Number.isFinite(r.score)
    && typeof r.at === 'number' && Number.isFinite(r.at);
}

/**
 * 排名：score 降序，同分 at 新者前（at 更大者在前）；at 亦相同时保持输入相对顺序
 * （Array.prototype.sort 自 ES2019 起语言规范保证稳定）。
 * limit 缺省 20；≤0/NaN 回落默认，小数向下取整，超长按全量截尾。
 * 永不 mutate 输入：filter 已产出新数组，sort 就地作用于该副本；返回元素为原引用。
 */
export function rankRuns(records: readonly RunRecord[], limit?: number): RunRecord[] {
  const rows = Array.isArray(records) ? records.filter(isRankable) : [];
  const cap =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : DEFAULT_LIMIT;
  return rows
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, cap);
}
