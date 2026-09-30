/**
 * feedFetch.ts —— 采新卡「来源库」的网络出口（D53）。
 *
 * ## 与 `pageFetch` 的分工
 * - `pageFetch`：抓**一篇文章的网页**（HTML），玩家给什么链接就抓什么；
 * - `feedFetch`：读**一个来源的最新条目**（RSS/Atom 或那几种 JSON API）。它不猜、不抓页面，
 *   只按源声明好的 `kind` 走对应解析器 —— 解析器认不出形状就如实回 `ok:false`。
 *
 * ## 两条硬口径
 * 1. **CORS 拦下来就是拦下来**：`fetch` 抛 `TypeError` 一律翻成 `blocked:true`
 *    （与 pageFetch 同款翻译），UI 据此把"下一步"递给玩家（配读取服务 / 打开原文去复制）。
 * 2. **不注入任何东西**：这就是个 GET，不带 cookie、不带凭据、不带 Key。读取服务那条路**不在这里**——
 *    它是 `ingestFlow` 的兜底，只作用于"抓某一篇文章"，不作用于订阅源。
 *
 * ## 解析放这儿，消毒放 core
 * 形状差异（RSS 的 `<item>` vs Atom 的 `<entry>` vs 四家 JSON）关在本文件里；
 * "什么算可用的一条"由 `core/sourceItem` 的 `normalizeItem` 决定。于是某家 API 改字段
 * 只会红一条解析测试，不会渗进 UI 逻辑。
 */
import type { SourceDef, SourceItemDraft } from '@core/sourceItem';
import { parseDateMs, usableUrl } from '@core/sourceItem';
import type { FetchLike } from './llmTypes';

/** 订阅源的超时（比文章短：它就是个 XML/JSON）。 */
export const FEED_TIMEOUT_MS = 15_000;
/**
 * 走**读取服务**时的超时预算（D62）：比直读宽 —— 那一头要先渲染整页再回传，
 * 比直接抓 API 慢得多；给它 25 秒，别让玩家以为卡死了。
 */
export const READER_TIMEOUT_MS = 25_000;
/**
 * 订阅源体积上限 3MB：实测 arXiv 每日 700KB、Latent.space 1.4MB、OpenAI 750KB，
 * 留一倍余量；再大就不是"清单"而是数据转储了。
 */
export const FEED_MAX_BYTES = 3_000_000;
/**
 * 文本清单（RSS / HTML）**解析前**的截断上限（D62）。
 *
 * 为什么不是直接拒绝：清单动辄几百 KB（arXiv 的每日列表就是），而我们要的只是**最新的那几条** ——
 * 全篇解析既慢又占内存，还可能因为一条畸形条目解析失败。截断到前 512 KB 足够覆盖排在
 * 前面的最新条目（列表本来就是新的在前），出问题的尾部本来就轮不到。
 */
export const FEED_PARSE_MAX_BYTES = 512_000;

export type FetchSourceResult =
  | {
      readonly ok: true;
      readonly items: readonly SourceItemDraft[];
      /** `'direct'` = 直读；`'reader'` = 经玩家配置的读取服务兜底（D55）。 */
      readonly via: 'direct' | 'reader';
      /**
       * 清单太长、解析前截断了（D62）。
       * 如实告诉玩家"只解析了前 512 KB" —— 否则"怎么只有这几条"看起来像 Bug。
       */
      readonly truncatedForParse?: boolean;
      /**
       * 这份结果是**会话内缓存**（D62）：没有真的再读一次，也就没有再花钱。
       * 屏上要如实说明 —— 玩家以为"刚读过一次怎么这么快"，会怀疑是不是坏了。
       */
      readonly cached?: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly blocked: boolean;
      /** 这一次**试过**读取服务没有 —— UI 据此决定要不要再说"去配一个读取服务"（D55）。 */
      readonly readerTried: boolean;
    };

