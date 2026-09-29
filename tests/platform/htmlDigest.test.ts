// @vitest-environment happy-dom
/**
 * tests/platform/htmlDigest.test.ts —— Plan 8 · T2：把 HTML 变成「正文 + 条目」。
 *
 * 判别力（每条都写清"坏实现为何必红"）：
 * - HD#1 脚本/样式必须被剥掉（把 <script> 源码当正文是最脏的失败：模型会去"总结"JS）；
 * - HD#2 `article` 优先于 `body`（否则导航/页脚噪声全进正文，"进入一层"的条目也没了语义）；
 * - HD#3 相对链接必须按 baseUrl 绝对化（否则点进去是 404 相对路径）；
 * - HD#5 同 url 只留一条（重复条目会让玩家看到一排一样的标题）；
 * - HD#6 超长按**码点**截断（`.slice` 会劈开代理对，产出乱码正文）。
 */
import { describe, expect, it } from 'vitest';
import { ARTICLE_MAX_CHARS, LINKS_MAX, digestHtml } from '../../src/platform/htmlDigest';

const BASE = 'https://news.example/column/index.html';

function page(body: string, head = ''): string {
  return `<!doctype html><html><head><title>栏目页</title>${head}</head><body>${body}</body></html>`;
}

describe('digestHtml —— 正文', () => {
  it('HD#1 剥掉 script/style/noscript，正文里不出现脚本源码', () => {
    const html = page(`
      <script>var secret = "SHOULD_NOT_APPEAR";</script>
      <style>.x{color:red}</style>
      <noscript>请开启 JS</noscript>
      <p>这是正文第一段。</p><p>这是第二段。</p>
    `);
    const d = digestHtml(html, BASE);
    expect(d.text).toContain('这是正文第一段');
    expect(d.text).toContain('这是第二段');
    expect(d.text).not.toContain('SHOULD_NOT_APPEAR');
    expect(d.text).not.toContain('color:red');
    expect(d.text).not.toContain('请开启 JS');
  });

  it('HD#1c 正文容器里**没有块级元素**时（走 textContent 路径），脚本同样不许漏进来', () => {
    // 判别力：HD#1 的页面里有 <p>，于是"按块级元素取正文"正好把脚本挡在外面——
    // 那条用例其实测不出"有没有删脚本"（变异实测 M1 没牙）。这里刻意不给块级元素。
    const html = page(`<div>真正的正文<span>。</span><script>var leak="LEAKED_JS";</script></div>`);
    const d = digestHtml(html, BASE);
    expect(d.text).toContain('真正的正文');
    expect(d.text).not.toContain('LEAKED_JS');
  });

  it('HD#2 article 优先于 body：页脚/侧栏噪声不进正文', () => {
    const html = page(`
      <nav>首页 · 关于我们 · 联系</nav>
      <article><h1>真正的文章</h1><p>文章正文在此。</p></article>
      <aside>推荐阅读：八卦新闻</aside>
      <footer>版权所有</footer>
    `);
    const d = digestHtml(html, BASE);
    expect(d.text).toContain('文章正文在此');
    expect(d.text).not.toContain('版权所有');
    expect(d.text).not.toContain('八卦新闻');
  });

  it('HD#2b 没有 article/main 时回落到 body，但仍剥掉 nav/footer', () => {
    const html = page(`<nav>导航</nav><div><p>裸 body 的正文。</p></div><footer>页脚</footer>`);
    const d = digestHtml(html, BASE);
    expect(d.text).toContain('裸 body 的正文');
    expect(d.text).not.toContain('导航');
    expect(d.text).not.toContain('页脚');
  });

  it('HD#6 超长正文按码点截断，且不劈开代理对', () => {
    // 刻意以 1 个 ASCII 字符开头：这样"按 UTF-16 单元 slice"会在奇偶边界上劈开一个代理对
    // （纯 emoji 的输入恰好落在偶边界上，`.slice` 也能蒙对——首版就是这么放跑 M4 的）
    const emoji = `A${'🐉'.repeat(ARTICLE_MAX_CHARS + 50)}`; // 12051 码点 / 24001 单元
    const d = digestHtml(page(`<p>${emoji}</p>`), BASE);
    expect([...d.text].length).toBe(ARTICLE_MAX_CHARS); // 按码点截满（.slice 只会剩一半）
    expect(d.text).not.toContain('\uFFFD');
    expect(/[\uD800-\uDBFF]$/.test(d.text)).toBe(false); // 末尾不是孤立高代理
  });

  it('HD#7 畸形 HTML（未闭合标签）不抛，仍能给出正文', () => {
    const broken = '<html><body><div><p>没闭合的段落<b>加粗<script>x</script>';
    expect(() => digestHtml(broken, BASE)).not.toThrow();
    const d = digestHtml(broken, BASE);
    expect(d.text).toContain('没闭合的段落');
  });

  it('HD#7b 空/脏输入不抛，标题与正文都给得出（可能为空）', () => {
    for (const bad of ['', '   ', '<html></html>', '这不是 HTML']) {
      const d = digestHtml(bad, BASE);
      expect(typeof d.title).toBe('string');
      expect(typeof d.text).toBe('string');
      expect(Array.isArray(d.links)).toBe(true);
    }
  });

  it('HD#1b 标题取 <title>（或 <h1>），剥控制字符并按码点截到 ≤120', () => {
    expect(digestHtml(page('<p>x</p>'), BASE).title).toBe('栏目页');
    const noTitle = digestHtml('<html><body><h1>一级标题</h1><p>x</p></body></html>', BASE);
    expect(noTitle.title).toBe('一级标题');
    const dirty = digestHtml(`<html><head><title>${'甲'.repeat(200)}\u202e尾</title></head><body>x</body></html>`, BASE);
    expect([...dirty.title].length).toBeLessThanOrEqual(120);
    expect(dirty.title).not.toContain('\u202e');
  });
});

