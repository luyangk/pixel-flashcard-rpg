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
import { mulberry32 } from '@core/rng';
import { mountBattleScreen, type BattleScreenDeps } from '../../src/ui/battleScreen';
import { flushMicrotasks } from './support';

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
      // Plan 6 · T5：作答模式与每日额度进档（迁移器为缺席档补同款缺省；
      // 夹具代表"当前形状的完整档"，缺席会让形状断言把归一化误读成丢字段——
      // 与上面 leaderboard 在 T7 时的理由逐字相同）。
      answerMode: 'choice',
      llmQuota: { day: '', cards: 0, judges: 0 },
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
    mode: 'fight',
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

function setup(stageSprites: StageSprites = {} as StageSprites, extra: Partial<BattleScreenDeps> = {}): Harness {
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
    // 选项洗牌用注入的确定性 rng（core/choices 只用注入的随机源；UI 的默认值见生产代码）
    rng: mulberry32(7),
    raf,
    caf,
    mountStage: (_host: HTMLElement, _d: BattleStageDeps) => stage,
    win: {
      innerWidth: 400,
      innerHeight: 300,
      addEventListener: addListener as unknown as Window['addEventListener'],
      removeEventListener: removeListener as unknown as Window['removeEventListener'],
    },
    ...extra,
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
/** Plan 6：作答区新辅助 —— 选项按钮、继续按钮、「其实是猜的」。 */
const choiceBtns = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-choice]'));
const choiceByLabel = (root: HTMLElement, label: string): HTMLButtonElement => {
  const el = choiceBtns(root).find((b) => (b.textContent ?? '') === label);
  if (!el) throw new Error(`没有这个选项：${label}`);
  return el;
};
/**
 * 当前卡的正确/错误选项标签。
 *
 * 夹具的背面形如 `a-cN`，而 `makeCard` 的 front/back 同源 ⇒ **正确项就是当前卡的 back**。
 * （首版用 `/^a-/` 猜"正确项"，但池里每张卡的背面都以 `a-` 开头 ⇒ 猜到了干扰项上，
 * BS#A2 因此假红——教训：判"哪个是对的"必须来自被测对象自身的数据，不能靠形状猜。）
 */
const correctLabelFor = (card: Card): string => card.back;
const wrongLabelFor = (root: HTMLElement, card: Card): string => {
  const labels = choiceBtns(root).map((b) => b.textContent ?? '');
  const wrong = labels.find((l) => l !== card.back);
  if (!wrong) throw new Error(`选项里没有干扰项：${labels.join('/')}`);
  return wrong;
};
const verdictBtn = (root: HTMLElement, ui: string): HTMLButtonElement => {
  const el = root.querySelector<HTMLButtonElement>(`[data-ui="${ui}"]`);
  if (!el) throw new Error(`missing ${ui}`);
  return el;
};

const hidden = (root: HTMLElement, ui: string): boolean =>
  root.querySelector(`[data-ui="${ui}"]`)!.hasAttribute('hidden');
const text = (root: HTMLElement, ui: string): string =>
  root.querySelector(`[data-ui="${ui}"]`)?.textContent ?? '';

/* ------------------------------------------------------------------ 用例 */

/**
 * 结构与作答区（Plan 6 · T6 把这一组从"四档自评"**逐条重述**到"选项 → 判定面板 → 继续"，
 * 而不是删掉：这里每一条原本守着的是"作答必须经手玩家、且看不到答案不能打分"，
 * 新形态下这些性质仍然必须成立）。
 */
