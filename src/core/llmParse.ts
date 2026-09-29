/**
 * llmParse.ts —— Plan 5 · T1：**不可信模型输出**的严格解析（纯逻辑）。
 *
 * ## 为什么单独成文件、且逐字段严检
 * 模型返回的文本是**外部输入**：它可能被提示注入操纵、可能是半截 JSON、可能夹带超长内容或
 * 控制字符、也可能一次吐出上千条。本模块是"外部文本 → 可入库候选数据"之间**唯一**的闸门，
 * 判据必须可穷举（同 `saveMigrate.validateSave` 的思路）：
 * - 只接受 JSON 数组/对象；容忍 ```json 围栏与前后废话（**扫描配对括号**取第一段完整 JSON，
 *   而不是贪婪正则——正则会在嵌套与字符串里的括号上出错）；
 * - 字段逐项验类型与长度上限，剥控制字符（含零宽与方向控制符，它们能在屏上伪装文本）；
 * - 条数**封顶**并在返回值里如实申报"被截断"，不静默丢弃也不无限接收；
 * - 任何异常都收敛成 `{ok:false, reason}` —— 本模块**永不抛**（UI 拿它直接上屏）。
 *
 * 纪律：零 DOM、零平台 API、零时钟、零随机（`check:purity` 会拦）。
 */

/** 一张候选卡（尚未入库；入库由 UI 在玩家确认后走 library.addCard）。 */
export interface CardCandidate {
  readonly front: string;
  readonly back: string;
  readonly tags: readonly string[];
  /**
   * 干扰项（Plan 6 · D41）：**模型在生成这张卡的那一刻**产出的错误选项，随卡存进存档。
   * 复习时不再临时调模型 —— 这是"省额度"的关键，也是本字段存在的理由。
   * 缺席（旧模型/旧档）⇒ `[]`，由 choices.ts 回落到同领域其他卡的背面。
   */
  readonly choices: readonly string[];
}

/** 判卷结果（Plan 6 · T2）：对/错 + 一句话理由 + 缺了哪些要点。 */
export interface Verdict {
  readonly match: boolean;
  readonly reason: string;
  readonly missing: readonly string[];
}

/** 一个候选称号。 */
export interface NameCandidate {
  readonly name: string;
}

/** 候选结果面：`reason` 可直接上屏。 */
export type ParseResult<T> = { ok: true; value: T[]; truncated: boolean } | { ok: false; reason: string };

/** 长度与条数上限（超出即截断/拒绝——上限本身就是"不可信"的一部分）。 */
export const CARD_FIELD_MAX = 200;
export const TAG_MAX = 16;
export const TAGS_PER_CARD_MAX = 8;
export const CARDS_MAX = 20;
export const NAMES_MAX = 5;
export const EGG_MAX = 200;
/** 判卷理由/要点与卡片干扰项的条数、长度上限（Plan 6 · T2）。 */
export const VERDICT_REASON_MAX = 120;
export const VERDICT_MISSING_MAX = 5;
export const VERDICT_MISSING_TEXT_MAX = 60;
export const CHOICES_MAX = 5;
export const CHOICE_TEXT_MAX = 200;

/**
 * 不可见/可伪装字符的黑名单：**全仓唯一来源**（`app/codexFlow` 与 `app/bossFlow` 都从这里引）。
 *
 * 五族（T6 安全评审判 I-1：首版漏了三族，模型输出里本来就会自然带这些字符）：
 * 1. C0/C1 控制字符与 DEL；
 * 2. 零宽与段落分隔：U+200B–200F、U+2028/2029、U+FEFF(BOM)；
 * 3. **双向控制与隔离符**：U+202A–202E（覆盖）、U+2066–2069（LRI/RLI/FSI/PDI）——
 *    它们能重排屏幕上的显示顺序，是"看着是 A、存进去是 B"最顺手的工具；
 * 4. 不可见填充与软连字符：U+00AD、U+061C(ALM)、U+3164/U+FFA0(Hangul filler)、U+2060–2064；
 * 5. 行间注记：U+FFF9–FFFB。
 *
 * 口径：**一律替换成空格再折叠**（不是删除）——删除会把"两个词"拼成一个新词，
 * 替换成空格至少不改变分词结构。
 */
export const UNSAFE_CHARS_RE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb]/g;

/**
 * 清洗一段**外部文本**：剥不可见字符 → 折叠空白 → 去首尾 → 按码点封顶。
 * 导出供 app 层的写口复用（彩蛋/称号都走这里，避免"解析器与写口各有一份正则"的裂缝）。
 */
