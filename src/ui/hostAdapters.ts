/**
 * hostAdapters.ts —— Plan 4 · T11 修复波：把 `src/main.ts` 的**装配逻辑**抽成可测函数。
 *
 * ## 为什么必须抽出来（T11 评审判 I-5）
 * 抽之前，`main.ts` 里这段装配是**零覆盖**的：删掉"导入前 flush"和"导入后 reload"
 * （两条都是 T10 冒烟逼出来的接缝修复）之后，73 条相关用例**全绿**——因为测试里各自
 * 复刻了一份自己的装配。装配层的错误恰恰是"每条单测都绿、游戏却不能用"的高发区，
 * 而 `main.ts` 带副作用（import CSS、自动 boot）不能直接被测试 import。
 *
 * ## 分工
 * - 本文件：**纯装配**——把 coordinator / store / 时钟 / 内容与 app 层写口装成 `HostAdapters`，
 *   外加两条与"会话记忆"有关的包装（`onReplay` 记住上一局参数、`onPractice` 走
 *   `bossFightParams` 单一来源）。
 * - `main.ts`：只剩"开存储 → 灌预置内容 → 建控制器 → 载素材 → 挂宿主"的编排与启动兜底。
 */
import type { Rng } from '@core/rng';
import type { GameStorage } from '@platform/storage';
// 【平台 LLM 模块的唯一 import 点】load/save/clear/presets/maskKey 与唯一的网络出口 chat
// 都在这里接线；UI 层只拿到已装配好的窄函数（fetch 与 localStorage 绝不出 platform）。
import { clearLlmConfig, LLM_PRESETS, loadLlmConfig, saveLlmConfig } from '../platform/llmConfig';
import { chat } from '../platform/llmHttp';
import { addCard, addDeck } from '../app/library';
import { bossFightParams, setBossName } from '../app/bossFlow';
import { setEggOnDeck } from '../app/codexFlow';
import { suggestBossNames, suggestCards, suggestEgg, type ChatFn } from '../app/llmFlow';
import type { GameController, GameIntent } from '../app/controllerTypes';
import type { Coordinator } from '../app/persist';
import {
  replayPrologue as writeReplayPrologue,
  setBossThresholdTier,
  setDefaultPoolSize,
  setSm2Params,
} from '../app/settingsFlow';
import { saveBeatCursor } from '../app/storyState';
import { exportAndMark, importBackupAndSave } from '../app/transfer';
import type { StageSprites } from '../stage/renderer';
import type { HostAdapters } from './hostTypes';

export interface AssembleDeps {
  /** 已建好的控制器（本函数会包一层，用于记住"上一局的开局参数"）。 */
  readonly ctrl: GameController;
  readonly coord: Coordinator;
  readonly store: GameStorage;
  readonly now: () => number;
  readonly tzOffsetMin: number;
  /** 假记忆演出的随机源（与战斗用不同的流，避免演出偷走战斗的随机序列）。 */
  readonly rng: Rng;
  readonly sprites: StageSprites;
  readonly prologueScenes: HostAdapters['prologueScenes'];
  readonly beats: HostAdapters['beats'];
  readonly acts: HostAdapters['acts'];
  readonly eggs: HostAdapters['eggs'];
  readonly wordTable: ReadonlyMap<string, string>;
  /** 需要让玩家知道的一句话（导入后重载失败等）；缺省丢弃。 */
  readonly onNotice?: (text: string) => void;
  /** 宿主句柄（用于「重看序章」把序章重新挂回来）；缺省则只写存档。 */
  readonly hostRef?: () => { replayPrologue(): void } | null;
  readonly toastMs?: number;
  /**
   * 文件口覆盖位（缺省走 `platform/files` 的真实现：隐藏 input + Blob 下载）。
   * 存在的理由：e2e 冒烟要在 happy-dom 里驱动**真装配**，而文件选择器/下载对话框
   * 无法在无头环境里走通；覆盖这两处不影响其余装配链（导入、reload、flush 全是真的）。
   */
  readonly pickBackupText?: HostAdapters['pickBackupText'];
  readonly saveTextFile?: HostAdapters['saveTextFile'];
  /**
   * AI 面覆盖位（Plan 5 · T4/T5；缺省走真实现：platform/llmConfig + llmHttp + app/llmFlow）。
   * 存在的理由与文件口覆盖位同款：装配链（设置屏的读写、三项 AI 职能的现读配置）要在测试里
   * 用假实现穷举，而**真装配**仍必须可被驱动。
   */
  readonly llmOverride?: HostAdapters['llm'];
  readonly llmCardsOverride?: HostAdapters['llmCards'];
  readonly llmNamesOverride?: HostAdapters['llmNames'];
  readonly llmEggOverride?: HostAdapters['llmEgg'];
  readonly setEggOverride?: HostAdapters['setEgg'];
}

