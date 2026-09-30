// @vitest-environment happy-dom
/**
 * tests/ui/practice.collect.test.ts —— Plan 8 · T6：采新卡（链接/粘贴 → 候选 → 选领域 → 入库）。
 *
 * 判别力（每条都写清"坏实现为何必红"）：
 * - PC#1 `article` ⇒ 直接出候选（把正文再丢给玩家看一眼才生成的实现，多一步没意义）；
 * - PC#2 `links` ⇒ 列条目；**点条目要再抓一次**（这就是"进入一层"，不实现等于这条需求没做）；
 * - PC#3 被拦 ⇒ 如实说明 + **自动进待读清单**（丢掉玩家刚给的链接是最恼人的失败）；
 * - PC#4 候选**默认全不勾**（抓来的页面玩家没读过，替他预勾就是替他背书）；
 * - PC#5 入库时 `sourceType` / `url` / `choices` 都要带对（丢了 url 就没法溯源，
 *   丢了 choices 就把"选项在生成时算一次"的设计废掉）；
 * - PC#6 可以用一个还不存在的领域名建领域再入库；重名时如实报错；
 * - PC#7 生成失败 ⇒ 文案上屏且**卡库零变化**；
 * - PC#9 「全选」真的勾满；
 * - PC#10 DOM 全树不出现 `sk-` 形状的明文（Key 永远不该进这个屏）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, Deck } from '@core/types';
import type { IngestResult } from '../../src/app/ingestFlow';
import type { CollectResult } from '../../src/app/knowledgeFlow';
import type { InboxItem } from '../../src/platform/inboxStore';
import { mountPracticeCollect, type CollectDeps } from '../../src/ui/practiceCollect';
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

const CANDIDATE = { front: '唐朝开国皇帝是谁？', back: '李渊', tags: ['历史'], choices: ['李世民', '杨坚'] };

function makeRig(
  over: {
    ingest?: (url: string) => Promise<IngestResult>;
    collect?: (input: { text: string; deckName: string; want?: number }) => Promise<CollectResult>;
    inboxInitial?: InboxItem[];
    /** 来源库口（D61：给「取全文再出卡」用）。 */
    sources?: CollectDeps['sources'];
    addCardOk?: boolean;
    addDeckOk?: boolean;
  } = {},
) {
  const root = makeRoot();
  const decks: Deck[] = [makeDeck('d1', '唐诗'), makeDeck('d2', '历史')];
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave({ decks, cards: [] }) }));
  let inbox: InboxItem[] = [...(over.inboxInitial ?? [])];
  const addCardCalls: Array<Record<string, unknown>> = [];
  const addDeckCalls: Array<Record<string, unknown>> = [];
  const ingestCalls: string[] = [];
  const collectCalls: Array<{ text: string; deckName: string; want?: number }> = [];
  let seq = 0;
  const deps: CollectDeps = {
    toastMs: 0,
    newId: () => `id-${++seq}`,
    ingestUrl:
      over.ingest ??
      ((url) => {
        ingestCalls.push(url);
        return Promise.resolve({ kind: 'blocked', url, reason: '这个站点不允许网页直读（跨域限制）。', blocked: true });
      }),
    collectCards:
      over.collect ??
      ((input) => {
        collectCalls.push(input);
        return Promise.resolve({
          ok: true,
          candidates: [CANDIDATE],
          quota: { day: '2026-11-01', cards: 1, judges: 0 },
          requests: 1,
          truncated: false,
        } satisfies CollectResult);
      }),
    inbox: {
      load: () => [...inbox],
      save: (items) => {
        inbox = [...items];
        return true;
      },
      clear: () => {
        inbox = [];
      },
    },
    ...(over.sources === undefined ? {} : { sources: over.sources }),
    addCard: (input) => {
      addCardCalls.push(input as unknown as Record<string, unknown>);
      return Promise.resolve(
        over.addCardOk === false
          ? { ok: false as const, reason: '加卡失败：卡片编号和已有的一张撞了。' }
          : { ok: true as const, value: makeCard(input.id, { deckId: input.deckId }) as Card },
      );
    },
    addDeck: (input) => {
      addDeckCalls.push(input as unknown as Record<string, unknown>);
      return Promise.resolve(
        over.addDeckOk === false
          ? { ok: false as const, reason: '已经有同名（或同编号）的领域了。' }
          : { ok: true as const, value: makeDeck(input.id, input.name) },
      );
    },
  };
  mountPracticeCollect(root, ctrl, deps);
  return { root, ctrl, deps, addCardCalls, addDeckCalls, ingestCalls, collectCalls, inboxNow: () => inbox };
}

