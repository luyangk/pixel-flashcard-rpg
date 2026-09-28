// @vitest-environment happy-dom
/**
 * tests/ui/battleScreen.test.ts —— Plan 4 · T5：战斗屏 DOM 接线。
 *
 * 环境：per-file `@vitest-environment happy-dom`（只让 src/ui 的测试进 DOM 环境，
 * 全局 environment 仍是 'node'，core 测试不被拖慢）。
 *
 * 断言纪律（T4 复核教训）：
 * - 视觉反馈一律**脉冲**（只对"本次快照新增的日志"显示，下一快照即消失）；
 *   因此本文件带判别力地断言「挂载时已有的历史 miss **不**重放」——旧式
 *   `log.some(kind==='miss')` 实现会红。
 * - 防连点是**两层**：UI 点击即 disabled + 新快照才解禁（此处断言 UI 层）；
 *   controller 侧 phase 守卫在 T3 已测。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Card, Deck, SaveFile, SRSState } from '@core/types';
import { GRADES } from '@core/sm2';
import type { BattleEvent, BattleState } from '../../src/core/battle';
import type { FightView } from '../../src/app/battleFlow';
import type { ControllerSnapshot, GameController, GameIntent } from '../../src/app/controllerTypes';
import type { BattleStage, BattleStageDeps } from '../../src/stage/battleStage';
import type { StageSprites } from '../../src/stage/renderer';
import { mountBattleScreen, type BattleScreenDeps } from '../../src/ui/battleScreen';

/* ------------------------------------------------------------------ 夹具 */

function makeCard(id: string): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due: 0,
    stability: 'review',
    effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

function makeSave(): SaveFile {
  const decks: Deck[] = [{ id: 'deck-a', name: '唐诗', isPreset: true }];
  return {
    schemaVersion: 1,
    decks,
    cards: [makeCard('c1')],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: 0, plays: 0 },
  };
}

/** 造一个战斗视图；log 就是权威战报（脉冲判定唯一数据源）。 */
function makeFight(idx: number, log: BattleEvent[], phase: BattleState['phase'] = 'answering'): FightView {
  const pool = [makeCard('c1'), makeCard('c2'), makeCard('c3')];
  const state: BattleState = {
    phase,
    pool: pool.map((c) => c.id),
    idx,
    enemyHp: 42,
    playerHp: 30,
    maxPlayerHp: 30,
    atk: 12,
    def: 3,
    enemyPower: 7,
    log,
  };
  return { state, pool, current: phase === 'answering' ? pool[idx] ?? null : null };
}

function makeSnap(over: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  return {
    screen: 'fight',
    fight: makeFight(0, []),
    save: makeSave(),
    readOnly: false,
    reminderDue: false,
    lastResult: null,
    lastError: null,
    notice: null,
    ...over,
  };
}

interface FakeCtrl extends GameController {
  readonly intents: GameIntent[];
  push(next: ControllerSnapshot): void;
}

function makeCtrl(initial: ControllerSnapshot = makeSnap()): FakeCtrl {
  let cur = initial;
  const subs = new Set<(s: ControllerSnapshot) => void>();
  const intents: GameIntent[] = [];
  return {
    intents,
    snapshot: () => cur,
    intent: (i: GameIntent) => {
      intents.push(i);
      return Promise.resolve();
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    push(next: ControllerSnapshot) {
      cur = next;
      for (const cb of [...subs]) cb(cur);
    },
  };
}

interface Harness {
  readonly root: HTMLElement;
  readonly ctrl: FakeCtrl;
  readonly calls: { frame: number[]; resize: Array<[number, number]>; destroy: number };
  readonly caf: ReturnType<typeof vi.fn>;
  readonly removeListener: ReturnType<typeof vi.fn>;
  /** 手动驱动一帧（注入的 raf 只把回调交出来，测试自己走时钟）。 */
  tick(tMs: number): void;
  readonly deps: BattleScreenDeps;
}

function setup(stageSprites: StageSprites = {} as StageSprites): Harness {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const ctrl = makeCtrl();
  const calls = { frame: [] as number[], resize: [] as Array<[number, number]>, destroy: 0 };
  const stage: BattleStage = {
    frame: (_st, _view, tMs) => void calls.frame.push(tMs),
    onResize: (w, h) => void calls.resize.push([w, h]),
    destroy: () => void (calls.destroy += 1),
  };
  let pendingCb: ((tMs: number) => void) | null = null;
  const caf = vi.fn();
  const raf = vi.fn((cb: (tMs: number) => void) => {
    pendingCb = cb;
    return 77;
  });
  const removeListener = vi.fn(window.removeEventListener.bind(window));
  const addListener = vi.fn(window.addEventListener.bind(window));
  const deps: BattleScreenDeps = {
    sprites: stageSprites,
    raf,
    caf,
    mountStage: (_host: HTMLElement, _d: BattleStageDeps) => stage,
    win: {
      innerWidth: 400,
      innerHeight: 300,
      addEventListener: addListener as unknown as Window['addEventListener'],
      removeEventListener: removeListener as unknown as Window['removeEventListener'],
    },
  };
  return {
    root,
    ctrl,
    calls,
    caf,
    removeListener,
    deps,
    tick(tMs: number) {
      const cb = pendingCb;
      pendingCb = null;
      if (cb) cb(tMs);
    },
  };
}

const btn = (root: HTMLElement, grade: string): HTMLButtonElement => {
  const el = root.querySelector<HTMLButtonElement>(`button[data-grade="${grade}"]`);
  if (!el) throw new Error(`missing grade button: ${grade}`);
  return el;
};
const grades = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-grade]'));
/** 两段式作答：先点"看答案"翻面，再自评（评分按钮在未翻面时是禁用的）。 */
const reveal = (root: HTMLElement): void => {
  const el = root.querySelector<HTMLButtonElement>('[data-ui="reveal"]');
  if (!el) throw new Error('missing reveal button');
  el.click();
};
const hidden = (root: HTMLElement, ui: string): boolean =>
  root.querySelector(`[data-ui="${ui}"]`)!.hasAttribute('hidden');