export interface HostAssembly {
  /** 包过的控制器：`startFight` 参数被记下来供「再来一场」复用。 */
  readonly ctrl: GameController;
  readonly adapters: HostAdapters;
}

/** 无 crypto.randomUUID 的极老环境用的进程内自增（不读钟、不用 Math.random）。 */
let idSeed = 0;

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  idSeed += 1;
  return `zx-${idSeed}`;
}

/**
 * 装配宿主依赖。**这里集中了三条接缝纪律**，改动本函数前请先读它们：
 * 1. **导入前先 flush**（R-T11-p4-c）：导入直写 store，若 coordinator 还有 debounce 中的
 *    旧档，一次陈旧的窗写会把导入结果覆盖掉。
 * 2. **导入成功后 reload**（R-T11-p4-b）：coordinator 的内存档是构造期载入的，不重载
 *    就继续显示旧档（实测：导入 plays=5 的备份后快照仍是 0）。reload 失败要**如实上屏**
 *    （评审判 m-6）——"备份已导入" + 只读横幅同时出现会让人以为游戏坏了。
 * 3. **练习关走 `bossFightParams`**：单领域 + `size = min(卡数, 25)` 的口径只有一处。
 */
export function assembleHost(deps: AssembleDeps): HostAssembly {
  const { ctrl, coord, store, now, tzOffsetMin } = deps;

  /* ------------------------------------------------------------ 上一局参数（「再来一场」） */
  let last: { size: number; deckIds?: string[]; difficulty?: 'encounter' | 'boss' } = { size: 15 };
  const wrapped: GameController = {
    snapshot: () => ctrl.snapshot(),
    subscribe: (cb) => ctrl.subscribe(cb),
    intent: (i: GameIntent) => {
      if (i.type === 'startFight') {
        last = { size: i.size, deckIds: i.deckIds ? [...i.deckIds] : undefined, difficulty: i.difficulty };
      }
      return ctrl.intent(i);
    },
  };

  /**
   * 造一个"**每次调用现读一次配置**"的 chat 绑定。
   *
   * 为什么不是绑定时就 load 一次：玩家在设置页改完 Key/模型后回到卡组页，下一句生成
   * 必须用新配置。缓存一份配置会让改动要等刷新页面才生效——而这条接缝在单测里看不出来
   * （测试注入的是假 chat），所以把理由写在这里而不是靠人记。
   */
  function boundChat(): ChatFn {
    return (messages) => chat({ config: loadLlmConfig(), messages });
  }

  const adapters: HostAdapters = {
    prologueScenes: deps.prologueScenes,
    beats: deps.beats,
    acts: deps.acts,
    eggs: deps.eggs,
    sprites: deps.sprites,
    wordTable: deps.wordTable,
    rng: deps.rng,
    now,
    tzOffsetMin,
    newId,
    toastMs: deps.toastMs,

    /* ---- 卡库 / 设置写口（全部经 app 层，视图零存储） ---- */
    // 手写新卡用**玩家自己调的 SM-2 参数**建初始 SRS（终审 Minor）：不传就会落到
    // core 的 FALLBACK_PARAMS，于是"设置页改了 initialEase"对新手写卡毫无效果。
    addCard: (input) =>
      addCard(coord, { ...input, nowMs: now(), sm2Params: coord.snapshot().settings.sm2Params }),
    addDeck: (input) => addDeck(coord, input),
    setBossName: (deckId, raw) => setBossName(coord, deckId, raw),
    setTier: (tier) => setBossThresholdTier(coord, tier),
    setParams: (params) => setSm2Params(coord, params),
    setPoolSize: (size) => setDefaultPoolSize(coord, size),
    replayPrologue: async () => {
      const res = await writeReplayPrologue(coord);
      // 写口成功后**当场**把序章挂回来（T11 评审判 I-2）：否则设置页那句
      // "下次回到菜单时会重新演出一次"是假的（prologueActive 只在挂载时求值一次）。
      if (res.ok) deps.hostRef?.()?.replayPrologue();
      return res;
    },
    onBeatDrawn: (cursor) => void saveBeatCursor(coord, cursor).catch(() => undefined),
    onReplay: () => void wrapped.intent({ type: 'startFight', ...last }).catch(() => undefined),
    onPractice: (deckId) => {
      const p = bossFightParams(coord.snapshot(), deckId);
      void wrapped
        .intent({ type: 'startFight', size: p.size, deckIds: p.deckIds, difficulty: 'boss' })
        .catch(() => undefined);
    },

    /* ---- 导入 / 导出 / 抢救 ---- */
    exportBackup: () => exportAndMark(coord, now()),
    importBackup: async (text) => {
      await coord.flush(); // ① 先落净在途改动，免得导入被一次陈旧的窗写覆盖
      const res = await importBackupAndSave(text, store);
      if (!res.ok) return res;
      const reloaded = await coord.reload(); // ② 让内存档跟上存储
      if (!reloaded.ok) {
        // ③ 导入写进去了、但载入读不出来：如实说清，别让玩家以为只是"导入成功"
        const reason = `备份已经写进存储，但重新载入时读不出来（${reloaded.reason ?? '原因未知'}）——请刷新页面再看看。`;
        deps.onNotice?.(reason);
        return { ok: false, reason };
      }
      return res;
    },
    pickBackupText:
      deps.pickBackupText ??
      (async () => {
        const { pickTextFile } = await import('../platform/files');
        const picked = await pickTextFile();
        return picked.ok ? picked.text : null; // 取消与读失败都回 null（导入屏据此不提示）
      }),
    saveTextFile:
      deps.saveTextFile ??
      ((text, filename) => {
        void import('../platform/files').then((m) => m.downloadText(text, filename));
      }),
    rawDump: () => coord.rawDump(),

    /* ---- AI（Plan 5 · T4/T5） ---- */
    llm:
      deps.llmOverride ??
      ({
        load: () => loadLlmConfig(),
        save: (cfg) => saveLlmConfig(cfg),
        clear: () => clearLlmConfig(),
        // 「测试连接」= 一次最小请求：玩家点它就是想确认"地址 + Key + 模型"三者能打通，
        // 因此只发一条最短的 user 消息（不做别的职能的提示词——那会把测试变成一次内容生成）。
        test: (cfg) => chat({ config: cfg, messages: [{ role: 'user', content: 'ping' }] }),
        presets: LLM_PRESETS,
      } satisfies NonNullable<HostAdapters['llm']>),
    // 三项职能共用一个"每次调用现读配置"的 chat：玩家刚在设置页改完 Key，下一句就得用新的。
    // 绑定一次配置会让改动要等重启页面才生效（这是最容易漏的一条接缝）。
    llmCards: deps.llmCardsOverride ?? ((input) => suggestCards({ chat: boundChat() }, input)),
    llmNames: deps.llmNamesOverride ?? ((deckName) => suggestBossNames({ chat: boundChat() }, { deckName })),
    llmEgg: deps.llmEggOverride ?? ((deckName) => suggestEgg({ chat: boundChat() }, { deckName })),
    setEgg: deps.setEggOverride ?? ((deckId, text) => setEggOnDeck(coord, deckId, text)),
  };

  return { ctrl: wrapped, adapters };
}