const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, text: string): void => {
  el.value = text;
  el.dispatchEvent(new Event('input'));
};
const candidateChecks = (root: HTMLElement): HTMLInputElement[] =>
  all(root, '[data-candidate-check]') as HTMLInputElement[];

describe('mountPracticeCollect —— 来源与"进入一层"', () => {
  it('PC#1 粘贴正文 ⇒ 直接生成候选（一张，默认不勾）', async () => {
    const rig = makeRig();
    typeInto(ui(rig.root, 'source-text') as HTMLTextAreaElement, '一段资料');
    click(ui(rig.root, 'source-paste-go'));
    await flushMicrotasks();

    expect(rig.collectCalls).toHaveLength(1);
    expect(rig.collectCalls[0].text).toContain('一段资料');
    const rows = all(rig.root, '[data-candidate]');
    expect(rows).toHaveLength(1);
    expect(candidateChecks(rig.root).every((c) => !c.checked)).toBe(true); // 默认全不勾
    expect(ui(rig.root, 'cand-save').hasAttribute('disabled')).toBe(false);
  });

  it('PC#2 链接是栏目页 ⇒ 列条目；点条目**再抓一次**那条（进入一层）', async () => {
    const seen: string[] = [];
    const rig = makeRig({
      ingest: (url) => {
        seen.push(url);
        if (url === 'https://news.example/column') {
          return Promise.resolve({
            kind: 'links',
            title: '栏目页',
            url,
            links: [
              { title: '第一篇', url: 'https://news.example/1' },
              { title: '第二篇', url: 'https://news.example/2' },
            ],
          });
        }
        return Promise.resolve({ kind: 'article', title: '第一篇', text: '正文'.repeat(300), url, via: 'direct' });
      },
    });
    typeInto(ui(rig.root, 'source-url') as HTMLInputElement, 'https://news.example/column');
    click(ui(rig.root, 'source-go'));
    await flushMicrotasks();

    const links = all(rig.root, '[data-ingest-link]');
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toContain('第一篇');

    click(links[0]);
    await flushMicrotasks();
    expect(seen).toEqual(['https://news.example/column', 'https://news.example/1']);
    expect(all(rig.root, '[data-candidate]')).toHaveLength(1); // 第二次抓到的正文已生成候选
  });

  it('PC#11 被拦 ⇒ 不止报错：露出「打开原文去复制」、点了真的打开、并聚焦粘贴框（D48）', async () => {
    const opened: string[] = [];
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave({ decks: [makeDeck('d1', '唐诗')], cards: [] }) }));
    mountPracticeCollect(root, ctrl, {
      toastMs: 0,
      newId: () => 'i1',
      openUrl: (u) => void opened.push(u),
      ingestUrl: (url) =>
        Promise.resolve({ kind: 'blocked', url, reason: '这个站点不允许网页直读（跨域限制）。', blocked: true }),
      inbox: { load: () => [], save: () => true, clear: () => undefined },
    });
    typeInto(ui(root, 'source-url') as HTMLInputElement, 'https://mp.weixin.qq.com/s/abc');
    click(ui(root, 'source-go'));
    await flushMicrotasks();

    // ① 状态行给的是"下一步"，不只是原因
    expect(ui(root, 'ingest-status').textContent).toContain('粘到下面的框里');
    expect(ui(root, 'ingest-status').textContent).toContain('待读清单');
    // ② 「打开原文去复制」露出且真的打开那条链接
    expect(ui(root, 'ingest-open').hidden).toBe(false);
    click(ui(root, 'ingest-open'));
    expect(opened).toEqual(['https://mp.weixin.qq.com/s/abc']);
    // ③ 光标已在粘贴框里（玩家要做的正是"复制 + 粘贴"）
    expect(document.activeElement).toBe(ui(root, 'source-text'));
  });

  it('PC#3 被拦 ⇒ 如实说明 + 链接自动进待读清单', async () => {
    const rig = makeRig();
    typeInto(ui(rig.root, 'source-url') as HTMLInputElement, 'https://mp.weixin.qq.com/s/abc');
    click(ui(rig.root, 'source-go'));
    await flushMicrotasks();

    expect(ui(rig.root, 'ingest-status').textContent).toContain('不允许网页直读');
    const items = all(rig.root, '[data-inbox-item]');
    expect(items).toHaveLength(1);
    expect(rig.inboxNow()).toHaveLength(1);
    expect(rig.inboxNow()[0]?.url).toBe('https://mp.weixin.qq.com/s/abc');
  });

  it('PC#3b 清单里已有条目 ⇒ 渲染出来；「用它的正文生成」直接用、不再联网；「丢掉」能删', async () => {
    const rig = makeRig({
      inboxInitial: [
        { id: 'a', title: '公众号文章', url: 'https://mp.weixin.qq.com/s/abc', addedAt: 1 },
        { id: 'b', title: '我粘的', text: '已经粘好的正文', addedAt: 2 },
        // c 与 b 一样是"只有正文、没有链接"：它的存在是为了钉住**只出箱这一条**
        // （按 url 匹配的实现会把所有无 url 的条目一起放过 —— 变异实测 M7 首版就是这么没牙的）
        { id: 'c', title: '另一段粘的', text: '另一段正文', addedAt: 3 },
      ],
    });
    expect(all(rig.root, '[data-inbox-item]')).toHaveLength(3);
    click(rig.root.querySelector('[data-inbox-use="b"]') as HTMLElement);
    await flushMicrotasks();
    expect(rig.collectCalls[0]?.text).toContain('已经粘好的正文');
    // 生成阶段**还在**清单里（出箱的时机是"入库成功"，不是"开始生成"）
    expect(rig.inboxNow().map((i) => i.id)).toEqual(['a', 'b', 'c']);

    // 勾一张并入库 ⇒ b 出箱（它只粘了正文、没有 url，所以要按 id 匹配才对）
    const box = candidateChecks(rig.root)[0];
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    click(ui(rig.root, 'cand-save'));
    await flushMicrotasks();
    // b 出箱，而同样"只有正文"的 c **必须留着**（只出箱处理过的那一条）
    expect(rig.inboxNow().map((i) => i.id)).toEqual(['a', 'c']);

    click(rig.root.querySelector('[data-inbox-drop="a"]') as HTMLElement);
    await flushMicrotasks();
    expect(rig.inboxNow().map((i) => i.id)).toEqual(['c']);
  });
});