export interface FetchSourceDeps {
  /** 注入位（测试用假 fetch；生产不传）。 */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** 读取服务的超时预算（缺省 `READER_TIMEOUT_MS`；两条路各算各的）。 */
  readonly readerTimeoutMs?: number;
  /**
   * 外部取消信号（D62：屏上的「取消」按钮）。传进来后，这个请求会随它一起被掐断，
   * 结果如实回 `已取消`（不是"失败"，也不是假装读到了）。
   */
  readonly signal?: AbortSignal;
  /**
   * 玩家可选的**读取服务**（缺省 = 不启用）。
   *
   * 为什么订阅源也要走它：实测 15 个源里 11 个"可达但没有 ACAO"（`docs/SOURCES.md`），
   * 浏览器直连一律读不到 —— 而这些源恰恰是玩家最想要的（OpenAI / DeepMind / arXiv）。
   * 读取服务是"把链接发给第三方"这条账，玩家自己开（设置页如实写了）。
   */
  readonly reader?: { readonly url: string; readonly key: string };
}

/** 状态码 → 人话（不含响应体、不含 Key）。 */
function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return `这个源拒绝了访问（${status}）。`;
  if (status === 404) return '这个源的地址打不开（404）——端点可能变了。';
  if (status === 429) return '这个源限流了（429）——它对外部请求不友好，等一会儿或换一个源。';
  if (status >= 500) return `这个源那边出故障了（${status}）。`;
  return `这个源返回了 ${status}。`;
}

