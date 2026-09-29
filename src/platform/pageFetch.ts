/**
 * pageFetch.ts —— Plan 8 · T1：全仓**唯一的网页网络出口**（LLM 出口在 llmHttp，两者分开）。
 *
 * ## 为什么必须只有一处，且必须诚实
 * 浏览器读第三方网页天然被 CORS 拦（实测：公众号 / 知乎 / 腾讯新闻 / 澎湃均无 CORS 头），
 * 所以这一层的首要职责不是"抓下来"，而是**把"抓不到"翻译成玩家能理解、能采取行动的一句话**：
 * `blocked:true` 表示"这个站点不允许网页直读"（UI 据此提示粘贴正文 / 存进待读清单），
 * `blocked:false` 表示别的问题（404、超时、不是网页）——两者的下一步完全不同。
 *
 * ## 可选读取服务（默认关闭，见 D43）
 * 玩家可以在设置里填一个"读取服务"（如自建网关 / r.jina.ai）与它自己的 Key。它**只在直读
 * 被拦之后**兜底，且：
 * - 带的是**读取服务的 Key，不是玩家那把 LLM Key**（两把钥匙互不串用）；
 * - 打开时设置页会明说"链接会经这台服务转一手"——隐私的账由玩家自己算。
 *
 * ## 刻意不做的事
 * - **不重试**：CORS 拦就是拦，重试只会拖时间；
 * - **不吞异常**：任何抛出都翻成 `{ok:false, reason}`；
 * - **不把 Key 写进任何文案**：所有 reason 都从状态码/异常类型生成。
 */
import type { FetchLike } from './llmTypes';

/** 超时：手机网络下 20s 足够；到点就中止（网页比 LLM 响应更该有硬上限）。 */
export const PAGE_TIMEOUT_MS = 20_000;
/** 体积上限：1.5MB 足够一篇长文；再大就不是"一篇文章"了，读进内存只会拖垮手机。 */
export const PAGE_MAX_BYTES = 1_500_000;

export type PageFetchResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly contentType: string;
      readonly finalUrl: string;
      /** `'direct'` = 直读；`'reader'` = 经玩家配置的读取服务兜底。 */
      readonly via: 'direct' | 'reader';
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** true = 这个站点**不允许网页直读**（CORS）；UI 据此给"粘贴正文/进待读清单"的出路。 */
      readonly blocked: boolean;
    };

export interface PageFetchDeps {
  /** 注入位（测试用假 fetch；生产不传）。 */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** 玩家可选的读取服务（缺省 = 不启用，直读被拦就是被拦）。 */
  readonly reader?: { readonly url: string; readonly key: string };
}

/** 只接受 http/https：`data:` / `file:` / `javascript:` 之类一律挡在发请求之前。 */
function normalizedHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length === 0) return null;
  if (!/^https?:\/\//i.test(t)) return null;
  return t;
}

/** 状态码 → 人话（**不含 Key、不含响应体**）。 */
function reasonForStatus(status: number, who: 'site' | 'reader'): string {
  const prefix = who === 'reader' ? '读取服务' : '这个站点';
  if (status === 401 || status === 403) return `${prefix}拒绝了访问（${status}）。`;
  if (status === 404) return `链接打不开（404）——可能已经被删了。`;
  if (status === 429) return `${prefix}限流了（429）——等一会儿再试。`;
  if (status >= 500) return `${prefix}那边出故障了（${status}）。`;
  return `${prefix}返回了 ${status}。`;
}

/** 可读正文的类型：只有这两类才可能包含"文章"。 */
function isReadableContentType(ct: string): boolean {
  const t = ct.toLowerCase();
  return t.includes('text/html') || t.includes('text/plain') || t.includes('text/xml') || t.includes('application/xhtml');
}

/**
 * 直读一个 URL。永不抛：所有失败都翻成 `{ok:false, reason, blocked}`。
 */
