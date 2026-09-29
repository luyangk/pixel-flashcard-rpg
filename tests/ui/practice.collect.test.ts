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