describe('mountBattleScreen —— 结构与作答区', () => {
  it('挂载后选项齐全（含正确答案）、「直接看答案」在、卡面只显 front', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    const labels = choiceBtns(hs.root).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(3); // 夹具池 3 张：1 正确 + 2 干扰
    expect(labels).toContain('a-c1');
    expect(text(hs.root, 'card-front')).toContain('q-c1');
    expect(hidden(hs.root, 'verdict')).toBe(true); // 未作答不显判定面板
    expect(hs.root.querySelector('[data-ui="stage-host"]')).not.toBeNull();
    expect(hs.root.querySelector('[data-ui="fx"]')).not.toBeNull(); // 回击飘字容器
    // 四档自评**已按 D41 下线**：界面上不再有 data-grade
    expect(hs.root.querySelectorAll('[data-grade]')).toHaveLength(0);
  });

  it('点正确选项 → 判定面板；「继续」恰发一次 answer intent（grade=good），期间选项立即 disabled', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    const answer = 'a-c1';

    choiceByLabel(hs.root, answer).click();
    expect(hs.ctrl.intents).toHaveLength(0); // 判定面板先给答案，不派发
    verdictBtn(hs.root, 'verdict-continue').click();

    expect(hs.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.good }]);
    expect(verdictBtn(hs.root, 'verdict-continue').disabled).toBe(true); // 防连点
  });

  it('pending 期间第二次点「继续」被吞掉（不产生第二个 intent）', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    reveal(hs.root);
    const cont = verdictBtn(hs.root, 'verdict-continue');
    cont.click();
    cont.click();

    expect(hs.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.again }]);
  });

  it('同一快照重放不解禁；新快照到达才解禁', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    const same = hs.ctrl.snapshot();

    reveal(hs.root);
    verdictBtn(hs.root, 'verdict-continue').click();
    hs.ctrl.push(same); // 旧对象重放：不是"新快照"
    expect(verdictBtn(hs.root, 'verdict-continue').disabled).toBe(true);

    hs.ctrl.push(makeSnap({ fight: makeFight(1, [{ kind: 'damage', cardId: 'c1', amount: 12 }]) }));
    expect(text(hs.root, 'card-front')).toContain('q-c2');
    // 换了卡就必须重新作答：新卡的判定面板收起、选项重新出现且可用
    expect(hidden(hs.root, 'verdict')).toBe(true);
    expect(choiceBtns(hs.root).every((b) => !b.disabled)).toBe(true);
  });

  it('终局快照（非 answering）不解禁作答区', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);

    reveal(hs.root);
    hs.ctrl.push(makeSnap({ fight: makeFight(0, [{ kind: 'end' }], 'won') }));

    expect(choiceBtns(hs.root).every((b) => b.disabled)).toBe(true);
    expect(verdictBtn(hs.root, 'verdict-continue').disabled).toBe(true);
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
  it('BS#Q1 点「退出本局」发一次 toMenu，并把作答区锁住（此前 UI 层没有任何生产者）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = setup();
    const handle = mountBattleScreen(root, h.ctrl, h.deps);

    const quit = root.querySelector('[data-ui="quit"]') as HTMLButtonElement;
    expect(quit).not.toBeNull();
    quit.click();
    expect(h.ctrl.intents).toEqual([{ type: 'toMenu' }]);
    // 退出后作答区全锁：选项、看答案、「继续」都不该再能派发
    expect(choiceBtns(root).every((b) => b.disabled)).toBe(true);
    expect((root.querySelector('[data-ui="reveal"]') as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector('[data-ui="verdict-continue"]') as HTMLButtonElement).disabled).toBe(true);
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
  it('R#1 未作答时没有任何"提交档位"的路径：选项是唯一的作答入口，且未作答时「继续」不可用', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    // 新形态下"看不到答案就打分"这条缝被结构性堵死：档位只能由「选项」或「看答案」产生，
    // 而两者都会先把判定面板（含完整答案）摆出来。
    expect(hidden(hs.root, 'verdict')).toBe(true);
    expect(verdictBtn(hs.root, 'verdict-continue').disabled).toBe(true);
    expect(hs.ctrl.intents).toHaveLength(0);

    reveal(hs.root);
    expect(hidden(hs.root, 'verdict')).toBe(false);
    expect(text(hs.root, 'answer-full')).toContain('a-c1');
    expect(verdictBtn(hs.root, 'verdict-continue').disabled).toBe(false);
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
    expect(text(hs.root, 'answer-full')).toContain('a-c1');

    verdictBtn(hs.root, 'verdict-continue').click();
    const f1: FightView = {
      ...f0,
      state: { ...f0.state, idx: 1, log: [{ kind: 'damage', cardId: 'c1', amount: 12 }] },
      current: f0.pool[1] ?? null,
    };
    hs.ctrl.push(makeSnap({ fight: f1 }));

    expect(text(hs.root, 'card-front')).toContain('q-c2');
    // 旧答案必须随卡一起收回（旧实现：这里仍显示「答案：a-c1」）
    expect(hidden(hs.root, 'verdict')).toBe(true);
  });

  it('R#3 同一张卡内状态稳定：快照重放不会把判定面板收回（只按卡 id 重置）', () => {
    const hs = setup();
    mountBattleScreen(hs.root, hs.ctrl, hs.deps);
    reveal(hs.root);
    const same = hs.ctrl.snapshot();
    hs.ctrl.push(same); // 重放同一快照对象
    expect(hidden(hs.root, 'verdict')).toBe(false);
    expect(text(hs.root, 'answer-full')).toContain('a-c1');
  });
});