describe('mountPracticeCollect —— 候选与入库', () => {
  it('PC#9 「全选」勾满；再点一次取消（不勾的条目不入库）', async () => {
    const rig = makeRig({
      collect: () =>
        Promise.resolve({
          ok: true,
          candidates: [CANDIDATE, { ...CANDIDATE, front: '第二题' }],
          quota: { day: '2026-11-01', cards: 2, judges: 0 },
          requests: 1,
          truncated: false,
        }),
    });
    typeInto(ui(rig.root, 'source-text') as HTMLTextAreaElement, '资料');
    click(ui(rig.root, 'source-paste-go'));
    await flushMicrotasks();

    click(ui(rig.root, 'cand-select-all'));
    expect(candidateChecks(rig.root).every((c) => c.checked)).toBe(true);
    // 取消第一张：只存第二张
    const first = candidateChecks(rig.root)[0];
    first.checked = false;
    first.dispatchEvent(new Event('change'));
    click(ui(rig.root, 'cand-save'));
    await flushMicrotasks();
    expect(rig.addCardCalls).toHaveLength(1);
    expect(rig.addCardCalls[0].front).toBe('第二题');
  });

  it('PC#5 入库带对 sourceType/hotspot、url、choices', async () => {
    const rig = makeRig({
      // 这条用例走"链接直读成功"的路 ⇒ 注入一个 article 形态的抓取口
      // （默认夹具是"被拦"，首版忘了注入 ⇒ 候选压根没生成，用例报 undefined）
      ingest: (url) =>
        Promise.resolve({ kind: 'article', title: '一篇文章', text: '正文'.repeat(300), url, via: 'direct' }),
      collect: () =>
        Promise.resolve({
          ok: true,
          candidates: [CANDIDATE],
          quota: { day: '2026-11-01', cards: 1, judges: 0 },
          requests: 1,
          truncated: false,
        }),
    });
    // 从链接进来 ⇒ sourceType 应为 hotspot 且带 url
    typeInto(ui(rig.root, 'source-url') as HTMLInputElement, 'https://news.example/a');
    click(ui(rig.root, 'source-go'));
    await flushMicrotasks();
    candidateChecks(rig.root)[0].checked = true;
    candidateChecks(rig.root)[0].dispatchEvent(new Event('change'));
    click(ui(rig.root, 'cand-save'));
    await flushMicrotasks();

    const call = rig.addCardCalls[0];
    expect(call.sourceType).toBe('hotspot');
    expect(call.url).toBe('https://news.example/a');
    expect(call.choices).toEqual(['李世民', '杨坚']);
    expect(call.deckId).toBe('d1'); // 默认选第一个领域
  });

  it('PC#5b 纯粘贴（没有链接）⇒ sourceType 为 llm 且不带 url', async () => {
    const rig = makeRig();
    typeInto(ui(rig.root, 'source-text') as HTMLTextAreaElement, '资料');
    click(ui(rig.root, 'source-paste-go'));
    await flushMicrotasks();
    candidateChecks(rig.root)[0].checked = true;
    candidateChecks(rig.root)[0].dispatchEvent(new Event('change'));
    click(ui(rig.root, 'cand-save'));
    await flushMicrotasks();
    expect(rig.addCardCalls[0].sourceType).toBe('llm');
    expect(rig.addCardCalls[0].url).toBeUndefined();
  });

  it('PC#6 可以新建领域再入库；重名时如实报错且不静默吞', async () => {
    const rig = makeRig({ addDeckOk: false });
    typeInto(ui(rig.root, 'source-text') as HTMLTextAreaElement, '资料');
    click(ui(rig.root, 'source-paste-go'));
    await flushMicrotasks();
    candidateChecks(rig.root)[0].checked = true;
    candidateChecks(rig.root)[0].dispatchEvent(new Event('change'));

    typeInto(ui(rig.root, 'cand-new-deck') as HTMLInputElement, '唐诗'); // 与已有领域重名
    click(ui(rig.root, 'cand-save'));
    await flushMicrotasks();
    expect(rig.addDeckCalls).toHaveLength(1);
    expect(rig.addCardCalls).toHaveLength(0); // 领域没建成就不该入库
    expect(ui(rig.root, 'cand-status').textContent).toContain('同名');
  });

  it('PC#7 生成失败 ⇒ 文案上屏且卡库零变化', async () => {
    const rig = makeRig({
      collect: () => Promise.resolve({ ok: false, reason: '今天的新知识额度用完了（200 张/天），明天再来。' }),
    });
    typeInto(ui(rig.root, 'source-text') as HTMLTextAreaElement, '资料');
    click(ui(rig.root, 'source-paste-go'));
    await flushMicrotasks();
    expect(ui(rig.root, 'ingest-status').textContent).toContain('额度用完');
    expect(all(rig.root, '[data-candidate]')).toHaveLength(0);
    expect(rig.addCardCalls).toHaveLength(0);
  });

  it('PC#8 生成后回调额度刷新（额度是给玩家的承诺，屏上要跟手）', async () => {
    let refreshed = 0;
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave({ decks: [makeDeck('d1', '唐诗')], cards: [] }) }));
    mountPracticeCollect(root, ctrl, {
      toastMs: 0,
      newId: () => 'id-1',
      onQuotaChanged: () => void (refreshed += 1),
      collectCards: () =>
        Promise.resolve({
          ok: true,
          candidates: [CANDIDATE],
          quota: { day: '2026-11-01', cards: 1, judges: 0 },
          requests: 1,
          truncated: false,
        }),
    });
    typeInto(ui(root, 'source-text') as HTMLTextAreaElement, '资料');
    click(ui(root, 'source-paste-go'));
    await flushMicrotasks();
    expect(refreshed).toBeGreaterThan(0);
  });

  it('PC#10 DOM 全树不出现 sk- 形状的明文（Key 永远不该进这个屏）', () => {
    const rig = makeRig();
    const html = rig.root.innerHTML;
    expect(html).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(html).not.toContain('apiKey');
    expect(html).not.toContain('Authorization');
  });
});

