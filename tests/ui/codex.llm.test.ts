// @vitest-environment happy-dom
/**
 * tests/ui/codex.llm.test.ts —— Plan 5 · T5：藏书阁「让 AI 写彩蛋」。
 *
 * 判别力：
 * - CX#LLM1 取值优先级 `deck.egg` → `eggs.json` 的键 → 字面「已净化」；且**只有没彩蛋的领域**
 *   才显示「让 AI 写彩蛋」。把顺序写反（预置键盖掉玩家自己写的那段）必红；
 * - CX#LLM2 生成**零写入**：候选只进预览区，`setEgg` 一次都没被调（"生成即入库"的实现必红）；
 *   生成中禁用（连点两次只调一次生成口）；
 * - CX#LLM3 「用这段」才写：`setEgg(deckId, text)` 一次，快照推回后条目**上屏**那段正文
 *   （指纹漏了 `deck.egg` 的实现会继续显示「已净化」⇒ 必红）；
 * - CX#LLM4 「不要」零写入且预览收起；
 * - CX#LLM5 生成失败：toast 人话 reason、预览不出现、零写入。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, Deck } from '@core/types';
import { mountCodex, type CodexDeps } from '../../src/ui/codex';
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

const EGGS: Readonly<Record<string, string>> = { p1: '预置彩蛋：闪电与雷声本是同一件事。', p2: '预置彩蛋二。' };
const OWN_EGG = 'AI 写的彩蛋：李白号青莲居士。';
const GENERATED = 'AI 新写的一段：唐诗的格律讲究平仄。';

/** 三个已净化领域：p1 只有预置键、p2 两者都有（测优先级）、d-new 什么都没有（可生成）。 */
function decksWith(over: Partial<Deck> = {}): Deck[] {
  const dNew = makeDeck('d-new', '英语词根', { purifiedAt: 100, ...over });
  return [
    makeDeck('p1', '生活常识', { purifiedAt: 900 }),
    makeDeck('p2', '唐诗', { purifiedAt: 800, egg: OWN_EGG }),
    dNew,
  ];
}

function saveWith(decks: Deck[], cards: Card[] = [makeCard('c1', { deckId: 'p2' })]) {
  return makeSave({ decks, cards });
}

interface Rig {
  readonly root: HTMLElement;
  readonly ctrl: ReturnType<typeof makeCtrl>;
  readonly setEggCalls: Array<[string, string]>;
  readonly genCalls: string[];
  setGenerated(r: { ok: true; text: string } | { ok: false; reason: string }): void;
  setEggResult(r: { ok: boolean; reason?: string }): void;
  rows(): HTMLElement[];
  rowOf(deckId: string): HTMLElement;
}

function makeRig(opts: { gate?: Promise<void>; deps?: Partial<CodexDeps> } = {}): Rig {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWith(decksWith()) }));
  const setEggCalls: Array<[string, string]> = [];
  const genCalls: string[] = [];
  let generated: { ok: true; text: string } | { ok: false; reason: string } = { ok: true, text: GENERATED };
  let eggResult: { ok: boolean; reason?: string } = { ok: true };
  const deps: CodexDeps = {
    toastMs: 0,
    onPractice: () => undefined,
    eggs: EGGS,
    llmEgg: (deckName) => {
      genCalls.push(deckName);
      return opts.gate ? opts.gate.then(() => generated) : Promise.resolve(generated);
    },
    setEgg: (deckId, text) => {
      setEggCalls.push([deckId, text]);
      return Promise.resolve(eggResult);
    },
    ...opts.deps,
  };
  mountCodex(root, ctrl, deps);
  const rowOf = (deckId: string): HTMLElement =>
    root.querySelector(`[data-codex-entry="${deckId}"]`) as HTMLElement;
  return {
    root,
    ctrl,
    setEggCalls,
    genCalls,
    setGenerated: (r) => {
      generated = r;
    },
    setEggResult: (r) => {
      eggResult = r;
    },
    rows: () => all(root, '[data-codex-entry]'),
    rowOf,
  };
}

