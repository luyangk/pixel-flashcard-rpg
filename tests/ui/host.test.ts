// @vitest-environment happy-dom
/**
 * tests/ui/host.test.ts —— Plan 4 · T11：宿主壳（屏路由 / 序章 / 只读横幅 / 依赖注入）。
 *
 * 判别力：
 * - HS#1 `resolveView` 的优先级是纯函数断言：序章 > fight > result > prepare(错误停留) > 本地路由。
 *   把 prepare 的优先级写丢（例如"本地路由优先"），HS#1/HS#4 必红——那正是"开局失败后玩家
 *   看不到 lastError 全屏乱转"的病灶；
 * - HS#2 序章在 `needsPrologue` 为真时**先演**，onDone 派 `seenPrologue` 后立刻换成菜单
 *   （T6 顾虑 #1 的闭环）：不派意图的实现会永远卡在序章；
 * - HS#4 会话位优先：本地路由停在卡组页时推入 fight 快照，必须换战斗屏（否则点击"开战"
 *   后画面不动）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameController } from '../../src/app/controllerTypes';
import type { BattleScreenDeps } from '../../src/ui/battleScreen';
import { mountHost, resolveView, type HostDeps, type HostRoute } from '../../src/ui/host';
import type { StageSprites } from '../../src/stage/renderer';
import { all, click, makeCtrl, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

function img(): HTMLImageElement {
  return document.createElement('img');
}

function sprites(): StageSprites {
  return { hero: img(), mob: img(), boss: img(), bg: img() };
}

/** 假战斗屏：只记"挂了几次"并在 DOM 里留一个可断言的标记（真屏需要 rAF 与 canvas）。 */
function fakeBattle(): { deps: Pick<HostDeps, 'mountBattle'>; mounts: () => number } {
  let mounts = 0;
  return {
    mounts: () => mounts,
    deps: {
      mountBattle: (root, _ctrl: GameController, _deps: BattleScreenDeps) => {
        mounts += 1;
        const el = document.createElement('div');
        el.setAttribute('data-ui', 'battle-stub');
        root.appendChild(el);
        const off = (): void => el.remove();
        return { unmount: off, destroy: off };
      },
    },
  };
}

function adapters(over: Partial<HostDeps> = {}): { deps: HostDeps; battleMounts: () => number } {
  const battle = fakeBattle();
  return {
    battleMounts: battle.mounts,
    deps: {
      prologueScenes: [{ text: '知识不再入脑，云端即是记忆。', art: 'assets/sprites/prologue-01-cloud-age.png' }],
      beats: ['混沌又退了一尺。'],
      sprites: sprites(),
      rng: () => 0.5,
      now: () => 0,
      tzOffsetMin: 480,
      newId: () => 'id-1',
      wordTable: new Map(),
      toastMs: 0,
      ...battle.deps,
      ...over,
    },
  };
}

function snapMenu(over: Parameters<typeof makeSnap>[0] = {}) {
  const base = makeSave();
  return makeSnap({
    screen: 'menu',
    save: { ...base, settings: { ...base.settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } } },
    ...over,
  });
}

describe('resolveView —— 优先级（唯一的分支权威）', () => {
  it('HS#1 序章 > fight > result > prepare > 本地路由', () => {
    const routes: HostRoute[] = ['menu', 'prepare', 'decks', 'codex', 'settings'];
    for (const route of routes) {
      // 普通状态：走本地路由
      expect(resolveView(snapMenu(), route, false)).toEqual({ kind: 'screen', route });
      // 会话位逐个压过本地路由
      expect(resolveView(makeSnap({ screen: 'prepare' }), route, false)).toEqual({ kind: 'prepare' });
      expect(resolveView(makeSnap({ screen: 'fight' }), route, false)).toEqual({ kind: 'battle' });
      expect(resolveView(makeSnap({ screen: 'result' }), route, false)).toEqual({ kind: 'result' });
      // 序章压过一切
      expect(resolveView(makeSnap({ screen: 'fight' }), route, true)).toEqual({ kind: 'prologue' });
    }
  });
});

describe('mountHost —— 序章（needsPrologue 闭环）', () => {
  it('HS#2 首次启动先演序章；看完派 seenPrologue 并换成菜单', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave() })); // prologueSeen=false
    const { deps } = adapters();
    mountHost(root, ctrl, deps);

    expect(ui(root, 'prologue-text').textContent).toBe('知识不再入脑，云端即是记忆。');
    expect(all(root, '[data-nav]')).toHaveLength(0); // 序章期间没有菜单

    click(ui(root, 'prologue-screen')); // 单屏 ⇒ 一次点击即收尾
    expect(ctrl.intents).toEqual([{ type: 'seenPrologue' }]);
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull();

    // 控制器推的回执快照（prologueSeen=true）⇒ 菜单上场
    ctrl.push(snapMenu());
    expect(all(root, '[data-nav]')).toHaveLength(4);
  });

  it('HS#2b 已看过序章（prologueSeen=true）直接进菜单', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    mountHost(root, ctrl, deps);
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull();
    expect(all(root, '[data-nav]')).toHaveLength(4);
  });
});

