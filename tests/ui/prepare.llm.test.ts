// @vitest-environment happy-dom
/**
 * tests/ui/prepare.llm.test.ts —— Plan 5 · T5：备战屏称号弹窗「让 AI 起几个名」。
 *
 * 判别力：
 * - PL#1 候选渲染与"生成中禁用"：连点两次只调一次生成口（不禁用的实现在此必红）；
 * - PL#2 **点候选只填输入框**：`setBossName` 一次都不许被调、也不许开战（"点一下候选就入库"
 *   的实现直接在断言上炸；这正是本计划"产出不可信、必须人审"的硬闸门）；
 * - PL#3 确认之后才写：一次 `setBossName`，传入的恰是候选名字；
 * - PL#4 AI 失败 ⇒ 状态行给人话 reason、弹窗**仍开着**、玩家还能手打名字走既有路径
 *   （失败就把弹窗关掉的实现会让玩家连手打的机会都没有）；
 * - PL#5 缺省注入 ⇒ 按钮隐藏（不显示点了没反应的入口）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import type { NameCandidate, ParseResult } from '@core/llmParse';
import { defaultBossName } from '../../src/app/bossFlow';
import { mountPrepare, type PrepareDeps } from '../../src/ui/prepare';
import { click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, makeSrs, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

/** 15 个有效复习日 = 低档阈值（15）的达标线；口径与 tests/ui/prepare.test.ts 一致。 */
const DAYS = Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

function saveWithBossReady(): SaveFile {
  const base = makeSave({
    decks: [makeDeck('d1', '唐诗')],
    cards: [makeCard('c1', { deckId: 'd1', srs: makeSrs({ stability: 'review', effectiveReviewDays: DAYS }) })],
  });
  return { ...base, settings: { ...base.settings, bossThresholdTier: 15 } };
}

function cand(name: string): NameCandidate {
  return { name };
}

interface Rig {
  readonly root: HTMLElement;
  readonly named: Array<[string, string]>;
  readonly intents: number;
  setNamesResult(r: ParseResult<NameCandidate>): void;
}

function makeRig(opts: { llmNames?: PrepareDeps['llmNames']; initial?: ParseResult<NameCandidate> } = {}): Rig {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithBossReady() }));
  const named: Array<[string, string]> = [];
  let result: ParseResult<NameCandidate> =
    opts.initial ?? { ok: true, value: [cand('诗酒篇·卷灵'), cand('青莲篇·卷灵')], truncated: false };
  const deps: PrepareDeps = {
    toastMs: 0,
    setBossName: (deckId, raw) => {
      named.push([deckId, raw]);
      return Promise.resolve({ ok: true, name: raw.trim() });
    },
    llmNames: opts.llmNames ?? (() => Promise.resolve(result)),
  };
  mountPrepare(root, ctrl, deps);
  return {
    root,
    named,
    get intents() {
      return ctrl.intents.length;
    },
    setNamesResult: (r) => {
      result = r;
    },
  };
}

function openDialog(rig: Rig): void {
  click(rig.root.querySelector('[data-boss="d1"]') as HTMLElement);
}

describe('mountPrepare —— AI 起名', () => {
  it('PL#1 弹窗内有 AI 入口；点击生成候选；生成中禁用且连点只调一次', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const rig = makeRig({
      llmNames: (deckName) => {
        calls.push(deckName);
        return gate.then(() => ({ ok: true as const, value: [cand('诗酒篇·卷灵')], truncated: false }));
      },
    });
    openDialog(rig);
    expect(ui(rig.root, 'boss-name-dialog').hidden).toBe(false);
    expect(ui(rig.root, 'boss-name-ai').hidden).toBe(false);

    click(ui(rig.root, 'boss-name-ai'));
    expect(ui(rig.root, 'boss-name-ai-status').textContent).not.toBe(''); // 状态行立刻有反馈
    click(ui(rig.root, 'boss-name-ai'));
    await flushMicrotasks();
    expect(calls).toEqual(['唐诗']); // 第二次点击被挡

    (release as unknown as () => void)();
    await flushMicrotasks();
    expect(rig.root.querySelectorAll('[data-name-candidate]')).toHaveLength(1);
    expect(ui(rig.root, 'boss-name-ai-status').textContent).toBe('');
  });

  it('PL#2 点候选**只填输入框**：不调 setBossName、不开战', async () => {
    const rig = makeRig();
    openDialog(rig);
    click(ui(rig.root, 'boss-name-ai'));
    await flushMicrotasks();

    const second = rig.root.querySelector('[data-name-candidate="1"]') as HTMLElement;
    click(second);
    expect((ui(rig.root, 'boss-name-input') as HTMLInputElement).value).toBe('青莲篇·卷灵');
    expect(rig.named).toEqual([]); // 绝不直接入库
    expect(rig.intents).toBe(0); // 也不开战
    expect(ui(rig.root, 'boss-name-dialog').hidden).toBe(false); // 弹窗还开着等确认
  });

  it('PL#3 点「就用这个名字」才写盘：一次 setBossName，且传的是候选名字', async () => {
    const rig = makeRig();
    openDialog(rig);
    click(ui(rig.root, 'boss-name-ai'));
    await flushMicrotasks();
    click(rig.root.querySelector('[data-name-candidate="0"]') as HTMLElement);
    click(ui(rig.root, 'boss-name-confirm'));
    await flushMicrotasks();

    expect(rig.named).toEqual([['d1', '诗酒篇·卷灵']]);
    expect(rig.intents).toBe(1);
  });

  it('PL#4 AI 失败：状态行给人话 reason、弹窗仍开、手打名字照旧可入库', async () => {
    const rig = makeRig();
    rig.setNamesResult({ ok: false, reason: 'Key 不对或没有权限（401/403）——去设置页检查一下。' });
    openDialog(rig);
    click(ui(rig.root, 'boss-name-ai'));
    await flushMicrotasks();

    expect(ui(rig.root, 'boss-name-ai-status').textContent).toBe(
      'Key 不对或没有权限（401/403）——去设置页检查一下。',
    );
    expect(ui(rig.root, 'boss-name-dialog').hidden).toBe(false);
    expect(rig.root.querySelectorAll('[data-name-candidate]')).toHaveLength(0);

    // 手打仍是唯一入库路径：写口照常工作
    (ui(rig.root, 'boss-name-input') as HTMLInputElement).value = '手打的名字';
    click(ui(rig.root, 'boss-name-confirm'));
    await flushMicrotasks();
    expect(rig.named).toEqual([['d1', '手打的名字']]);
  });

  it('PL#4b 生成抛错也不逃逸：状态行收成一句人话，弹窗与手打不受影响', async () => {
    const rig = makeRig({
      llmNames: () => Promise.reject(new Error('boom')),
    });
    openDialog(rig);
    click(ui(rig.root, 'boss-name-ai'));
    await flushMicrotasks();
    expect(ui(rig.root, 'boss-name-ai-status').textContent).toContain('boom');
    expect(ui(rig.root, 'boss-name-dialog').hidden).toBe(false);
    expect((ui(rig.root, 'boss-name-input') as HTMLInputElement).placeholder).toBe(defaultBossName('唐诗'));
  });

  it('PL#5 缺省注入 ⇒ 无 AI 入口；预置领域（不弹窗）不受影响', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithBossReady() }));
    mountPrepare(root, ctrl, {
      setBossName: () => Promise.resolve({ ok: true, name: 'x' }),
    });
    click(root.querySelector('[data-boss="d1"]') as HTMLElement);
    expect(ui(root, 'boss-name-ai').hidden).toBe(true);
  });
});
