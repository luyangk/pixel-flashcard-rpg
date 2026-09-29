/**
 * htmlDigest.ts —— Plan 8 · T2：把一份 HTML 变成「正文 + 条目」（两级抓取的解析底座）。
 *
 * ## 为什么在 platform 层而不是 core
 * 解析要 `DOMParser`（平台能力），而 `src/core` 禁一切平台 API、`src/app` 禁 DOM 单例。
 * 真正的"怎么分类"（直读/进一层/被拒）在 `app/ingestFlow`，这一层只做**纯解析**。
 *
 * ## 为什么要"条目"这一级（D43 的"进入一层"）
 * 玩家给的常常是**栏目页/首页**而不是某一篇。把页面上的链接抽出来让玩家挑一条、再抓那一篇，
 * 就是"进入一层"的全部实现 —— 它完全不需要爬虫，只是把页面里本来就有的链接列出来。
 *
 * ## 口径
 * - 先删脚本/样式/导航/页脚等噪声，再按 `article → main → [role=main] → body` 取正文容器；
 * - 正文按**段落**换行、空白折叠，按**码点**截断（`.slice` 会劈开代理对）；
 * - 链接绝对化（相对路径按 baseUrl 解析）、只留 http(s)、按 url 去重、同源优先、封顶 40；
 * - **永不抛**：畸形 HTML / 脏输入都回一个（可能为空的）digest。
 */
import { UNSAFE_CHARS_RE } from '@core/llmParse';

/** 正文长度上限（码点）：一篇长文足够，再多只会拖垮手机与模型请求。 */
export const ARTICLE_MAX_CHARS = 12_000;
/** 条目上限：栏目页给的链接再多，玩家也不会一条条看完。 */
export const LINKS_MAX = 40;
/** 标题长度上限（码点）。 */
export const TITLE_MAX = 120;

export interface PageLink {
  readonly title: string;
  readonly url: string;
}

export interface PageDigest {
  readonly title: string;
  readonly text: string;
  readonly links: readonly PageLink[];
}

/** 噪声标签：删掉它们比"猜哪个 div 是正文"稳得多。 */
const DROP_SELECTOR = 'script, style, noscript, iframe, svg, nav, footer, header, aside, form, template';
/** 正文容器优先级（从最具体到最泛）。 */
const CONTENT_SELECTORS = ['article', 'main', '[role="main"]', 'body'];

/** 空白折叠 + 剥不可见字符（保留可读的单行文本，段落由调用方用 \n 拼）。 */
function inlineText(raw: string): string {
  const stripped = String(raw ?? '').replace(UNSAFE_CHARS_RE, ' ');
  return stripped.replace(/\s+/g, ' ').trim();
}

/** 码点安全截断（超出即截，不追加省略号——正文不需要）。 */
function clipPoints(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join('') : text;
}

/** 绝对化一个 href；非 http(s) 或解析失败 ⇒ null。 */
function absoluteHttpUrl(href: string, baseUrl: string): string | null {
  const raw = String(href ?? '').trim();
  if (raw.length === 0) return null;
  try {
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * 解析一份 HTML。`baseUrl` 用于把相对链接绝对化（也是"同源优先"的判据）。
 */
export function digestHtml(html: string, baseUrl: string): PageDigest {
  const empty: PageDigest = { title: '', text: '', links: [] };
  try {
    const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    if (typeof Parser !== 'function') return empty;
    const doc = new Parser().parseFromString(String(html ?? ''), 'text/html');
    if (!doc) return empty;

    // ① 先把噪声整块删掉（导航/页脚/脚本）—— 之后取任何容器都干净
    for (const el of Array.from(doc.querySelectorAll(DROP_SELECTOR))) el.remove();

    // ② 标题：<title> 优先，其次第一个 <h1>
    const titleRaw = doc.querySelector('title')?.textContent ?? doc.querySelector('h1')?.textContent ?? '';
    const title = clipPoints(inlineText(titleRaw), TITLE_MAX);

    // ③ 正文容器：按优先级取第一个存在的
    let container: Element | null = null;
    for (const sel of CONTENT_SELECTORS) {
      const found = doc.querySelector(sel);
      if (found) {
        container = found;
        break;
      }
    }
    // 段落化：块级元素各占一行（`<p>`/`<li>`/`<h*>`/`<br>` 之间补换行）
    let text = '';
    if (container) {
      const blocks: string[] = [];
      const blockEls = container.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, dd, dt');
      if (blockEls.length > 0) {
        for (const el of Array.from(blockEls)) {
          const t = inlineText(el.textContent ?? '');
          if (t.length > 0) blocks.push(t);
        }
      } else {
        const t = inlineText(container.textContent ?? '');
        if (t.length > 0) blocks.push(t);
      }
      text = clipPoints(blocks.join('\n'), ARTICLE_MAX_CHARS);
    }

    // ④ 条目：绝对化 + 去重 + 同源优先 + 封顶
    let baseHost = '';
    try {
      baseHost = new URL(baseUrl).host;
    } catch {
      baseHost = '';
    }
    // 同页锚点与"指向自己的链接"不是新文章（点进去还是这一页）⇒ 一律丢掉。
    // 判据按**去掉 fragment** 的地址比较："#section" 与"指向本页的完整 URL"都算自己。
    const baseSansFragment = baseUrl.split('#')[0];
    const isSelf = (url: string): boolean => url.split('#')[0] === baseSansFragment;
    const seen = new Set<string>();
    const sameHost: PageLink[] = [];
    const otherHost: PageLink[] = [];
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      const url = absoluteHttpUrl(a.getAttribute('href') ?? '', baseUrl);
      if (url === null || seen.has(url) || isSelf(url)) continue;
      const label = inlineText(a.textContent ?? '');
      if (label.length === 0) continue; // 没有可读标题的链接对"挑一条"没有意义
      seen.add(url);
      const link: PageLink = { title: clipPoints(label, TITLE_MAX), url };
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        host = '';
      }
      if (baseHost.length > 0 && host === baseHost) sameHost.push(link);
      else otherHost.push(link);
      if (sameHost.length + otherHost.length >= LINKS_MAX * 2) break; // 早停：别为一张列表遍历整页
    }
    const links = [...sameHost, ...otherHost].slice(0, LINKS_MAX);

    return { title, text, links };
  } catch {
    // "永不抛"是接口契约：解析炸了就当这一页没内容，由上层决定怎么跟玩家说
    return empty;
  }
}
