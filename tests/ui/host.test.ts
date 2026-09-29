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
    expect(all(root, '[data-nav]')).toHaveLength(5);
  });

  it('HS#2b 已看过序章（prologueSeen=true）直接进菜单', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapMenu());
    const { deps } = adapters();
    mountHost(root, ctrl, deps);
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull();
    expect(all(root, '[data-nav]')).toHaveLength(5);
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
        lastResult: { won: false, mode: 'fight', expGained: 0, levelBefore: 1, levelAfter: 1, leveledUp: false, misses: 1, poolLen: 1 },
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
        save: () => true,
        clear: () => undefined,
        test: () => Promise.resolve({ ok: true, text: 'pong' }),
        presets: [],
      },
      llmCards: () => Promise.resolve({ ok: true, value: [{ front: 'f', back: 'b', tags: [], choices: ['x', 'y'] }], truncated: false }),
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

  it('战斗屏拿到 judge / setAnswerMode（漏透传 ⇒ 问答模式在生产里不可用而单测全绿）', async () => {
    const root = makeRoot();
    const base = makeSave();
    const fight = {
      state: {
        phase: 'answering' as const,
        pool: base.cards.map((c) => c.id),
        idx: 0,
        enemyHp: 42,
        playerHp: 30,
        maxPlayerHp: 30,
        atk: 12,
        def: 3,
        enemyPower: 7,
        log: [],
      },
      pool: base.cards,
      current: base.cards[0] ?? null,
    };
    const ctrl = makeCtrl(
      makeSnap({
        screen: 'fight',
        fight: fight as never,
        // 序章没看过的档会先挂序章（resolveView 的优先级）⇒ 这里显式标成看过
        save: {
          ...base,
          settings: { ...base.settings, answerMode: 'qa', story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } },
        },
      }),
    );
    // 本文件的夹具把战斗屏换成了 stub（真屏要 canvas/rAF），所以这里**直接取证**透传：
    // 记下宿主交给战斗屏的 deps，再断言两个口确实在里面且是同一份实现。
    let seen: BattleScreenDeps | null = null;
    const judge = () => Promise.resolve({ ok: true as const, match: true, reason: '要点都在', missing: [] });
    const setAnswerMode = () => Promise.resolve({ ok: true as const });
    const { deps } = adapters({
      judge,
      setAnswerMode,
      mountBattle: (_root, _ctrl, battleDeps) => {
        seen = battleDeps;
        const el = document.createElement('div');
        el.setAttribute('data-ui', 'battle-stub');
        _root.appendChild(el);
        return { unmount: () => el.remove(), destroy: () => el.remove() };
      },
    });
    mountHost(root, ctrl, deps);

    expect(seen).not.toBeNull();
    expect((seen as unknown as BattleScreenDeps).judge).toBe(judge); // ← 同一份实现（漏透传 ⇒ undefined）
    expect((seen as unknown as BattleScreenDeps).setAnswerMode).toBe(setAnswerMode);
    expect((seen as unknown as BattleScreenDeps).rng).toBe(deps.rng); // T6 的洗牌源同样透传
  });

  it('设置屏拿到 resetSave / exportBackupNow（漏透传 = 生产里功能是死的，单元测试仍全绿）', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(
      makeSnap({
        screen: 'menu',
        save: {
          ...makeSave(),
          settings: { ...makeSave().settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } },
        },
      }),
    );
    let resets = 0;
    let exports = 0;
    const { deps } = adapters({
      resetSave: () => {
        resets += 1;
        return Promise.resolve({ ok: true, cards: 30, decks: 4 });
      },
      exportBackupNow: () => {
        exports += 1;
        return Promise.resolve({ ok: true });
      },
    });
    mountHost(root, ctrl, deps);
    click(root.querySelector('[data-nav="settings"]') as HTMLElement);

    // ① 分组可见 ⇒ resetSave 透传成功（缺它整组隐藏）
    expect(ui(root, 'save-group').hidden).toBe(false);
    // ② 「先导出备份」可见 ⇒ exportBackupNow 透传成功
    click(ui(root, 'save-reset'));
    await flushMicrotasks();
    expect(ui(root, 'save-export-first').hidden).toBe(false);

    // ③ 走到底：确认后真的调到宿主那份写口
    click(ui(root, 'save-export-first'));
    await flushMicrotasks();
    click(ui(root, 'save-reset-confirm'));
    await flushMicrotasks();
    expect(exports).toBe(1);
    expect(resets).toBe(1);
  });
});

