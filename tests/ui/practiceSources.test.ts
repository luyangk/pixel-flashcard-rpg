// @vitest-environment happy-dom
/**
 * tests/ui/practiceSources.test.ts —— 采新卡「来源库」这一块（D53）。
 *
 * 判别力：
 * - PS#1 内置来源真的渲染出来，且**实测没有 CORS 的源带「需读取服务」标**
 *   （全都不打标的实现必红：玩家会以为点了就有内容）；
 * - PS#2 「看最新」走注入的抓取口，条目按 core 的规则消毒/排序后上屏；
 * - PS#3 「用这篇」：响应里带正文 ⇒ 交给 `onUseText`；只有链接 ⇒ 交给 `onUseUrl`
 *   （两条路混为一谈的实现必红：前者不该再抓页面，后者必须去抓）；
 * - PS#4 读不到（blocked）⇒ 说明"没开跨域" + 露出「打开原文去复制」（把下一步递到手里）；
 * - PS#5 维护：加源要过校验、存进注入的库；删内置源 / 恢复推荐都要真的调到写口；
 * - PS#6 没有 `fetchItems` 口 ⇒ 按钮禁用（不显示点了没反应的入口）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceDef, SourceItemDraft } from '../../src/core/sourceItem';
import type { FetchSourceResult } from '../../src/platform/feedFetch';
import type { UserLibrary } from '../../src/app/sourceLibrary';
import { mountPracticeSources } from '../../src/ui/practiceSources';
import { all, click, flushMicrotasks, makeRoot, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

function draft(over: Partial<SourceItemDraft> = {}): SourceItemDraft {
  return {
    sourceId: 'hf-papers',
    sourceName: 'HF Daily Papers',
    title: '某篇论文',
    url: 'https://huggingface.co/papers/1',
    dateMs: Date.UTC(2026, 8, 25),
    text: 'x'.repeat(400),
    ...over,
  };
}

function makeRig(
  over: {
    fetchItems?: (source: SourceDef) => Promise<FetchSourceResult>;
    library?: UserLibrary;
    withLibrary?: boolean;
    withFetch?: boolean;
  } = {},
) {
  const root = makeRoot();
  let lib: UserLibrary = over.library ?? { added: [], removed: [] };
  const saved: UserLibrary[] = [];
  const fetchCalls: string[] = [];
  const usedText: Array<{ title: string; text: string; url: string }> = [];
  const usedUrl: string[] = [];
  const opened: string[] = [];

  mountPracticeSources(root, {
    toastMs: 0,
    ...(over.withFetch === false
      ? {}
      : {
          fetchItems: (source: SourceDef) => {
            fetchCalls.push(source.id);
            return over.fetchItems
              ? over.fetchItems(source)
              : Promise.resolve({
                  ok: true as const,
                  via: 'direct' as const,
                  items: [draft({ sourceId: source.id, sourceName: source.name })],
                });
          },
        }),
    ...(over.withLibrary === false
      ? {}
      : {
          library: {
            load: () => lib,
            save: (next: UserLibrary) => {
              saved.push(next);
              lib = next;
              return true;
            },
          },
        }),
    onUseText: (input) => void usedText.push({ title: input.title, text: input.text, url: input.url }),
    onUseUrl: (url) => void usedUrl.push(url),
    openUrl: (url) => void opened.push(url),
  });
  return { root, saved, fetchCalls, usedText, usedUrl, opened, lib: () => lib };
}

describe('mountPracticeSources —— 来源库（D53）', () => {
  it('PS#1 内置来源渲染出来；实测没有 CORS 的源带「需读取服务」标', () => {
    const { root } = makeRig();
    const rows = all(root, '[data-src-row]').map((el) => el.getAttribute('data-src-row'));
    expect(rows).toContain('hf-papers');
    expect(rows).toContain('gh-vllm');
    expect(rows).toContain('openai-news');
    // 直连可读的源不该有标；没有 ACAO 的源必须有
    expect(root.querySelector('[data-src-badge="hf-papers"]')).toBeNull();
    expect(root.querySelector('[data-src-badge="openai-news"]')?.textContent).toContain('需读取服务');
    expect(root.querySelector('[data-src-badge="arxiv-cs-ai"]')?.textContent).toContain('需读取服务');
  });

  it('PS#2 「看最新」走注入的抓取口，条目上屏（标题 + 日期 + 用这篇）', async () => {
    const { root, fetchCalls } = makeRig({
      fetchItems: (source) =>
        Promise.resolve({
          ok: true,
          via: 'direct' as const,
          items: [
            draft({ sourceId: source.id, sourceName: source.name, title: '旧的', url: 'https://x/old', dateMs: Date.UTC(2026, 0, 1) }),
            draft({ sourceId: source.id, sourceName: source.name, title: '新的', url: 'https://x/new', dateMs: Date.UTC(2026, 8, 1) }),
          ],
        }),
    });
    click(root.querySelector('[data-src-load="hf-papers"]') as HTMLElement);
    await flushMicrotasks();

    expect(fetchCalls).toEqual(['hf-papers']);
    const titles = all(root, '[data-src-item] .src-item-title').map((el) => el.textContent);
    expect(titles).toEqual(['新的', '旧的']); // core 的排序口径：新的在前
    expect(ui(root, 'src-status').textContent).toContain('2 条');
  });

  it('PS#3 「用这篇」：带正文 ⇒ onUseText；只有链接 ⇒ onUseUrl', async () => {
    const { root, usedText, usedUrl } = makeRig({
      fetchItems: () =>
        Promise.resolve({
          ok: true,
          via: 'direct' as const,
          items: [
            draft({ title: '有摘要的论文', url: 'https://x/paper', text: 'y'.repeat(500) }),
            draft({ title: '只有标题的新闻', url: 'https://x/news', text: '' }),
          ],
        }),
    });
    click(root.querySelector('[data-src-load="hf-papers"]') as HTMLElement);
    await flushMicrotasks();

    click(root.querySelector('[data-src-use="https://x/paper"]') as HTMLElement);
    expect(usedText).toHaveLength(1);
    expect(usedText[0].text).toHaveLength(500);
    expect(usedUrl).toEqual([]); // 有正文就不该再去抓页面

    click(root.querySelector('[data-src-use="https://x/news"]') as HTMLElement);
    expect(usedUrl).toEqual(['https://x/news']);
    expect(usedText).toHaveLength(1); // 只有链接的那条不许走"就地生成"
  });

  it('PS#4 读不到（没开跨域）⇒ 说清 + 露出「打开原文去复制」且真的打开该链接', async () => {
    const { root, opened } = makeRig({
      fetchItems: () =>
        Promise.resolve({ ok: false, reason: '读不到这个源（跨域被拒或网络不通）。', blocked: true, readerTried: false }),
    });
    click(root.querySelector('[data-src-load="openai-news"]') as HTMLElement);
    await flushMicrotasks();

    const status = ui(root, 'src-status').textContent ?? '';
    expect(status).toContain('跨域');
    expect(status).toContain('读取服务'); // 把"配读取服务"这条出路说给玩家
    expect(ui(root, 'src-open').hidden).toBe(false);
    click(ui(root, 'src-open'));
    expect(opened).toEqual(['https://openai.com/news/rss.xml']);
  });

  it('PS#5 维护：加源过校验并存库；删内置源与恢复推荐都真的调到写口', async () => {
    const rig = makeRig();
    click(ui(rig.root, 'src-manage'));
    expect(ui(rig.root, 'src-manage-body').hidden).toBe(false);

    // ① 名字为空 ⇒ 拒绝，不写库
    (ui(rig.root, 'src-new-url') as HTMLInputElement).value = 'https://my.example/feed';
    click(ui(rig.root, 'src-add'));
    expect(rig.saved).toEqual([]);
    expect(ui(rig.root, 'src-status').textContent).toContain('名字');

    // ② 补齐后加入
    (ui(rig.root, 'src-new-name') as HTMLInputElement).value = '我的博客';
    click(ui(rig.root, 'src-add'));
    expect(rig.saved).toHaveLength(1);
    expect(rig.saved[0].added.map((s) => s.name)).toEqual(['我的博客']);
    // 切到「我的来源」那一组能看到它
    expect(all(rig.root, '[data-src-domain]').map((el) => el.getAttribute('data-src-domain'))).toContain('mine');

    // ③ 移出一个内置源 ⇒ 记墓碑
    click(rig.root.querySelector('[data-src-remove="github-blog"]') as HTMLElement);
    expect(rig.saved.at(-1)?.removed).toContain('github-blog');

    // ④ 恢复推荐 ⇒ 清墓碑
    click(ui(rig.root, 'src-restore'));
    expect(rig.saved.at(-1)?.removed).toEqual([]);
    expect(rig.saved.at(-1)?.added.map((s) => s.name)).toEqual(['我的博客']); // 自己加的还在
  });

  it('PS#6 缺 fetchItems 口 ⇒ 「看最新」禁用（不显示点了没反应的入口）；缺 library ⇒ 没有维护按钮', () => {
    const bare = makeRig({ withFetch: false, withLibrary: false });
    const go = bare.root.querySelector('[data-src-load="hf-papers"]') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect((bare.root.querySelector('[data-ui="src-manage"]') as HTMLElement).hidden).toBe(true);
  });

  it('PS#7 点「看最新」时先清掉上一批条目（避免把两个源的条目混在一起看）', async () => {
    const { root } = makeRig({
      fetchItems: (source) =>
        Promise.resolve({
          ok: true,
          via: 'direct' as const,
          items: [draft({ sourceId: source.id, sourceName: source.name, title: `来自 ${source.id}`, url: `https://x/${source.id}` })],
        }),
    });
    click(root.querySelector('[data-src-load="hf-papers"]') as HTMLElement);
    await flushMicrotasks();
    expect(all(root, '[data-src-item]')).toHaveLength(1);
    expect(ui(root, 'src-items').textContent).toContain('来自 hf-papers');

    const spy = vi.fn();
    void spy;
    click(root.querySelector('[data-src-load="github-blog"]') as HTMLElement);
    // 加载中是"空的 + 正在读"，加载完只剩新源那一条
    await flushMicrotasks();
    expect(ui(root, 'src-items').textContent).toContain('来自 github-blog');
    expect(ui(root, 'src-items').textContent).not.toContain('来自 hf-papers');
  });
});

/* ------------------------------------------------------------------ D55：经读取服务 */

