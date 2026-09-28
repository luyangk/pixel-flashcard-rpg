// @vitest-environment happy-dom
/**
 * tests/ui/prepare.test.ts —— Plan 4 · T7：备战屏（领域多选 / 三挡 / 随机 / 错误分流）。
 *
 * 判别力（每条都对着"旧实现会怎样红"写）：
 * - PR#1 多选进 intent：把领域做成单选的实现只会有 1 个 deckId ⇒ 必红；
 * - PR#2 随机项：`'deckIds' in intent === false`（空数组不等于"不限定"——空数组合法域是
 *   "命中 0 张"，会被 battleFlow 判 insufficient-cards）⇒ 传 `deckIds: []` 的实现必红；
 * - PR#4 三挡吸附：不改初始值的实现在 defaultPoolSize=23 时无选中项 ⇒ 必红；
 * - PR#6 错误分流：只显示 message、不按 code 给引导的实现拿不到「去卡组」按钮 ⇒ 必红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameIntent, StartError } from '../../src/app/controllerTypes';
import { mountPrepare, nearestPoolSize, POOL_SIZES } from '../../src/ui/prepare';
import type { SaveFile } from '@core/types';
import { defaultBossName } from '../../src/app/bossFlow';
import {
  all,
  click,
  flushMicrotasks,
  makeCard,
  makeCtrl,
  makeDeck,
  makeRoot,
  makeSave,
  makeSnap,
  makeSrs,
  ui,
} from './support';

afterEach(() => {
  document.body.replaceChildren();
});

/** 两个领域：deck-a 有 3 张卡、deck-b 有 1 张，另有一个空领域 deck-empty。 */
function saveWithDecks() {
  return makeSave({
    decks: [makeDeck('deck-a', '唐诗'), makeDeck('deck-b', '英语词根'), makeDeck('deck-empty', '成语典故')],
    cards: [
      makeCard('c1', { deckId: 'deck-a' }),
      makeCard('c2', { deckId: 'deck-a' }),
      makeCard('c3', { deckId: 'deck-a' }),
      makeCard('c4', { deckId: 'deck-b' }),
    ],
  });
}

function chip(root: ParentNode, deckId: string): HTMLElement {
  const el = root.querySelector(`[data-deck-id="${deckId}"]`);
  if (!el) throw new Error(`缺少领域 chip：${deckId}`);
  return el as HTMLElement;
}

describe('mountPrepare —— 领域多选与随机', () => {
  it('PR#1 多选两个领域 → intent 带两个 deckIds；单选实现必红', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    mountPrepare(root, ctrl, {});

    click(chip(root, 'deck-a'));
    click(chip(root, 'deck-b'));
    expect(chip(root, 'deck-a').getAttribute('aria-pressed')).toBe('true');
    expect(chip(root, 'deck-b').getAttribute('aria-pressed')).toBe('true');
    expect(ui(root, 'deck-random').getAttribute('aria-pressed')).toBe('false');

    click(ui(root, 'start'));
    expect(ctrl.intents).toHaveLength(1);
    const intent = ctrl.intents[0] as Extract<GameIntent, { type: 'startFight' }>;
    expect(intent.type).toBe('startFight');
    expect([...(intent.deckIds ?? [])].sort()).toEqual(['deck-a', 'deck-b']);
    expect(intent.size).toBe(15);
  });

  it('PR#2 默认「随机」：intent 不携带 deckIds（传空数组的实现必红）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    mountPrepare(root, ctrl, {});
    expect(ui(root, 'deck-random').getAttribute('aria-pressed')).toBe('true');

    click(ui(root, 'start'));
    const intent = ctrl.intents[0] as Extract<GameIntent, { type: 'startFight' }>;
    expect('deckIds' in intent).toBe(false);
  });

  it('PR#3 取消最后一个领域 ⇒ 自动回落「随机」（不留 deckIds:[] 的死状态）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    mountPrepare(root, ctrl, {});

    click(chip(root, 'deck-a'));
    click(chip(root, 'deck-a'));
    expect(ui(root, 'deck-random').getAttribute('aria-pressed')).toBe('true');

    click(ui(root, 'start'));
    expect('deckIds' in (ctrl.intents[0] as Extract<GameIntent, { type: 'startFight' }>)).toBe(false);
  });

  it('PR#3b 点「随机」清空已选领域（两条路互斥，不留残影）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    mountPrepare(root, ctrl, {});

    click(chip(root, 'deck-a'));
    click(ui(root, 'deck-random'));
    expect(chip(root, 'deck-a').getAttribute('aria-pressed')).toBe('false');
    click(ui(root, 'start'));
    expect('deckIds' in (ctrl.intents[0] as Extract<GameIntent, { type: 'startFight' }>)).toBe(false);
  });
});

