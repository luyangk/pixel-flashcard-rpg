/**
 * choices.ts —— Plan 6 · T1：选择题生成（纯逻辑）。
 *
 * ## 为什么在这一层
 * 出选择题要"凑干扰项 + 洗牌 + 截断标签"，这三件事全是纯计算：不读时钟、不碰 DOM、
 * 不调网络 ⇒ 放在 core 可以用注入的 rng 把"顺序确实被打乱""标签确实互不相同"这类
 * 性质逐条钉住（UI 层测不了这些）。
 *
 * ## 选项从哪儿来（D41 的三级来源，顺序不能换）
 * 1. `stored` —— **卡上自带的 `choices`**：模型在**生成这张卡那一刻**产出的干扰项，
 *    随卡存进存档。复习时**不再调模型**（省额度、也省等待）——这是本模块存在的首要理由；
 * 2. `pool` —— 同领域其他卡的背面 + 它们自带的 `choices`（本地、即时、零消耗，
 *    且选项组合会随卡库变化，避免同一张卡每次都看到完全相同的三个干扰项）；
 * 3. 都不够就**少给选项**（2–3 个）；一个干扰项都凑不出 ⇒ `null`，由调用方回落"看答案"。
 *
 * ## 标签为什么要单独算
 * 屏上显示的是**截断后的预览**（长答案的四个选项会把战斗舞台挤没），但玩家必须能区分它们：
 * 若两个选项的前 40 字相同，先截断就会变成"两个一模一样的选项"（连正确答案都认不出来）。
 * 因此 `labels` 在截断后会**逐字加长**直到互不相同，且截断一律按**码点**（不能切坏代理对）。
 */

import type { Rng } from './rng';

/** 目标选项总数（含正确项）的默认值与合法域。 */
export const CHOICE_COUNT_DEFAULT = 4;
export const CHOICE_COUNT_MIN = 2;
export const CHOICE_COUNT_MAX = 6;
/** 屏上预览的码点上限（超出追加省略号）。 */
export const CHOICE_LABEL_MAX = 40;

export interface ChoiceSet {
  /** 已洗牌的选项全文；`options[correctIndex]` 恒等于传入的 `answer`（trim 后）。 */
  readonly options: readonly string[];
  /** 与 `options` 一一对应的**屏上预览**：截断且互不相同。 */
  readonly labels: readonly string[];
  /** 正确项在 `options` / `labels` 中的下标。 */
  readonly correctIndex: number;
}

/** 非空字符串（trim 后）判定——脏输入一律先过这道闸。 */
function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** 目标选项数：域外/非整数一律回落默认（与 deckBuild.isPositiveInt 同款"先消毒再判断"）。 */
function normalizeCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isInteger(count)) return CHOICE_COUNT_DEFAULT;
  if (count < CHOICE_COUNT_MIN || count > CHOICE_COUNT_MAX) return CHOICE_COUNT_DEFAULT;
  return count;
}

/**
 * 码点安全截断 + 省略号。`max` 为码点上限（含省略号占位）：返回文本的码点数 ≤ max。
 * 域外 `max` 回落 `CHOICE_LABEL_MAX`。
 */
export function previewLabel(text: string, max: number = CHOICE_LABEL_MAX): string {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) return '';
  const limit = typeof max === 'number' && Number.isFinite(max) && max >= 2 ? Math.floor(max) : CHOICE_LABEL_MAX;
  const cps = Array.from(raw); // 按码点切分：代理对不会被切开
  if (cps.length <= limit) return raw;
  return `${cps.slice(0, limit - 1).join('')}…`;
}

/** Fisher–Yates（对副本操作；不用 Math.random —— core 层只接受注入的 rng）。 */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    // rng 约定返回 [0,1)；域外（NaN/负数/≥1）时 j 可能越界 ⇒ 钳到合法区间，永不产出 undefined
    const k = j >= 0 && j <= i ? j : 0;
    const tmp = out[i];
    out[i] = out[k];
    out[k] = tmp;
  }
  return out;
}

/**
 * 由候选列表凑出干扰项：逐项 trim、剔空、去重（按 trim 后的文本），并剔除两类别项：
 * 1. 与正确答案**逐字相同**者；
 * 2. **截断预览与已有选项相同**者（见 `buildLabels` 的说明）——撞车的干扰项直接不要，
 *    宁可少一个选项，也不显示两个"看起来一模一样"的选项。
 * `stored` 先用，不够再用 `pool` 补（补的过程中继续去重）。
 */
function pickDistractors(
  answer: string,
  stored: readonly string[] | undefined,
  pool: readonly string[] | undefined,
  want: number,
  rng: Rng,
): string[] {
  const seenText = new Set<string>([answer]);
  const seenLabel = new Set<string>([previewLabel(answer)]);
  const candidates: string[] = [];
  for (const list of [stored, pool]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const t = nonEmpty(raw);
      if (t === null || seenText.has(t)) continue;
      const label = previewLabel(t);
      if (label.length === 0 || seenLabel.has(label)) continue;
      seenText.add(t);
      seenLabel.add(label);
      candidates.push(t);
    }
  }
  return shuffle(candidates, rng).slice(0, Math.max(0, want));
}

/**
 * 屏上预览：逐项截断。
 *
 * **为什么不做"撞车就加长"**：若两个选项前 40 字相同，加长到能区分意味着预览变成 60+ 字 ——
 * 那正好把"截断是为了让四个选项在一屏内看清"这个初衷抵消掉。所以撞车在**挑干扰项时**就解决：
 * 预览标签相同的干扰项直接不要（`pickDistractors`），于是这里产出的标签天然互不相同、
 * 且每个都 ≤ `CHOICE_LABEL_MAX`。代价是选项数可能少一个（2–3 个），如实反映"这些答案在屏上分不清"。
 */
function buildLabels(options: readonly string[], max: number): string[] {
  return options.map((o) => previewLabel(o, max));
}

/**
 * 生成一张卡的选择题。返回 `null` = **凑不出干扰项**（由调用方回落"直接看答案"并说明原因）。
 * 永不抛异常。
 */
export function buildChoices(input: {
  readonly answer: string;
  readonly stored?: readonly string[];
  readonly pool?: readonly string[];
  readonly count?: number;
  readonly rng: Rng;
}): ChoiceSet | null {
  const answer = nonEmpty(input?.answer);
  if (answer === null) return null;

  const count = normalizeCount(input?.count);
  const rng: Rng = typeof input?.rng === 'function' ? input.rng : () => 0;
  const distractors = pickDistractors(answer, input?.stored, input?.pool, count - 1, rng);
  if (distractors.length === 0) return null; // 只有正确答案 ⇒ 不是选择题

  const options = shuffle([answer, ...distractors], rng);
  const correctIndex = options.indexOf(answer);
  if (correctIndex < 0) return null; // 不可达（answer 只进一次），防御性兜底
  return { options, labels: buildLabels(options, CHOICE_LABEL_MAX), correctIndex };
}
