// @vitest-environment happy-dom
/**
 * tests/e2e/playable.smoke.test.ts —— Plan 4 · T10：**可玩性**端到端冒烟（DoD2/DoD4 的可执行证据）。
 *
 * 与 Plan 3 的 `tests/app/fullSession.smoke.test.ts`（无画面的逻辑链）分工不同：本文件把
 * **真宿主壳 + 真控制器 + 真屏组件 + 真装配层（`ui/hostAdapters.assembleHost`）**接起来
 * 跑一条完整玩家路径。被替换的只有三处**无头环境里无法真实完成**的边界：
 *   1. 战斗屏（happy-dom 没有 2D canvas context）→ 假 stage 屏；
 *   2. 文件选择与下载（真实现会开系统对话框）→ 两个 spy；
 *   3. 加卡写口 → 恒失败的桩（本冒烟的卡都来自预置内容与导入备份）。
 * 其余一切——屏路由、序章、控制器、导入链（含 flush→import→reload）、只读横幅——
 * 走的都是生产代码本身：
 *
 *   E2E#1 冷启动 → 预置内容灌装（4 领域 30 卡）→ 序章 8 屏 → 菜单
 *   E2E#2 首战（引导域「生活常识」单领域）→ 逐张答对 → 结算屏：胜 + 战报碎片
 *   E2E#3 导入他机备份（30 卡 + 已攒够阈值的引导域 + 高等级）→ 卡组页分页与列表刷新
 *   E2E#4 卷灵现身 → 卷灵战取胜 → 净化 → 藏书阁条目 + 彩蛋 + 练习关（行记三幕仍锁）
 *   E2E#5 导出备份（下载 spy 收到文本）→ 7 天提醒闸门 true → false
 *   E2E#6 只读演练：坏档接管 → 横幅在场 + 坏档原文可导出（D29），序章与只读组合不炸（R-T6-p4-c）
 *
 * 时间纪律：`now` 是测试自己的可变时钟（不读宿主钟），时区固定 UTC+8，
 * rng 注入固定种子——每个断言都是可复算的常量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Deck, SaveFile, Stability, SRSState } from '@core/types';
import { mulberry32 } from '@core/rng';
import { GRADES } from '@core/sm2';
import { validateSave } from '@core/saveMigrate';
import { exportBackup } from '../../src/app/backup';
import { createMemoryStorage } from '@platform/memoryStore';
import { installPresetContent } from '../../src/app/presetContent';
import { setBossName } from '../../src/app/bossFlow';
import { setBossThresholdTier, setDefaultPoolSize, setSm2Params, replayPrologue } from '../../src/app/settingsFlow';
import { saveBeatCursor } from '../../src/app/storyState';
import { exportAndMark, importBackupAndSave } from '../../src/app/transfer';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import { createGameController } from '../../src/app/gameController';
import type { ControllerSnapshot, GameController } from '../../src/app/controllerTypes';
import { mountHost, type HostDeps } from '../../src/ui/host';
import type { HostAdapters } from '../../src/ui/hostTypes';
import { assembleHost } from '../../src/ui/hostAdapters';
import type { BattleScreenDeps } from '../../src/ui/battleScreen';
import arcJson from '../../assets/narrative/arc.json';
import beatsJson from '../../assets/narrative/beats.json';
import eggsJson from '../../assets/narrative/eggs.json';
import fakeWordsJson from '../../assets/narrative/fake-words.json';
import presetJson from '../../assets/content/preset.json';
import prologueJson from '../../assets/narrative/prologue.json';

const TZ = 480;
let NOW = Date.UTC(2026, 9, 26, 4, 0, 0); // UTC+8 下本地日键 2026-10-26
let idSeq = 0;

function card(id: string, deckId: string, reviewDays = 0, stability: Stability = 'new'): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: stability === 'new' ? 0 : 10,
    reps: stability === 'new' ? 0 : 3,
    lapses: 0,
    due: 0,
    stability,
    effectiveReviewDays: Array.from({ length: reviewDays }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`),
  };
  return { id, deckId, front: `问-${id}`, back: `答-${id}`, srs, tags: [] };
}

function img(): HTMLImageElement {
  return document.createElement('img');
}

interface Harness {
  readonly root: HTMLElement;
  readonly ctrl: GameController;
  readonly coord: Coordinator;
  readonly downloads: Array<[string, string]>;
  readonly host: { unmount(): void };
  setPicked(text: string | null): void;
  spies: () => { mountBattle: number };
}

async function boot(opts: { seed?: SaveFile } = {}): Promise<Harness> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const store = createMemoryStorage();
  if (opts.seed) await store.save(opts.seed);
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
  if (!opts.seed) {
    const installed = await installPresetContent(coord, presetJson, NOW);
    expect(installed.installed).toBe(true); // 冷启动必须真的灌上新手套装
    await coord.flush();
  }
  const rawCtrl = await createGameController({ coord, rng: mulberry32(7), now: () => NOW, tzOffsetMin: TZ });

  const calls = { pick: 0, import: 0, export: 0 };
  const downloads: Array<[string, string]> = [];
  let picked: string | null = null;
  let battleMounts = 0;

  // 真装配层（生产同一段代码）：导入前 flush、导入后 reload、练习关走 bossFightParams…全在这
  const { ctrl, adapters } = assembleHost({
    ctrl: rawCtrl,
    coord,
    store,
    now: () => NOW,
    tzOffsetMin: TZ,
    rng: mulberry32(11),
    // 直接用四个 <img> 当舞台素材（happy-dom 没有真解码，也无需等 load 事件）
    sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
    prologueScenes: prologueJson.scenes as unknown as HostAdapters['prologueScenes'],
    beats: beatsJson.beats as unknown as HostAdapters['beats'],
    acts: arcJson.acts as unknown as HostAdapters['acts'],
    eggs: eggsJson.eggs as Readonly<Record<string, string>>,
    wordTable: new Map(Object.entries(fakeWordsJson.pairs as Record<string, string>)),
    toastMs: 0,
    // 文件口与加卡写口：无头环境里换成 spy/桩（见文件头"被替换的三处"）
    pickBackupText: () => {
      calls.pick += 1;
      return Promise.resolve(picked);
    },
    saveTextFile: (text: string, filename: string) => downloads.push([text, filename]),
  });
  const deps: HostDeps = {
    ...adapters,
    addCard: async () => ({ ok: false, reason: '冒烟不手写卡' }),
    mountBattle: (mountRoot, _c, _d: BattleScreenDeps) => {
      battleMounts += 1;
      const el = document.createElement('div');
      el.setAttribute('data-ui', 'battle-stub');
      mountRoot.appendChild(el);
      const off = (): void => el.remove();
      return { unmount: off, destroy: off };
    },
  };
  const exportCalls = (): number => calls.export;

  const trace: string[] = [];
  ctrl.subscribe((snap: ControllerSnapshot) => trace.push(`${snap.screen}:${snap.fight?.state.phase ?? '-'}`));
  const host = mountHost(root, ctrl, deps);
  (root as unknown as { __trace?: string[] }).__trace = trace;
  return {
    root,
    ctrl,
    coord,
    downloads,
    host,
    setPicked: (text) => {
      picked = text;
    },
    spies: () => ({ mountBattle: battleMounts, ...calls, exportCalls: exportCalls() }),
  };
}

/** 让 macrotask/microtask 全部结算（真实定时器路径：debounce 落库、导出收口都在这条链上）。 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * 轮询直到条件成立（事件处理器里的链是"点击 → 动态 import → 存储 IO → 重载"，
 * 光靠固定轮数的 settle 会在 CI 上偶尔跑在断言后面；这个助手的失败信息带条件文本）。
 */
