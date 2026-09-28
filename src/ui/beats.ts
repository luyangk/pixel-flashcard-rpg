/**
 * beats.ts —— Plan 4 · T6：战报碎片池（LORE §5.2）。
 *
 * 职责只有一件：给定模板池与一个整数游标，给出**下一句战报碎片**与该句之后的游标。
 * 文案本体在 `assets/narrative/beats.json`（LORE §5.2 是文案权威），本文件只管抽取规则。
 *
 * 三条规则（brief Interfaces + LORE §5.2 的"随机抽取、抽完重置、暗线低频混入"）：
 *
 * 1. **抽完重置**：每 `cycleLen = 普通条数 + 本轮暗线条数` 次抽取为一轮。一轮之内普通碎片
 *    各出现一次（不重复）；轮末自动重置——下一轮照常出句（重新排一遍序），不会空转或卡死。
 * 2. **暗线低频混入（权重口径）**：`arc:true` 的条目每轮只混入 `max(1, round(暗线总权重))` 条。
 *    `ARC_WEIGHT = 0.25` ⇒ 3 条暗线的期望出现量 = 0.75 条/轮，取整为 1 条/轮。按 27 普通 +
 *    3 暗线的真实池算，暗线只占 **1/28 ≈ 3.6%** 的抽取，且三条暗线按轮次轮转（三轮各一次）。
 *    `max(1, …)` 是防空转下限：极小池子下暗线不该永不可见。
 * 3. **确定性排期**：落盘位 `settings.story.beatIndex` 只有**一个整数**，装不下整张抽序；
 *    故排期由 (池长, 轮次) 经 mulberry32 派生——同一 (池, 游标) 恒得同一句（可复现、可测），
 *    不同轮次重排 ⇒ 玩家不会看到一成不变的顺序。
 *
 * 游标语义：`next` 是**累计抽取数**（0 = 从未抽过），单调递增，**不是池内下标**。
 * 调用方把它写回 `settings.story.beatIndex`（app 侧写口见 src/app/storyState.ts）。
 * 负数/小数/NaN 游标按 0 处理（防御：UI 传进来的中间值不该让渲染炸掉；落盘位的严检在
 * validateSave，不在此处）。
 */
import { mulberry32 } from '@core/rng';

/** 池条目：裸字符串（普通碎片）或带 `arc` 标记的模板。 */
export interface BeatTemplate {
  readonly text: string;
  /** true = 暗线前奏（LORE §5.2：低频混入，指向"知识的影子"真相）。 */
  readonly arc?: boolean;
}

export type BeatEntry = string | BeatTemplate;

/** 一次抽取的结果。`text` 为空串只有一种情形：池是空的（防御契约，见 nextBeat）。 */
export interface BeatDraw {
  readonly text: string;
  /** 下一位游标（累计抽取数）。 */
  readonly next: number;
}

/**
 * 暗线前奏相对普通碎片的权重。普通碎片 = 1；0.25 ⇒ 每条暗线平均约 4 轮露一次面
 * （3 条合起来 ≈ 0.75 条/轮 ⇒ 取整后 1 条/轮 ⇒ 实际 ≈ 1/3 轮每条）。
 * 调这一个数就能调暗线的"神秘度"，文案池不必改。
 */
export const ARC_WEIGHT = 0.25;

/** 排期种子（固定值 ⇒ 跨会话可复现；与轮次混算后每轮换序）。 */
const ORDER_SEED = 0x9e3779b9 | 0;
const ARC_SLOT_SEED = 0x85ebca6b | 0;

function isArc(e: BeatTemplate): boolean {
  return e.arc === true;
}

/** 拆池：普通 / 暗线各保原序（`arc` 只认严格 true，JSON 里的缺省即普通碎片）。 */
function splitPool(pool: readonly BeatEntry[]): { normals: BeatTemplate[]; arcs: BeatTemplate[] } {
  const normals: BeatTemplate[] = [];
  const arcs: BeatTemplate[] = [];
  if (!Array.isArray(pool)) return { normals, arcs };
  for (const entry of pool) {
    if (entry === null || entry === undefined) continue;
    const tpl = typeof entry === 'string' ? { text: entry } : entry;
    if (typeof tpl.text !== 'string' || tpl.text.length === 0) continue;
    (isArc(tpl) ? arcs : normals).push(tpl);
  }
  return { normals, arcs };
}

/** 每轮混入的暗线条数：由权重解出的期望条数取整，下限 1（前提是池里确实有暗线）。 */
function arcsPerCycle(arcCount: number): number {
  if (arcCount <= 0) return 0;
  const expected = arcCount * ARC_WEIGHT; // 期望条数与普通条数无关：p·n/(1−p) ≡ 暗线总权重
  return Math.max(1, Math.min(arcCount, Math.round(expected)));
}

/** [0, n) 的确定性洗牌（mulberry32 + Fisher–Yates）；n ≤ 30 量级，代价可忽略。 */
function shuffled(n: number, seed: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  const rng = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function orderSeedFor(cycle: number): number {
  return (ORDER_SEED ^ Math.imul(cycle + 1, 0x27d4eb2d)) | 0;
}

function arcSlotSeedFor(cycle: number): number {
  return (ARC_SLOT_SEED ^ Math.imul(cycle + 1, 0x165667b1)) | 0;
}

/**
 * 造一轮的排期槽位（长度恰 = 普通条数 + 本轮暗线条数）：
 * 先按确定性洗牌选暗线槽位（去重），再按另一颗种子洗牌把普通碎片填满其余槽位。
 */
function scheduleFor(
  normals: readonly BeatTemplate[],
  arcs: readonly BeatTemplate[],
  cycle: number,
): BeatTemplate[] {
  const a = arcsPerCycle(arcs.length);
  const len = normals.length + a;
  const slots: (BeatTemplate | null)[] = new Array<BeatTemplate | null>(len).fill(null);
  if (a > 0) {
    const positions = shuffled(len, arcSlotSeedFor(cycle)).slice(0, a).sort((x, y) => x - y);
    for (let j = 0; j < positions.length; j++) {
      // 暗线轮转：第 cycle 轮取暗线池的第 (cycle + j) 条 ⇒ 三条暗线三轮各露一次。
      slots[positions[j]] = arcs[(cycle + j) % arcs.length] ?? null;
    }
  }
  const order = shuffled(normals.length, orderSeedFor(cycle));
  let k = 0;
  for (let i = 0; i < len; i++) {
    if (slots[i] === null) slots[i] = normals[order[k++]] ?? null;
  }
  return slots as BeatTemplate[];
}

/** 非负整数化游标：负数/小数/NaN/Infinity 一律按 0 处理。 */
function normalizeCursor(cursor: number): number {
  return Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
}

/**
 * 抽下一条战报碎片。空池返回 `{text:'', next: 游标原值}`（不推进——没有内容可"抽过"）。
 */
export function nextBeat(pool: readonly BeatEntry[], cursor: number): BeatDraw {
  const idx = normalizeCursor(cursor);
  const { normals, arcs } = splitPool(pool);
  if (normals.length === 0 && arcs.length === 0) return { text: '', next: idx };

  const cycleLen = Math.max(1, normals.length + arcsPerCycle(arcs.length));
  const cycle = Math.floor(idx / cycleLen);
  const offset = idx % cycleLen;

  const slots = scheduleFor(normals, arcs, cycle);
  const hit = slots[offset] ?? normals[0] ?? arcs[0];
  return { text: hit?.text ?? '', next: idx + 1 };
}
