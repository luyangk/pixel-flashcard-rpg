/**
 * sourceItem.ts —— 采新卡「来源库」的纯逻辑（D53）。
 *
 * 这一层只管**一条内容长什么样**：归一化、上限、去重、排序，以及"这条内容该怎么用"
 * （响应里带了正文就直接生成，只给了链接就去抓页面）。不认识网络、不认识 DOM、不认识存储。
 *
 * ## 为什么要有一层"归一化"
 * 8 个源的响应形状各不相同（RSS / Atom / 四家 JSON API），但屏上要的东西永远一样：
 * 标题、链接、时间、一段正文、一行补充信息。把"形状差异"关在 platform 的解析器里，
 * 把"什么算可用"钉在这里 —— 于是"某家 API 换字段"只会红一条解析测试，不会污染 UI 逻辑。
 */

/** 支持的源类型（每一种对应 platform 里的一个解析器）。 */
export type SourceKind = 'rss' | 'hn' | 'hf-papers' | 'hf-models' | 'gh-releases' | 'gh-org-repos';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'rss',
  'hn',
  'hf-papers',
  'hf-models',
  'gh-releases',
  'gh-org-repos',
];

export const KIND_LABEL: Readonly<Record<SourceKind, string>> = {
  rss: 'RSS / Atom',
  hn: 'Hacker News（Algolia）',
  'hf-papers': 'HF Daily Papers',
  'hf-models': 'HF 热门模型',
  'gh-releases': 'GitHub Releases',
  'gh-org-repos': 'GitHub 组织仓库',
};

/** 一个来源（内置或玩家自己加的）。 */
export interface SourceDef {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly kind: SourceKind;
  /**
   * 浏览器能不能**直连读到**（实测响应里有 ACAO）。`false` 的源在屏上必须打「需读取服务」的标，
   * 否则玩家点下去只会看到一个"点了报错"的入口 —— 见 `docs/SOURCES.md` 的实测表。
   */
  readonly direct: boolean;
  /** 覆盖什么内容（给玩家一句话）。 */
  readonly note?: string;
}

/** 一个领域（一组来源）。以后加领域 = 再加一组。 */
export interface SourceDomain {
  readonly id: string;
  readonly name: string;
  readonly sources: readonly SourceDef[];
}

/** 解析器交出来的原始一条（还没消毒）。 */
export interface SourceItemDraft {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly title: string;
  readonly url: string;
  readonly dateMs: number;
  /** **随响应一起回来的正文**（摘要 / 更新说明）；空串 ⇒ 只能去抓页面。 */
  readonly text: string;
  /** 一行补充信息（分数、下载量、★ 等），屏上显示在标题后。 */
  readonly extra?: string;
  /**
   * **全文地址**（D61，可选）：能拿到全文时填（例：论文的 arXiv HTML 版）。
   * 有了它，屏上就多一个「取全文再出卡」——摘要装不下主线与步骤，全文才装得下。
   */
  readonly fullTextUrl?: string;
}

/** 消毒后的一条（屏上用这个）。 */
export interface SourceItem {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly title: string;
  readonly url: string;
  readonly dateMs: number;
  readonly text: string;
  readonly extra: string;
  /** **全文地址**（D61）：有它才显示「取全文再出卡」；没有就不显示（不假装能取）。 */
  readonly fullTextUrl?: string;
}

/** 标题上限（码点）。 */
export const ITEM_TITLE_MAX = 160;
/** 正文上限（码点）：与 paste/ingest 的口径一致，超出的由 app 层分块。 */
export const ITEM_TEXT_MAX = 12_000;
/** 一次最多列多少条（再多也不看）。 */
export const ITEMS_MAX = 20;
/**
 * 少于这么多字就没必要"直接生成"：模型拿一句标题只能编，不如去抓原文。
 * 200 是实测出来的分界（HF 摘要 1500+ 字、GitHub 更新说明数万字；HN 只有标题）。
 */
export const MIN_INLINE_TEXT = 200;

/** 码点安全截断（不切断代理对）。 */
function clip(text: string, max: number): string {
  const s = String(text ?? '');
  const cp = Array.from(s);
  return cp.length <= max ? s : cp.slice(0, max).join('');
}

