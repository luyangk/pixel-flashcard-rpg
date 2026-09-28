/**
 * main.ts —— Plan 4 · T11：装配层（唯一把"真世界"接进游戏的地方）。
 *
 * 职责边界：本文件**只有装配**，没有规则。它按顺序做四件事，然后交给 `ui/host.mountHost`：
 *   1. 开存储（IndexedDB 失败自动降级内存，`openStorage` 已有契约）→ 建 coordinator；
 *   2. 首次启动灌预置内容（`app/presetContent`，空库才灌）并 flush；
 *   3. 建会话控制器（时钟/时区/rng 全部来自 platform）；
 *   4. 把 assets/ 里的内容与 app 层的写口装进 `HostAdapters`，挂宿主。
 *
 * 三条刻意的取舍：
 * - **启动失败要有人话**：任何一步抛错都落到 `#app` 里的一句大白话 + 原始信息
 *   （手机上看不到控制台；白屏是最差的结果）；
 * - **预置内容灌装失败不阻断启动**（`installed:false` 只记一句 notice 素材）：
 *   内容文件坏了就不给新手套装，玩家仍可以手写卡开局；
 * - **精灵加载永不 reject**（`platform/assets` 已保证），所以战斗不会因为缺图而起不来。
 */
import './ui/styles.css';

import arcJson from '../assets/narrative/arc.json';
import beatsJson from '../assets/narrative/beats.json';
import eggsJson from '../assets/narrative/eggs.json';
import fakeWordsJson from '../assets/narrative/fake-words.json';
import prologueJson from '../assets/narrative/prologue.json';
import presetJson from '../assets/content/preset.json';

import { addCard, addDeck } from './app/library';
import { bossFightParams, setBossName } from './app/bossFlow';
import { createGameController } from './app/gameController';
import { createCoordinator } from './app/persist';
import { installPresetContent } from './app/presetContent';
import { setBossThresholdTier, setDefaultPoolSize, setSm2Params, replayPrologue } from './app/settingsFlow';
import { saveBeatCursor } from './app/storyState';
import { exportAndMark, importBackupAndSave } from './app/transfer';
import type { GameController, GameIntent } from './app/controllerTypes';
import { loadSprites } from './platform/assets';
import { now as clockNow } from './platform/clock';
import { tzOffsetMin } from './platform/env';
import { downloadText, pickTextFile } from './platform/files';
import { makeRng } from './platform/rngProvider';
import { openStorage } from './platform/storage';
import { mountHost } from './ui/host';
import type { ArcAct } from './ui/codex';
import type { BeatEntry } from './ui/beats';
import type { PrologueScene } from './ui/prologue';

/** 启动失败的人话（避免白屏）。 */
function showFatal(root: HTMLElement, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  root.textContent = `游戏没能启动：${detail}。刷新页面再试一次；如果一直这样，把这句话截图反馈。`;
  root.setAttribute('data-ui', 'fatal');
}

/** 装配期占位：包一层控制器只为记住"上一局的开局参数"，故先声明后赋值（见 boot 内顺序）。 */
let bootCtrl: GameController;
/** 无 crypto.randomUUID 的极老环境用的进程内自增（不读钟、不用 Math.random）。 */
let idSeed = 0;

/**
 * 记录"上一局的开局参数"：「再来一场」按它重开，不必让玩家再走一遍备战屏。
 * 包一层而不改控制器：控制器不知道"上一局参数"这件事，属宿主记忆。
 */
function withLastStart(): { ctrl: GameController; lastStart: () => GameIntent } {
  let last: { size: number; deckIds?: string[]; difficulty?: 'encounter' | 'boss' } = { size: 15 };
  return {
    ctrl: {
      snapshot: () => bootCtrl.snapshot(),
      subscribe: (cb) => bootCtrl.subscribe(cb),
      intent: (i: GameIntent) => {
        if (i.type === 'startFight') {
          last = { size: i.size, deckIds: i.deckIds ? [...i.deckIds] : undefined, difficulty: i.difficulty };
        }
        return bootCtrl.intent(i);
      },
    },
    lastStart: () => ({ type: 'startFight', ...last }),
  };
}

async function boot(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;

  const store = await openStorage('pixel-flashcard');
  const coord = await createCoordinator(store, { now: clockNow });

  // 首次启动：空库才灌预置内容（内容坏了只提示、不阻断）
  const installed = await installPresetContent(coord, presetJson, clockNow());
  if (installed.installed) await coord.flush();

  bootCtrl = await createGameController({
    coord,
    rng: makeRng(clockNow()),
    now: clockNow,
    tzOffsetMin: tzOffsetMin(),
  });

  const { ctrl, lastStart } = withLastStart();
  const sprites = await loadSprites();
  const wordTable = new Map(Object.entries(fakeWordsJson.pairs as Record<string, string>));

  mountHost(root, ctrl, {
    prologueScenes: prologueJson.scenes as unknown as readonly PrologueScene[],
    beats: beatsJson.beats as unknown as readonly BeatEntry[],
    eggs: eggsJson.eggs as Readonly<Record<string, string>>,
    acts: arcJson.acts as unknown as readonly ArcAct[],
    sprites,
    wordTable,
    rng: makeRng(clockNow() ^ 0x5f3759df),
    now: clockNow,
    tzOffsetMin: tzOffsetMin(),
    newId: () => {
      const c = globalThis.crypto;
      if (c && typeof c.randomUUID === 'function') return c.randomUUID();
      idSeed += 1;
      return `zx-${idSeed}`;
    },
    // 写口：全部经 app 层（视图不持存储）
    addCard: (input) => addCard(coord, { ...input, nowMs: clockNow() }),
    addDeck: (input) => addDeck(coord, input),
    setBossName: (deckId, raw) => setBossName(coord, deckId, raw),
    setTier: (tier) => setBossThresholdTier(coord, tier),
    setParams: (params) => setSm2Params(coord, params),
    setPoolSize: (size) => setDefaultPoolSize(coord, size),
    replayPrologue: () => replayPrologue(coord),
    onBeatDrawn: (cursor) => void saveBeatCursor(coord, cursor).catch(() => undefined),
    onReplay: () => void ctrl.intent(lastStart()).catch(() => undefined),
    onPractice: (deckId) => {
      const p = bossFightParams(coord.snapshot(), deckId);
      void ctrl.intent({ type: 'startFight', size: p.size, deckIds: p.deckIds, difficulty: 'boss' }).catch(() => undefined);
    },
    // 导入 / 导出 / 抢救
    exportBackup: () => exportAndMark(coord, clockNow()),
    importBackup: (text) => importBackupAndSave(text, store),
    pickBackupText: async () => {
      const picked = await pickTextFile();
      return picked.ok ? picked.text : null; // 取消与读失败都回 null，导入屏不弹提示
    },
    saveTextFile: (text, filename) => {
      downloadText(text, filename);
    },
    rawDump: () => coord.rawDump(),
  });
}

boot().catch((e: unknown) => {
  showFatal(document.getElementById('app') ?? document.body, e);
});