describe('mountPrepare —— 三挡池子', () => {
  it('PR#4 defaultPoolSize 就近吸附（23→25 / 12→10 / 脏值→10）', () => {
    expect(nearestPoolSize(23)).toBe(25);
    expect(nearestPoolSize(12)).toBe(10);
    expect(nearestPoolSize(15)).toBe(15);
    expect(nearestPoolSize('x')).toBe(10);
    expect(nearestPoolSize(Number.NaN)).toBe(10);
    expect(POOL_SIZES).toEqual([10, 15, 25]);
  });

  it('PR#4b 存档默认值决定初始选中；点了别的挡后 intent 用玩家选的', () => {
    const root = makeRoot();
    const save = saveWithDecks();
    const dirty = { ...save, settings: { ...save.settings, battle: { defaultPoolSize: 23 } } };
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: dirty }));
    mountPrepare(root, ctrl, {});

    const sizeBtn = (s: number): HTMLElement => root.querySelector(`[data-size="${s}"]`) as HTMLElement;
    expect(sizeBtn(25).getAttribute('aria-pressed')).toBe('true'); // 23 吸附到 25
    expect(sizeBtn(10).getAttribute('aria-pressed')).toBe('false');

    click(sizeBtn(10));
    expect(sizeBtn(10).getAttribute('aria-pressed')).toBe('true');
    click(ui(root, 'start'));
    expect((ctrl.intents[0] as Extract<GameIntent, { type: 'startFight' }>).size).toBe(10);
  });
});

describe('mountPrepare —— 空领域与空库', () => {
  it('PR#5 空领域 chip 不可点（点了也只会开出 insufficient-cards）；计数上屏', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    mountPrepare(root, ctrl, {});

    expect((chip(root, 'deck-empty') as HTMLButtonElement).disabled).toBe(true);
    expect(chip(root, 'deck-a').textContent).toContain('3');
    expect(ui(root, 'pool-total').textContent).toBe('卡库共 4 张卡。');
  });

  it('PR#5b 空库给出大白话（不是空白屏）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: makeSave({ cards: [] }) }));
    mountPrepare(root, ctrl, {});
    expect(ui(root, 'pool-total').textContent).toBe('卡库还是空的。');
  });
});

