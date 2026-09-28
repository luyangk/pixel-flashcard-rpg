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

/** 控制字符与"看起来像空白但不显示"的字符：一律剥掉（防屏上伪装/排版破坏）。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** 清洗一段文本：剥控制字符 → 折叠内部空白 → 去首尾 → 截断到上限。 */
function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(CONTROL_RE, ' ');
  const collapsed = stripped.replace(/[ \t\r\n]+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max).trim() : collapsed;
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

/** 解析卡片候选。`max` 缺省 CARDS_MAX。 */
export function parseCards(text: string, opts: { max?: number } = {}): ParseResult<CardCandidate> {
  const max = Number.isInteger(opts.max) && (opts.max as number) > 0 ? (opts.max as number) : CARDS_MAX;
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
    return { front, back, tags };
  });
}

/** 解析称号候选。 */
export function parseNames(text: string, opts: { max?: number } = {}): ParseResult<NameCandidate> {
  const max = Number.isInteger(opts.max) && (opts.max as number) > 0 ? (opts.max as number) : NAMES_MAX;
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