export function fetchPage(url: string, deps: PageFetchDeps = {}): Promise<PageFetchResult> {
  const target = normalizedHttpUrl(url);
  if (target === null) {
    return Promise.resolve({ ok: false, reason: '只支持 http/https 链接。', blocked: false });
  }
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return Promise.resolve({ ok: false, reason: '这个环境不支持网络请求。', blocked: false });
  }
  const timeoutMs =
    typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs >= 0
      ? deps.timeoutMs
      : PAGE_TIMEOUT_MS;

  return request(fetchImpl, target, { timeoutMs, who: 'site' }).then((direct) => {
    if (direct.ok) return direct;
    // 只有"被站点拦住"才值得走读取服务：404/不是网页这类换条路也一样（省一次外发）
    const reader = deps.reader;
    const readerUrl = typeof reader?.url === 'string' ? reader.url.trim() : '';
    if (!direct.blocked || readerUrl.length === 0) return direct;
    return request(fetchImpl, `${readerUrl}${encodeURIComponent(target)}`, {
      timeoutMs,
      who: 'reader',
      authorization: typeof reader?.key === 'string' && reader.key.trim().length > 0 ? `Bearer ${reader.key.trim()}` : undefined,
      via: 'reader',
    }).then((viaReader) => {
      if (viaReader.ok) return viaReader;
      // 两条路都失败：如实说清，并保留 blocked（UI 仍走"请粘贴正文"的出路）
      return {
        ok: false as const,
        reason: `${direct.reason}（读取服务也没成：${viaReader.reason}）`,
        blocked: true,
      };
    });
  });
}

interface RequestOpts {
  readonly timeoutMs: number;
  readonly who: 'site' | 'reader';
  readonly authorization?: string;
  readonly via?: 'direct' | 'reader';
}

/** 一次 GET + 读取 + 分类。**所有分支都返回结果**，绝不抛。 */
async function request(fetchImpl: FetchLike, target: string, opts: RequestOpts): Promise<PageFetchResult> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
  }
  const finish = (): void => {
    if (timer !== null) clearTimeout(timer);
  };

  try {
    const res = await fetchImpl(target, {
      method: 'GET',
      // 读取服务的 Key 只出现在这一行；直读不带任何鉴权头
      ...(opts.authorization ? { headers: { Authorization: opts.authorization } } : {}),
      signal: controller?.signal,
    });
    if (!res || typeof res.ok !== 'boolean') {
      finish();
      return { ok: false, reason: '返回异常：拿不到响应状态。', blocked: false };
    }
    if (!res.ok) {
      finish();
      return { ok: false, reason: reasonForStatus(res.status, opts.who), blocked: false };
    }
    const contentType = String(res.headers?.get?.('content-type') ?? '');
    if (!isReadableContentType(contentType)) {
      finish();
      return { ok: false, reason: '这不是一个网页（不是可读的文本内容）。', blocked: false };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      finish();
      return { ok: false, reason: `读取内容失败：${describe(e)}`, blocked: false };
    }
    finish();
    if (text.length > PAGE_MAX_BYTES) {
      return { ok: false, reason: '这个页面太大了（超过 1.5MB），没法当一篇文章读。', blocked: false };
    }
    return {
      ok: true,
      text,
      contentType,
      finalUrl: target,
      via: opts.via ?? 'direct',
    };
  } catch (e) {
    finish();
    if (timedOut) {
      return { ok: false, reason: `等太久了（${Math.round(opts.timeoutMs / 1000)} 秒没响应）。`, blocked: false };
    }
    // `TypeError` 是浏览器**跨域拦截**的形态（"Failed to fetch"/"NetworkError"）：
    // 这是本功能最常见的失败，必须和"别的网络错误"分开表达。
    if (e instanceof TypeError) {
      const reason = opts.who === 'reader' ? '读取服务连不上。' : '这个站点不允许网页直读（跨域限制）。';
      return { ok: false, reason, blocked: true };
    }
    return { ok: false, reason: `请求失败：${describe(e)}`, blocked: false };
  }
}

/** 异常 → 一句话（不把栈/对象塞进 UI）。 */
function describe(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? '请求被中止。' : e.message;
  return String(e);
}