const text = (root: HTMLElement, ui: string): string =>
  root.querySelector(`[data-ui="${ui}"]`)?.textContent ?? '';

/* ------------------------------------------------------------------ 用例 */

describe('mountBattleScreen —— 结构与四档按钮', () => {
  it('挂载后四档按钮齐全，档位映射到 GRADES，卡面只显 front', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    expect(grades(hs.root)).toHaveLength(4);
    expect(btn(hs.root, 'again').textContent).toBe('忘了');
    expect(btn(hs.root, 'hard').textContent).toBe('想起来了');
    expect(btn(hs.root, 'good').textContent).toBe('对了');
    expect(btn(hs.root, 'easy').textContent).toBe('太简单');

    expect(text(hs.root, 'card-front')).toContain('q-c1');
    expect(hidden(hs.root, 'card-back')).toBe(true); // 作答前不显背面
    expect(hs.root.querySelector('[data-ui="stage-host"]')).not.toBeNull();
    expect(hs.root.querySelector('[data-ui="fx"]')).not.toBeNull(); // 回击飘字容器
  });

  it('点击 good 恰发一次 answer intent（grade=GRADES.good），四档立即 disabled', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    reveal(hs.root);
    btn(hs.root, 'good').click();

    expect(hs.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.good }]);
    expect(grades(hs.root).every((b) => b.disabled)).toBe(true);
    // 作答后背面出现（自评流程的"确认答案"）
    expect(hidden(hs.root, 'card-back')).toBe(false);
    expect(text(hs.root, 'card-back')).toContain('a-c1');
  });

  it('pending 期间第二档点击被吞掉（不产生第二个 intent）', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    reveal(hs.root);
    btn(hs.root, 'easy').click();
    btn(hs.root, 'again').click();

    expect(hs.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.easy }]);
  });

  it('同一快照重放不解禁；新快照到达才解禁', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    const same = hs.ctrl.snapshot();

    reveal(hs.root);
    btn(hs.root, 'good').click();
    hs.ctrl.push(same); // 旧对象重放：不是"新快照"
    expect(btn(hs.root, 'good').disabled).toBe(true);

    hs.ctrl.push(makeSnap({ fight: makeFight(1, [{ kind: 'damage', cardId: 'c1', amount: 12 }]) }));
    expect(text(hs.root, 'card-front')).toContain('q-c2');
    // 换了卡就必须重新翻面：新卡未看答案前不给评分（两段式语义）
    expect(grades(hs.root).every((b) => b.disabled)).toBe(true);
    reveal(hs.root);
    expect(grades(hs.root).every((b) => !b.disabled)).toBe(true);
  });

  it('终局快照（非 answering）不解禁答题按钮', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    reveal(hs.root);
    btn(hs.root, 'good').click();
    hs.ctrl.push(makeSnap({ fight: makeFight(0, [{ kind: 'end' }], 'won') }));

    expect(grades(hs.root).every((b) => b.disabled)).toBe(true);
  });
});

