// @vitest-environment happy-dom
/**
 * tests/platform/feedFetch.test.ts —— 订阅源解析与抓取（D53）。
 *
 * 判别力：
 * - FF#1 RSS / Atom 都能解析（字段名不同：`<item>/<pubDate>` vs `<entry>/<updated>`）；
 * - FF#2 四家 JSON API 各自形状（**用实测样例的字段名**：某家改字段必红）；
 * - FF#3 CORS/断网（fetch 抛 TypeError）⇒ `blocked:true`（UI 据此给"配读取服务/复制原文"）；
 * - FF#4 状态码 → 人话（429 要说"限流"，不是"未知错误"）；
 * - FF#5 非 feed / 坏 JSON ⇒ `ok:false` 且**不撒谎**（"里面没有条目"而不是"网络错误"）；
 * - FF#6 体积上限（content-length 与实测体积两条都要拦）；
 * - FF#7 解析产物里**没有可用条目**就明确失败（不许回一个空清单让 UI 看起来"读到了但没内容"）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FEED_MAX_BYTES,
  fetchSourceItems,
  parseFeedXml,
  parseJsonItems,
  plainText,
} from '../../src/platform/feedFetch';
import type { SourceDef } from '../../src/core/sourceItem';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Git 2.56</title><link>https://github.blog/x</link><pubDate>Tue, 22 Sep 2026 05:20:54 GMT</pubDate><description><![CDATA[<p>摘要 &amp; 更多</p>]]></description></item>
<item><title>没有链接的条目</title><description>应被丢掉</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Atom 条目</title><link rel="alternate" href="https://example.com/a"/><updated>2026-09-22T05:20:54Z</updated><summary>Atom 摘要</summary></entry>
</feed>`;

/** 假响应：用真 `Response`（与 pageFetch 的测试同款），只在需要伪造体积时补 content-length。 */
function res(body: string, init: { status?: number; contentType?: string; contentLength?: number } = {}): Response {
  const headers = new Headers({ 'Content-Type': init.contentType ?? 'application/rss+xml' });
  if (init.contentLength !== undefined) headers.set('Content-Length', String(init.contentLength));
  return new Response(body, { status: init.status ?? 200, headers });
}

/** 把假响应包成可注入的 fetch。 */
const fakeFetch = (make: () => Response | Promise<Response>) => make as unknown as typeof fetch;

const rssSource: SourceDef = { id: 's1', name: '博客', url: 'https://example.com/feed.xml', kind: 'rss', direct: true };

describe('platform/feedFetch —— 解析（D53）', () => {
  it('FF#1 RSS 与 Atom 都能解析，且丢掉了没有链接的条目', () => {
    const rss = parseFeedXml(RSS);
    expect(rss).toHaveLength(1);
    expect(rss[0].title).toBe('Git 2.56');
    expect(rss[0].url).toBe('https://github.blog/x');
    expect(rss[0].dateMs).toBeGreaterThan(0);
    expect(rss[0].text).toContain('摘要');

    const atom = parseFeedXml(ATOM);
    expect(atom).toHaveLength(1);
    expect(atom[0].title).toBe('Atom 条目');
    expect(atom[0].url).toBe('https://example.com/a');
    expect(atom[0].text).toBe('Atom 摘要');
  });

  it('FF#2 四家 JSON API 的形状（字段名按实测样例）', () => {
    const hn = parseJsonItems('hn', {
      hits: [
        { title: 'Sonnet 5.5', url: 'https://a.com/x', created_at: '2026-09-28T17:58:11Z', points: 609, num_comments: 418, objectID: '1' },
        { title: 'Ask HN：只有自帖', created_at: '2026-09-28T10:00:00Z', objectID: '2' },
        { title: '没有链接也没 id', created_at: '2026-09-28T10:00:00Z' },
      ],
    });
    expect(hn).toHaveLength(2);
    expect(hn[0].extra).toContain('609');
    // 自帖没有 url ⇒ 退回讨论页，而不是被丢掉
    expect(hn[1].url).toBe('https://news.ycombinator.com/item?id=2');

    const papers = parseJsonItems('hf-papers', [
      { title: 'CoWindow Attention', publishedAt: '2026-09-25T20:00:00.000Z', summary: '摘要正文', paper: { id: '2609.32704', upvotes: 12 } },
      { title: '没有 id 的论文', paper: {} },
    ]);
    expect(papers).toHaveLength(1);
    expect(papers[0].url).toBe('https://huggingface.co/papers/2609.32704');
    expect(papers[0].text).toBe('摘要正文');
    expect(papers[0].extra).toContain('12');

    const models = parseJsonItems('hf-models', [
      { modelId: 'Qwen/Qwen-Image-2.1', pipeline_tag: 'text-to-image', likes: 2595, downloads: 58693, createdAt: '2026-09-18T05:05:55.000Z', tags: ['transformers', 'license:apache-2.0', 'diffusion'] },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0].url).toBe('https://huggingface.co/Qwen/Qwen-Image-2.1');
    expect(models[0].text).toContain('text-to-image');
    expect(models[0].text).toContain('2595'); // 正文里带热度
    expect(models[0].text).not.toContain('license:apache-2.0'); // 许可证标签不进正文

    const rel = parseJsonItems('gh-releases', [
      { tag_name: 'v0.30.0', html_url: 'https://github.com/vllm-project/vllm/releases/tag/v0.30.0', published_at: '2026-09-22T05:20:54Z', body: '## Highlights\n762 commits\n\n- 支持 x', prerelease: false },
      { tag_name: 'v-draft', html_url: 'https://github.com/x/y/releases/tag/d', draft: true, body: '草稿不该出现' },
    ]);
    expect(rel).toHaveLength(1);
    expect(rel[0].title).toContain('v0.30.0');
    expect(rel[0].text).toContain('Highlights'); // 更新说明正文随响应回来 ⇒ 不用再抓页面
    expect(rel[0].extra).toContain('字');

    const repos = parseJsonItems('gh-org-repos', [
      { full_name: 'deepseek-ai/deepseek-harness', html_url: 'https://github.com/deepseek-ai/deepseek-harness', description: 'Everything is a Plugin.', stargazers_count: 238901, pushed_at: '2026-09-28T12:35:34Z', language: 'TypeScript' },
      { full_name: 'old/archived', html_url: 'https://github.com/old/archived', archived: true },
    ]);
    expect(repos).toHaveLength(1);
    expect(repos[0].extra).toContain('238901');
    expect(repos[0].text).toContain('TypeScript');
  });

  it('FF#2b plainText 去掉标签、解实体、折叠空白（RSS 的 description 常带 HTML）', () => {
    expect(plainText('<p>a<br/>b</p> &amp; <b>c</b>')).toBe('a b & c');
    expect(plainText('<script>var x=1</script>正文')).toBe('正文');
    expect(plainText(undefined)).toBe('');
  });
});