describe('mountPrepare —— 开局失败分流（兑现 T2 deferred）', () => {
  const noCards: StartError = { code: 'no-cards', message: '卡库里没有可用的卡。' };
  const badSize: StartError = { code: 'invalid-size', message: '池子大小不在合法范围。' };

  it('PR#6 no-cards：显示 message + 引导去卡组，点「去卡组」调 onNav', () => {
    const root = makeRoot();
    const nav: string[] = [];
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: makeSave({ cards: [] }), lastError: noCards }));
    mountPrepare(root, ctrl, { onNav: (t) => nav.push(t) });

    const err = ui(root, 'start-error');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('卡库里没有可用的卡。');
    expect(err.textContent).toContain('卡组');

    const go = ui(root, 'error-go-decks');
    expect(go.hidden).toBe(false);
    click(go);
    expect(nav).toEqual(['decks']);
  });

  it('PR#6b invalid-size：不给「去卡组」引导（那是换一挡的事）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks(), lastError: badSize }));
    mountPrepare(root, ctrl, { onNav: () => undefined });

    expect(ui(root, 'start-error').textContent).toContain('换个池子大小再试');
    expect(ui(root, 'error-go-decks').hidden).toBe(true);
  });

  it('PR#6d insufficient-cards 与 no-cards 同支（两个码都要给「去卡组」引导）', () => {
    const root = makeRoot();
    const nav: string[] = [];
    const few: StartError = { code: 'insufficient-cards', message: '这个领域的卡不够凑一局。' };
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks(), lastError: few }));
    mountPrepare(root, ctrl, { onNav: (t) => nav.push(t) });

    expect(ui(root, 'error-go-decks').hidden).toBe(false);
    click(ui(root, 'error-go-decks'));
    expect(nav).toEqual(['decks']);
    // 引导语是"多攒几张卡"，不是 no-cards 的"先去加几张或导入备份"
    expect(ui(root, 'start-error').textContent).toContain('多攒几张');
  });

  it('PR#6c 无错误时错误区隐藏（脉冲式，不留残影）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks(), lastError: noCards }));
    mountPrepare(root, ctrl, {});
    expect(ui(root, 'start-error').hidden).toBe(false);

    ctrl.push(makeSnap({ screen: 'prepare', save: saveWithDecks(), lastError: null }));
    expect(ui(root, 'start-error').hidden).toBe(true);
  });
});