/* ------------------------------------------------------------------ D56 补：候选行露选项 */

/**
 * 判别力：PC#12 候选行必须把模型给的干扰项**逐条列出来**（存进隐藏字段但不显示的实现必红）——
 * 选项不搭就该在"存之前"被拦住，而不是等进了战斗才发现。
 */
describe('mountPracticeCollect —— 候选行里的干扰项（D56 补）', () => {
  it('PC#12 候选行的干扰项逐条显示；没有则如实说明', async () => {
    const withChoices = makeRig({
      collect: () =>
        Promise.resolve({
          ok: true,
          candidates: [{ front: 'F', back: 'B', tags: [], choices: ['错一', '错二'] }],
          quota: { day: '2026-10-27', cards: 0, judges: 0 },
          requests: 1,
          truncated: false,
        }),
    });
    const ta = withChoices.root.querySelector('[data-ui="source-text"]') as HTMLTextAreaElement;
    ta.value = '一段资料';
    click(withChoices.root.querySelector('[data-ui="source-paste-go"]') as HTMLElement);
    await flushMicrotasks();
    const line = withChoices.root.querySelector('[data-candidate-choice-line="0"]')?.textContent ?? '';
    expect(line).toContain('错一');
    expect(line).toContain('错二');

    const noChoices = makeRig({
      collect: () =>
        Promise.resolve({
          ok: true,
          candidates: [{ front: 'F', back: 'B', tags: [], choices: [] }],
          quota: { day: '2026-10-27', cards: 0, judges: 0 },
          requests: 1,
          truncated: false,
        }),
    });
    const ta2 = noChoices.root.querySelector('[data-ui="source-text"]') as HTMLTextAreaElement;
    ta2.value = '一段资料';
    click(noChoices.root.querySelector('[data-ui="source-paste-go"]') as HTMLElement);
    await flushMicrotasks();
    const line2 = noChoices.root.querySelector('[data-candidate-choice-line="0"]')?.textContent ?? '';
    expect(line2).toContain('无');
    expect(line2).toContain('同领域');
  });
});

