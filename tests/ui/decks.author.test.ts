// @vitest-environment happy-dom
/**
 * tests/ui/decks.author.test.ts —— Plan 5 · T4：卡组页「AI 辅建卡」。
 *
 * 这一组守的是"人审闸门"：模型产出**任何一条**都不许在玩家逐条确认之前入库。
 * 判别力：
 * - DA#1 缺省注入 ⇒ 整块隐藏；展开面板后才出现生成口；
 * - DA#2 候选**默认全勾**且可编辑：取消勾选的那条不入库、编辑后的值入库、逐条 await `addCard`
 *   且 `sourceType:'llm'`。默认不勾（或只提交原始候选、忽略输入框编辑）的实现在这条上必红；
 * - DA#3 生成中禁用生成键：连点两次只调一次生成口（`llm-author-run` 不禁用的实现在此必红）；
 * - DA#4 生成失败 / 解析失败 / 取消 ⇒ **零写入**（`addCard` 一次都没被调过）且状态行给 reason；
 * - DA#5 `truncated:true` 时状态行如实说"已截断为前 N 条"（静默丢条的实现必红）；
 * - DA#6 一条失败不中断其余：两条都调了写口，成功的那条计数正确，失败原因不吞。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card } from '@core/types';
import type { CardCandidate, ParseResult } from '@core/llmParse';
import { mountDecks, type DecksDeps } from '../../src/ui/decks';
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

function cand(front: string, back: string): CardCandidate {
  // choices（Plan 6 · D41）：模型在生成这张卡时一并产出的干扰项；夹具给一条即可
  return { front, back, tags: [], choices: [`不是 ${back}`] };
}

function saveOneDeck() {
  return makeSave({ decks: [makeDeck('deck-a', '唐诗')], cards: [] });
}

interface AuthorRig {
  readonly root: HTMLElement;
  readonly addCalls: Array<{
    front: string;
    back: string;
    deckId: string;
    id: string;
    sourceType?: string;
    tags?: readonly string[];
    choices?: readonly string[];
  }>;
  readonly genCalls: Array<{ text: string; deckName: string }>;
  setResult(r: ParseResult<CardCandidate>): void;
  setAddResult(r: (input: { front: string; back: string; id: string }) => { ok: boolean; reason?: string }): void;
}

function makeRig(opts: { initial?: ParseResult<CardCandidate>; gate?: Promise<void> } = {}): AuthorRig {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveOneDeck() }));
  const addCalls: AuthorRig['addCalls'] = [];
  const genCalls: AuthorRig['genCalls'] = [];
  let result: ParseResult<CardCandidate> = opts.initial ?? { ok: true, value: [cand('f1', 'b1')], truncated: false };
  let addResult: (input: { front: string; back: string; id: string }) => { ok: boolean; reason?: string } = () => ({
    ok: true,
  });
  let seq = 0;
  const deps: DecksDeps = {
    newId: () => `id-${++seq}`,
    toastMs: 0,
    addCard: (input) => {
      addCalls.push(input);
      const r = addResult(input);
      return Promise.resolve(
        r.ok
          ? { ok: true as const, value: makeCard(input.id, { deckId: input.deckId }) as Card }
          : { ok: false as const, reason: r.reason ?? '没加进去。' },
      );
    },
    // gate 用来模拟"生成还没回来"的在途态（DA#3 的防连点判据）
    llmCards: (input) => {
      genCalls.push({ text: input.text, deckName: input.deckName });
      return opts.gate ? opts.gate.then(() => result) : Promise.resolve(result);
    },
  };
  mountDecks(root, ctrl, deps);
  return {
    root,
    addCalls,
    genCalls,
    setResult: (r) => {
      result = r;
    },
    setAddResult: (fn) => {
      addResult = fn;
    },
  };
}

async function openAndGenerate(rig: AuthorRig): Promise<void> {
  click(ui(rig.root, 'llm-author-open'));
  (ui(rig.root, 'llm-author-text') as HTMLTextAreaElement).value = '李白，字太白，唐代诗人。';
  click(ui(rig.root, 'llm-author-run'));
  await flushMicrotasks();
}

describe('mountDecks —— AI 辅建卡', () => {
  it('DA#1 缺省注入 ⇒ 整块隐藏；注入后可展开面板（展开时入口隐藏）', () => {
    const bare = makeRoot();
    mountDecks(bare, makeCtrl(makeSnap({ save: saveOneDeck() })), { addCard: () => Promise.resolve({ ok: true, value: makeCard('x') }) });
    expect(ui(bare, 'llm-author-section').hidden).toBe(true);

    const rig = makeRig();
    expect(ui(rig.root, 'llm-author-section').hidden).toBe(false);
    expect(ui(rig.root, 'llm-author').hidden).toBe(true); // 初始收起
    click(ui(rig.root, 'llm-author-open'));
    expect(ui(rig.root, 'llm-author').hidden).toBe(false);
    expect(ui(rig.root, 'llm-author-open').hidden).toBe(true);
  });

  it('DA#2 默认全勾；取消勾选的不入库、编辑后的值入库、逐条 await 且 sourceType=llm', async () => {
    const rig = makeRig({
      initial: { ok: true, value: [cand('f1', 'b1'), cand('f2', 'b2'), cand('f3', 'b3')], truncated: false },
    });
    await openAndGenerate(rig);

    expect(rig.genCalls).toEqual([{ text: '李白，字太白，唐代诗人。', deckName: '唐诗' }]);
    expect(all(rig.root, '[data-candidate]')).toHaveLength(3);
    const checks = all(rig.root, '[data-candidate-check]') as HTMLInputElement[];
    expect(checks.map((c) => c.checked)).toEqual([true, true, true]); // 默认全勾

    // 取消第 1 条、编辑第 2 条的正面
    checks[0].checked = false;
    (rig.root.querySelector('[data-candidate-front="1"]') as HTMLInputElement).value = '改过的正面';
    click(ui(rig.root, 'llm-author-confirm'));
    await flushMicrotasks();

    expect(rig.addCalls).toEqual([
      // choices 一并带着（Plan 6 · D41）：夹具的 cand() 给每条候选一个干扰项
      {
        front: '改过的正面',
        back: 'b2',
        deckId: 'deck-a',
        id: 'id-1',
        sourceType: 'llm',
        tags: [],
        choices: ['不是 b2'],
      },
      { front: 'f3', back: 'b3', deckId: 'deck-a', id: 'id-2', sourceType: 'llm', tags: [], choices: ['不是 b3'] },
    ]);
    expect(ui(rig.root, 'toast').textContent).toBe('已加入 2 张卡。');
    expect(ui(rig.root, 'llm-author').hidden).toBe(true); // 收摊
    expect(all(rig.root, '[data-candidate]')).toHaveLength(0);
  });

  it('DA#2b 候选的 tags 随卡入库并在行上可见（丢了 tags 的实现必红——它是主题筛选的依据）', async () => {
    const rig = makeRig({
      initial: {
        ok: true,
        value: [{ front: 'f1', back: 'b1', tags: ['历史', '唐诗'], choices: [] }],
        truncated: false,
      },
    });
    await openAndGenerate(rig);

    expect(all(rig.root, '[data-candidate-tag-text]')[0].textContent).toBe('标签：历史/唐诗');
    click(ui(rig.root, 'llm-author-confirm'));
    await flushMicrotasks();
    expect(rig.addCalls[0].tags).toEqual(['历史', '唐诗']);
  });

  it('DA#3 生成中禁用生成键：连点两次只调一次生成口，状态行显示「正在生成…」', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const rig = makeRig({ initial: { ok: true, value: [cand('f1', 'b1')], truncated: false }, gate });
    click(ui(rig.root, 'llm-author-open'));
    (ui(rig.root, 'llm-author-text') as HTMLTextAreaElement).value = '资料';
    click(ui(rig.root, 'llm-author-run'));
    expect((ui(rig.root, 'llm-author-run') as HTMLButtonElement).disabled).toBe(true);
    expect(ui(rig.root, 'llm-author-status').textContent).toBe('正在生成…');
    click(ui(rig.root, 'llm-author-run'));
    await flushMicrotasks();
    expect(rig.genCalls).toHaveLength(1);

    (release as unknown as () => void)();
    await flushMicrotasks();
    expect((ui(rig.root, 'llm-author-run') as HTMLButtonElement).disabled).toBe(false);
    expect(all(rig.root, '[data-candidate]')).toHaveLength(1);
  });

  it('DA#4 生成失败 / 解析失败 / 取消 ⇒ 零写入，状态行给 reason', async () => {
    const rig = makeRig();
    rig.setResult({ ok: false, reason: '模型没有返回内容。' });
    await openAndGenerate(rig);
    expect(ui(rig.root, 'llm-author-status').textContent).toBe('模型没有返回内容。');
    expect(all(rig.root, '[data-candidate]')).toHaveLength(0);

    rig.setResult({ ok: true, value: [cand('f1', 'b1')], truncated: false });
    await openAndGenerate(rig);
    expect(all(rig.root, '[data-candidate]')).toHaveLength(1);
    click(ui(rig.root, 'llm-author-cancel'));
    expect(ui(rig.root, 'llm-author').hidden).toBe(true);
    expect(all(rig.root, '[data-candidate]')).toHaveLength(0);
    expect(ui(rig.root, 'llm-author-status').textContent).toBe('');

    expect(rig.addCalls).toEqual([]); // 三条路径都零写入
  });

  it('DA#8 生成在途 → 取消 → 再放行响应：**候选不出现**、零写入（评审 M-1：代际令牌无用例）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const rig = makeRig({ initial: { ok: true, value: [cand('f1', 'b1')], truncated: false }, gate });
    click(ui(rig.root, 'llm-author-open'));
    (ui(rig.root, 'llm-author-text') as HTMLTextAreaElement).value = '资料';
    click(ui(rig.root, 'llm-author-run'));
    click(ui(rig.root, 'llm-author-cancel')); // 玩家改主意了
    expect(ui(rig.root, 'llm-author').hidden).toBe(true);

    (release as unknown as () => void)(); // 响应这时才回来
    await flushMicrotasks();
    // 面板仍关着、候选一个都没有（删掉代际令牌守卫的实现会在这里红：幽灵候选 + 可能被误确认）
    expect(ui(rig.root, 'llm-author').hidden).toBe(true);
    expect(all(rig.root, '[data-candidate]')).toHaveLength(0);
    expect(rig.addCalls).toEqual([]);
  });

  it('DA#5 truncated:true ⇒ 状态行如实提示「已截断为前 N 条」', async () => {
    const rig = makeRig({ initial: { ok: true, value: [cand('f1', 'b1'), cand('f2', 'b2')], truncated: true } });
    await openAndGenerate(rig);
    expect(ui(rig.root, 'llm-author-status').textContent).toBe('已截断为前 2 条。');
  });

  it('DA#6 一条失败不中断其余：两条都调了写口，计数与原因都上屏', async () => {
    const rig = makeRig({
      initial: { ok: true, value: [cand('f1', 'b1'), cand('f2', 'b2')], truncated: false },
    });
    rig.setAddResult((input) =>
      input.id === 'id-1' ? { ok: true } : { ok: false, reason: '加卡失败：卡片编号和已有的一张撞了。' },
    );
    await openAndGenerate(rig);
    click(ui(rig.root, 'llm-author-confirm'));
    await flushMicrotasks();

    expect(rig.addCalls).toHaveLength(2); // 第 1 条失败没有打断第 2 条
    expect(ui(rig.root, 'toast').textContent).toContain('已加入 1 张卡。');
    expect(ui(rig.root, 'toast').textContent).toContain('卡片编号和已有的一张撞了');
  });

  it('DA#7 一条都不勾 ⇒ 不写盘、状态行提示；空白资料 ⇒ 不调生成口', async () => {
    const rig = makeRig({ initial: { ok: true, value: [cand('f1', 'b1')], truncated: false } });
    await openAndGenerate(rig);
    (rig.root.querySelector('[data-candidate-check="0"]') as HTMLInputElement).checked = false;
    click(ui(rig.root, 'llm-author-confirm'));
    await flushMicrotasks();
    expect(rig.addCalls).toEqual([]);
    expect(ui(rig.root, 'llm-author-status').textContent).toContain('至少勾一张');

    const rig2 = makeRig();
    click(ui(rig2.root, 'llm-author-open'));
    (ui(rig2.root, 'llm-author-text') as HTMLTextAreaElement).value = '   ';
    click(ui(rig2.root, 'llm-author-run'));
    await flushMicrotasks();
    expect(rig2.genCalls).toHaveLength(0);
    expect(ui(rig2.root, 'llm-author-status').textContent).toBe('先粘一段资料进来。');
  });
});

/* ------------------------------------------------------------------ Plan 6 · T8 */

