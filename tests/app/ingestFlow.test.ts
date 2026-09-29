/**
 * tests/app/ingestFlow.test.ts —— Plan 8 · T3：摄入分类（直读 / 进一层 / 被拒）。
 *
 * 这一层是"给个链接之后到底能做什么"的**唯一分叉点**，所以每条分支都要钉死：
 * - IG#1 抓得到正文 ⇒ `article`（后面直接生成卡）；
 * - IG#3 **只有条目**的栏目页 ⇒ `links`（玩家挑一条再抓 = "进入一层"）；
 * - IG#5 既没正文也没条目 ⇒ `blocked` 但 `blocked:false`（换条路也没用，得让玩家粘贴）；
 * - IG#6 被 CORS 拦 ⇒ `blocked:true`（UI 据此给"粘贴正文 / 进待读清单"的出路）；
 * - IG#7 解析本身抛错也得收敛成 blocked（**绝不把异常扔给 UI**）；
 * - IG#2 经读取服务拿到的已经是纯文本 ⇒ 直接当正文，不再当 HTML 解析。
 */
import { describe, expect, it } from 'vitest';
import { ARTICLE_MIN_CHARS, ingestUrl } from '../../src/app/ingestFlow';
import type { PageDigest } from '../../src/platform/htmlDigest';
import type { PageFetchResult } from '../../src/platform/pageFetch';

const URL_A = 'https://news.example/a.html';

function ok(text: string, via: 'direct' | 'reader' = 'direct'): PageFetchResult {
  return { ok: true, text, contentType: via === 'reader' ? 'text/plain' : 'text/html', finalUrl: URL_A, via };
}
function fail(reason: string, blocked: boolean): PageFetchResult {
  return { ok: false, reason, blocked };
}
function digest(over: Partial<PageDigest> = {}): PageDigest {
  return { title: '标题', text: '', links: [], ...over };
}

/** 注入两个口：只关心"分类"，不关心真实抓取/解析（那两层各自有自己的用例）。 */
function deps(fetched: PageFetchResult, digested: PageDigest = digest(), onDigest?: () => void) {
  return {
    fetchPage: () => Promise.resolve(fetched),
    digestHtml: () => {
      onDigest?.();
      return digested;
    },
  };
}

describe('ingestUrl —— 三条分支', () => {
  it('IG#1 抓得到足够长的正文 ⇒ article（title/text/url/via 齐）', async () => {
    const long = '正文'.repeat(ARTICLE_MIN_CHARS);
    const res = await ingestUrl(deps(ok('<html/>'), digest({ title: '一篇文章', text: long })), URL_A);
    expect(res.kind).toBe('article');
    if (res.kind !== 'article') return;
    expect(res.title).toBe('一篇文章');
    expect(res.text).toBe(long);
    expect(res.url).toBe(URL_A);
    expect(res.via).toBe('direct');
  });

  it('IG#2 经读取服务拿到的已是纯文本 ⇒ 直接当正文，不再喂给 HTML 解析', async () => {
    let digested = false;
    const text = '读取服务返回的纯文本正文'.repeat(20);
    const res = await ingestUrl(deps(ok(text, 'reader'), digest(), () => void (digested = true)), URL_A);
    expect(res.kind).toBe('article');
    if (res.kind === 'article') {
      expect(res.text).toBe(text);
      expect(res.via).toBe('reader');
    }
    expect(digested, '纯文本不该再走 HTML 解析').toBe(false);
  });

  it('IG#3 正文太短但有条目 ⇒ links（这就是"进入一层"的落点）', async () => {
    const links = [
      { title: '第一篇', url: 'https://news.example/1.html' },
      { title: '第二篇', url: 'https://news.example/2.html' },
    ];
    const res = await ingestUrl(deps(ok('<html/>'), digest({ title: '栏目页', text: '短', links })), URL_A);
    expect(res.kind).toBe('links');
    if (res.kind !== 'links') return;
    expect(res.title).toBe('栏目页');
    expect(res.links).toEqual(links);
  });

  it('IG#4 正文长度**恰好**到门槛 ⇒ article（边界不当成"太短"）', async () => {
    const exact = '甲'.repeat(ARTICLE_MIN_CHARS);
    const res = await ingestUrl(deps(ok('<html/>'), digest({ text: exact })), URL_A);
    expect(res.kind).toBe('article');
    const short = '甲'.repeat(ARTICLE_MIN_CHARS - 1);
    const res2 = await ingestUrl(deps(ok('<html/>'), digest({ text: short, links: [{ title: 'x', url: 'https://news.example/x' }] })), URL_A);
    expect(res2.kind).toBe('links');
  });

  it('IG#5 既没正文也没条目 ⇒ blocked:false + 人话（换条路也一样，得让玩家粘贴）', async () => {
    const res = await ingestUrl(deps(ok('<html/>'), digest({ text: '', links: [] })), URL_A);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.blocked).toBe(false);
    expect(res.reason).toContain('没找到正文');
    expect(res.url).toBe(URL_A);
  });

  it('IG#6 抓取被 CORS 拦 ⇒ blocked:true 原样透传（UI 据此给"粘贴/清单"的出路）', async () => {
    const res = await ingestUrl(deps(fail('这个站点不允许网页直读（跨域限制）。', true)), URL_A);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain('不允许网页直读');
  });

  it('IG#7 解析抛错 ⇒ 收敛成 blocked，绝不把异常扔给 UI', async () => {
    const bad = {
      fetchPage: () => Promise.resolve(ok('<html/>')),
      digestHtml: () => {
        throw new Error('解析炸了');
      },
    };
    const res = await ingestUrl(bad, URL_A);
    expect(res.kind).toBe('blocked');
    if (res.kind === 'blocked') {
      expect(res.reason.length).toBeGreaterThan(0);
      // **解析失败不是"这个站点不允许直读"**（抓取明明成功了）：若把它标成 blocked:true，
      // 玩家会收到"这个站点不允许网页直读"的误导，并去走一条根本没坏的路。
      // （变异实测：不钉这一条时"内层 catch 改成 rethrow"是等价变异，测不出来。）
      expect(res.blocked).toBe(false);
    }
  });

  it('IG#7b 抓取本身抛错（注入实现违约）⇒ 同样收敛，不抛', async () => {
    const bad = {
      fetchPage: () => Promise.reject(new Error('boom')),
      digestHtml: () => digest(),
    };
    const res = await ingestUrl(bad, URL_A);
    expect(res.kind).toBe('blocked');
    if (res.kind === 'blocked') expect(res.blocked).toBe(true);
  });

  it('IG#8 同一 URL 两次调用结果一致（本层无隐藏状态）', async () => {
    const long = '正文'.repeat(ARTICLE_MIN_CHARS);
    const d = deps(ok('<html/>'), digest({ text: long }));
    const a = await ingestUrl(d, URL_A);
    const b = await ingestUrl(d, URL_A);
    expect(a).toEqual(b);
  });
});