/* ------------------------------------------------------------------ Plan 7 · T5 */

/**
 * 宿主侧：木桩练功不演假记忆（Plan 7 · T5）。
 *
 * 判别力：只要 `!won` 就演假记忆的实现 ⇒ 练完一局木桩会看到"记忆开始褪色"（纯噪音，
 * 而且与"练功不会输"的设定矛盾）。
 */
describe('mountHost —— 木桩练完不演假记忆（Plan 7 · T5）', () => {
  /**
   * 计数用的词表：`pickFakes`/`tamperWord` 只要真的开始挑素材就会**遍历**这张表。
   *
   * 为什么必须看"有没有遍历"而不是"假记忆区可不可见"：result.ts 自己也有一道
   * `!isDrill` 的闸门 ⇒ 宿主漏判 mode 时屏上照样不显示，**可见性看不见这个 bug**
   * （变异实测：M4 首版因此没牙）。真正要钉的是"练功压根不去生成假记忆素材"。
   */
  function countingWordTable(pairs: Array<[string, string]>) {
    const inner = new Map(pairs);
    let walks = 0;
    return {
      walks: () => walks,
      table: {
        [Symbol.iterator]: () => {
          walks += 1;
          return inner[Symbol.iterator]();
        },
      } as unknown as ReadonlyMap<string, string>,
    };
  }

  it('HS#D1 lastResult.mode=drill ⇒ 不挂假记忆；fight 败局照旧挂', () => {
    const cases: Array<{ mode: 'fight' | 'drill'; expectFake: boolean }> = [
      { mode: 'drill', expectFake: false },
      { mode: 'fight', expectFake: true },
    ];
    for (const c of cases) {
      const root = makeRoot();
      const base = makeSave();
      // 素材里必须真的含可替换的词，否则 pickFakes 回空数组 ⇒ 这条用例对"漏了 mode 判断"
      // 的实现没有区分力（变异实测发现的假绿：M4 首版没牙）
      // 篡改发生在**背面**（tamperWord 只扫 card.back）⇒ 词必须放在 back 里
      const pool = [makeCard('c1', { front: '开国皇帝是谁？', back: '唐朝的李渊' })];
      const ctrl = makeCtrl(
        makeSnap({
          screen: 'result',
          save: { ...base, settings: { ...base.settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } } },
          fight: { state: { pool: ['c1'] } as never, pool, current: null },
          lastResult: {
            won: false,
            mode: c.mode,
            expGained: c.mode === 'drill' ? 1 : 0,
            levelBefore: 1,
            levelAfter: 1,
            leveledUp: false,
            misses: 1,
            poolLen: 1,
          },
        }),
      );
      const spy = countingWordTable([['唐朝', '宋朝']]);
      const { deps } = adapters({ wordTable: spy.table });
      mountHost(root, ctrl, deps);
      expect(root.querySelector('[data-ui="result-screen"]')).not.toBeNull();
      const fakeHidden = (ui(root, 'fake-memory') as HTMLElement).hidden;
      expect(fakeHidden, `${c.mode} 的假记忆显隐`).toBe(!c.expectFake);
      // drill：**一次都不该去挑素材**（非 0 即证明宿主漏了 mode 判断）
      expect(spy.walks() > 0, `${c.mode} 是否真的挑过假记忆素材`).toBe(c.expectFake);
      document.body.replaceChildren();
    }
  });
});

/* ------------------------------------------------------------------ Plan 7 · T6 */

/**
 * 练功屏的宿主接线（Plan 7 · T6）。
 *
 * 判别力：菜单里必须有「练功」入口（漏了 = 玩家到不了这一屏），且**勾选后点「练这一域」
 * 必须真的走到 `onDrill`**（宿主漏透传 = 按钮永远禁用/点了没反应，而屏级单测全绿）。
 */