/* ------------------------------------------------------------------ D59：两段式的进度 */

/**
 * 判别力：PC#13 长文生成时，屏上要依次说"正在提炼主线…"→"正在按主线出卡…" ——
 * 第一次调用不产卡，不说清楚就像卡住了。
 */
describe('mountPracticeCollect —— 两段式的进度（D59）', () => {
  it('PC#13 生成过程中如实显示两个阶段', async () => {
    const seen: string[] = [];
    const rig = makeRig({
      collect: (input: { text: string; deckName: string; onStage?: (s: 'outline' | 'cards') => void }) => {
        input.onStage?.('outline');
        seen.push(ui(rig.root, 'ingest-status').textContent ?? '');
        input.onStage?.('cards');
        seen.push(ui(rig.root, 'ingest-status').textContent ?? '');
        return Promise.resolve({
          ok: true as const,
          candidates: [CANDIDATE],
          quota: { day: '2026-10-27', cards: 1, judges: 0 },
          requests: 2,
          truncated: false,
        });
      },
    });
    const ta = rig.root.querySelector('[data-ui="source-text"]') as HTMLTextAreaElement;
    ta.value = '一段长资料';
    click(rig.root.querySelector('[data-ui="source-paste-go"]') as HTMLElement);
    await flushMicrotasks();

    expect(seen[0]).toContain('提炼主线');
    expect(seen[1]).toContain('出卡');
  });
});

/* ------------------------------------------------------------------ D60：候选审阅看原文 */

/**
 * 判别力：
 * - PC#14 手里有正文（粘的/抓的）⇒ 「看原文」可展开，内容就是**当次那份正文**；
 * - PC#15 被跨域拦下（没有正文）⇒ 不假装有内嵌，给「打开原文去复制」；
 * - PC#16 面板内容跟着**新的一批**候选走（张冠李戴 = 玩家照着错的原文判断总结对不对）。
 */
