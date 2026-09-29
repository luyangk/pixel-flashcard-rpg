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
 * 订阅源体积上限 3MB：实测 arXiv 每日 700KB、Latent.space 1.4MB、OpenAI 750KB，
 * 留一倍余量；再大就不是"清单"而是数据转储了。
 */
export const FEED_MAX_BYTES = 3_000_000;

export type FetchSourceResult =
  | { readonly ok: true; readonly items: readonly SourceItemDraft[] }
  | { readonly ok: false; readonly reason: string; readonly blocked: boolean };

export interface FetchSourceDeps {
  /** 注入位（测试用假 fetch；生产不传）。 */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
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
      // 摘要随响应一起回来 —— 这就是"不用再抓页面"的底气（HF 的网页本身没有 ACAO）
      const text = plainText(p.summary) || plainText(paper.summary);
      const upvotes = Number(paper.upvotes ?? 0);
      out.push({
        title,
        url,
        dateMs: parseDateMs(p.publishedAt) || parseDateMs(paper.publishedAt),
        text,
        extra: Number.isFinite(upvotes) && upvotes > 0 ? `${upvotes} 票` : '论文摘要',
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

/* ------------------------------------------------------------------ 出口 */

/**
 * 读一个来源的最新条目。
 *
 * 永不 throw：失败一律翻成 `{ok:false, reason, blocked}`。`blocked:true` = CORS/断网
 * （浏览器无法区分这两者，只能如实把两种可能都说给玩家）。
 */
export async function fetchSourceItems(
  source: SourceDef,
  deps: FetchSourceDeps = {},
): Promise<FetchSourceResult> {
  const url = usableUrl(source?.url);
  if (url === null) return { ok: false, reason: '这个源的地址不合法（要 http/https）。', blocked: false };
  const doFetch: FetchLike | undefined = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof doFetch !== 'function') return { ok: false, reason: '这个环境没有网络能力。', blocked: false };

  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0 ? deps.timeoutMs : FEED_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url, {
      method: 'GET',
      // 只收 XML/JSON，不带凭据（凭据会让 CORS 变成"必须精确回显来源"的更严口径）
      headers: { Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml, */*' },
      ...(controller !== null ? { signal: controller.signal } : {}),
    });
    if (!res || typeof res.text !== 'function') {
      return { ok: false, reason: '这个源返回的东西读不出来。', blocked: false };
    }
    if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) {
      return { ok: false, reason: reasonForStatus(res.status), blocked: false };
    }
    const len = Number(res.headers?.get?.('content-length') ?? 0);
    if (Number.isFinite(len) && len > FEED_MAX_BYTES) {
      return { ok: false, reason: `这个源太大了（${Math.round(len / 1000)}KB），不像一份清单。`, blocked: false };
    }
    const body = await res.text();
    if (body.length > FEED_MAX_BYTES) {
      return { ok: false, reason: '这个源太大了，不像一份清单。', blocked: false };
    }
    if (source.kind === 'rss') {
      const items = parseFeedXml(body);
      if (items.length === 0) {
        // 拿到了内容但没有一条能解析 ⇒ 多半不是 feed（或被塞了反爬页）
        return { ok: false, reason: '这个地址不是可解析的 RSS/Atom（里面没有条目）。', blocked: false };
      }
      return { ok: true, items: items.map((i) => ({ ...i, sourceId: source.id, sourceName: source.name })) };
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
    return { ok: true, items: items.map((i) => ({ ...i, sourceId: source.id, sourceName: source.name })) };
  } catch (e) {
    // `fetch` 在 CORS 被拦、断网、DNS 失败时抛的都是 TypeError —— 浏览器不告诉你是哪一种
    const aborted = e instanceof Error && e.name === 'AbortError';
    if (aborted) return { ok: false, reason: '这个源响应太慢（超时），稍后再试。', blocked: false };
    return {
      ok: false,
      reason: '读不到这个源（跨域被拒或网络不通）。',
      blocked: true,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