export function sanitizeExternalText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(UNSAFE_CHARS_RE, ' ');
  const collapsed = stripped.replace(/[ \t\r\n]+/g, ' ').trim();
  const points = [...collapsed];
  return points.length > max ? points.slice(0, max).join('').trim() : collapsed;
}

/**
 * 清洗一段文本（本模块内的简写）：实现见 `sanitizeExternalText`。
 * 按**码点**截断而不是 `.slice()`：后者按 UTF-16 单元切，会把 emoji/生僻字的代理对劈成
 * 两半，留下孤立代理字符写进存档（渲染成 "�"，且 `validateSave` 的类型检查看不出来）。
 */
function clean(raw: unknown, max: number): string {
  return sanitizeExternalText(raw, max);
}

/**
 * 从一段可能夹带废话的文本里取出**第一段完整的 JSON**（对象或数组）。
 *
 * 做法是扫描配对括号（把字符串字面量与转义也考虑进去），而不是 `/\{.*\}/s`：
 * 后者在"JSON 后面还有一段说明"时会把说明一起吃进来，导致解析失败；
 * 在"JSON 里有嵌套括号"时也可能截错。扫描是 O(n) 且对这两种情况都稳。
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: '模型没有返回内容。' };
  }
  const src = text;
  const start = src.search(/[[{]/);
  if (start < 0) return { ok: false, reason: '返回里没有找到 JSON 内容。' };

  const open = src[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = src.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(slice) as unknown };
        } catch (e) {
          return { ok: false, reason: `返回的 JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
        }
      }
    }
  }
  return { ok: false, reason: '返回的 JSON 不完整（括号没有配对）。' };
}

/** 候选数组的通用入口：取出 JSON → 必须是数组（或单对象视为长度 1）→ 逐项交给 mapper。 */
function parseArray<T>(
  text: string,
  max: number,
  what: string,
  mapper: (item: unknown) => T | null,
): ParseResult<T> {
  const extracted = extractJson(text);
  if (!extracted.ok) return extracted;
  const raw = extracted.value;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: T[] = [];
  for (const item of list) {
    const mapped = mapper(item);
    if (mapped !== null) out.push(mapped);
  }
  if (out.length === 0) return { ok: false, reason: `${what}一条可用的都没有（字段缺失或全是空的）。` };
  const truncated = out.length > max;
  return { ok: true, value: truncated ? out.slice(0, max) : out, truncated };
}

/**
 * 干扰项净化（**全仓唯一来源**：core 的解析与 `app/library.addCard` 都走它）。
 *
 * 口径：逐项 trim、剔空、去重、**剔除与正确答案逐字相同者**（否则选项里会出现答案本身），
 * 按码点截到 `CHOICE_TEXT_MAX`、条数截到 `CHOICES_MAX`。非数组 ⇒ `[]`。
 */
export function sanitizeChoices(raw: unknown, back: string): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const answer = typeof back === 'string' ? back.trim() : '';
  const out: string[] = [];
  for (const item of list) {
    const text = clean(item, CHOICE_TEXT_MAX);
    if (text.length === 0 || text === answer || out.includes(text)) continue;
    out.push(text);
    if (out.length >= CHOICES_MAX) break;
  }
  return out;
}

/** 解析卡片候选。`max` 缺省 CARDS_MAX。 */
export function parseCards(text: string, opts: { max?: number } = {}): ParseResult<CardCandidate> {
  // `opts` 可能是显式 null（默认参数只兜 undefined）——"永不抛"是文件头写下的契约，故 `?? {}`
  const o = opts ?? {};
  const max = Number.isInteger(o.max) && (o.max as number) > 0 ? (o.max as number) : CARDS_MAX;
  return parseArray<CardCandidate>(text, max, '卡片', (item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    const front = clean(o.front ?? o.question ?? o.q, CARD_FIELD_MAX);
    const back = clean(o.back ?? o.answer ?? o.a, CARD_FIELD_MAX);
    if (front.length === 0 || back.length === 0) return null; // 半截卡不如不要
    const tagsRaw = Array.isArray(o.tags) ? o.tags : [];
    const tags: string[] = [];
    for (const t of tagsRaw) {
      const tag = clean(t, TAG_MAX);
      if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= TAGS_PER_CARD_MAX) break;
    }
    return { front, back, tags, choices: sanitizeChoices(o.choices, back) };
  });
}