describe('mountPracticeSources —— 经读取服务取回（D55）', () => {
  it('PS#8 经读取服务取回 ⇒ 状态行说明"经读取服务来"（玩家知道链接出过门）', async () => {
    const { root } = makeRig({
      fetchItems: () =>
        Promise.resolve({
          ok: true,
          via: 'reader',
          items: [draft({ title: 'arXiv 论文', url: 'https://arxiv.org/abs/1', text: 'z'.repeat(300) })],
        }),
    });
    click(root.querySelector('[data-src-load="arxiv-cs-lg"]') as HTMLElement);
    await flushMicrotasks();
    expect(ui(root, 'src-status').textContent).toContain('经读取服务取回');
    expect(all(root, '[data-src-item]')).toHaveLength(1);
  });

  it('PS#9 配了读取服务还是读不到 ⇒ 说清是谁没读到，且**不再叫玩家去配一遍**', async () => {
    const { root } = makeRig({
      fetchItems: () =>
        Promise.resolve({
          ok: false,
          reason: '读取服务那边：读取服务限流了（429）。 直连那边：读不到这个源（跨域被拒或网络不通）。',
          blocked: false,
          readerTried: true,
        }),
    });
    click(root.querySelector('[data-src-load="arxiv-cs-lg"]') as HTMLElement);
    await flushMicrotasks();
    const status = ui(root, 'src-status').textContent ?? '';
    expect(status).toContain('429');
    expect(status).toContain('换一个能连上的读取服务'); // 下一步
    expect(status).not.toContain('在「设置 → AI → 读取服务」里配一个'); // 他刚配过
    expect(ui(root, 'src-open').hidden).toBe(false); // 「打开原文去复制」仍在
  });

  it('PS#10 没配读取服务 ⇒ 老文案：叫他去配，并说明链接会转一手', async () => {
    const { root } = makeRig({
      fetchItems: () =>
        Promise.resolve({ ok: false, reason: '读不到这个源（跨域被拒或网络不通）。', blocked: true, readerTried: false }),
    });
    click(root.querySelector('[data-src-load="arxiv-cs-lg"]') as HTMLElement);
    await flushMicrotasks();
    const status = ui(root, 'src-status').textContent ?? '';
    expect(status).toContain('设置 → AI → 读取服务');
    expect(status).toContain('发给那台服务'); // 隐私那笔账要写在屏上
  });
});

/* ------------------------------------------------------------------ D62：截断如实申报 */

/**
 * 判别力：清单太长、只解析了前一段时，屏上要说一句 —— 否则玩家看到一个比预期短的列表，
 * 会以为是这个源坏了（或者"读取服务有毛病"）。
 */
describe('mountPracticeSources —— 截断如实申报（D62）', () => {
  it('PS#T1 truncatedForParse ⇒ 状态里说明"只解析了前一段"', async () => {
    const root = makeRoot();
    mountPracticeSources(root, {
      toastMs: 0,
      fetchItems: () =>
        Promise.resolve({ ok: true, via: 'direct' as const, items: [draft({ title: '一条' })], truncatedForParse: true }),
    });
    click(root.querySelector('[data-src-load="hf-papers"]') as HTMLElement);
    await flushMicrotasks();
    expect(ui(root, 'src-status').textContent).toContain('只解析了前一段');
  });
});