describe('digestHtml —— 条目（"进入一层"的落点）', () => {
  it('HD#3 相对链接按 baseUrl 绝对化，标题取锚文本', () => {
    const html = page(`
      <article>
        <a href="/a/one.html">第一篇</a>
        <a href="two.html">第二篇</a>
        <a href="https://other.example/three">第三篇</a>
      </article>
    `);
    const d = digestHtml(html, BASE);
    const urls = d.links.map((l) => l.url);
    expect(urls).toContain('https://news.example/a/one.html');
    expect(urls).toContain('https://news.example/column/two.html');
    expect(urls).toContain('https://other.example/three');
    expect(d.links.find((l) => l.url.endsWith('/a/one.html'))?.title).toBe('第一篇');
  });

  it('HD#4 非 http(s) 链接与空标题被过滤（javascript: 不能变成"可点条目"）', () => {
    const html = page(`
      <article>
        <a href="javascript:alert(1)">点我</a>
        <a href="mailto:x@example.com">写信</a>
        <a href="#anchor">锚点</a>
        <a href="/a/ok.html">   </a>
        <a href="/column/index.html">指向本页的链接</a>
        <a href="/a/good.html">正常条目</a>
      </article>
    `);
    const d = digestHtml(html, BASE);
    const urls = d.links.map((l) => l.url);
    // 同页锚点 + 指向本页的链接都不是"新的文章"，只有 good.html 该留下
    expect(urls).toEqual(['https://news.example/a/good.html']);
  });

  it('HD#5 同 url 只留一条；同名不同 url 都保留', () => {
    const html = page(`
      <article>
        <a href="/a/x.html">标题 A</a>
        <a href="/a/x.html">标题 A（重复）</a>
        <a href="/b/x.html">标题 A</a>
      </article>
    `);
    const d = digestHtml(html, BASE);
    expect(d.links.map((l) => l.url)).toEqual(['https://news.example/a/x.html', 'https://news.example/b/x.html']);
  });

  it('HD#8 同源链接排在异源前面（栏目页里"本站的文章"最可能是玩家要的）', () => {
    const html = page(`
      <article>
        <a href="https://other.example/1">外站一</a>
        <a href="/local/2.html">本站二</a>
        <a href="https://other.example/2">外站二</a>
        <a href="/local/1.html">本站一</a>
      </article>
    `);
    const d = digestHtml(html, BASE);
    expect(d.links.map((l) => l.url)).toEqual([
      'https://news.example/local/2.html',
      'https://news.example/local/1.html',
      'https://other.example/1',
      'https://other.example/2',
    ]);
  });

  it('HD#9 条目数量封顶 LINKS_MAX', () => {
    const many = Array.from({ length: LINKS_MAX + 15 }, (_, i) => `<a href="/a/${i}.html">条目 ${i}</a>`).join('');
    const d = digestHtml(page(`<article>${many}</article>`), BASE);
    expect(d.links).toHaveLength(LINKS_MAX);
  });
});