/**
 * 解析「重出选项」的返回（D56）：`{"choices":[…]}` → 消毒后的选项数组。
 *
 * 返回形状与 `parseVerdict` 同款（**不用** `ParseResult`：那边是"一组条目"，
 * 这里是"一个对象里的一个数组"，硬套 `value: T[]` 只会多一层无意义的嵌套）。
 * 一条都消毒不出来（缺字段 / 全是答案本身 / 全是脏项）⇒ **失败**：
 * 调用方要能如实说"这次没重出成功"，而不是把这张卡的干扰项静默清空。
 */
export function parseChoices(
  text: string,
  back: string,
): { ok: true; choices: string[] } | { ok: false; reason: string } {
  const fail = { ok: false as const, reason: '没能读懂模型给的选项。' };
  if (typeof text !== 'string') return fail;
  const extracted = extractJson(text);
  if (!extracted.ok) return fail;
  const raw = extracted.value;
  const container = Array.isArray(raw) ? raw[0] : raw; // 有的模型会把对象包进数组
  if (container === null || typeof container !== 'object') return fail;
  const choices = sanitizeChoices((container as Record<string, unknown>).choices, back);
  if (choices.length === 0) return fail;
  return { ok: true, choices };
}

/** 解析称号候选。 */
export function parseNames(text: string, opts: { max?: number } = {}): ParseResult<NameCandidate> {
  const o = opts ?? {};
  const max = Number.isInteger(o.max) && (o.max as number) > 0 ? (o.max as number) : NAMES_MAX;
  return parseArray<NameCandidate>(text, max, '称号', (item) => {
    if (typeof item === 'string') {
      const name = clean(item, 30);
      return name.length > 0 ? { name } : null;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    const name = clean(o.name ?? o.title, 30);
    return name.length > 0 ? { name } : null;
  });
}

/**
 * 解析判卷结果（Plan 6 · T2）。
 *
 * `match` **必须是布尔**：模型偶尔会回 `"true"` / `1` / `"yes"`，而这里刻意**不做**字符串嗅探
 * ——判"答对"是一件会写进复习账本的事，宁可让它回落成"没判成，你自己定对错"，
 * 也不能靠 `includes('true')` 把 `{"match":"not true"}` 读成答对。
 * `missing` 只接受字符串数组（缺失/其它类型 ⇒ `[]`，不因此拒绝整条判定），
 * 逐项去重、剔空、≤5 条、每条 ≤60 码点。**永不抛**。
 */
export function parseVerdict(text: string): { ok: true; value: Verdict } | { ok: false; reason: string } {
  const fail = { ok: false as const, reason: '没能读懂模型的判定结果。' };
  if (typeof text !== 'string') return fail;
  const extracted = extractJson(text);
  if (!extracted.ok) return fail;
  const raw = extracted.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail;
  const o = raw as Record<string, unknown>;
  if (typeof o.match !== 'boolean') return fail;

  const reason = clean(o.reason, VERDICT_REASON_MAX);
  const missing: string[] = [];
  if (Array.isArray(o.missing)) {
    for (const m of o.missing) {
      const item = clean(m, VERDICT_MISSING_TEXT_MAX);
      if (item.length === 0 || missing.includes(item)) continue;
      missing.push(item);
      if (missing.length >= VERDICT_MISSING_MAX) break;
    }
  }
  return { ok: true, value: { match: o.match, reason, missing } };
}

/**
 * 解析彩蛋正文：模型可能直接给一段自然语言（这是**唯一**允许非 JSON 的入口，
 * 因为它本来就是一段文本）。仍然剥控制字符、折叠空白、封顶长度。
 */
export function parseEgg(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof text !== 'string') return { ok: false, reason: '模型没有返回内容。' };
  // 若模型"多此一举"包了 JSON，就把里面的 text/egg 字段取出来
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const extracted = extractJson(trimmed);
    if (extracted.ok && extracted.value !== null && typeof extracted.value === 'object') {
      const o = extracted.value as Record<string, unknown>;
      const inner = clean(o.text ?? o.egg ?? o.content, EGG_MAX);
      if (inner.length > 0) return { ok: true, text: inner };
      // 长得像 JSON 却取不到正文 ⇒ **拒绝**，不要把 JSON 原文当彩蛋（安全评审判 m-4）：
      // 那会把 `{"error":"..."}` 之类的机器串写进图鉴，玩家看到的是一段乱码。
      return { ok: false, reason: '返回的 JSON 里没有正文（text 字段）。' };
    }
  }
  const body = clean(
    trimmed
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```$/, '')
      .replace(/^\s*(彩蛋|图鉴彩蛋)[:：]\s*/, ''),
    EGG_MAX,
  );
  if (body.length === 0) return { ok: false, reason: '模型没有给出可用的内容。' };
  return { ok: true, text: body };
}