async function waitFor(what: string, cond: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${what}`);
}

/** 点完序章（八屏逐屏点击）。 */
function clickThroughPrologue(root: HTMLElement): void {
  for (let i = 0; i < prologueJson.scenes.length; i++) {
    const screen = root.querySelector('[data-ui="prologue-screen"]') as HTMLElement | null;
    expect(screen, `第 ${i + 1} 屏不存在`).not.toBeNull();
    screen?.click();
  }
}

/** 一路答对直到终局（返回本局结果摘要）。 */
async function playUntilEnd(ctrl: GameController, grade = GRADES.good): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (ctrl.snapshot().screen !== 'fight') return;
    await ctrl.intent({ type: 'answer', grade });
  }
  throw new Error('冒烟：一局没能在 60 次作答内结束');
}

beforeEach(() => {
  NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
  idSeq = 0;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('E2E#1 冷启动 → 预置内容 → 序章 → 菜单', () => {
  it('新装玩家拿到 4 领域 30 张手写卡；序章逐屏演完才进菜单', async () => {
    const h = await boot();
    // 预置内容真的进了存档（且过落盘自检）
    const save = h.coord.snapshot();
    expect(save.decks.map((d) => d.id)).toEqual(['preset-life', 'preset-tang', 'preset-root', 'preset-idiom']);
    expect(save.cards).toHaveLength(30);
    await h.coord.flush();
    expect(validateSave(h.coord.snapshot()).ok).toBe(true);

    // 序章先演（needsPrologue=true），演完派 seenPrologue → 菜单
    expect(h.root.querySelector('[data-ui="prologue-screen"]')).not.toBeNull();
    clickThroughPrologue(h.root);
    await settle(); // 序章收尾派的是异步意图（落库 + 回菜单），等它结算
    expect(h.ctrl.snapshot().save.settings.story.prologueSeen).toBe(true);
    expect(h.root.querySelector('[data-ui="menu-screen"]')).not.toBeNull();
    // 菜单上四入口齐备，本地榜为空
    expect(h.root.querySelectorAll('[data-nav]')).toHaveLength(4);
    expect(h.root.querySelectorAll('[data-ui="rank-row"]')).toHaveLength(0);
    h.host.unmount();
  });
});

describe('E2E#2 首战（引导域）→ 结算屏', () => {
  it('全 new 卡的首战必败（伤害 0.1×）：假记忆演出逐拍推进 + 打叉揭示，榜单记一条败绩', async () => {
    const h = await boot();
    clickThroughPrologue(h.root);
    await settle();

    // 这里**不再**为了逼出演出而临时改卡（终审 I-1 抓的正是这一点）：预置内容本身必须
    // 含可篡改的答案（ASCII 数字或词表词），否则玩家最可能的第一场败局看不到 LORE §5.5
    // 的叙事钩子。演出是否出现由真实内容决定 —— 下面的断言就是这条内容的回归钉。

    (h.root.querySelector('[data-nav="prepare"]') as HTMLElement).click();
    expect(h.root.querySelector('[data-ui="prepare-screen"]')).not.toBeNull();
    expect(h.root.querySelector('[data-boss]')).toBeNull(); // 没攒复习 ⇒ 没有卷灵

    (h.root.querySelector('[data-deck-id="preset-life"]') as HTMLElement).click();
    (h.root.querySelector('[data-ui="start"]') as HTMLElement).click();
    await settle(2);
    expect(h.ctrl.snapshot().screen).toBe('fight');
    expect(h.root.querySelector('[data-ui="battle-stub"]')).not.toBeNull();

    await playUntilEnd(h.ctrl);
    expect(h.ctrl.snapshot().screen).toBe('result');
    // 数值事实：new 卡 damageMultiplier=0.1 ⇒ 每击 1 点，10 张全答对也打不掉 70 点敌血
    expect(h.ctrl.snapshot().lastResult?.won).toBe(false);
    expect(h.ctrl.snapshot().lastResult?.expGained).toBe(0);

    // 战败演出（LORE §5.5）：闪现 → 打叉揭示；纯演出，零数值后果
    expect((h.root.querySelector('[data-ui="outcome"]') as HTMLElement).textContent).toBe('败');
    expect((h.root.querySelector('[data-ui="fake-memory"]') as HTMLElement).hidden).toBe(false);
    expect((h.root.querySelector('[data-ui="fake-back"]') as HTMLElement).textContent).not.toBe('');
    (h.root.querySelector('[data-ui="fake-skip"]') as HTMLElement).click();
    expect((h.root.querySelector('[data-ui="fake-cross"]') as HTMLElement).hidden).toBe(false);
    expect((h.root.querySelector('[data-ui="fake-reveal-text"]') as HTMLElement).textContent).toBe('假的。幸好你没记住它。');

    // 回菜单：败局也上榜（1 条），碎片不抽（LORE §5.2 只对胜局）
    (h.root.querySelector('[data-ui="to-menu"]') as HTMLElement).click();
    await settle(2);
    expect(h.root.querySelector('[data-ui="menu-screen"]')).not.toBeNull();
    expect(h.root.querySelectorAll('[data-ui="rank-row"]')).toHaveLength(1);
    expect(h.coord.snapshot().settings.story.beatIndex).toBe(0);
    h.host.unmount();
  });

  it('复习把卡推到 review 稳定度后，同样的池子就能赢（"苦修换伤害"的循环端到端）', async () => {
    const h = await boot();
    clickThroughPrologue(h.root);
    await settle();

    // 等价于"复习了几天"：稳定度晋升到 review ⇒ 伤害 1.0×（每击 12 点）
    await h.coord.mutate((save) => {
      for (const c of save.cards) {
        if (c.deckId !== 'preset-life') continue;
        c.srs.stability = 'review';
        c.srs.interval = 10;
        c.srs.reps = 3;
      }
    });
    await h.coord.flush();

    (h.root.querySelector('[data-nav="prepare"]') as HTMLElement).click();
    (h.root.querySelector('[data-deck-id="preset-life"]') as HTMLElement).click();
    (h.root.querySelector('[data-ui="start"]') as HTMLElement).click();
    await settle(2);
    await playUntilEnd(h.ctrl);

    expect(h.ctrl.snapshot().lastResult?.won).toBe(true);
    expect(h.ctrl.snapshot().lastResult?.expGained).toBe(21); // 遭遇战档：round(30×0.7)
    expect((h.root.querySelector('[data-ui="outcome"]') as HTMLElement).textContent).toBe('胜');
    // 胜局抽一条战报碎片并回写游标
    expect((h.root.querySelector('[data-ui="beat"]') as HTMLElement).hidden).toBe(false);
    await waitFor('碎片游标回写（saveBeatCursor）', () => h.coord.snapshot().settings.story.beatIndex === 1);
    h.host.unmount();
  });
});

describe('E2E#3 导入他机备份 → 卡组页', () => {
  it('导入 30 张卡的档：校验通过、列表刷新、分页与计数跟着变', async () => {
    const h = await boot();
    clickThroughPrologue(h.root);
    await settle();

    // 他机档：4 个预置领域共 30 张卡（生活常识已攒 15 次有效复习），等级很高（atk 够打卷灵）
    const decks: Deck[] = presetJson.decks.map((d) => ({ id: d.id, name: d.name, isPreset: true }));
    const cards: Card[] = [];
    for (const d of presetJson.decks) {
      for (const c of d.cards) cards.push(card(c.id, d.id, d.id === 'preset-life' ? 15 : 3, 'review'));
    }
    const incoming: SaveFile = {
      schemaVersion: 1,
      decks,
      cards,
      settings: {
        bossThresholdTier: 30,
        sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
        battle: { defaultPoolSize: 15 },
        progress: { exp: 200_000 }, // 高等级 ⇒ atk 足够在池尽前杀掉卷灵
        story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 },
        leaderboard: [],
      },
      meta: { savedAt: NOW - 1000, plays: 5 },
    };
    expect(cards).toHaveLength(30);
    // 导入链路吃的是**备份信封**（format/version/exportedAt/save），不是裸存档：
    // 用真 exportBackup 造文本，顺带把"导出→导入"这一对函数钉在一起
    h.setPicked(exportBackup(incoming, NOW));

    (h.root.querySelector('[data-nav="decks"]') as HTMLElement).click();
    (h.root.querySelector('[data-ui="import"]') as HTMLElement).click();
    await waitFor('导入落库并重载（meta.plays=5）', () => h.coord.snapshot().meta.plays === 5);

    const save = h.coord.snapshot();
    expect(save.cards).toHaveLength(30);
    expect(save.decks).toHaveLength(4);
    expect(save.meta.plays).toBe(5);
    expect(validateSave(save).ok).toBe(true);
    // 卡组页按 content 指纹刷新（导入后屏上是新卡，不是旧卡）
    expect((h.root.querySelector('[data-ui="card-count"]') as HTMLElement).textContent).toBe('共 30 张 · 已显示 30 张');
    expect(h.root.querySelectorAll('[data-card-id]')).toHaveLength(30);
    h.host.unmount();
  });
});

describe('E2E#4 卷灵战 → 净化 → 藏书阁', () => {
  it('达标领域出现卷灵 chip；取胜后净化落账，藏书阁出现条目+彩蛋+练习关，行记第一幕仍锁（只净化 1 个领域）', async () => {
    const h = await boot();
    clickThroughPrologue(h.root);
    await settle();

    // 直接把"已攒够复习次数的高等级档"灌进存储（等价于玩了几天）
    await h.coord.mutate((save) => {
      save.settings.bossThresholdTier = 15;
      save.settings.progress.exp = 200_000;
      for (const c of save.cards) {
        c.srs.stability = 'review';
        c.srs.interval = 10;
        c.srs.reps = 3;
        if (c.deckId === 'preset-life') c.srs.effectiveReviewDays = Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
      }
    });
    await h.coord.flush();

    (h.root.querySelector('[data-nav="prepare"]') as HTMLElement).click();
    const bossChip = h.root.querySelector('[data-boss="preset-life"]') as HTMLElement | null;
    expect(bossChip, '引导域攒够 15 次后应出现卷灵 chip').not.toBeNull();
    bossChip?.click();
    await settle(2);

    expect(h.ctrl.snapshot().screen).toBe('fight');
    expect(h.ctrl.snapshot().fight?.difficulty).toBe('boss');
    await playUntilEnd(h.ctrl);
    expect(h.ctrl.snapshot().lastResult?.won).toBe(true);
    expect(h.coord.snapshot().decks.find((d) => d.id === 'preset-life')?.purifiedAt).toBe(NOW);
    // 只净化了一个领域 ⇒ 三幕一幕未现
    expect(h.coord.snapshot().settings.story.arcSeen).toBe(0);

    (h.root.querySelector('[data-ui="to-menu"]') as HTMLElement).click();
    await settle(2);
    (h.root.querySelector('[data-nav="codex"]') as HTMLElement).click();
    expect(h.root.querySelectorAll('[data-codex-entry]')).toHaveLength(1);
    // LORE §4.2 的预置领域官方称号（T11 评审 I-6：预置内容必须用官方名，不能自造）
    expect((h.root.querySelector('[data-ui="entry-name"]') as HTMLElement).textContent).toBe('烟火篇·卷灵');
    expect((h.root.querySelector('[data-ui="entry-egg"]') as HTMLElement).textContent).toBe(eggsJson.eggs['preset-life']);
    expect(h.root.querySelectorAll('[data-act][data-unlocked="true"]')).toHaveLength(0);

    // 练习关（重战）：真点一次，断言走的是 boss 档 + 单领域（口径来自 bossFightParams）
    h.root.querySelector('[data-practice="preset-life"]')?.dispatchEvent(new Event('click'));
    await waitFor('练习关开出卷灵战', () => h.ctrl.snapshot().screen === 'fight');
    expect(h.ctrl.snapshot().fight?.difficulty).toBe('boss');
    expect(h.ctrl.snapshot().fight?.pool.every((c) => c.deckId === 'preset-life')).toBe(true);
    h.host.unmount();
  });
});

describe('E2E#5 备份导出与提醒闸门', () => {
  it('导出把文本交给下载口；闸门 true → false（真实 exportAndMark 链路）', async () => {
    const h = await boot();
    clickThroughPrologue(h.root);
    await settle();

    expect(h.ctrl.snapshot().reminderDue).toBe(true); // 从未导出
    (h.root.querySelector('[data-nav="decks"]') as HTMLElement).click();
    (h.root.querySelector('[data-ui="export"]') as HTMLElement).click();
    await waitFor('导出把文本交给下载口', () => h.downloads.length === 1);
    await settle(2); // 落库收口（markExported）稍晚于文本生成

    expect(h.downloads).toHaveLength(1);
    const [text, filename] = h.downloads[0];
    expect(filename).toMatch(/^zx-xia-backup-\d{4}-\d{2}-\d{2}\.json$/);
    // 下载到的是**备份信封**（format/version/exportedAt/save），存档本体在 .save 里
    expect(JSON.parse(text).format).toBeTruthy();
    expect(JSON.parse(text).save.schemaVersion).toBe(1);
    expect(JSON.parse(text).save.cards).toHaveLength(30);
    expect(h.ctrl.snapshot().reminderDue).toBe(false); // markExported 落位
    h.host.unmount();
  });
});

describe('E2E#6 只读演练（D29）', () => {
  it('坏档接管：横幅在场、原文可导出、序章与只读组合不炸', async () => {
    const bad = { schemaVersion: 2, decks: [], cards: [], settings: {}, meta: { savedAt: 1, plays: 0 } } as unknown as SaveFile;
    const h = await boot({ seed: bad });
    expect(h.coord.readOnly()).toBe(true);

    // 只读 + 序章组合（R-T6-p4-c）：序章照演，写不进也不炸
    expect(h.root.querySelector('[data-ui="prologue-screen"]')).not.toBeNull();
    clickThroughPrologue(h.root);
    await settle();
    expect(h.root.querySelector('[data-ui="menu-screen"]')).not.toBeNull();
    expect((h.root.querySelector('[data-ui="readonly-bar"]') as HTMLElement).hidden).toBe(false);
    expect((h.root.querySelector('[data-ui="readonly-text"]') as HTMLElement).textContent).toBe('存档无法读取，本次进度不会保存');

    // 坏档原文导出（第二个 D29 出口）
    (h.root.querySelector('[data-ui="readonly-dump"]') as HTMLElement).click();
    await waitFor('坏档原文导出', () => h.downloads.length === 1);
    expect(h.downloads).toHaveLength(1);
    expect(JSON.parse(h.downloads[0][0]).schemaVersion).toBe(2);
    expect(h.downloads[0][1]).toMatch(/^zx-xia-corrupt-\d{4}-\d{2}-\d{2}\.json$/);
    h.host.unmount();
  });
});
