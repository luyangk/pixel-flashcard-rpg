/**
 * main.ts —— Plan 4 · T11：启动编排（唯一把"真世界"接进游戏的地方）。
 *
 * 本文件**只做编排**，一条规则都没有：开存储 → 首次启动灌预置内容 → 建控制器 →
 * 载素材 → 装配宿主依赖（`ui/hostAdapters.assembleHost`，那里是唯一可测的装配点）→ 挂宿主。
 *
 * 三条刻意的取舍：
 * - **启动失败要有人话**：任何一步抛错都落到 `#app` 里的一句大白话 + 原始信息
 *   （手机上看不到控制台；白屏是最差的结果）；
 * - **预置内容灌装失败要上屏**（T11 评审判 m-5）：原来的实现把 `installed.reason`
 *   丢进虚空，玩家只看到空卡库、不知道发生了什么——现在挂载后用 toast 说一句；
 * - **精灵加载永不 reject**（`platform/assets` 保证），所以战斗不会因为缺图起不来。
 */
import './ui/styles.css';

/**
 * PWA：注册 Service Worker（Plan 5）。
 *
 * **只在生产构建里注册**：dev 下 SW 会把旧资源喂回浏览器，改一行代码看不到效果——
 * 本机调试的麻烦事够多了，这里绝不添一件。判据用 `import.meta.env.PROD`（Vite 注入）。
 * 注册失败（http 明文环境、隐私模式、iOS 老版本）静默忽略：SW 是增强，不是依赖，
 * 游戏在没有它的情况下必须照常能玩。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

import arcJson from '../assets/narrative/arc.json';
import beatsJson from '../assets/narrative/beats.json';
import eggsJson from '../assets/narrative/eggs.json';
import fakeWordsJson from '../assets/narrative/fake-words.json';
import prologueJson from '../assets/narrative/prologue.json';
import presetJson from '../assets/content/preset.json';

import { createGameController } from './app/gameController';
import { createCoordinator } from './app/persist';
import { installPresetContent, isFreshLibrary } from './app/presetContent';
import { loadSprites } from './platform/assets';
import { now as clockNow } from './platform/clock';
import { tzOffsetMin } from './platform/env';
import { makeRng } from './platform/rngProvider';
import { openStorage } from './platform/storage';
import { mountHost, type HostHandle } from './ui/host';
import { assembleHost } from './ui/hostAdapters';
import { showToast } from './ui/toast';
import type { ArcAct } from './ui/codex';
import type { BeatEntry } from './ui/beats';
import type { PrologueScene } from './ui/prologue';

/** 启动失败的人话（避免白屏）。 */
function showFatal(root: HTMLElement, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  root.textContent = `游戏没能启动：${detail}。刷新页面再试一次；如果一直这样，把这句话截图反馈。`;
  root.setAttribute('data-ui', 'fatal');
}

async function boot(): Promise<void> {
  const root = document.getElementById('app') ?? document.body;

  const store = await openStorage('pixel-flashcard');
  const coord = await createCoordinator(store, { now: clockNow });

  // 首次启动：空库才灌预置内容。失败**不阻断启动**（玩家仍可手写卡开局），但要说一句
  // （评审判 m-5）：只有"本来就该有新手套装"的场合才提示——老玩家看到"没灌预置内容"
  // 的 toast 只会莫名其妙。
  const wasFresh = isFreshLibrary(coord.snapshot());
  const installed = await installPresetContent(coord, presetJson, clockNow());
  if (installed.installed) await coord.flush();
  const notice = wasFresh && !installed.installed ? installed.reason : null;

  const rawCtrl = await createGameController({
    coord,
    rng: makeRng(clockNow()),
    now: clockNow,
    tzOffsetMin: tzOffsetMin(),
  });
  const sprites = await loadSprites();

  let host: HostHandle | null = null;
  const { ctrl, adapters } = assembleHost({
    ctrl: rawCtrl,
    coord,
    store,
    now: clockNow,
    tzOffsetMin: tzOffsetMin(),
    // 假记忆演出的随机流与战斗分开（演出不该偷走战斗的随机序列）
    rng: makeRng(clockNow() ^ 0x5f3759df),
    sprites,
    prologueScenes: prologueJson.scenes as unknown as readonly PrologueScene[],
    beats: beatsJson.beats as unknown as readonly BeatEntry[],
    acts: arcJson.acts as unknown as readonly ArcAct[],
    eggs: eggsJson.eggs as Readonly<Record<string, string>>,
    wordTable: new Map(Object.entries(fakeWordsJson.pairs as Record<string, string>)),
    hostRef: () => host, // 「重看序章」用它把序章当场挂回来
    onNotice: (text) => showToast(root, text, { ms: 8000 }),
  });

  host = mountHost(root, ctrl, adapters);
  if (notice !== null) showToast(root, notice, { ms: 8000 });
}

boot().catch((e: unknown) => {
  showFatal(document.getElementById('app') ?? document.body, e);
});