/** 去标签 + 解实体 + 折叠空白（RSS 的 description/summary 常带 HTML）。 */
export function plainText(raw: unknown): string {
  const s = String(raw ?? '');
  if (s.length === 0) return '';
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 一个解析器的产物：只有标题与链接是必需的，其余给空。 */
type ParsedItem = Omit<SourceItemDraft, 'sourceId' | 'sourceName'>;

/**
 * 由 HF 论文 id 推出 arXiv 的 **HTML 全文**地址（D61）。
 *
 * 为什么能这么推：HF Daily Papers 的 `paper.id` 就是 arXiv 编号（如 `2609.32704`）。
 * 为什么优先 HTML：arXiv 从 2023 年底起为多数论文提供 HTML 版（`/html/<id>`），
 * 比 PDF 好解析得多；取不到时调用方会如实回落到摘要。
 */
function arxivHtmlUrl(paperId: string): string | undefined {
  const id = paperId.trim();
  if (!/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) return undefined;
  return `https://arxiv.org/html/${id}`;
}

/* ------------------------------------------------------------------ XML（RSS / Atom） */

/**
 * 取一个标签的**内容**（含 CDATA）。`[\s\S]*?` 非贪婪，够用且不会跨条目 ——
 * 我们只在已经切好的单个条目块里找子标签。
 */
function tagText(block: string, names: readonly string[]): string {
  for (const name of names) {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(block);
    if (m && m[1] !== undefined) return m[1];
  }
  return '';
}

/** Atom 的链接在属性里：优先 `rel="alternate"`，其次第一个带 href 的 `<link>`。 */
function atomHref(block: string): string {
  const links: string[] = [];
  const re = /<link\b([^>]*)\/*>/gi;
  let m: RegExpExecArray | null = re.exec(block);
  while (m !== null) {
    const attrs = m[1] ?? '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    if (href.length > 0) {
      const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? 'alternate';
      links.push(`${rel}\u0000${href}`);
    }
    m = re.exec(block);
  }
  const alt = links.find((l) => l.startsWith('alternate\u0000'));
  const pick = alt ?? links[0];
  return pick === undefined ? '' : pick.slice(pick.indexOf('\u0000') + 1);
}

/**
 * 解析 RSS 2.0 / Atom 的条目。
 *
 * ## 为什么不用 `DOMParser`
 * 两条理由，第二条是实测踩出来的：
 * 1. 订阅源里 **CDATA 是常态**（WordPress/GitHub Blog 的 `<description>` 全是），
 *    而 CDATA 里可以塞任意 HTML；正则切块 + 解 CDATA 对这种形状更直接；
 * 2. **happy-dom 的 XML 解析器不接受 CDATA**（`StartTag: invalid element name`）——
 *    用 DOMParser 的话，"真实形状的 feed"在测试环境里会整条解析失败，于是测试要么
 *    测不到真实形状，要么只能喂简化过的假数据。正则实现两边行为一致（与 `htmlDigest`
 *    同款取舍：宁可自己写一段可测的解析，也不依赖环境差异）。
 */
export function parseFeedXml(xml: string): ParsedItem[] {
  const body = String(xml ?? '');
  if (body.length === 0) return [];
  const out: ParsedItem[] = [];
  const blocks = /<(item|entry)\b[\s\S]*?<\/\1\s*>/gi;
  let m: RegExpExecArray | null = blocks.exec(body);
  while (m !== null) {
    const block = m[0];
    const isAtom = m[1].toLowerCase() === 'entry';
    const title = plainText(tagText(block, ['title']));
    const rawLink = isAtom ? atomHref(block) : tagText(block, ['link']);
    // RSS 的链接是文本；Atom 的是属性。两者都拿不到就退回 guid（很多站只有它）
    const url =
      usableUrl(plainText(rawLink)) ??
      usableUrl(atomHref(block)) ??
      usableUrl(plainText(tagText(block, ['guid', 'id'])));
    const date = tagText(block, isAtom ? ['updated', 'published'] : ['pubDate', 'published', 'updated', 'dc:date']);
    const text = plainText(tagText(block, ['description', 'summary', 'content:encoded', 'content']));
    if (title.length === 0 || url === null) {
      m = blocks.exec(body);
      continue;
    }
    out.push({ title, url, dateMs: parseDateMs(plainText(date)), text, extra: '' });
    m = blocks.exec(body);
  }
  return out;
}

/* ------------------------------------------------------------------ JSON（四家 API） */

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/**
 * 各 JSON API 的形状映射。
 *
 * 每一家都**只用实测见过的字段**（见 `docs/SOURCES.md` 的样例），缺失就退回空串 ——
 * `normalizeItem` 会把没有链接/标题的条目标掉，所以这里不需要防御性地编造内容。
 */
export function parseJsonItems(kind: SourceDef['kind'], payload: unknown): ParsedItem[] {
  const out: ParsedItem[] = [];
  if (kind === 'hn') {
    for (const hit of asArray((payload as { hits?: unknown })?.hits)) {
      const h = hit as Record<string, unknown>;
      const title = str(h.title);
      const id = str(h.objectID);
      // 链接可能为空（Ask HN 这类自帖）⇒ 退回那条讨论本身的地址
      const url = usableUrl(h.url) ?? usableUrl(id ? `https://news.ycombinator.com/item?id=${id}` : '');
      if (!title || !url) continue;
      const points = Number(h.points ?? 0);
      const comments = Number(h.num_comments ?? 0);
      out.push({
        title,
        url,
        dateMs: parseDateMs(h.created_at),
        text: '',
        extra: `${Number.isFinite(points) ? points : 0} 分 · ${Number.isFinite(comments) ? comments : 0} 评论`,
      });
    }
    return out;
  }

  if (kind === 'hf-papers') {
    for (const raw of asArray(payload)) {
      const p = raw as Record<string, unknown>;
      const paper = (p.paper ?? {}) as Record<string, unknown>;
      const title = str(p.title) || str(paper.title);
      const id = str(paper.id);
      // 论文页地址由 id 拼出来（实测响应里没有 url 字段）
      const url = usableUrl(id ? `https://huggingface.co/papers/${id}` : '');
      if (!title || !url) continue;
      const fullTextUrl = arxivHtmlUrl(id);
      // 摘要随响应一起回来 —— 这就是"不用再抓页面"的底气（HF 的网页本身没有 ACAO）
      const text = plainText(p.summary) || plainText(paper.summary);
      const upvotes = Number(paper.upvotes ?? 0);
      out.push({
        title,
        url,
        dateMs: parseDateMs(p.publishedAt) || parseDateMs(paper.publishedAt),
        text,
        extra: Number.isFinite(upvotes) && upvotes > 0 ? `${upvotes} 票` : '论文摘要',
        ...(fullTextUrl === undefined ? {} : { fullTextUrl }),
      });
    }
    return out;
  }

  if (kind === 'hf-models') {
    for (const raw of asArray(payload)) {
      const m = raw as Record<string, unknown>;
      const id = str(m.modelId) || str(m.id);
      const url = usableUrl(id ? `https://huggingface.co/${id}` : '');
      if (!id || !url) continue;
      const likes = Number(m.likes ?? 0);
      const downloads = Number(m.downloads ?? 0);
      const task = str(m.pipeline_tag);
      const tags = asArray(m.tags).map((t) => str(t)).filter((t) => t.length > 0 && !t.includes(':')).slice(0, 6);
      // 正文给"数据卡"级别的信息：模型名 + 任务 + 标签。够生成"这是什么/什么时候用"的卡，
      // 但不假装我们知道它的细节（细节在模型卡页面，那页没有 CORS）。
      const text =
        `模型：${id}\n任务：${task || '未标注'}\n` +
        `热度：${Number.isFinite(likes) ? likes : 0} 赞 · ${Number.isFinite(downloads) ? downloads : 0} 次下载\n` +
        (tags.length > 0 ? `标签：${tags.join('、')}\n` : '');
      out.push({
        title: `${id}（${task || '未标注'}）`,
        url,
        dateMs: parseDateMs(m.createdAt),
        text,
        extra: `${Number.isFinite(likes) ? likes : 0} 赞`,
      });
    }
    return out;
  }

  if (kind === 'gh-releases') {
    for (const raw of asArray(payload)) {
      const r = raw as Record<string, unknown>;
      if (r.draft === true) continue;
      const tag = str(r.tag_name) || str(r.name);
      const url = usableUrl(r.html_url);
      if (!tag || !url) continue;
      const repo = str((r as { repository_url?: unknown }).repository_url);
      const text = plainText(r.body);
      out.push({
        title: `${tag}${repo ? ` · ${repo.split('/').slice(-2).join('/')}` : ''}`,
        url,
        dateMs: parseDateMs(r.published_at) || parseDateMs(r.created_at),
        text,
        extra: r.prerelease === true ? '预发布' : `更新说明 ${text.length} 字`,
      });
    }
    return out;
  }

  if (kind === 'gh-org-repos') {
    for (const raw of asArray(payload)) {
      const repo = raw as Record<string, unknown>;
      if (repo.archived === true) continue;
      const full = str(repo.full_name) || str(repo.name);
      const url = usableUrl(repo.html_url);
      if (!full || !url) continue;
      const stars = Number(repo.stargazers_count ?? 0);
      const desc = str(repo.description);
      const lang = str(repo.language);
      const text =
        `仓库：${full}\n${desc ? `说明：${desc}\n` : ''}` +
        `语言：${lang || '未标注'}\n星标：${Number.isFinite(stars) ? stars : 0}\n` +
        `最近推送：${str(repo.pushed_at).slice(0, 10) || '未知'}\n`;
      out.push({
        title: `${full}${desc ? `：${desc}` : ''}`,
        url,
        dateMs: parseDateMs(repo.pushed_at) || parseDateMs(repo.updated_at),
        text,
        extra: `★ ${Number.isFinite(stars) ? stars : 0}`,
      });
    }
    return out;
  }

  return out; // rss 不走这里
}


/* ------------------------------------------------------------------ 读取服务的渲染结果 */

/**
 * 读取服务返回的**不是原始 feed**，而是它渲染过的页面（实测 r.jina.ai）：
 * arXiv 的 RSS 经它一转，`<item>` 全没了，只剩两种形态之一 ——
 * - 默认 markdown：`### [标题](链接)` + 下一段正文；
 * - 带 `x-respond-with: html`：`<h3><a href="链接">标题</a></h3><p>正文…</p>`。
 *
 * 所以要**另写一个解析器**（用 RSS 的正则去套渲染结果必然一条都出不来 —— 实测 0 条）。
 * 两种形态都认，因为自建网关未必支持那个请求头。
 */
export function parseReaderList(body: string): ParsedItem[] {
  const text = String(body ?? '');
  if (text.length === 0) return [];

  // ① HTML 渲染：<h3><a href="…">标题</a></h3> 后面跟着正文（直到下一个标题）
  const html = /<h[1-4][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[1-4]>([\s\S]*?)(?=<h[1-4][^>]*>|$)/gi;
  const out: ParsedItem[] = [];
  let m = html.exec(text);
  while (m !== null) {
    const url = usableUrl(m[1]);
    const title = plainText(m[2]);
    if (url !== null && title.length > 0) {
      out.push({ title, url, dateMs: 0, text: plainText(m[3]), extra: '' });
    }
    m = html.exec(text);
  }
  if (out.length > 0) return out;

  // ② markdown 渲染：`### [标题](链接)` + 正文（直到下一个标题）
  const md = /^#{2,4}\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)[^\n]*\n([\s\S]*?)(?=^#{2,4}\s|\n(?=Title:)|$)/gim;
  m = md.exec(text);
  while (m !== null) {
    const url = usableUrl(m[2]);
    const title = plainText(m[1]);
    if (url !== null && title.length > 0) {
      out.push({ title, url, dateMs: 0, text: plainText(m[3]), extra: '' });
    }
    m = md.exec(text);
  }
  return out;
}

/* ------------------------------------------------------------------ 出口 */

type Attempt =
  | { readonly ok: true; readonly items: ParsedItem[]; readonly truncatedForParse?: boolean }
  | { readonly ok: false; readonly reason: string; readonly blocked: boolean };

/** 一个请求的公共外壳：超时 + 状态码 → 人话 + 体积上限。 */
async function requestText(
  target: string,
  doFetch: FetchLike,
  timeoutMs: number,
  headers: Record<string, string>,
  external?: AbortSignal,
): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly reason: string; readonly blocked: boolean }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
  // 外部取消（D62）：玩家的「取消」要能真的掐断在途请求，而不是只把界面变回去
  const onExternalAbort = (): void => controller?.abort();
  if (controller !== null && external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await doFetch(target, {
      method: 'GET',
      headers,
      ...(controller !== null ? { signal: controller.signal } : {}),
    });
    if (!res || typeof res.text !== 'function') {
      return { ok: false, reason: '返回的东西读不出来。', blocked: false };
    }
    if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) {
      return { ok: false, reason: reasonForStatus(res.status), blocked: false };
    }
    const len = Number(res.headers?.get?.('content-length') ?? 0);
    if (Number.isFinite(len) && len > FEED_MAX_BYTES) {
      return { ok: false, reason: `太大了（${Math.round(len / 1000)}KB），不像一份清单。`, blocked: false };
    }
    const body = await res.text();
    if (body.length > FEED_MAX_BYTES) return { ok: false, reason: '太大了，不像一份清单。', blocked: false };
    return { ok: true, body };
  } catch (e) {
    // `fetch` 在 CORS 被拦、断网、DNS 失败时抛的都是 TypeError —— 浏览器不告诉你是哪一种
    if (e instanceof Error && e.name === 'AbortError') {
      // 分清"玩家点的取消"与"自己超时"：前者不该说成"太慢，稍后再试"
      return external?.aborted === true
        ? { ok: false, reason: '已取消。', blocked: false }
        : { ok: false, reason: '响应太慢（超时），稍后再试。', blocked: false };
    }
    return { ok: false, reason: '读不到这个源（跨域被拒或网络不通）。', blocked: true };
  } finally {
    external?.removeEventListener('abort', onExternalAbort);
    if (timer !== null) clearTimeout(timer);
  }
}