describe('mountCodex —— AI 彩蛋', () => {
  it('CX#LLM1 取值优先级 deck.egg → eggs.json → 「已净化」；只给没彩蛋的领域挂生成入口', () => {
    const rig = makeRig();
    expect(rig.rows().map((r) => r.getAttribute('data-codex-entry'))).toEqual(['p1', 'p2', 'd-new']);

    expect(ui(rig.rowOf('p1'), 'entry-egg').textContent).toBe(EGGS.p1);
    expect(ui(rig.rowOf('p2'), 'entry-egg').textContent).toBe(OWN_EGG); // deck.egg 优先
    expect(ui(rig.rowOf('d-new'), 'entry-egg').textContent).toBe('已净化');

    const aiButtons = all(rig.root, '[data-ui="egg-ai"]');
    expect(aiButtons).toHaveLength(1);
    expect(aiButtons[0].getAttribute('data-egg-deck')).toBe('d-new');
    expect(aiButtons[0].getAttribute('data-practice')).toBeNull(); // 与练习关同级、是另一个按钮
    expect(rig.rowOf('d-new').querySelector('[data-practice]')).not.toBeNull();
  });

  it('CX#LLM2 生成只进预览、零写入；生成中禁用且连点只调一次', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const rig = makeRig({ gate });
    const btn = all(rig.root, '[data-ui="egg-ai"]')[0];
    click(btn);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    click(btn);
    await flushMicrotasks();
    expect(rig.genCalls).toEqual(['英语词根']);
    expect(ui(rig.root, 'egg-preview').hidden).toBe(true); // 还没回来，不预览

    (release as unknown as () => void)();
    await flushMicrotasks();
    expect(ui(rig.root, 'egg-preview').hidden).toBe(false);
    expect(ui(rig.root, 'egg-preview-text').textContent).toBe(GENERATED);
    expect(rig.setEggCalls).toEqual([]); // 生成 ≠ 入库
    expect(ui(rig.rowOf('d-new'), 'entry-egg').textContent).toBe('已净化'); // 屏上仍未写入
  });

  it('CX#LLM3「用这段」：setEgg 一次；快照推回后条目上屏那段正文、生成入口消失', async () => {
    const rig = makeRig();
    click(all(rig.root, '[data-ui="egg-ai"]')[0]);
    await flushMicrotasks();
    click(ui(rig.root, 'egg-accept'));
    await flushMicrotasks();

    expect(rig.setEggCalls).toEqual([['d-new', GENERATED]]);
    expect(ui(rig.root, 'egg-preview').hidden).toBe(true);
    expect(ui(rig.root, 'toast').textContent).toBe('彩蛋已写进图鉴。');

    // 写入成功后宿主会推一份新快照（deck.egg 已落）
    rig.ctrl.push(makeSnap({ screen: 'menu', save: saveWith(decksWith({ egg: GENERATED })) }));
    expect(ui(rig.rowOf('d-new'), 'entry-egg').textContent).toBe(GENERATED);
    expect(all(rig.root, '[data-ui="egg-ai"]')).toHaveLength(0); // 有彩蛋了就不再挂生成入口
  });

  it('CX#LLM4「不要」：预览收起、零写入、条目保持原样', async () => {
    const rig = makeRig();
    click(all(rig.root, '[data-ui="egg-ai"]')[0]);
    await flushMicrotasks();
    expect(ui(rig.root, 'egg-preview').hidden).toBe(false);

    click(ui(rig.root, 'egg-discard'));
    expect(ui(rig.root, 'egg-preview').hidden).toBe(true);
    expect(ui(rig.root, 'egg-preview-text').textContent).toBe('');
    expect(rig.setEggCalls).toEqual([]);
    expect(ui(rig.rowOf('d-new'), 'entry-egg').textContent).toBe('已净化');
    expect(all(rig.root, '[data-ui="egg-ai"]')).toHaveLength(1); // 还能再让 AI 写
  });

  it('CX#LLM5 生成失败：toast reason、无预览、零写入', async () => {
    const rig = makeRig();
    rig.setGenerated({ ok: false, reason: '被服务商限流了（429）——等一会儿再试。' });
    click(all(rig.root, '[data-ui="egg-ai"]')[0]);
    await flushMicrotasks();

    expect(ui(rig.root, 'toast').textContent).toBe('被服务商限流了（429）——等一会儿再试。');
    expect(ui(rig.root, 'egg-preview').hidden).toBe(true);
    expect(rig.setEggCalls).toEqual([]);
    expect((all(rig.root, '[data-ui="egg-ai"]')[0] as HTMLButtonElement).disabled).toBe(false); // 失败后能重试
  });

  it('CX#LLM5b 写入口失败：toast reason，预览保留（文本不白丢），不重试写入', async () => {
    const rig = makeRig();
    rig.setEggResult({ ok: false, reason: '存档没法读取（只读保护中）：现在改不了彩蛋，你的存档原样保留。' });
    click(all(rig.root, '[data-ui="egg-ai"]')[0]);
    await flushMicrotasks();
    click(ui(rig.root, 'egg-accept'));
    await flushMicrotasks();

    expect(rig.setEggCalls).toHaveLength(1);
    expect(ui(rig.root, 'toast').textContent).toContain('只读保护中');
    expect(ui(rig.root, 'egg-preview').hidden).toBe(false); // 草稿还在，玩家可以再试
    expect(ui(rig.root, 'egg-preview-text').textContent).toBe(GENERATED);
  });

  it('CX#LLM6 缺省注入（无 llmEgg/setEgg）⇒ 不显示生成入口，其余条目照旧', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWith(decksWith()) }));
    mountCodex(root, ctrl, { eggs: EGGS, toastMs: 0 });
    expect(all(root, '[data-ui="egg-ai"]')).toHaveLength(0);
    expect(ui(root.querySelector('[data-codex-entry="d-new"]') as HTMLElement, 'entry-egg').textContent).toBe('已净化');
  });
});
