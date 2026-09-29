/**
 * tests/platform/pageFetch.test.ts —— Plan 8 · T1：唯一的网页网络出口。
 *
 * 判别力（每条都写清"坏实现为何必红"）：
 * - PF#2 `fetch` 抛 `TypeError` 正是浏览器的 **CORS 拦截**形态 ⇒ 必须翻成
 *   `blocked:true` + 人话（判成普通网络错误的实现会让 UI 走错分支）；
 * - PF#3 超时必须真的 abort（只把 Promise 丢掉的实现留下悬挂请求）；
 * - PF#5 非网页（PDF/图片）不当作正文（拿二进制当正文喂给模型是整个功能最脏的失败）；
 * - PF#6 非 http(s)（`data:` / `file:` / `javascript:`）**连请求都不发**；
 * - PF#7 读取服务只在直读被拦后兜底，且带的是 **readerKey 而不是玩家那把 LLM Key**；
 * - PF#9 任何错误文案都不含 Key（把 Key 设成特征串再逐条扫）。
 */
import { describe, expect, it, vi } from 'vitest';
import { PAGE_MAX_BYTES, fetchPage } from '../../src/platform/pageFetch';

const URL_OK = 'https://example.com/article';
const KEY = 'sk-reader-SECRET-1234';

function htmlResponse(body = '<html><body><p>正文</p></body></html>', init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    ...init,
  });
}

describe('fetchPage —— 直读', () => {
  it('PF#1 正常网页 ⇒ ok/direct，带回文本、content-type 与最终地址', async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL) => {
      calls.push(String(url));
      return htmlResponse();
    }) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.via).toBe('direct');
    expect(res.text).toContain('正文');
    expect(res.contentType).toContain('text/html');
    expect(res.finalUrl).toBe(URL_OK);
    expect(calls).toEqual([URL_OK]);
  });

  it('PF#2 fetch 抛 TypeError（浏览器 CORS 拦截的形态）⇒ blocked:true + 人话', async () => {
    const fake = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain('不允许网页直读');
  });

  it('PF#3 超时 ⇒ 中止请求并回人话（不只是把 Promise 丢掉）', async () => {
    let aborted = false;
    const fake = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener?.('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake, timeoutMs: 5 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(aborted, '超时必须真的 abort').toBe(true);
    expect(res.reason).toContain('等太久');
    expect(res.blocked).toBe(false);
  });

  it('PF#4 403 / 404 / 500 各一句人话', async () => {
    for (const [status, expectWord] of [
      [403, '拒绝'],
      [404, '打不开'],
      [500, '出故障'],
    ] as const) {
      const fake = (async () => new Response('nope', { status, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
      const res = await fetchPage(URL_OK, { fetchImpl: fake });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain(expectWord);
        expect(res.blocked).toBe(false);
      }
    }
  });

  it('PF#5 非网页（PDF / 图片）⇒ 拒，不把二进制当正文', async () => {
    const fake = (async () =>
      new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf' } })) as unknown as typeof fetch;
    const res = await fetchPage('https://example.com/a.pdf', { fetchImpl: fake });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('不是一个网页');
  });

  it('PF#6 非 http(s) 链接 ⇒ 连请求都不发', async () => {
    const spy = vi.fn();
    const fake = spy as unknown as typeof fetch;
    for (const bad of ['data:text/html,<p>x</p>', 'file:///etc/passwd', 'javascript:alert(1)', '', '   ', 'ftp://x/y']) {
      const res = await fetchPage(bad, { fetchImpl: fake });
      expect(res.ok, bad).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain('http');
        expect(res.blocked).toBe(false);
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('PF#5c 4MB **以内**要接受（实测：公众号单篇原始 HTML 3.63MB ⇒ 旧上限 1.5MB 会把这条兜底路堵死）', async () => {
    const html = `<html><body><p>${'字'.repeat(3_600_000)}</p></body></html>`; // ≈3.6MB
    expect(html.length).toBeGreaterThan(1_500_000);
    expect(html.length).toBeLessThan(PAGE_MAX_BYTES);
    const fake = (async () =>
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text.length).toBeGreaterThan(1_500_000);
  });

  it('PF#5b 超过体积上限 ⇒ 拒（不把几 MB 的页面读进内存再喂模型）', async () => {
    const huge = 'x'.repeat(PAGE_MAX_BYTES + 10);
    const fake = (async () =>
      new Response(huge, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('太大');
      expect(res.reason).toContain(String(Math.round(PAGE_MAX_BYTES / 1_000_000))); // 文案里的数字取自常量
    }
  });
});

describe('fetchPage —— 可选的读取服务（默认关闭，只在直读被拦后兜底）', () => {
  it('PF#7 直读被拦 ⇒ 走读取服务且带的是 readerKey（不是玩家那把 LLM Key）', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (u.startsWith('https://reader.example/')) {
        return new Response('读取服务返回的纯文本正文', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const res = await fetchPage(URL_OK, {
      fetchImpl: fake,
      reader: { url: 'https://reader.example/', key: KEY },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.via).toBe('reader');
    expect(res.text).toContain('纯文本正文');
    expect(seen).toHaveLength(2);
    expect(seen[0].auth).toBeUndefined(); // 直读不带任何鉴权头
    expect(seen[1].url).toBe(`https://reader.example/${encodeURIComponent(URL_OK)}`);
    expect(seen[1].auth).toBe(`Bearer ${KEY}`);
  });

  it('PF#7c 直读成功 ⇒ **绝不**外发给读取服务（配了也不用，省一次外发）', async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      return htmlResponse();
    }) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake, reader: { url: 'https://reader.example/', key: KEY } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.via).toBe('direct');
    expect(seen).toEqual([URL_OK]); // 读取服务一次都没被碰
  });

  it('PF#7d 直读失败但**不是**被拦（404）⇒ 也不外发给读取服务（换条路也一样，省一次外发）', async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake, reader: { url: 'https://reader.example/', key: KEY } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.blocked).toBe(false);
    expect(seen).toEqual([URL_OK]);
  });

  it('PF#7b 没有配置读取服务时，直读被拦就是被拦（不偷偷换路径）', async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake });
    expect(res.ok).toBe(false);
    expect(seen).toEqual([URL_OK]);
  });

  it('PF#8 读取服务也失败 ⇒ blocked:true，说明两条路都没成', async () => {
    const fake = (async (url: string | URL) => {
      if (String(url).startsWith('https://reader.example/')) {
        return new Response('busy', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const res = await fetchPage(URL_OK, { fetchImpl: fake, reader: { url: 'https://reader.example/', key: KEY } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.blocked).toBe(true);
      expect(res.reason).toContain('读取服务');
    }
  });

  it('PF#9 所有失败文案都不含 Key（含读取服务失败的路径）', async () => {
    const cases: Array<() => typeof fetch> = [
      () => (() => Promise.reject(new TypeError(`boom ${KEY}`))) as unknown as typeof fetch,
      () => (async () => new Response(`err ${KEY}`, { status: 500 })) as unknown as typeof fetch,
      () =>
        (async (url: string | URL) => {
          if (String(url).startsWith('https://reader.example/')) {
            return new Response(`busy ${KEY}`, { status: 503 });
          }
          throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch,
    ];
    for (const make of cases) {
      const res = await fetchPage(URL_OK, { fetchImpl: make(), reader: { url: 'https://reader.example/', key: KEY } });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).not.toContain(KEY);
    }
  });
});