describe('platform/feedFetch —— 抓取失败的分支（D53）', () => {
  it('FF#3 CORS/断网（TypeError）⇒ blocked:true，文案说两种可能', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const res1 = await fetchSourceItems(rssSource, { fetchImpl });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.blocked).toBe(true);
      expect(res1.reason).toContain('跨域');
    }
  });

  it('FF#4 状态码翻成人话：429 说限流，404 说端点可能变了', async () => {
    for (const [status, expectWord] of [[429, '限流'], [404, '404'], [500, '故障']] as const) {
      const r = await fetchSourceItems(rssSource, { fetchImpl: fakeFetch(() => res('', { status })) });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.blocked).toBe(false);
        expect(r.reason).toContain(expectWord);
      }
    }
  });

  it('FF#5 非 feed / 坏 JSON ⇒ 明确失败，且**不把"不是 feed"说成"网络错误"**', async () => {
    const html = await fetchSourceItems(rssSource, {
      fetchImpl: fakeFetch(() => res('<html><body>反爬页</body></html>', { contentType: 'text/html' })),
    });
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.reason).toContain('不是可解析的 RSS');

    const badJson = await fetchSourceItems(
      { ...rssSource, kind: 'hn' },
      { fetchImpl: fakeFetch(() => res('{oops', { contentType: 'application/json' })) },
    );
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.reason).toContain('不是 JSON');
  });

  it('FF#5b JSON 结构对但没有一条可用 ⇒ 说"端点可能变了"，而不是回一个空清单', async () => {
    const r = await fetchSourceItems(
      { ...rssSource, kind: 'hf-papers' },
      { fetchImpl: fakeFetch(() => res('[]', { contentType: 'application/json' })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('端点可能变了');
  });

  it('FF#6 体积上限：content-length 与实测体积两条都拦', async () => {
    const big = await fetchSourceItems(rssSource, {
      fetchImpl: fakeFetch(() => res(RSS, { contentLength: FEED_MAX_BYTES + 1 })),
    });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toContain('太大');

    const big2 = await fetchSourceItems(rssSource, {
      fetchImpl: fakeFetch(() => res(RSS + 'x'.repeat(FEED_MAX_BYTES))),
    });
    expect(big2.ok).toBe(false);
    if (!big2.ok) expect(big2.reason).toContain('太大');
  });

  it('FF#7 超时（AbortError）⇒ 说"响应太慢"，不是"跨域被拒"', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = await fetchSourceItems(rssSource, { fetchImpl: (() => Promise.reject(abortErr)) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blocked).toBe(false);
      expect(r.reason).toContain('超时');
    }
  });

  it('FF#8 成功的 RSS：entries 带上来源信息，且不吃掉 dateMs', async () => {
    const r = await fetchSourceItems(rssSource, { fetchImpl: fakeFetch(() => res(RSS)) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.items[0].sourceId).toBe('s1');
      expect(r.items[0].sourceName).toBe('博客');
      expect(r.items[0].dateMs).toBeGreaterThan(0);
    }
  });

  it('FF#9 非法链接在发请求之前就被挡下（不外发一个 javascript: 地址）', async () => {
    const fetchImpl = vi.fn(() => res(RSS));
    const r = await fetchSourceItems(
      { ...rssSource, url: 'javascript:alert(1)' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