/** 折叠空白（RSS 的 description 常带换行与缩进）。 */
function squeeze(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 解析时间。**只认带时区的写法**（ISO 的 `Z`/`±hh:mm`、RFC822 的 `GMT`/`UTC`）：
 * 不带时区的 `2026-09-22T05:20:54` 在不同设备上会被当成不同的本地时间 ⇒ 排序会飘，
 * 那种输入一律回 0（"没有日期"，排在最后），宁可不知道也不要猜。
 */
export function parseDateMs(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (s.length < 10) return 0;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(s);
  if (!hasZone) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** 只接受 http(s) 链接（feed 里偶有 `javascript:` 或相对路径，那都不能当"用这篇"的目标）。 */
export function usableUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (s.length === 0) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return clip(s, 2_000);
}

/** 一条内容的主键（去重按它：同一个链接只留最新的一条）。 */
export function itemKeyOf(draft: { readonly url: string }): string {
  return String(draft?.url ?? '').trim().toLowerCase();
}

/** 消毒一条：没有标题或没有可用链接 ⇒ `null`（这种条目点了也没用，不如不显示）。 */
export function normalizeItem(draft: SourceItemDraft): SourceItem | null {
  if (!draft || typeof draft !== 'object') return null;
  const url = usableUrl(draft.url);
  if (url === null) return null;
  const title = clip(squeeze(draft.title), ITEM_TITLE_MAX);
  if (title.length === 0) return null;
  const dateMs = Number.isFinite(draft.dateMs) && draft.dateMs > 0 ? draft.dateMs : 0;
  return {
    id: itemKeyOf({ url }),
    sourceId: String(draft.sourceId ?? ''),
    sourceName: clip(squeeze(draft.sourceName), 60),
    title,
    url,
    dateMs,
    text: clip(String(draft.text ?? '').trim(), ITEM_TEXT_MAX),
    extra: clip(squeeze(draft.extra ?? ''), 60),
    ...(usableUrl(draft.fullTextUrl) === null ? {} : { fullTextUrl: usableUrl(draft.fullTextUrl) as string }),
  };
}

/**
 * 一批候选 → 可用清单：逐条消毒 → 按链接去重（保留先出现的）→ 新的在前 → 截到上限。
 *
 * 排序口径：有日期的按时间倒序；**没日期的排在有日期的后面**（不能因为它们 dateMs=0
 * 就冒到最前面 —— 那会让"今天的论文"被一堆无日期条目顶下去）。
 */
export function prepareItems(drafts: readonly SourceItemDraft[], max: number = ITEMS_MAX): SourceItem[] {
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const d of Array.isArray(drafts) ? drafts : []) {
    const item = normalizeItem(d);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  items.sort((a, b) => {
    if (a.dateMs === 0 && b.dateMs === 0) return 0;
    if (a.dateMs === 0) return 1;
    if (b.dateMs === 0) return -1;
    return b.dateMs - a.dateMs;
  });
  const cap = Number.isInteger(max) && max > 0 ? max : ITEMS_MAX;
  return items.slice(0, cap);
}

/**
 * 这条内容该怎么用？
 * - 响应里带了够长的正文（HF 摘要 / GitHub 更新说明）⇒ `text` 模式：**直接用**，
 *   根本不去抓页面（绕开 CORS —— 那些站的网页本身没有 ACAO，API 才有）；
 * - 只有标题与链接（HN 头条、HF 模型、GitHub 仓库）⇒ `url` 模式：走既有的抓取管线，
 *   抓不到时既有界面会把"复制原文"的下一步递到玩家手里。
 */
export function planIngest(item: SourceItem): { readonly mode: 'text'; readonly text: string } | { readonly mode: 'url'; readonly url: string } {
  if (item.text.length >= MIN_INLINE_TEXT) return { mode: 'text', text: item.text };
  return { mode: 'url', url: item.url };
}

/** 校验玩家手填的一个源（名称 / 链接 / 类型）。 */
export function validateSourceInput(input: {
  readonly name?: unknown;
  readonly url?: unknown;
  readonly kind?: unknown;
  readonly direct?: unknown;
}): { readonly ok: true; readonly value: SourceDef } | { readonly ok: false; readonly reason: string } {
  const name = squeeze(input?.name ?? '').slice(0, 40);
  if (name.length === 0) return { ok: false, reason: '给它起个名字吧。' };
  const url = usableUrl(input?.url);
  if (url === null) return { ok: false, reason: '链接要写成 http(s):// 开头的完整地址。' };
  const kind = String(input?.kind ?? '') as SourceKind;
  if (!SOURCE_KINDS.includes(kind)) return { ok: false, reason: '类型只能是 RSS 或那几种 API。' };
  return {
    ok: true,
    value: {
      id: `user:${itemKeyOf({ url })}`,
      name,
      url,
      kind,
      // 玩家自己加的源一律标"未核实直连"：我们没替他量过 ACAO，界面按"需要读取服务"对待，
      // 真抓通了也照常工作（direct 只影响那句提示，不影响能不能读）。
      direct: input?.direct === true,
      note: '自己加的源',
    },
  };
}