describe('mountBattleScreen —— 脉冲式视觉反馈（T4 教训）', () => {
  it('miss 快照显"空转"提示，下一快照即消失（脉冲，不是持续状态）', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    expect(hidden(hs.root, 'miss-hint')).toBe(true);

    hs.ctrl.push(makeSnap({ fight: makeFight(1, [{ kind: 'miss', cardId: 'c1' }]) }));
    expect(hidden(hs.root, 'miss-hint')).toBe(false);
    expect(text(hs.root, 'miss-hint')).toContain('空转');

    hs.ctrl.push(
      makeSnap({ fight: makeFight(2, [{ kind: 'miss', cardId: 'c1' }, { kind: 'damage', cardId: 'c2', amount: 12 }]) })
    );
    expect(hidden(hs.root, 'miss-hint')).toBe(true); // 旧实现（log.some）会在这里红
  });

  it('挂载时就已有的历史 miss 不重放（首帧只对齐）', () => {
    const hs = setup();
    hs.ctrl.push(makeSnap({ fight: makeFight(1, [{ kind: 'miss', cardId: 'c1' }]) }));
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    expect(hidden(hs.root, 'miss-hint')).toBe(true);
  });

  it('新增 retaliate 追加回击飘字，下一快照清空', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    const fx = () => Array.from(hs.root.querySelectorAll('[data-ui="fx"] > *')).map((n) => n.textContent);

    hs.ctrl.push(makeSnap({ fight: makeFight(1, [{ kind: 'damage', cardId: 'c1', amount: 12 }]) }));
    expect(fx()).toEqual([]);

    hs.ctrl.push(
      makeSnap({
        fight: makeFight(1, [{ kind: 'damage', cardId: 'c1', amount: 12 }, { kind: 'retaliate', amount: 4 }]),
      })
    );
    expect(fx()).toEqual(['-4']);

    hs.ctrl.push(
      makeSnap({
        fight: makeFight(2, [
          { kind: 'damage', cardId: 'c1', amount: 12 },
          { kind: 'retaliate', amount: 4 },
          { kind: 'damage', cardId: 'c2', amount: 12 },
        ]),
      })
    );
    expect(fx()).toEqual([]);
  });

  it('只读快照渲染常驻横幅，解除只读后移除', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    expect(hs.root.querySelector('[data-ui="banner"]')).toBeNull();

    hs.ctrl.push(makeSnap({ readOnly: true }));
    expect(text(hs.root, 'banner')).toContain('只读');

    hs.ctrl.push(makeSnap({ readOnly: false }));
    expect(hs.root.querySelector('[data-ui="banner"]')).toBeNull();
  });
});

describe('mountBattleScreen —— 新卡伤害提示（终审 J-1）', () => {
  /** 造一张指定稳定度的卡（本文件的 makeCard 固定 review，故这里单独造）。 */
  function cardWith(id: string, stability: SRSState['stability']): Card {
    const base = makeCard(id);
    return { ...base, srs: { ...base.srs, stability } };
  }

  it('BS#H1 当前卡是 new 时才挂说明；换到 review 卡即收回（不是一次性开关）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = setup();
    const handle = mountBattleScreen(root, h.ctrl, h.deps);

    // 先断言"review 卡不显示"，避免"永远显示"的实现蒙对
    expect((root.querySelector('[data-ui="new-card-hint"]') as HTMLElement).hidden).toBe(true);

    const pool = [cardWith('n1', 'new'), cardWith('r1', 'review')];
    const view: FightView = {
      state: { ...h.ctrl.snapshot().fight!.state, idx: 0, pool: ['n1', 'r1'] },
      pool,
      current: pool[0],
    };

    h.ctrl.push({ ...h.ctrl.snapshot(), fight: view });
    const hint = root.querySelector('[data-ui="new-card-hint"]') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('三成伤害'); // Plan 5 数值改进后文案同步（0.1→0.3）

    h.ctrl.push({
      ...h.ctrl.snapshot(),
      fight: { ...view, state: { ...view.state, idx: 1 }, current: pool[1] },
    });
    expect((root.querySelector('[data-ui="new-card-hint"]') as HTMLElement).hidden).toBe(true);
    handle.unmount();
  });
});

describe('mountBattleScreen —— 教学局提示（Plan 5 数值改进）', () => {
  it('BS#T1 只有 difficulty=tutorial 时挂提示；普通遭遇战与 Boss 都不显示', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = setup();
    const handle = mountBattleScreen(root, h.ctrl, h.deps);
    const hint = (): HTMLElement => root.querySelector('[data-ui="tutorial-hint"]') as HTMLElement;
    expect(hint().hidden).toBe(true); // 默认 encounter

    const base = h.ctrl.snapshot().fight!;
    h.ctrl.push({ ...h.ctrl.snapshot(), fight: { ...base, difficulty: 'tutorial' } });
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toContain('教学局');

    h.ctrl.push({ ...h.ctrl.snapshot(), fight: { ...base, difficulty: 'boss' } });
    expect(hint().hidden).toBe(true); // 难度变化不是暗改：Boss 不该挂教学局提示
    handle.unmount();
  });
});

