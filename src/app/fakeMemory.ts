/**
 * fakeMemory.ts —— Plan 3 · T6 假记忆素材池（LORE §5.5「假记忆注入」规则引擎）。
 *
 * 叙事位置：卡池耗尽未杀敌 → 战斗界面短暂闪现 1–2 张**篡改版卡面**（答案被改成
 * 似是而非的错误内容）→ 随即打叉揭示"假的。幸好你没记住它。"本模块是这出**战败演出**
 * 的素材生成器：给一批真卡，产出可渲染的篡改面。
 *
 * **纯演出，零数值后果**（LORE §5.5 明令）：不修改任何 SRS 数据、不冻结计数、
 * 不落盘、不改动入参——本模块全部为纯函数，随机源一律注入（全局约束：禁 Math.random）。
 * 重试时敌人保持原样，这里也保持卡池原样。
 *
 * 四条硬契约：
 * - **不含真答案**：tamperedBack 恒 ≠ 原 back。两处细节保证它：数字位移在 10^位数
 *   上取模（位移量 1..9 永不等于 0），词替换拒绝恒等/空串映射。
 * - **front 保真**：只篡改答案面，问题面逐字照搬——玩家先认出这张卡，再被答案惊到。
 * - **分寸**（LORE §5.5「一眼像错的，细想有点慌」）：位移只有 ±1..9，且**保持位数外观**；
 *   给出的是"6秒≈30万公里"这类近乎可信的错，而不是"6000秒"这类一眼荒谬或
 *   "1秒≈30万公里"这类根本没改。
 * - **确定性**：同 seed 同输出。
 *
 * ## tamperNumber 的数值口径（brief 只写"±1~9 扰动、保持位数外观"，此处钉死）
 * 1. 匹配 `back` 中第一个 `/\d+/`（最长连续数字串）。**负号不在 `\d` 内**，故符号位
 *    原样保留、只扰动绝对值——不会产出 `--7` 这类畸形。
 * 2. 位移量 `mag = 1 + floor(uniform(rng, 0, 9))` ∈ 1..9；方向 `rng() < 0.5 ? -1 : +1`。
 *    调用顺序即"先幅度后方向"，是确定性序列的一部分。
 * 3. 结果在 `10^width` 上取模回绕（width = 数字串长度）。这既是"保持位数外观"的
 *    定义（"9"+9 → "8" 而非两位的 "18"），也天然保证结果 ≠ 原值（1..9 位移在 mod 10^k
 *    下不可能是 0）。原串带前导零时按宽度补零回写（"007" → "006"）。
 * 4. **小数/百分号**：只替换首个数字串，`.14`、`%` 等后缀逐字保留（"3.14%" → "2.14%"）。
 *    因此"改的是这个数字本身，不是它的量纲"——正是"细想有点慌"的来源。
 * 5. 大整数用 BigInt 运算，避免 Number 精度丢失破坏位数外观。
 * 6. **无可替换数字 → null**，且**不调用 rng**（降级路径不偷走随机序列，调用方
 *    pickFakes 的序列因此与池内容无关地稳定）。
 *
 * ## tamperWord 的口径
 * 表内**字面**查找（indexOf，非正则——键含 `+`/`(` 等元字符也按原样匹配），
 * 命中项按 Map 插入序收集，再由注入 rng 经 `pickWeighted` 等权选一个，替换其**首个**
 * 出现处。跳过空串键（`indexOf('')` 恒命中，会产出整段挪位的伪篡改）与恒等映射
 * （from === to，会产出"假记忆 === 真答案"）。无有效命中 → null。
 *
 * 文案纪律：本模块产出的是**卡面篡改内容**（演出素材），不是叙事文本也不是功能文本，
 * 故不新造文案，只做真答案的规则变换（LORE §5.5 允许的两条来源之一）。
 */

import type { Card } from '@core/types';
import { pickWeighted, uniform, type Rng } from '@core/rng';

/** 一条可渲染的假记忆（brief Produces 逐字对齐）。 */
export interface FakeCard {
  id: string;
  realCardId: string;
  front: string;
  tamperedBack: string;
  rule: 'number-shift' | 'word-swap';
}