describe('mountPracticeCollect —— 候选审阅看原文（D60）', () => {
  it('PC#14 有正文 ⇒ 展开内嵌当次正文，再点收起', async () => {
    const rig = makeRig({
      ingest: (url) =>
        Promise.resolve({ kind: 'article', title: '一篇', text: '这是抓到的正文甲。', url, via: 'direct' }),
    });
    (rig.root.querySelector('[data-ui="source-url"]') as HTMLInputElement).value = 'https://x.example/a';
    click(rig.root.querySelector('[data-ui="source-go"]') as HTMLElement);
    await flushMicrotasks();

    const toggle = rig.root.querySelector('[data-ui="cand-source-toggle"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(ui(rig.root, 'cand-source').hidden).toBe(true); // 默认收起（不挡住候选列表）

    click(toggle);
    expect(ui(rig.root, 'cand-source').hidden).toBe(false);
    expect(ui(rig.root, 'cand-source-body').textContent).toBe('这是抓到的正文甲。');
    expect(toggle.textContent).toContain('收起');

    click(toggle);
    expect(ui(rig.root, 'cand-source').hidden).toBe(true);
  });

  it('PC#15 没有正文（被拦）⇒ 不做假的空面板，给「打开原文去复制」', async () => {
    const rig = makeRig(); // 缺省 ingest = blocked
    (rig.root.querySelector('[data-ui="source-url"]') as HTMLInputElement).value = 'https://mp.weixin.qq.com/s/x';
    click(rig.root.querySelector('[data-ui="source-go"]') as HTMLElement);
    await flushMicrotasks();

    expect((rig.root.querySelector('[data-ui="cand-source-toggle"]') as HTMLElement).hidden).toBe(true);
    expect(ui(rig.root, 'ingest-open').hidden).toBe(false);
  });

  it('PC#16 面板内容跟着新一批候选走（不张冠李戴）', async () => {
    let n = 0;
    const rig = makeRig({
      ingest: (url) => {
        n += 1;
        return Promise.resolve({ kind: 'article', title: `第${n}篇`, text: `正文${n}`, url, via: 'direct' });
      },
    });
    const input = rig.root.querySelector('[data-ui="source-url"]') as HTMLInputElement;
    input.value = 'https://x.example/1';
    click(rig.root.querySelector('[data-ui="source-go"]') as HTMLElement);
    await flushMicrotasks();
    click(rig.root.querySelector('[data-ui="cand-source-toggle"]') as HTMLElement);
    expect(ui(rig.root, 'cand-source-body').textContent).toBe('正文1');

    input.value = 'https://x.example/2';
    click(rig.root.querySelector('[data-ui="source-go"]') as HTMLElement);
    await flushMicrotasks();
    // 新一批 ⇒ 面板收起、内容是新的
    expect(ui(rig.root, 'cand-source').hidden).toBe(true);
    click(rig.root.querySelector('[data-ui="cand-source-toggle"]') as HTMLElement);
    expect(ui(rig.root, 'cand-source-body').textContent).toBe('正文2');
  });
});

/* ------------------------------------------------------------------ D60 补：入口位置与来源说明 */

/**
 * 判别力（这两条来自现场反馈"新卡看不到看原文选项 / 不是所有卡都有"）：
 * - PC#17 「看原文」与来源说明要在**候选列表之前**（放在底部时，候选一多就滚出屏幕 —— 入口等于没有）；
 * - PC#18 有链接 ⇒ 说明里带上链接并承诺"存下来的卡上有看原文"；
 *          直接粘正文（无链接）⇒ **如实说"不会有"**，而不是让玩家以为是 Bug。
 */
describe('mountPracticeCollect —— 看原文入口的位置与来源说明（D60 补）', () => {
  it('PC#17 入口在候选列表之前', async () => {
    const rig = makeRig({
      ingest: (url) => Promise.resolve({ kind: 'article', title: '一篇', text: '正文', url, via: 'direct' }),
    });
    (rig.root.querySelector('[data-ui="source-url"]') as HTMLInputElement).value = 'https://x.example/a';
    click(rig.root.querySelector('[data-ui="source-go"]') as HTMLElement);
    await flushMicrotasks();

    const section = ui(rig.root, 'cand-section');
    const toggle = section.querySelector('[data-ui="cand-source-toggle"]') as HTMLElement;
    const list = section.querySelector('[data-ui="cand-list"]') as HTMLElement;
    // compareDocumentPosition: FOLLOWING(4) ⇒ list 在 toggle 之后
    expect(toggle.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('PC#18 有链接 → 说明带链接；粘正文（无链接）→ 如实说"不会有"', async () => {
    const withUrl = makeRig({
      ingest: (url) => Promise.resolve({ kind: 'article', title: '一篇', text: '正文', url, via: 'direct' }),
    });
    (withUrl.root.querySelector('[data-ui="source-url"]') as HTMLInputElement).value = 'https://x.example/a';
    click(withUrl.root.querySelector('[data-ui="source-go"]') as HTMLElement);
    await flushMicrotasks();
    const note1 = ui(withUrl.root, 'cand-source-note').textContent ?? '';
    expect(note1).toContain('https://x.example/a');
    expect(note1).toContain('会有「看原文」');

    const pasted = makeRig();
    const ta = pasted.root.querySelector('[data-ui="source-text"]') as HTMLTextAreaElement;
    ta.value = '我自己粘的正文';
    click(pasted.root.querySelector('[data-ui="source-paste-go"]') as HTMLElement);
    await flushMicrotasks();
    const note2 = ui(pasted.root, 'cand-source-note').textContent ?? '';
    expect(note2).toContain('没有来源链接');
    expect(note2).toContain('不会有');
  });
});

/* ------------------------------------------------------------------ D61：取全文再出卡 */

/**
 * 判别力：
 * - PC#19 有全文地址的条目才显示「取全文再出卡」；没有就不显示（不假装能取）；
 * - PC#20 点了 ⇒ 抓**全文地址**（不是摘要页），生成时依据标成「全文」；
 * - PC#21 全文取不到 ⇒ **如实说明并回落摘要**（不假装成功）；屏上依据仍标「摘要」。
 */
describe('mountPracticeCollect —— 取全文再出卡（D61）', () => {
  const ITEM = {
    id: 'i1',
    sourceId: 'hf',
    sourceName: 'HF',
    title: 'A Paper',
    url: 'https://huggingface.co/papers/2609.32704',
    dateMs: Date.UTC(2026, 9, 25),
    text: '摘要正文',
    extra: '摘要',
    fullTextUrl: 'https://arxiv.org/html/2609.32704',
  };
  const sources = (items: unknown[]): CollectDeps['sources'] => ({
    // 不带 library ⇒ 屏上就用内置域（mergeLibrary(空库)），HF 在列
    fetchItems: () =>
      Promise.resolve({ ok: true as const, items: items as never, via: 'direct' as const, readerTried: false }),
  });

  /** 点一下来源的「看最新」把条目读出来（列表不会自己联网）。 */
  async function loadItems(root: HTMLElement): Promise<void> {
    // eslint-disable-next-line no-console
    click(root.querySelector('[data-src-load="hf-papers"]') as HTMLElement);
    await flushMicrotasks();
  }

  it('PC#19 有全文地址才显示按钮', async () => {
    const withFull = makeRig({ sources: sources([ITEM]) });
    await loadItems(withFull.root);
    // 条目 id 由 core 按 url 生成（不是夹具里那个）⇒ 按属性选
    expect(withFull.root.querySelector('[data-src-full]')).not.toBeNull();

    const { fullTextUrl: _drop, ...noFull } = ITEM;
    const withoutFull = makeRig({ sources: sources([noFull]) });
    await loadItems(withoutFull.root);
    expect(withoutFull.root.querySelector('[data-src-full]')).toBeNull();
    expect(withoutFull.root.querySelector('[data-src-use]')).not.toBeNull(); // 「用这篇」仍在
  });

  it('PC#20 点了取全文：抓全文地址，生成时依据是"全文"', async () => {
    // 注：夹具给了 ingest 时，rig 自带的那本 ingestCalls 不记账 ⇒ 这里自己收
    const fetched: string[] = [];
    const rig = makeRig({
      sources: sources([ITEM]),
      ingest: (url) => {
        fetched.push(url);
        return Promise.resolve({ kind: 'article', title: 'A Paper', text: '整篇正文', url, via: 'reader' });
      },
    });
    await loadItems(rig.root);
    click(rig.root.querySelector('[data-src-full]') as HTMLElement);
    await flushMicrotasks();

    expect(fetched).toEqual(['https://arxiv.org/html/2609.32704']); // 抓的是全文，不是摘要页
    expect(rig.collectCalls[0]?.text).toBe('整篇正文');
    expect(ui(rig.root, 'cand-source-note').textContent).toContain('依据：全文');
  });

  it('PC#21 全文取不到 ⇒ 如实说明并回落摘要', async () => {
    const rig = makeRig({
      sources: sources([ITEM]),
      ingest: (url) =>
        Promise.resolve({ kind: 'blocked', url, reason: '跨域限制。', blocked: true }),
    });
    await loadItems(rig.root);
    click(rig.root.querySelector('[data-src-full]') as HTMLElement);
    await flushMicrotasks();

    expect(ui(rig.root, 'ingest-status').textContent).toContain('全文');
    expect(rig.collectCalls).toHaveLength(0); // 没有假装生成
  });
});