describe('mountHost —— 换屏与本地路由', () => {
  it('HS#3 菜单入口换屏；返回回菜单；会话位（fight）压过本地路由', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps, battleMounts } = adapters();
    mountHost(root, ctrl, deps);

    click(root.querySelector('[data-nav="decks"]') as HTMLElement);
    expect(root.querySelector('[data-ui="decks-screen"]')).not.toBeNull();

    click(ui(root, 'back'));
    expect(root.querySelector('[data-ui="menu-screen"]')).not.toBeNull();

    click(root.querySelector('[data-nav="settings"]') as HTMLElement);
    expect(root.querySelector('[data-ui="settings-screen"]')).not.toBeNull();

    // 本地路由还停在设置页时，控制器进入战斗 ⇒ 必须换战斗屏
    ctrl.push(makeSnap({ screen: 'fight', fight: { state: { pool: [] } as never, pool: [], current: null } }));
    expect(root.querySelector('[data-ui="battle-stub"]')).not.toBeNull();
    expect(root.querySelector('[data-ui="settings-screen"]')).toBeNull();
    expect(battleMounts()).toBe(1);
  });

  it('HS#4 startFight 失败（screen=prepare + lastError）时停在备战屏并显示错误', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    mountHost(root, ctrl, deps);

    click(root.querySelector('[data-nav="decks"]') as HTMLElement); // 本地路由 = 卡组页
    ctrl.push(
      makeSnap({
        screen: 'prepare',
        save: snapMenu().save,
        lastError: { code: 'no-cards', message: '卡库里没有可用的卡。' },
      }),
    );
    expect(root.querySelector('[data-ui="prepare-screen"]')).not.toBeNull();
    expect(ui(root, 'start-error').hidden).toBe(false);
    expect(ui(root, 'start-error').textContent).toContain('卡库里没有可用的卡。');
  });

  it('HS#5 回到会话 menu 位时本地路由复位（回菜单后不该还停在卡组页）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    mountHost(root, ctrl, deps);

    click(root.querySelector('[data-nav="codex"]') as HTMLElement);
    expect(root.querySelector('[data-ui="codex-screen"]')).not.toBeNull();

    // 控制器从会话里回菜单（例如 finish/toMenu）：快照 screen 变回 menu
    ctrl.push(makeSnap({ screen: 'prepare' }));
    ctrl.push(snapMenu());
    expect(root.querySelector('[data-ui="menu-screen"]')).not.toBeNull();
  });

  it('HS#6 只读态常驻横幅：进任意屏都在，unmount 后全部摘掉', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    const handle = mountHost(root, ctrl, deps);
    expect(ui(root, 'readonly-bar').hidden).toBe(true);

    ctrl.push(snapMenu({ readOnly: true }));
    expect(ui(root, 'readonly-bar').hidden).toBe(false);
    expect(ui(root, 'readonly-text').textContent).toBe('存档无法读取，本次进度不会保存');

    click(root.querySelector('[data-nav="decks"]') as HTMLElement);
    expect(ui(root, 'readonly-bar').hidden).toBe(false); // 换屏不影响横幅

    handle.unmount();
    expect(root.querySelector('[data-ui="readonly-bar"]')).toBeNull();
    expect(all(root, '[data-nav]')).toHaveLength(0);
  });

  it('HS#7 结果屏：败局带上假记忆素材（wordTable 注入才有演出）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const battle = fakeBattle();
    const { deps } = adapters({
      ...battle.deps,
      wordTable: new Map([['唐朝', '宋朝']]),
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    mountHost(root, ctrl, deps);

    const pool = [
      {
        id: 'c1',
        deckId: 'deck-a',
        front: '唐朝开国皇帝是谁？',
        back: '李渊，唐朝开国皇帝。',
        srs: { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, stability: 'new' as const, effectiveReviewDays: [] },
        tags: [],
      },
    ];
    ctrl.push(makeSnap({ screen: 'fight', fight: { state: { pool: ['c1'] } as never, pool, current: null } }));
    ctrl.push(
      makeSnap({
        screen: 'result',
        fight: { state: { pool: ['c1'] } as never, pool, current: null },
        lastResult: { won: false, expGained: 0, levelBefore: 1, levelAfter: 1, leveledUp: false, misses: 1, poolLen: 1 },
      }),
    );

    expect(root.querySelector('[data-ui="result-screen"]')).not.toBeNull();
    const fake = ui(root, 'fake-card');
    expect(ui(root, 'fake-memory').hidden).toBe(false);
    expect(ui(root, 'fake-back').textContent).toContain('宋朝'); // 篡改后的答案
    expect(fake.getAttribute('data-fake-rule')).toBe('word-swap');
  });
});