/** 数字位移的最小/最大幅度（brief：±(1..9)）。 */
const MIN_SHIFT = 1;
const MAX_SHIFT = 9;

/**
 * 逐字段搬运真卡，只换答案面。id 由"真卡 id + 规则"派生——确定性、且在一批素材内
 * 唯一（pickFakes 保证同一张真卡不重复登场），可直接作渲染 key。
 */
function toFake(card: Card, rule: FakeCard['rule'], tamperedBack: string): FakeCard {
  return {
    id: `${card.id}#${rule}`,
    realCardId: card.id,
    front: card.front,
    tamperedBack,
    rule,
  };
}

/**
 * 数字规则：把 back 里第一个数字做 ±(1..9) 位移，保持位数外观（口径见文件头）。
 * 无可替换数字返回 null。**无数字时在调用 rng 之前就返回**。
 */
export function tamperNumber(card: Card, rng: Rng): FakeCard | null {
  const hit = /\d+/.exec(card.back);
  if (hit === null) return null;

  const width = hit[0].length;
  const orig = BigInt(hit[0]);
  const span = 10n ** BigInt(width);

  const magnitude = BigInt(MIN_SHIFT + Math.floor(uniform(rng, 0, MAX_SHIFT - MIN_SHIFT + 1)));
  const sign = rng() < 0.5 ? -1n : 1n;

  const shifted = (orig + sign * magnitude) % span;
  const next = shifted < 0n ? shifted + span : shifted;

  const rendered = next.toString().padStart(width, '0');
  const tamperedBack =
    card.back.slice(0, hit.index) + rendered + card.back.slice(hit.index + width);

  return toFake(card, 'number-shift', tamperedBack);
}

/** 一条可用替换：按键出现位置无关，只记首个命中处与替换词。 */
interface WordHit {
  readonly from: string;
  readonly to: string;
  readonly at: number;
}

/**
 * 词表规则：命中则换（近义/反义由词表作者决定），未命中返回 null（口径见文件头）。
 */
export function tamperWord(
  card: Card,
  table: ReadonlyMap<string, string>,
  rng: Rng,
): FakeCard | null {
  const hits: WordHit[] = [];
  for (const [from, to] of table) {
    if (from.length === 0 || from === to) continue; // 空串键/恒等映射不算篡改
    const at = card.back.indexOf(from);
    if (at >= 0) hits.push({ from, to, at });
  }
  if (hits.length === 0) return null;

  // 等权抽取：以 pickWeighted 承担"选哪一个"（上游原语复用，避免自造选择逻辑）
  const chosen = pickWeighted(rng, hits, () => 1);
  if (chosen === null) return null;

  const tamperedBack =
    card.back.slice(0, chosen.at) + chosen.to + card.back.slice(chosen.at + chosen.from.length);

  return toFake(card, 'word-swap', tamperedBack);
}

/**
 * 从池里凑一场战败演出的素材：**依序**尝试 number-shift → word-swap，凑不满 `count`
 * 就少产（LORE §5.5 容忍 1–2 张；此处不循环硬凑、不重复用同一张真卡）。
 *
 * 池按数组顺序扫描，每张真卡至多贡献一条素材：
 * - 数字卡命中数字规则即收；无数字（或数字规则无解）的卡降级走词表；两规则皆无解则跳过
 *   该卡继续看下一张——因此**产出条数取决于池内容**，调用方需按实际返回长度渲染。
 * - `count` 非有限（NaN/Infinity）或 ≤ 0 → 空数组；小数向下取整。
 * - 入参 `pool` 只读，不被修改（LORE：零数值后果）。
 */
export function pickFakes(
  pool: readonly Card[],
  count: number,
  deps: { rng: Rng; wordTable: ReadonlyMap<string, string> },
): FakeCard[] {
  const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const fakes: FakeCard[] = [];
  for (const card of pool) {
    if (fakes.length >= wanted) break;
    const fake = tamperNumber(card, deps.rng) ?? tamperWord(card, deps.wordTable, deps.rng);
    if (fake !== null) fakes.push(fake);
  }
  return fakes;
}