describe('mountPrepare —— 防双开与拆除', () => {
  it('PR#7 intent 未回来前「开战」禁用（双开一局会让会话位互相覆盖）', async () => {
    const root = makeRoot();
    const base = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    let release: () => void = () => undefined;
    const ctrl = {
      ...base,
      intent: (i: GameIntent) => {
        base.intents.push(i);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    mountPrepare(root, ctrl, {});

    const start = ui(root, 'start') as HTMLButtonElement;
    click(start);
    await flushMicrotasks();
    expect(start.disabled).toBe(true);
    expect(base.intents).toHaveLength(1);

    release();
    await flushMicrotasks();
    expect(start.disabled).toBe(false);
  });

  it('PR#8 unmount 后不再响应快照（订阅已撤销，且 DOM 已摘）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    const handle = mountPrepare(root, ctrl, {});
    expect(all(root, '[data-deck-id]')).toHaveLength(3);

    handle.unmount();
    expect(all(root, '[data-deck-id]')).toHaveLength(0);
    // 拆除后再推快照：不得抛错、不得重建 DOM
    ctrl.push(makeSnap({ screen: 'prepare', save: saveWithDecks() }));
    expect(all(root, '[data-deck-id]')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ 卷灵现身（T8） */

describe('mountPrepare —— 卷灵现身与称号（T8）', () => {
  /** 15 个有效复习日 = 引导域/低档阈值的达标线（Boss 计数口径 = Σ effectiveReviewDays）。 */
  const DAYS = Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

  function cardWithDays(id: string, deckId: string, days = 15) {
    return makeCard(id, {
      deckId,
      srs: makeSrs({ stability: 'review', effectiveReviewDays: DAYS.slice(0, days) }),
    });
  }

  function saveWith(over: Partial<SaveFile> = {}): SaveFile {
    const base = makeSave({
      decks: [makeDeck('d1', '唐诗'), makeDeck('d2', '英语词根')],
      cards: [cardWithDays('c1', 'd1'), cardWithDays('c2', 'd2', 14)],
    });
    return { ...base, ...over, settings: { ...base.settings, bossThresholdTier: 15, ...(over.settings ?? {}) } };
  }

  it('PR#9 达标领域出现「卷灵现身」chip（带 已复习/阈值）；点击 → boss 档单领域开战', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWith() }));
    mountPrepare(root, ctrl, {});

    const chipEl = root.querySelector('[data-boss="d1"]') as HTMLElement;
    expect(chipEl).not.toBeNull();
    expect(chipEl.textContent).toContain('唐诗·卷灵');
    expect(chipEl.textContent).toContain('15/15');
    expect(root.querySelector('[data-boss="d2"]')).toBeNull(); // 14/15 未达标

    click(chipEl);
    const intent = ctrl.intents[0] as Extract<GameIntent, { type: 'startFight' }>;
    expect(intent).toMatchObject({ type: 'startFight', size: 1, deckIds: ['d1'], difficulty: 'boss' });
  });

  it('PR#9b 未达标领域不出现 chip（按 count≥threshold 判，不看卡数）', () => {
    const root = makeRoot();
    const save = saveWith({ settings: { ...makeSave().settings, bossThresholdTier: 30 } });
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save }));
    mountPrepare(root, ctrl, {});
    expect(root.querySelector('[data-boss]')).toBeNull();
  });

  it('PR#10 自建领域首次现身：先问称号，确认后写入并开战', async () => {
    const root = makeRoot();
    const named: Array<[string, string]> = [];
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWith() }));
    mountPrepare(root, ctrl, {
      toastMs: 0,
      setBossName: (deckId, raw) => {
        named.push([deckId, raw]);
        return Promise.resolve({ ok: true, name: raw.trim() });
      },
    });

    click(root.querySelector('[data-boss="d1"]') as HTMLElement);
    expect(ui(root, 'boss-name-dialog').hidden).toBe(false);
    expect((ui(root, 'boss-name-input') as HTMLInputElement).placeholder).toBe(defaultBossName('唐诗'));
    expect(ctrl.intents).toHaveLength(0); // 称号没定之前不开战

    (ui(root, 'boss-name-input') as HTMLInputElement).value = '荒原卷灵';
    click(ui(root, 'boss-name-confirm'));
    await flushMicrotasks();

    expect(named).toEqual([['d1', '荒原卷灵']]);
    expect(ui(root, 'boss-name-dialog').hidden).toBe(true);
    expect(ctrl.intents[0]).toMatchObject({ type: 'startFight', deckIds: ['d1'], difficulty: 'boss' });
  });

  it('PR#10b「用默认称号」传默认模板（{卡组名}·卷灵）', async () => {
    const root = makeRoot();
    const named: string[] = [];
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWith() }));
    mountPrepare(root, ctrl, {
      setBossName: (_deckId, raw) => {
        named.push(raw);
        return Promise.resolve({ ok: true, name: raw });
      },
    });

    click(root.querySelector('[data-boss="d1"]') as HTMLElement);
    click(ui(root, 'boss-name-default'));
    await flushMicrotasks();
    expect(named).toEqual(['唐诗·卷灵']);
    expect(ctrl.intents).toHaveLength(1);
  });

  it('PR#10c 预置领域（isPreset=true，称号手写）不问称号直接开战', () => {
    const root = makeRoot();
    const save = saveWith({ decks: [makeDeck('d1', '唐诗', { isPreset: true })] });
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save }));
    mountPrepare(root, ctrl, { setBossName: () => Promise.resolve({ ok: true, name: 'x' }) });

    click(root.querySelector('[data-boss="d1"]') as HTMLElement);
    expect(ui(root, 'boss-name-dialog').hidden).toBe(true);
    expect(ctrl.intents).toHaveLength(1);
  });

  it('PR#10d 称号非法（写口回 ok:false）→ 提示一句但仍开战（不让玩家卡在弹窗上）', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'prepare', save: saveWith() }));
    mountPrepare(root, ctrl, {
      toastMs: 0,
      setBossName: () => Promise.resolve({ ok: false, name: '唐诗·卷灵', reason: '称号最多 30 个字，先用默认的。' }),
    });

    click(root.querySelector('[data-boss="d1"]') as HTMLElement);
    (ui(root, 'boss-name-input') as HTMLInputElement).value = '字'.repeat(40);
    click(ui(root, 'boss-name-confirm'));
    await flushMicrotasks();

    expect(document.querySelector('[data-ui="toast"]')?.textContent).toBe('称号最多 30 个字，先用默认的。');
    expect(ctrl.intents).toHaveLength(1);
    expect(ui(root, 'boss-name-dialog').hidden).toBe(true);
  });
});