describe('mountHost —— 练功入口与 onDrill 透传（Plan 7 · T6）', () => {
  it('HS#P1 菜单有「练功」；进屏后勾选并开练 ⇒ 走到注入的 onDrill', () => {
    const root = makeRoot();
    const base = makeSave();
    const cards = [
      makeCard('c1', { srs: { ...makeSave().cards[0].srs, stability: 'new', due: 0 } }),
      makeCard('c2', { srs: { ...makeSave().cards[0].srs, stability: 'new', due: 0 } }),
    ];
    const ctrl = makeCtrl(
      makeSnap({
        screen: 'menu',
        save: { ...base, settings: { ...base.settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } }, cards },
      }),
    );
    const seen: string[][] = [];
    const { deps } = adapters({ onDrill: ({ cardIds }) => void seen.push([...cardIds]) });
    mountHost(root, ctrl, deps);

    const entry = root.querySelector('[data-nav="practice"]') as HTMLElement | null;
    expect(entry, '菜单里没有「练功」入口').not.toBeNull();
    entry?.click();
    expect(root.querySelector('[data-ui="practice-screen"]')).not.toBeNull();

    // 打开第一个领域 → 勾选默认就有了 → 开练
    click(root.querySelector('[data-deck]') as HTMLElement);
    click(ui(root, 'drill-start'));
    expect(seen).toHaveLength(1);
    expect(seen[0].sort()).toEqual(['c1', 'c2']);
  });
});

/* ------------------------------------------------------------------ Plan 8 · T9 */

/**
 * 练功屏「采新卡」的宿主透传（Plan 8 · T9）。
 *
 * 判别力：采新卡整块依赖（ingestUrl/collectCards/inbox/addCard/addDeck）**缺一个就整块收起** ——
 * 漏透传 = 生产里"采新卡"是死的（点了没反应/入口不显示），而屏级单测全绿。
 */
describe('mountHost —— 采新卡透传（Plan 8 · T9）', () => {
  it('HS#C1 五个口齐 ⇒ 采新卡分区可用；缺 collectCards ⇒ 整块收起', () => {
    const base = makeSave();
    const ctrl = makeCtrl(
      makeSnap({
        screen: 'menu',
        save: {
          ...base,
          settings: { ...base.settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } },
        },
      }),
    );
    const seen: string[] = [];
    const { deps } = adapters({
      ingestUrl: () => {
        seen.push('ingest');
        return Promise.resolve({ kind: 'blocked', url: 'u', reason: 'r', blocked: true });
      },
      collectCards: () =>
        Promise.resolve({
          ok: true,
          candidates: [],
          quota: { day: '', cards: 0, judges: 0 },
          requests: 0,
          truncated: false,
        }),
      inbox: { load: () => [], save: () => true, clear: () => undefined },
      addCard: () => Promise.resolve({ ok: true, value: makeCard('x') }),
    });
    const root = makeRoot();
    mountHost(root, ctrl, deps);
    click(root.querySelector('[data-nav="practice"]') as HTMLElement);
    // 分区条在（说明整块 collect 依赖透传成功）
    expect(ui(root, 'practice-tabs').hidden).toBe(false);
    click(ui(root, 'tab-collect'));
    expect(root.querySelector('[data-ui="practice-collect"]')).not.toBeNull();
    // 真的能走到注入的抓取口
    (ui(root, 'source-url') as HTMLInputElement).value = 'https://x.example/a';
    click(ui(root, 'source-go'));
    return flushMicrotasks().then(() => {
      expect(seen).toEqual(['ingest']);
      document.body.replaceChildren();

      // 缺 collectCards ⇒ 分区条整块收起（不显示点了没反应的入口）
      const ctrl2 = makeCtrl(
        makeSnap({
          screen: 'menu',
          save: {
            ...base,
            settings: { ...base.settings, story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 } },
          },
        }),
      );
      const { deps: deps2 } = adapters({});
      const root2 = makeRoot();
      mountHost(root2, ctrl2, deps2);
      click(root2.querySelector('[data-nav="practice"]') as HTMLElement);
      expect(ui(root2, 'practice-tabs').hidden).toBe(true);
    });
  });
});