describe('mountBattleScreen —— 退出本局（终审 I-2）', () => {
  it('BS#Q1 点「退出本局」发一次 toMenu，并把四档锁住（此前 UI 层没有任何生产者）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = setup();
    const handle = mountBattleScreen(root, h.ctrl, h.deps);

    const quit = root.querySelector('[data-ui="quit"]') as HTMLButtonElement;
    expect(quit).not.toBeNull();
    quit.click();
    expect(h.ctrl.intents).toEqual([{ type: 'toMenu' }]);
    expect(btn(root, 'good').disabled).toBe(true);
    handle.unmount();
  });
});

describe('mountBattleScreen —— rAF / resize / destroy', () => {
  it('rAF 的 timestamp 原样作为 tMs 传给 stage.frame；resize 事件转 onResize', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    hs.tick(1234.5);
    expect(hs.calls.frame).toEqual([1234.5]);
    expect(hs.calls.resize[0]).toEqual([400, 300]); // 挂载即按视口摆一次

    window.dispatchEvent(new Event('resize'));
    expect(hs.calls.resize).toHaveLength(2);
    expect(hs.calls.resize[1]).toEqual([400, 300]);
  });

  it('unmount：cancelAnimationFrame(handles) + 摘 resize 监听 + stage.destroy，且幂等', () => {
    const hs = setup();
    const handle = mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    handle.unmount();
    expect(hs.caf).toHaveBeenCalledWith(77);
    expect(hs.removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(hs.calls.destroy).toBe(1);

    handle.unmount(); // 幂等：不重复 destroy
    expect(hs.calls.destroy).toBe(1);

    hs.tick(99); // 回调已被取消：再驱动也不该画
    expect(hs.calls.frame).toEqual([]);
  });

  it('真实 mountBattleStage 接线：canvas 宿主里出现 320×240 逻辑分辨率画布', () => {
    const hs = setup();
    const { mountStage: _drop, ...deps } = hs.deps; // 走真实 stage 挂载
    mountBattleScreen(hs.root, hs.ctrl, deps);

    const canvas = hs.root.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.width).toBe(320);
    expect(canvas!.height).toBe(240);
  });
});

/* --------------------------------------------------- T5 评审 Important 回归钉 */
describe('mountBattleScreen —— 答案归属（跨卡错配的回归钉）', () => {
  it('R#1 未翻面时四档禁用：看不到答案就无法自评（两段式的机器保证）', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    expect(grades(hs.root).every((b) => b.disabled)).toBe(true);
    expect(hidden(hs.root, 'card-back')).toBe(true);
    reveal(hs.root);
    expect(grades(hs.root).every((b) => !b.disabled)).toBe(true);
    expect(hidden(hs.root, 'card-back')).toBe(false);
    expect(text(hs.root, 'card-back')).toContain('a-c1');
  });

  it('R#2 作答后新快照换卡（**同一 pool 引用**）：答案立刻收回，绝不把上一张的 back 挂在新 front 上', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    // 判别力关键（二轮评审指出）：旧实现的重置条件是 pool **引用**变化，而真实链路
    // （battleFlow 的 toView 原样透传 view.pool）整局同一引用。故本用例必须复用同一
    // pool 换卡，才能在回退成旧逻辑时真的报警——用 makeFight 重建 pool 会让旧实现也绿。
    const f0 = makeFight(0, []);
    hs.ctrl.push(makeSnap({ fight: f0 }));
    reveal(hs.root);
    expect(text(hs.root, 'card-back')).toContain('a-c1');

    btn(hs.root, 'good').click();
    const f1: FightView = {
      ...f0,
      state: { ...f0.state, idx: 1, log: [{ kind: 'damage', cardId: 'c1', amount: 12 }] },
      current: f0.pool[1] ?? null,
    };
    hs.ctrl.push(makeSnap({ fight: f1 }));

    expect(text(hs.root, 'card-front')).toContain('q-c2');
    expect(hidden(hs.root, 'card-back')).toBe(true); // 旧实现：这里仍显示「答案：a-c1」
  });

  it('R#3 同一张卡内翻面状态稳定：快照重放不会把答案收回（只按卡 id 重置）', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    reveal(hs.root);
    const same = hs.ctrl.snapshot();
    hs.ctrl.push(same); // 重放同一快照对象
    expect(hidden(hs.root, 'card-back')).toBe(false);
    expect(text(hs.root, 'card-back')).toContain('a-c1');
  });
});
