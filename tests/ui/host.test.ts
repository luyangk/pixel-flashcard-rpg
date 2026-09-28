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
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, makeSrs, ui } from './support';

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

/** 点完序章（本文件的夹具只有一屏）。 */
function clickThroughPrologue(root: HTMLElement): void {
  const screen = root.querySelector('[data-ui="prologue-screen"]') as HTMLElement | null;
  if (!screen) throw new Error('序章屏不存在');
  screen.click();
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

  it('HS#8 备战屏有返回入口（T11 评审判 I-1：此前是条导航死路）', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    mountHost(root, ctrl, deps);

    click(root.querySelector('[data-nav="prepare"]') as HTMLElement);
    expect(root.querySelector('[data-ui="prepare-screen"]')).not.toBeNull();
    const back = ui(root, 'back');
    expect(back.hidden).toBe(false);
    click(back);
    expect(root.querySelector('[data-ui="menu-screen"]')).not.toBeNull();
    expect(root.querySelector('[data-ui="prepare-screen"]')).toBeNull();
  });

  it('HS#9 宿主句柄的 replayPrologue 当场重演序章（设置页「重看序章」的落点）', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave() })); // prologueSeen=false
    const { deps } = adapters();
    const handle = mountHost(root, ctrl, deps);
    expect(root.querySelector('[data-ui="prologue-screen"]')).not.toBeNull();

    clickThroughPrologue(root);
    expect(ctrl.intents).toEqual([{ type: 'seenPrologue' }]);
    const base = makeSave();
    ctrl.push(snapMenu({ save: { ...base, settings: { ...base.settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } } } }));
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull();

    // 玩家在设置页点了「重看序章」⇒ 设置写口成功后宿主调它
    handle.replayPrologue();
    expect(root.querySelector('[data-ui="prologue-screen"]')).not.toBeNull();
    expect(root.querySelector('[data-ui="menu-screen"]')).toBeNull();
  });

  it('HS#10 startFight 失败**不重建**备战屏：玩家刚选的池子不该被静默复位（评审判 I-3）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    mountHost(root, ctrl, deps);

    click(root.querySelector('[data-nav="prepare"]') as HTMLElement);
    const sizeBtn = (n: number): HTMLElement => root.querySelector(`[data-size="${n}"]`) as HTMLElement;
    click(sizeBtn(25));
    expect(sizeBtn(25).getAttribute('aria-pressed')).toBe('true');

    // 控制器把屏停在 prepare 并带 lastError（键必须与本地路由的 prepare 归一，否则整屏重建）
    ctrl.push(
      makeSnap({
        screen: 'prepare',
        lastError: { code: 'insufficient-cards', message: '这个领域的卡不够凑一局。' },
      }),
    );
    expect(ui(root, 'start-error').hidden).toBe(false);
    expect(sizeBtn(25).getAttribute('aria-pressed')).toBe('true'); // 选择还在
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

/**
 * HS#11 —— Plan 5 · T4/T5：**AI 依赖的透传不落空**。
 *
 * 为什么单独立这条（这是真实踩过的坑）：宿主 → 各屏的 deps 是**显式白名单**
 * （`host.ts` 里逐个字段列出来），`HostAdapters` 上加了字段而 host.ts 忘记透传时，
 * 四条屏内单测**全绿**、生产里 AI 功能却是死的。这条用例走**真 mountHost**，
 * 逐个屏断言"注入的假 llm 依赖确实到了屏上"——漏任何一处透传，对应断言必红。
 */
describe('mountHost —— AI 依赖透传到四屏（HS#11）', () => {
  /** 15 个有效复习日 = 低档阈值 15 的达标线（口径同 prepare.test.ts）。 */
  const DAYS = Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

  function aiSave() {
    const base = makeSave({
      decks: [
        makeDeck('d-boss', '唐诗'), // 未命名自建 + 达标 ⇒ 点 chip 会弹称号窗
        makeDeck('d-clean', '英语词根', { purifiedAt: 200 }), // 已净化、无彩蛋 ⇒ 挂 AI 彩蛋入口
      ],
      cards: [
        makeCard('c1', { deckId: 'd-boss', srs: makeSrs({ stability: 'review', effectiveReviewDays: DAYS }) }),
      ],
    });
    return { ...base, settings: { ...base.settings, bossThresholdTier: 15 as const } };
  }

  it('四个屏各自拿到 llm / llmCards / llmNames / llmEgg+setEgg（漏一处透传即红）', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(
      makeSnap({
        screen: 'menu',
        save: {
          ...aiSave(),
          settings: { ...aiSave().settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } },
        },
      }),
    );
    const { deps } = adapters({
      llm: {
        load: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-fake', model: 'deepseek-chat' }),
        save: () => undefined,
        clear: () => undefined,
        test: () => Promise.resolve({ ok: true, text: 'pong' }),
        presets: [],
      },
      llmCards: () => Promise.resolve({ ok: true, value: [{ front: 'f', back: 'b', tags: [] }], truncated: false }),
      llmNames: () => Promise.resolve({ ok: true, value: [{ name: '诗酒篇·卷灵' }], truncated: false }),
      llmEgg: () => Promise.resolve({ ok: true, text: '一段彩蛋。' }),
      setEgg: () => Promise.resolve({ ok: true }),
      setBossName: () => Promise.resolve({ ok: true, name: 'x' }),
      // AI 辅建卡还要有入库口才整块显示（缺一个就隐藏——见 decks.canAuthor）
      addCard: () => Promise.resolve({ ok: true, value: makeCard('new-card') }),
    });
    mountHost(root, ctrl, deps);

    // ① 设置屏：llm 分组必须存在且可见（说明 deps.llm 透传成功）
    click(root.querySelector('[data-nav="settings"]') as HTMLElement);
    expect(ui(root, 'llm-group').hidden).toBe(false);
    expect(root.querySelectorAll('[data-ui="llm-key"]')).toHaveLength(1);

    // ② 卡组屏：AI 辅建卡入口
    click(ui(root, 'back'));
    click(root.querySelector('[data-nav="decks"]') as HTMLElement);
    expect(ui(root, 'llm-author-section').hidden).toBe(false);
    expect(ui(root, 'llm-author-open').hidden).toBe(false);

    // ③ 藏书阁：已净化且无彩蛋的领域挂「让 AI 写彩蛋」
    click(ui(root, 'back'));
    click(root.querySelector('[data-nav="codex"]') as HTMLElement);
    const eggAi = all(root, '[data-ui="egg-ai"]');
    expect(eggAi).toHaveLength(1);
    expect(eggAi[0].getAttribute('data-egg-deck')).toBe('d-clean');

    // ④ 备战屏：达标卷灵的称号弹窗里有 AI 起名入口
    click(ui(root, 'back'));
    click(root.querySelector('[data-nav="prepare"]') as HTMLElement);
    click(root.querySelector('[data-boss="d-boss"]') as HTMLElement);
    expect(ui(root, 'boss-name-dialog').hidden).toBe(false);
    expect(ui(root, 'boss-name-ai').hidden).toBe(false);

    // ⑤ 透传的是**同一份**依赖：点一下真的能走到假 llmNames（而不是屏内自带空实现）
    click(ui(root, 'boss-name-ai'));
    await flushMicrotasks();
    expect(root.querySelectorAll('[data-name-candidate]')).toHaveLength(1);
  });
});