/**
 * 候选的干扰项随卡入库（Plan 6 · D41）：模型在**生成卡那一刻**产出的 `choices` 必须
 * 活着走到 `addCard` —— 丢了它，这张卡以后就只能退回"同领域其他卡的背面"这一级来源，
 * 而"省额度"整个设计的前提就是"选项在生成时算一次、复习时不再调模型"。
 */
describe('卡组页 AI 辅建 —— 干扰项入库（Plan 6 · T8）', () => {
  it('DA#C1 勾选入库时把 choices 一起交给 addCard（丢了必红）', async () => {
    const rig = makeRig({
      initial: {
        ok: true,
        value: [
          { front: 'f1', back: 'b1', tags: ['历史'], choices: ['错甲', '错乙', '错丙'] },
          { front: 'f2', back: 'b2', tags: [], choices: [] },
        ],
        truncated: false,
      },
    });
    await openAndGenerate(rig);
    click(ui(rig.root, 'llm-author-confirm'));
    await flushMicrotasks();

    expect(rig.addCalls).toHaveLength(2);
    expect(rig.addCalls[0].choices).toEqual(['错甲', '错乙', '错丙']);
    expect(rig.addCalls[1].choices).toEqual([]); // 没有干扰项就是空数组，不凭空造
  });
});
