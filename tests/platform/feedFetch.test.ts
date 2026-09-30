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
import { BUILTIN_DOMAINS } from '../../src/app/sourceLibrary';
import {
  FEED_MAX_BYTES,
  FEED_PARSE_MAX_BYTES,
  FEED_TIMEOUT_MS,
  READER_TIMEOUT_MS,
  fetchSourceItems,
  parseFeedXml,
  parseJsonItems,
  parseReaderList,
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
/** 实测没有 ACAO 的源（arXiv）——读取服务那条路的典型对象。 */
const arxiv: SourceDef = { id: 'arxiv-cs-lg', name: 'arXiv cs.LG', url: 'https://rss.arxiv.org/rss/cs.LG', kind: 'rss', direct: false };

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

/* ------------------------------------------------------------------ D55：经读取服务读源 */

/**
 * 这一段用**真实抓回来的渲染结果**当夹具（2026-09-29 用 `x-respond-with: html` 从 r.jina.ai
 * 取 arXiv cs.LG 的片段）：它证明"读取服务返回的不是 feed 本身"——`<item>` 一条都没有，
 * 只有 `<h3><a href>标题</a></h3><p>正文</p>`。所以必须有**另一个解析器**（用 RSS 的正则去套
 * 渲染结果实测 0 条）。
 */
const READER_HTML = `<h3><a href="https://arxiv.org/abs/2609.31630">Replay in the Silent Degrees of Freedom: Continual Learning Without an Offline Phase</a></h3><p>arXiv:2609.31630v1 Announce Type: new  Abstract: Replay-based continual learning almost always consolidates in a dedicated offline phase or by interleaving replayed samples with the input stream, whereas brains also consolidate during wakefulness through local sleep, brief use-dependent off-periods of individual circuits. We ask whether a network trained by local, biologically constrained rules can consolidate with no offline phase at all. An isolation rule confines replay updates to hidden synapses invisible to the current input under k-winner-take-all dynamics, with optimiser state advanced only inside the mask; a refractory rotation rule makes units that have just fired sit out the next competition, widening the consolidable set; a homeostatic pressure and a relative-novelty gate decide when replay bursts fire and when rotation runs. This inverts the usual direction of non-interfering continual learning: the hidden computation on the current input is held invariant (exactly on the proven channels, and for all but 0.3% of waking samples pe<h3><a href="https://arxiv.org/abs/2609.31632">第三条：用来确认解析器会继续往下走</a></h3><p>摘要第三条。</p>`;

const READER_MD = `Title: cs.LG updates on arXiv.org

URL Source: https://rss.arxiv.org/rss/cs.LG

Markdown Content:
### [Replay in the Silent Degrees of Freedom](https://arxiv.org/abs/2609.31630)

arXiv:2609.31630v1 Announce Type: new Abstract: Replay-based continual learning.

### [OMP-MoE: Efficient Expert Pruning](https://arxiv.org/abs/2609.31631)

arXiv:2609.31631v1 Announce Type: new Abstract: Mixture-of-Experts pruning.
`;

describe('platform/feedFetch —— 经读取服务读源（D55）', () => {
  it('FF#10 读取服务返回的是**渲染结果**（没有 <item>）：专用解析器认得 HTML 与 markdown 两种', () => {
    const html = parseReaderList(READER_HTML);
    expect(html.length).toBeGreaterThanOrEqual(2);
    expect(html[0].url).toBe('https://arxiv.org/abs/2609.31630');
    expect(html[0].title).toContain('Replay in the Silent Degrees');
    expect(html[0].text).toContain('Abstract');
    // 用 RSS 的解析器去套渲染结果 ⇒ 一条都没有（这就是必须另写解析器的原因）
    expect(parseFeedXml(READER_HTML)).toEqual([]);

    const md = parseReaderList(READER_MD);
    expect(md).toHaveLength(2);
    expect(md[1].url).toBe('https://arxiv.org/abs/2609.31631');
    expect(md[1].title).toContain('OMP-MoE');
  });

  it('FF#11 没配读取服务 ⇒ 行为不变（blocked，且 readerTried=false 让 UI 叫玩家去配）', async () => {
    const r = await fetchSourceItems(arxiv, {
      fetchImpl: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blocked).toBe(true);
      expect(r.readerTried).toBe(false);
      expect(r.reason).toContain('跨域');
    }
  });

  it('FF#12 配了读取服务 ⇒ 经它读回条目，并标上 via=reader（直连必然是失败的）', async () => {
    const calls: string[] = [];
    const fake = ((input: string, init?: RequestInit) => {
      calls.push(input);
      if (input.startsWith('https://r.jina.ai/')) {
        return Promise.resolve(
          new Response(READER_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } }),
        );
      }
      return Promise.reject(new TypeError('CORS'));
    }) as unknown as typeof fetch;

    const r = await fetchSourceItems(arxiv, { fetchImpl: fake, reader: { url: 'https://r.jina.ai/', key: 'jin_x' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.via).toBe('reader');
      expect(r.items.length).toBeGreaterThanOrEqual(2);
      expect(r.items[0].sourceId).toBe(arxiv.id);
    }
    // 实测没有 ACAO 的源 ⇒ **先走读取服务**（直读那 700KB 不必白跑）
    expect(calls[0].startsWith('https://r.jina.ai/')).toBe(true);
    // 目标地址必须整段编码（否则服务会把它自己的查询参数吃进去）
    expect(calls[0]).toContain(encodeURIComponent(arxiv.url));
    expect(calls.some((c) => c === arxiv.url)).toBe(false);
  });

  it('FF#13 读取服务请求带上它自己的 Key 与 x-respond-with（不串用玩家的 LLM Key）', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fake = ((input: string, init?: RequestInit) => {
      seen = { url: input, headers: (init?.headers ?? {}) as Record<string, string> };
      return Promise.resolve(new Response(READER_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    }) as unknown as typeof fetch;

    await fetchSourceItems(arxiv, { fetchImpl: fake, reader: { url: 'https://r.jina.ai', key: 'jin_abc' } });
    expect(seen).not.toBeNull();
    const s2 = seen as unknown as { url: string; headers: Record<string, string> };
    expect(s2.url.startsWith('https://r.jina.ai/')).toBe(true); // 结尾没斜杠也要补上
    expect(s2.headers.Authorization).toBe('Bearer jin_abc');
    expect(s2.headers['x-respond-with']).toBe('html');
  });

  it('FF#14 读取服务也没成 ⇒ 文案说清"是读取服务那边没读到"，且 readerTried=true（UI 不再叫玩家去配）', async () => {
    const fake = (() => Promise.resolve(new Response('nope', { status: 429 }))) as unknown as typeof fetch;
    const r = await fetchSourceItems(arxiv, { fetchImpl: fake, reader: { url: 'https://r.jina.ai/', key: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.readerTried).toBe(true);
      expect(r.reason).toContain('读取服务');
      expect(r.reason).toContain('429');
      expect(r.blocked).toBe(false);
    }
  });

  it('FF#15 直连可读的源仍是直连优先（配了读取服务也不改路线）', async () => {
    const calls: string[] = [];
    const fake = ((input: string) => {
      calls.push(input);
      return Promise.resolve(new Response(RSS, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }));
    }) as unknown as typeof fetch;
    const r = await fetchSourceItems(rssSource, { fetchImpl: fake, reader: { url: 'https://r.jina.ai/', key: '' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe('direct');
    expect(calls).toEqual([rssSource.url]);
  });
});

/* ------------------------------------------------------------------ D61：全文地址 */

/**
 * 判别力：
 * - FF#F1 HF 论文条目带上 **arXiv HTML 全文地址**（`/html/<id>`）—— 有它屏上才显示「取全文再出卡」；
 * - FF#F2 id 形状不像 arXiv 编号 ⇒ **不瞎猜**（宁可不给入口，也不要给一个必然 404 的地址）；
 * - FF#F3 别家来源（HN / GitHub）没有这个概念 ⇒ 不带这个字段。
 */
describe('feedFetch —— 全文地址（D61）', () => {
  it('FF#F1/F2 有 arXiv 编号才给全文地址', () => {
    const papers = parseJsonItems('hf-papers', [
      { title: 'A Paper', summary: '摘要', paper: { id: '2609.32704' } },
      { title: 'Strange Id', summary: '摘要', paper: { id: 'not-an-id' } },
    ]);
    expect(papers[0].fullTextUrl).toBe('https://arxiv.org/html/2609.32704');
    expect(papers[1].fullTextUrl).toBeUndefined();
  });

  it('FF#F3 其它来源不带这个字段', () => {
    const hn = parseJsonItems('hn', {
      hits: [{ title: 'Post', url: 'https://a.com/x', created_at: '2026-09-28T17:58:11Z', points: 5, objectID: '1' }],
    });
    expect(hn).toHaveLength(1);
    expect(hn[0].fullTextUrl).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ D62：小端点与截断 */

/**
 * 判别力：
 * - FF#T1 内置的 arXiv 源必须走**官方小接口**（`export.arxiv.org/api/query`）——
 *   换回 `rss.arxiv.org`（每天 300+ 条、经读取服务渲染 2.6 MB）就当场红：
 *   那正是"第一个源读完，后面几个全超时"的现场原因；
 * - FF#T2 文本清单**解析前截断**（512 KB）：超长清单不再整份拒，且前面的条目照样解析出来；
 * - FF#T3 截断不影响 JSON 源（JSON 一旦截断就整个解析不了）。
 */
describe('platform/feedFetch —— 小端点优先与解析前截断（D62）', () => {
  it('FF#T1 arXiv 源走官方小接口，且带 max_results', () => {
    const flat = BUILTIN_DOMAINS.flatMap((d) => d.sources);
    const arxiv = flat.filter((s) => s.id.startsWith('arxiv-'));
    expect(arxiv.length).toBeGreaterThanOrEqual(2);
    for (const s of arxiv) {
      expect(s.url, `${s.id} 应走官方接口`).toContain('export.arxiv.org/api/query');
      expect(s.url).toContain('max_results=20'); // 只要 20 条：体积小、来得快
      expect(s.url).not.toContain('rss.arxiv.org');
    }
  });

  it('FF#T2 超长 RSS：解析前截断，前面的条目照常出来，且**如实申报**截断过', async () => {
    const head = '<rss><channel>'
      + '<item><title>最新的一条</title><link>https://x/a</link><description>摘要 A</description></item>'
      + '</channel>';
    const filler = '<item><title>旧条目</title><link>https://x/old</link></item>'.repeat(20_000); // 远超 512KB
    const body = head + filler;

    const big = await fetchSourceItems(
      { id: 'big', name: '超长清单', url: 'https://x.example/feed.xml', kind: 'rss', direct: true },
      { fetchImpl: fakeFetch(() => res(body)) },
    );
    expect(big.ok).toBe(true);
    if (!big.ok) return;
    expect(big.items[0]?.title).toBe('最新的一条');
    // 不截断的话这个 flag 不会出现 ⇒ 删掉那行 slice 的实现必红
    expect(big.truncatedForParse).toBe(true);
    // 而且**只解析了截断后的那一段**：整份有 20000 条，截断后明显更少
    // （去掉 slice 的实现会解析出全部 20000 条 ⇒ 这条断言会红）
    expect(big.items.length).toBeLessThan(15_000);

    const small = await fetchSourceItems(
      { id: 'small', name: '短清单', url: 'https://x.example/small.xml', kind: 'rss', direct: true },
      { fetchImpl: fakeFetch(() => res(head)) },
    );
    expect(small.ok).toBe(true);
    if (small.ok) expect(small.truncatedForParse).toBeUndefined();
  });

  it('FF#T3 JSON 端点不受文本截断影响', () => {
    const items = parseJsonItems('hn', { hits: [{ title: 'Post', url: 'https://a.com/x', objectID: '1' }] });
    expect(items).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ D62 后半：路数、预算、取消 */

/**
 * 判别力：
 * - FF#D1 `direct:false` 的源**只走读取服务**（原来读取服务失败后再白等 15 秒直连 ——
 *   那些源的实测结论就是"没有 ACAO"，直连必然失败）；
 * - FF#D2 读取服务有自己的 25 秒预算（整页渲染回传本来就慢，15 秒不够就全是超时）；
 * - FF#D3 屏上点「取消」⇒ 在途请求真的被掐断，结果如实回「已取消」，不冒充超时。
 */
describe('platform/feedFetch —— 路数、预算与取消（D62）', () => {
  it('FF#D1 direct:false 只试读取服务（不再白跑直连）', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((target: string) => {
      calls.push(String(target));
      // 读取服务回来的是**渲染后的 HTML**（不是 XML）⇒ 用 parseReaderList 认得的那种形状
      return Promise.resolve(res('<h3><a href="https://x/a">一条论文</a></h3><p>摘要文字</p>'));
    }) as unknown as typeof fetch;

    const r = await fetchSourceItems(
      { id: 'x', name: 'X', url: 'https://x.example/feed.xml', kind: 'rss', direct: false },
      { fetchImpl, reader: { url: 'https://reader.example', key: '' } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe('reader');
    expect(calls).toHaveLength(1); // 只发了**一次**请求
    expect(calls[0]).toContain('reader.example');
  });

  it('FF#D2 读取服务预算 25 秒（比直读宽）', () => {
    expect(READER_TIMEOUT_MS).toBe(25_000);
    expect(READER_TIMEOUT_MS).toBeGreaterThan(FEED_TIMEOUT_MS);
  });

  it('FF#D3 外部取消 ⇒ 掐断在途请求，如实回"已取消"', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_t: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const pending = fetchSourceItems(rssSource, { fetchImpl, signal: controller.signal });
    controller.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('已取消');
      expect(r.reason).not.toContain('超时'); // 取消不是超时，别混为一谈
    }
  });
});