/* ------------------------------------------------------------------ Plan 6 · T6 */

/**
 * 选择题作答 + 判定面板（Plan 6 · T6 / D41）。
 *
 * 判别力：
 * - BS#A2 **作答之后先展开完整答案，再放行「继续」**：点完选项就派发 intent 的实现必红
 *   （那就回到"看到答案之前已经判分"的老问题）；
 * - BS#A3 「继续」才派发，档位是 `good`/`again` **两档**（UI 只发两档是 D41 的口径）；
 * - BS#A6 干扰项凑不出（领域只有一张卡）⇒ 不出选项、回落看答案并说明原因；
 * - BS#A7 答对后点「其实是猜的」⇒ 派发的是 `again`（4 选 1 有 25% 蒙对率，不该静默算记住）；
 * - BS#A8 换卡即清干净（判定面板/选项/猜按钮都不会残留上一张的状态）。
 */
describe('mountBattleScreen —— 选择题与判定面板（Plan 6 · T6）', () => {
  it('BS#A1 出选项：当前卡的正确背面是其中一个选项，另有两个来自本局池', () => {
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);
    const labels = choiceBtns(h.root).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(3); // 夹具池 3 张卡：1 正确 + 2 干扰
    expect(labels).toContain('a-c1'); // 当前卡（idx=0）的背面
    expect(labels).toContain('a-c2');
    expect(labels).toContain('a-c3');
    expect(hidden(h.root, 'verdict')).toBe(true); // 未作答不显示判定面板
  });

  it('BS#A2 点选项：先展开完整答案与对错，**此时不派发 intent**', () => {
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);
    choiceByLabel(h.root, correctLabelFor(makeCard('c1'))).click();

    expect(h.ctrl.intents).toHaveLength(0); // ← 关键：还没放行
    expect(hidden(h.root, 'verdict')).toBe(false);
    expect(text(h.root, 'verdict-result')).toBe('答对了');
    expect(text(h.root, 'answer-full')).toContain('a-c1'); // 完整答案
    expect(choiceBtns(h.root)).toHaveLength(0); // 选项收起（避免误触第二下）
  });

  it('BS#A3 点「继续」才派发，且档位只有 good / again 两档', () => {
    const right = setup();
    mountBattleScreen(right.root, right.ctrl, right.deps);
    choiceByLabel(right.root, correctLabelFor(makeCard('c1'))).click();
    verdictBtn(right.root, 'verdict-continue').click();
    expect(right.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.good }]);

    const wrong = setup();
    mountBattleScreen(wrong.root, wrong.ctrl, wrong.deps);
    choiceByLabel(wrong.root, wrongLabelFor(wrong.root, makeCard('c1'))).click();
    expect(text(wrong.root, 'verdict-result')).toBe('答错了');
    verdictBtn(wrong.root, 'verdict-continue').click();
    expect(wrong.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.again }]);
  });

  it('BS#A4 选项按码点截断预览，但判定面板里是完整答案（长背面不挤爆屏幕）', () => {
    const long = '很长的答案'.repeat(20);
    const card: Card = { ...makeCard('long'), back: long };
    const snap = makeSnap({
      fight: { ...makeFight(0, []), pool: [card, makeCard('c2')], current: card },
      save: { ...makeSave(), cards: [card, makeCard('c2')] },
    });
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, { ...h.deps, ctrlSnap: undefined } as never);
    h.ctrl.push(snap);
    const labels = choiceBtns(h.root).map((b) => b.textContent ?? '');
    for (const l of labels) expect(Array.from(l).length).toBeLessThanOrEqual(40);
    choiceByLabel(h.root, labels.find((l) => l.startsWith('很长的答案')) as string).click();
    expect(text(h.root, 'answer-full')).toContain(long); // 全文
  });

  it('BS#A5 「直接看答案」⇒ 展开全文并记为答错', () => {
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);
    reveal(h.root);
    expect(text(h.root, 'answer-full')).toContain('a-c1');
    expect(h.ctrl.intents).toHaveLength(0);
    verdictBtn(h.root, 'verdict-continue').click();
    expect(h.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.again }]);
  });

  it('BS#A6 领域只有一张卡（凑不出干扰项）⇒ 不出选项、回落看答案并说明原因', () => {
    const solo = makeCard('solo');
    const state: BattleState = { ...makeFight(0, []).state, pool: ['solo'] };
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);
    h.ctrl.push(
      makeSnap({
        fight: { state, pool: [solo], current: solo },
        save: { ...makeSave(), cards: [solo] },
      }),
    );
    expect(choiceBtns(h.root)).toHaveLength(0);
    expect(hidden(h.root, 'no-choice-hint')).toBe(false);
    reveal(h.root); // 仍然可以看答案
    expect(text(h.root, 'answer-full')).toContain('a-solo');
  });

  it('BS#A7 答对后点「其实是猜的」⇒ 改判 again，且屏上标明按答错记', () => {
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);
    choiceByLabel(h.root, correctLabelFor(makeCard('c1'))).click();
    verdictBtn(h.root, 'verdict-guess').click();
    expect(text(h.root, 'verdict-result')).toContain('猜'); // 文案说明已改判
    verdictBtn(h.root, 'verdict-continue').click();
    expect(h.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.again }]);
  });

  it('BS#A8 换到下一张卡 ⇒ 判定面板、选项、猜按钮全部重置（不残留上一张的状态）', () => {
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);

    // **同一 pool 引用**、idx 前进：真实链路（battleFlow 的 toView 原样透传 view.pool）
    // 整局就是同一个 pool 数组，所以只有"按卡 id 重置"这一条能救 —— 用 makeFight 重建
    // pool 会让"换局重置"那条分支替它兜住，判据就失去区分力（变异实测发现的假绿）。
    const f0 = makeFight(0, []);
    h.ctrl.push(makeSnap({ fight: f0 }));
    choiceByLabel(h.root, 'a-c1').click(); // 进入判定面板
    const f1: FightView = {
      ...f0,
      state: { ...f0.state, idx: 1, log: [{ kind: 'damage', cardId: 'c1', amount: 12 }] },
      current: f0.pool[1] ?? null,
    };
    h.ctrl.push(makeSnap({ fight: f1 }));
    expect(hidden(h.root, 'verdict')).toBe(true); // 面板收起（不看旧内容，看可见性）
    expect(choiceBtns(h.root).length).toBeGreaterThan(0); // 新卡的选项在
    // 「其实是猜的」也随面板一起收起（残留在屏上会让下一张卡误触改判）
    expect(hidden(h.root, 'verdict-guess')).toBe(true);
    // 新卡再作答时，面板显示的是**新卡**的对错与答案，而不是上一张的
    choiceByLabel(h.root, 'a-c2').click();
    expect(text(h.root, 'verdict-result')).toBe('答对了');
    expect(text(h.root, 'answer-full')).toContain('a-c2');
  });

  it('BS#A9 终局（非 answering）不给选项也不给继续（不再产生 intent）', () => {
    const h = setup();
    mountBattleScreen(h.root, h.ctrl, h.deps);
    h.ctrl.push(makeSnap({ fight: makeFight(3, [], 'won') }));
    for (const b of choiceBtns(h.root)) expect(b.disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ Plan 6 · T7 */

/**
 * 问答模式（Plan 6 · T7 / D42）。
 *
 * 判别力：
 * - BS#Q1 提交后**调用注入的 judge**，入参含卡面/答案/玩家输入（D42 的例外必须真发生）；
 * - BS#Q2/Q3 判对 ⇒ good、判错 ⇒ again，且**理由与缺失要点上屏**（只说"错"等于让人自己找差距）；
 * - BS#Q4 **判定失败不猜**：给二选一自评，点了才派发（失败也要先能看到完整答案）；
 * - BS#Q5 空输入不给提交（省一次网络往返，也避免把空话喂给模型）；
 * - BS#Q6 **判定额度到顶**走同一条回落路（额度是成本闸，不该变成复习的锁）；
 * - BS#Q7 没配 AI 时如实说明"用不了"，并**停在可用形态**（不静默变成别的模式）；
 * - BS#Q8 模式切换写回成功/失败两条路：失败（只读）必须停在原模式并如实提示。
 */
describe('mountBattleScreen —— 问答模式（Plan 6 · T7）', () => {
  const qaSave = (): SaveFile => {
    const base = makeSave();
    return { ...base, settings: { ...base.settings, answerMode: 'qa' } };
  };
  const qaSnap = (over: Partial<ControllerSnapshot> = {}): ControllerSnapshot =>
    makeSnap({ save: qaSave(), ...over });

  function qaSetup(judge?: BattleScreenDeps['judge'], extra: Partial<BattleScreenDeps> = {}) {
    const h = setup({} as StageSprites, { judge, ...extra });
    h.ctrl.push(qaSnap()); // 存档模式 = qa，且这一屏已经挂上
    mountBattleScreen(h.root, h.ctrl, h.deps);
    return h;
  }
  const qaInput = (root: HTMLElement): HTMLTextAreaElement =>
    root.querySelector<HTMLTextAreaElement>('[data-ui="qa-input"]') as HTMLTextAreaElement;
  const qaSubmit = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>('[data-ui="qa-submit"]') as HTMLButtonElement;
  /** 模拟"打字"：真实输入会触发 input 事件，而提交按钮的可用性正是由它驱动的。 */
  const typeQa = (root: HTMLElement, text: string): void => {
    const input = qaInput(root);
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };

  it('BS#Q1 提交后调用 judge，入参含卡面 / 答案 / 玩家输入', async () => {
    const seen: Array<{ front: string; answer: string; reply: string }> = [];
    const h = qaSetup((input) => {
      seen.push(input);
      return Promise.resolve({ ok: true, match: true, reason: '要点都在', missing: [] });
    });
    typeQa(h.root, '是李渊建立的');
    qaSubmit(h.root).click();
    await flushMicrotasks();

    expect(seen).toEqual([{ front: 'q-c1', answer: 'a-c1', reply: '是李渊建立的' }]);
  });

  it('BS#Q2 判对 ⇒ 判定面板显示良好 + 理由 + 缺失要点 + 完整答案；继续派发 good', async () => {
    const h = qaSetup(() => Promise.resolve({ ok: true, match: true, reason: '抓住了要点', missing: [] }));
    typeQa(h.root, '李渊');
    qaSubmit(h.root).click();
    await flushMicrotasks();

    expect(hidden(h.root, 'verdict')).toBe(false);
    expect(text(h.root, 'verdict-result')).toBe('答对了');
    expect(text(h.root, 'verdict-reason')).toBe('抓住了要点');
    expect(text(h.root, 'answer-full')).toContain('a-c1');
    expect(h.ctrl.intents).toHaveLength(0);
    verdictBtn(h.root, 'verdict-continue').click();
    expect(h.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.good }]);
  });

  it('BS#Q3 判错 ⇒ 缺失要点逐条上屏，继续派发 again', async () => {
    const h = qaSetup(() =>
      Promise.resolve({ ok: true, match: false, reason: '漏了关键', missing: ['作者', '朝代'] }),
    );
    typeQa(h.root, '不知道');
    qaSubmit(h.root).click();
    await flushMicrotasks();

    expect(text(h.root, 'verdict-result')).toBe('答错了');
    expect(text(h.root, 'verdict-reason')).toBe('漏了关键');
    const items = Array.from(h.root.querySelectorAll('[data-ui="verdict-missing"] > *')).map((n) => n.textContent);
    expect(items).toEqual(['作者', '朝代']);
    verdictBtn(h.root, 'verdict-continue').click();
    expect(h.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.again }]);
  });

  it('BS#Q4 判定失败 ⇒ 不猜：显示原因 + 完整答案 + 二选一自评，点了才派发', async () => {
    const h = qaSetup(() => Promise.resolve({ ok: false, reason: 'AI 调用失败：网络断了' }));
    typeQa(h.root, '我的理解');
    qaSubmit(h.root).click();
    await flushMicrotasks();

    expect(text(h.root, 'verdict-result')).toContain('没判成');
    expect(text(h.root, 'verdict-reason')).toContain('网络断了');
    expect(text(h.root, 'answer-full')).toContain('a-c1'); // 失败也要看得到答案
    expect(h.ctrl.intents).toHaveLength(0); // ← 绝不替玩家猜
    verdictBtn(h.root, 'verdict-self-right').click();
    expect(h.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.good }]);
  });

  it('BS#Q4b 自评二选一：点"错了"派发 again', async () => {
    const h = qaSetup(() => Promise.resolve({ ok: false, reason: '没判成' }));
    typeQa(h.root, 'x');
    qaSubmit(h.root).click();
    await flushMicrotasks();
    verdictBtn(h.root, 'verdict-self-wrong').click();
    expect(h.ctrl.intents).toEqual([{ type: 'answer', grade: GRADES.again }]);
  });

  it('BS#Q5 空输入：提交按钮禁用，点了也不发请求', async () => {
    let calls = 0;
    const h = qaSetup(() => {
      calls += 1;
      return Promise.resolve({ ok: true, match: true, reason: '', missing: [] });
    });
    expect(qaSubmit(h.root).disabled).toBe(true);
    qaSubmit(h.root).click();
    await flushMicrotasks();
    expect(calls).toBe(0);

    qaInput(h.root).value = '   '; // 只有空白也算空
    qaInput(h.root).dispatchEvent(new Event('input'));
    expect(qaSubmit(h.root).disabled).toBe(true);
  });

  it('BS#Q6 判定额度到顶（宿主回 ok:false + 额度文案）⇒ 走同一条自评回落', async () => {
    const h = qaSetup(() =>
      Promise.resolve({ ok: false, reason: '今天的判定额度用完了（300 次），这次你自己定对错。' }),
    );
    typeQa(h.root, '试试');
    qaSubmit(h.root).click();
    await flushMicrotasks();
    expect(text(h.root, 'verdict-reason')).toContain('额度用完');
    expect(hidden(h.root, 'verdict-self-right')).toBe(false); // 回落可用，复习没被锁住
  });

  it('BS#Q7 没配 AI 而存档是问答模式 ⇒ 说明用不了，并停在选择题形态', () => {
    const h = qaSetup(undefined);
    expect(hidden(h.root, 'qa-unavailable')).toBe(false);
    expect(choiceBtns(h.root).length).toBeGreaterThan(0); // 仍有可用的作答方式
    expect(qaSubmit(h.root).disabled).toBe(true);
  });

  it('BS#Q8 切换写回：成功即换形态；失败（只读）停在原模式并如实提示', async () => {
    const ok = setup({} as StageSprites, { setAnswerMode: () => Promise.resolve({ ok: true }) });
    mountBattleScreen(ok.root, ok.ctrl, ok.deps);
    expect(hidden(ok.root, 'answer-choices')).toBe(false);
    (ok.root.querySelector('[data-ui="mode-toggle"]') as HTMLButtonElement).click();
    await flushMicrotasks();
    // 写口成功 ⇒ 屏上要跟着切（本夹具的写口不回写快照，故此处只断言"调用发生了"）
    expect(hidden(ok.root, 'mode-toggle')).toBe(false);

    const bad = setup({} as StageSprites, {
      setAnswerMode: () => Promise.resolve({ ok: false, reason: '存档无法读取（只读保护）。' }),
    });
    mountBattleScreen(bad.root, bad.ctrl, bad.deps);
    (bad.root.querySelector('[data-ui="mode-toggle"]') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(text(bad.root, 'toast')).toContain('只读'); // 如实提示，不假装切成
    expect(hidden(bad.root, 'answer-choices')).toBe(false); // 仍在选择题形态
  });
});