/** 直读一个源（浏览器直接取它的 RSS/JSON）。 */
async function attemptDirect(
  source: SourceDef,
  url: string,
  doFetch: FetchLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Attempt> {
  const got = await requestText(
    url,
    doFetch,
    timeoutMs,
    { Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml, */*' },
    signal,
  );
  if (!got.ok) return got;
  const body = got.body;

  if (source.kind === 'rss') {
    // D62：文本清单解析前截断（JSON 不截：结构一旦截断就整个解析不了，见下）
    const longList = body.length > FEED_PARSE_MAX_BYTES;
    const items = parseFeedXml(body.slice(0, FEED_PARSE_MAX_BYTES));
    if (items.length === 0) {
      return { ok: false, reason: '这个地址不是可解析的 RSS/Atom（里面没有条目）。', blocked: false };
    }
    return { ok: true, items, ...(longList ? { truncatedForParse: true } : {}) };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: '这个源返回的不是 JSON（可能被登录页/反爬页顶替了）。', blocked: false };
  }
  const items = parseJsonItems(source.kind, payload);
  if (items.length === 0) {
    return { ok: false, reason: '这个源一条可用条目都没解析出来（端点可能变了）。', blocked: false };
  }
  return { ok: true, items };
}

/**
 * 经**玩家配置的读取服务**读一个源（D55）。
 *
 * 三件事必须一起做对：
 * 1. 目标 URL 要**整段**编码后接在服务地址后面（与 `pageFetch` 同款；实测 r.jina.ai 两种都收，
 *    但编码过的不会被服务把它自己的查询参数吃进去）；
 * 2. 带 `x-respond-with: html` 请它回渲染后的 HTML（比 markdown 更好解析；自建网关不支持也无妨，
 *    我们的解析器两种都认）；
 * 3. 带上服务自己的 Key（`Authorization: Bearer …`）——**不是**玩家的 LLM Key（两把钥匙互不串用）。
 */
async function attemptReader(
  reader: { readonly url: string; readonly key: string },
  source: SourceDef,
  doFetch: FetchLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Attempt> {
  const base = reader.url.endsWith('/') ? reader.url : `${reader.url}/`;
  const target = `${base}${encodeURIComponent(source.url)}`;
  const headers: Record<string, string> = {
    Accept: 'text/html, text/plain, */*',
    'x-respond-with': 'html',
  };
  const key = typeof reader.key === 'string' ? reader.key.trim() : '';
  if (key.length > 0) headers.Authorization = `Bearer ${key}`;

  const got = await requestText(target, doFetch, timeoutMs, headers, signal);
  if (!got.ok) {
    return {
      ok: false,
      reason: got.blocked ? '读取服务连不上（跨域被拒或网络不通）。' : `读取服务那边：${got.reason}`,
      blocked: false,
    };
  }
  // D62：读取服务回来的是**渲染后的整页 HTML**（arXiv 那种能到 2.6 MB）——
  // 解析前同样截断：最新的条目排在最前面，尾部解析不到不影响这一趟。
  const items = parseReaderList(got.body.slice(0, FEED_PARSE_MAX_BYTES));
  if (items.length === 0) {
    return { ok: false, reason: '读取服务把它转成了别的格式，里面没有可识别的条目列表。', blocked: false };
  }
  return { ok: true, items };
}

/**
 * 读一个来源的最新条目。**永不 throw**：失败一律翻成 `{ok:false, reason, blocked, readerTried}`。
 *
 * ## 尝试顺序（D55）
 * - 玩家**没配**读取服务：只直读（`blocked:true` = 这个源没开 CORS，UI 据此给"配读取服务/复制原文"）；
 * - 玩家配了：
 *   - 实测**直连可读**的源（`direct:true`）先直读、失败再经读取服务；
 *   - 实测**没有 ACAO** 的源（`direct:false`）**先经读取服务**（直读必然白跑一趟 700KB），
 *     失败了再直读一次 —— 万一那个站哪天补上了 CORS，这里就自愈了。
 */
export async function fetchSourceItems(
  source: SourceDef,
  deps: FetchSourceDeps = {},
): Promise<FetchSourceResult> {
  const url = usableUrl(source?.url);
  if (url === null) {
    return { ok: false, reason: '这个源的地址不合法（要 http/https）。', blocked: false, readerTried: false };
  }
  const doFetch: FetchLike | undefined = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof doFetch !== 'function') {
    return { ok: false, reason: '这个环境没有网络能力。', blocked: false, readerTried: false };
  }
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0 ? deps.timeoutMs : FEED_TIMEOUT_MS;
  const readerTimeoutMs =
    typeof deps.readerTimeoutMs === 'number' && deps.readerTimeoutMs > 0 ? deps.readerTimeoutMs : READER_TIMEOUT_MS;
  const readerUrl = typeof deps.reader?.url === 'string' ? deps.reader.url.trim() : '';
  const reader = readerUrl.length > 0 ? { url: readerUrl, key: typeof deps.reader?.key === 'string' ? deps.reader.key : '' } : null;
  const readerTried = reader !== null;

  /**
   * 试哪几条路、什么顺序（D62 修正）：
   * - `direct:false` 的源**只走读取服务** —— 它们的 note 就是"实测无 ACAO"，
   *   直连必然白等 15 秒（原来"读取服务失败→再直连"最长要卡 40 秒，玩家以为崩了）；
   * - 其余源先直读（快、免费），失败再走读取服务。
   * - 没配读取服务时永远只直读（不假装有）。
   */
  const order: ReadonlyArray<'direct' | 'reader'> =
    source.direct === false
      ? reader !== null
        ? ['reader']
        : ['direct']
      : reader !== null
        ? ['direct', 'reader']
        : ['direct'];

  const failures: Array<{ who: 'direct' | 'reader'; reason: string; blocked: boolean }> = [];
  for (const which of order) {
    const attempt =
      which === 'direct'
        ? await attemptDirect(source, url, doFetch, timeoutMs, deps.signal)
        : await attemptReader(reader as { url: string; key: string }, source, doFetch, readerTimeoutMs, deps.signal);
    if (attempt.ok) {
      return {
        ok: true,
        items: attempt.items.map((i) => ({ ...i, sourceId: source.id, sourceName: source.name })),
        via: which,
        // D62：把"清单太长、只解析了前 512 KB"如实带到上层（UI 会说明，别让玩家以为条目少了）
        ...(attempt.truncatedForParse === true ? { truncatedForParse: true } : {}),
      };
    }
    failures.push({ who: which, reason: attempt.reason.replace(/。$/, ''), blocked: attempt.blocked });
  }

  // 失败文案：**两条路各自为什么没成，都要说清**（只报后一条会把玩家引到错误的下一步：
  // "读取服务 429 了"和"这个站没开跨域"要采取的行动完全不同）
  const label = (who: 'direct' | 'reader'): string => (who === 'direct' ? '直连' : '读取服务');
  const reason =
    failures.length === 0
      ? '读不到这个源。'
      : failures.length === 1
        ? `${failures[0].reason}。`
        : failures.map((f) => `${label(f.who)}那边：${f.reason}。`).join(' ');
  const blocked = !readerTried && failures.some((f) => f.blocked);
  return { ok: false, reason, blocked, readerTried };
}
