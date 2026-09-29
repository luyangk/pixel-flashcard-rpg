/**
 * ingestFlow.ts —— Plan 8 · T3：摄入分类（"给个链接之后到底能做什么"的唯一分叉点）。
 *
 * ## 三条分支，各有各的下一步
 * | 结果 | 含义 | UI 该做什么 |
 * |---|---|---|
 * | `article` | 拿到了正文（直读或经读取服务） | 直接进"生成候选卡" |
 * | `links` | 只是一个**栏目页**（正文太短、但有条目） | 列出条目让玩家**进入一层** |
 * | `blocked` | 没拿到（被 CORS 拦 / 404 / 不是网页 / 页面没内容） | 说清原因 + 给"粘贴正文 / 存进待读清单" |
 *
 * `blocked.blocked` 区分"这个站点不允许网页直读"（true，换条路也白搭 → 请玩家粘贴）
 * 与"别的问题"（false，比如 404）。
 *
 * ## 为什么放在 app 层
 * 本层只做分类与编排，抓取在 `platform/pageFetch`、解析在 `platform/htmlDigest` ——
 * 两者都经参数注入，因此这条分叉能在测试里被逐条穷举（不需要联网、也不需要真 DOM）。
 * **永不抛**：任何一步炸掉都收敛成 `blocked`。
 */
import type { PageDigest, PageLink } from '@platform/htmlDigest';
import type { PageFetchResult } from '@platform/pageFetch';

/**
 * 正文长度门槛：低于它就不当"一篇文章"。
 * 200 码点是个保守的下限——新闻/公众号正文远超它，而目录页、登录页、错误页通常远低于它。
 */
export const ARTICLE_MIN_CHARS = 200;

export type IngestResult =
  | {
      readonly kind: 'article';
      readonly title: string;
      readonly text: string;
      readonly url: string;
      readonly via: 'direct' | 'reader';
    }
  | {
      readonly kind: 'links';
      readonly title: string;
      readonly url: string;
      readonly links: readonly PageLink[];
    }
  | {
      readonly kind: 'blocked';
      readonly url: string;
      readonly reason: string;
      readonly blocked: boolean;
    };

export interface IngestDeps {
  readonly fetchPage: (url: string) => Promise<PageFetchResult>;
  readonly digestHtml: (html: string, baseUrl: string) => PageDigest;
}

/** 分类一次抓取结果。 */
export function ingestUrl(deps: IngestDeps, url: string): Promise<IngestResult> {
  const target = typeof url === 'string' ? url : '';
  return Promise.resolve()
    .then(() => deps.fetchPage(target))
    .then((res): IngestResult => {
      if (!res || res.ok !== true) {
        const reason = res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '抓取失败了。';
        return { kind: 'blocked', url: target, reason, blocked: res?.blocked === true };
      }
      // 读取服务给的已经是纯文本 ⇒ 不再当 HTML 解析（再解析一次只会把换行吃掉）
      if (res.via === 'reader') {
        return { kind: 'article', title: '', text: res.text, url: target, via: 'reader' };
      }
      let digest: PageDigest;
      try {
        digest = deps.digestHtml(res.text, target);
      } catch (e) {
        return {
          kind: 'blocked',
          url: target,
          reason: `这个页面读不出来：${e instanceof Error ? e.message : String(e)}`,
          blocked: false,
        };
      }
      const text = typeof digest?.text === 'string' ? digest.text : '';
      const title = typeof digest?.title === 'string' ? digest.title : '';
      const links = Array.isArray(digest?.links) ? digest.links : [];
      if ([...text].length >= ARTICLE_MIN_CHARS) {
        return { kind: 'article', title, text, url: target, via: 'direct' };
      }
      if (links.length > 0) {
        // 正文太短但有条目 ⇒ 这是一张目录/栏目页：让玩家挑一条（"进入一层"）
        return { kind: 'links', title, url: target, links };
      }
      return {
        kind: 'blocked',
        url: target,
        reason: '这个页面里没找到正文，也没有可点的条目。',
        blocked: false,
      };
    })
    .catch((e: unknown): IngestResult => ({
      kind: 'blocked',
      url: target,
      // 抓取口自己抛错（注入实现违约 / 浏览器层意外）：按"被拦"处理 —— 让玩家看到
      // "请粘贴正文"这条真有用的出路，而不是一句"未知错误"
      reason: `抓取失败：${e instanceof Error ? e.message : String(e)}`,
      blocked: true,
    }));
}
