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
import { chat, listModels } from '../platform/llmHttp';
import { addCard, addDeck, removeCard, removeDeck, renameDeck } from '../app/library';
import { digestHtml } from '../platform/htmlDigest';
import { clearInbox, loadInbox, saveInbox } from '../platform/inboxStore';
import { fetchSourceItems } from '../platform/feedFetch';
import { loadSources, saveSources } from '../platform/sourceStore';
import { ensureProfile, loadProfile, saveProfile } from '../platform/profileStore';
import { checkForUpdate, pageBuild, reloadPage } from '../platform/pwaUpdate';
import { fetchPage, type PageFetchResult } from '../platform/pageFetch';
import { bossFightParams, setBossName } from '../app/bossFlow';
import { setEggOnDeck } from '../app/codexFlow';
import {
  judgeAnswer,
  suggestBossNames,
  suggestCards,
  suggestChoices,
  suggestEgg,
  suggestFightTitle,
  type ChatFn,
} from '../app/llmFlow';
import type { GameController, GameIntent } from '../app/controllerTypes';
import type { Coordinator } from '../app/persist';
import {
  replayPrologue as writeReplayPrologue,
  setAnswerMode,
  setBossThresholdTier,
  setDefaultPoolSize,
  setLlmQuota,
  setSm2Params,
} from '../app/settingsFlow';
import { saveBeatCursor } from '../app/storyState';
import { ingestUrl } from '../app/ingestFlow';
import { collectCards } from '../app/knowledgeFlow';
import { setCardChoices, updateCard } from '../app/library';
import { upgradeRunTitle } from '../app/results';
import { DAILY_CARD_CAP, DAILY_JUDGE_CAP, planCharge, planJudge, remainingCards, remainingJudges } from '../app/quota';
import { resetSave } from '../app/resetFlow';
import { exportAndMark, importBackupAndSave } from '../app/transfer';
import type { StageSprites } from '../stage/renderer';
import type { FetchLike, LlmConfig } from '../platform/llmTypes';
import { backupFileName } from './decks';
import type { FetchSourceResult } from '../platform/feedFetch';
import type { HostAdapters } from './hostTypes';
import type { SharedInput } from './practiceCollect';

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
  /**
   * 预置内容原文（`assets/content/preset.json`，由 main.ts 静态 import 传进来）。
   *
   * **缺省 = 不接「重置存档」**：重置的最后一步是"重装预置内容"，没有素材就没有
   * "新装状态"可言（会留下一个空卡库，比不重置更糟）。于是宁可整组不显示，
   * 也不给一个点了会坏档的按钮。
   */
  readonly presetContent?: unknown;
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
   * LLM 请求的 fetch 注入位（测试用）。存在的理由：**"每次调用现读配置"这条接缝
   * 在单测里看不见**（测试注入假 chat），安全评审 M15 变异因此逃逸。有了它就能
   * 直接断言"改完 Key 后下一次请求带的是新 Key"。
   */
  readonly llmFetchImpl?: FetchLike;
  /**
   * LLM 配置读写的注入位（缺省走 `platform/llmConfig`）。
   * 存在的理由与 llmFetchImpl 相同：让"每次调用现读配置"这条接缝可被取证。
   */
  readonly llmConfigIo?: {
    readonly load: () => LlmConfig;
    readonly save: (cfg: LlmConfig) => boolean;
    readonly clear: () => void;
  };
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
  /** 判卷口覆盖位（Plan 6 · T7）：装配链要能在测试里穷举"额度记账 + 现读配置"。 */
  readonly judgeOverride?: HostAdapters['judge'];
  /** 作答模式写口的覆盖位（一般不需要：真实现就是 settingsFlow 的薄封装）。 */
  readonly setAnswerModeOverride?: HostAdapters['setAnswerMode'];
  /** 网页抓取口的覆盖位（Plan 8 · T9）：装配链要能在测试里穷举"读取服务怎么接"。 */
  readonly fetchPageImpl?: (url: string, opts?: Parameters<typeof fetchPage>[1]) => Promise<PageFetchResult>;
  /** 待读清单的覆盖位（缺省走 platform/inboxStore）。 */
  readonly inboxOverride?: HostAdapters['inbox'];
  /** 订阅源抓取的 fetch 注入位（测试用；生产不传 = 真 fetch）。 */
  readonly feedFetchImpl?: FetchLike;
  /** 来源库口径（测试用；生产接 platform/feedFetch + platform/sourceStore）。 */
  readonly sourcesOverride?: HostAdapters['sources'];
  /** 遭遇战名字升级口径（测试用；生产接 llmFlow.suggestFightTitle + results.upgradeRunTitle）。 */
  readonly onNameRequestOverride?: HostAdapters['onNameRequest'];
  /** 玩家身份口径（测试用；生产接 platform/profileStore）。 */
  readonly profileOverride?: HostAdapters['profile'];
  /** 「重出选项」口径（测试用；生产接 llmFlow.suggestChoices + library.setCardChoices + 额度记账）。 */
  readonly refreshChoicesOverride?: HostAdapters['refreshChoices'];
  /** 「关于」口径（测试用；生产接 platform/pwaUpdate）。 */
  readonly pwaOverride?: HostAdapters['pwa'];
  /**
   * 「采新卡」生成口的覆盖位（Plan 8 · T9）。与 `llmCardsOverride` 同款理由：
   * 装配链里的"额度写回"是**本函数自己的逻辑**，要能在不联网的前提下穷举；
   * 提示词/分块/去重那部分各有自己的用例（`tests/app/knowledgeFlow.test.ts`）。
   */
  readonly collectCardsOverride?: HostAdapters['collectCards'];
  /** 系统分享进来的内容（main.ts 从 query 解析；缺省 null）。 */
  readonly sharedInput?: SharedInput | null;
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
/**
 * 会话内缓存（D62）：同一个源在一次会话里只真读一次。
 *
 * 为什么放在**装配层**而不是 platform：它的生命周期就该是"这一次页面会话" ——
 * 刷新即失效，不必落盘、也不该跨会话（订阅源天天在变）。
 */
const feedCache = new Map<string, { readonly at: number; readonly result: FetchSourceResult }>();
/** 缓存有效期：5 分钟。够挡住"连着点几次"，又不至于让「看最新」看到过期内容。 */
export const FEED_CACHE_TTL_MS = 5 * 60_000;
/** 清掉会话内的源缓存（重置存档 / 导入备份之后该清 —— 测试也用它隔离用例）。 */
export function clearFeedCache(): void {
  feedCache.clear();
}

export function assembleHost(deps: AssembleDeps): HostAssembly {
  const { ctrl, coord, store, now, tzOffsetMin } = deps;

  /* ------------------------------------------------------------ 上一局参数（「再来一场」） */
  let last: {
    size: number;
    deckIds?: string[];
    difficulty?: 'tutorial' | 'encounter' | 'boss';
    /** Plan 7 · T5：「再练一次」要复用**同一批勾选的卡**与同一形态（drill）。 */
    mode?: 'fight' | 'drill';
    cardIds?: string[];
  } = { size: 15 };
  const wrapped: GameController = {
    snapshot: () => ctrl.snapshot(),
    subscribe: (cb) => ctrl.subscribe(cb),
    intent: (i: GameIntent) => {
      if (i.type === 'startFight') {
        last = {
          size: i.size,
          deckIds: i.deckIds ? [...i.deckIds] : undefined,
          difficulty: i.difficulty,
          mode: i.mode,
          cardIds: i.cardIds ? [...i.cardIds] : undefined,
        };
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
    return (messages) => chat({ config: llmIo.load(), messages, fetchImpl: deps.llmFetchImpl });
  }

  /**
   * 把一段文本交到玩家手里（生产 = `platform/files.downloadText` 的 Blob 下载；测试注入）。
   * 抽成局部常量是因为它现在有两个调用点（卡组页导出、设置页「先导出备份」，后者见下），
   * 默认实现写两遍就会有一天分叉。
   */
  const saveText: (text: string, filename: string) => void =
    deps.saveTextFile ??
    ((text, filename) => {
      void import('../platform/files').then((m) => m.downloadText(text, filename));
    });

  /** 配置读写端口（生产 = platform/llmConfig；测试可注入内存实现）。 */
  const llmIo =
    deps.llmConfigIo ??
    ({
      load: () => loadLlmConfig(),
      save: (cfg) => saveLlmConfig(cfg),
      clear: () => clearLlmConfig(),
    } as const);

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
    sharedInput: deps.sharedInput ?? null,
    addDeck: (input) => addDeck(coord, input),
    renameDeck: (input) => renameDeck(coord, input),
    removeDeck: (input) => removeDeck(coord, input),
    removeCard: (input) => removeCard(coord, input),
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
    /**
     * 「练这一域」（Plan 7 · T6）：走**显式卡池**的木桩练功 —— 玩家勾的那几张就是那几张，
     * 不经过 80/20 抽样（`startFight` 的 cardIds 分支）。
     */
    onDrill: ({ cardIds }) =>
      void wrapped
        .intent({ type: 'startFight', size: cardIds.length, cardIds: [...cardIds], mode: 'drill' })
        .catch(() => undefined),
    practiceQuotaText: () =>
      `今日：生成剩 ${remainingCards(coord.snapshot().settings.llmQuota, now(), tzOffsetMin)} / ${DAILY_CARD_CAP} · 判定剩 ${remainingJudges(coord.snapshot().settings.llmQuota, now(), tzOffsetMin)} / ${DAILY_JUDGE_CAP}`,
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
    saveTextFile: saveText,
    rawDump: () => coord.rawDump(),

    /* ---- 存档重置（Plan 5 追加） ---- */
    // 只有在拿到预置内容时才接：见 AssembleDeps.presetContent 的注释。
    resetSave:
      deps.presetContent === undefined
        ? undefined
        : () => resetSave({ coord, store, content: deps.presetContent, nowMs: now() }),
    exportBackupNow: async () => {
      const res = await exportAndMark(coord, now());
      // 只要有文本就先交到用户手里——哪怕 ok:false（与卡组页导出同口径：
      // "没记成导出时间"不该扣下他手里的那份档）
      if (typeof res.text === 'string' && res.text.length > 0) {
        saveText(res.text, backupFileName(now(), tzOffsetMin));
      }
      return res.ok ? { ok: true } : { ok: false, reason: res.reason ?? '导出没能完成。' };
    },

    /* ---- AI（Plan 5 · T4/T5） ---- */
    llm:
      deps.llmOverride ??
      ({
        load: () => llmIo.load(),
        save: (cfg) => llmIo.save(cfg),
        clear: () => llmIo.clear(),
        // 「测试连接」= 一次最小请求：玩家点它就是想确认"地址 + Key + 模型"三者能打通，
        // 因此只发一条最短的 user 消息（不做别的职能的提示词——那会把测试变成一次内容生成）。
        test: (cfg) => chat({ config: cfg, messages: [{ role: 'user', content: 'ping' }] }),
        // 「拉取模型列表」：与 chat 共用同一个 fetch 注入位（测试同一条路径取证）
        listModels: (cfg) => listModels({ config: cfg, fetchImpl: deps.llmFetchImpl }),
        presets: LLM_PRESETS,
      } satisfies NonNullable<HostAdapters['llm']>),
    // 三项职能共用一个"每次调用现读配置"的 chat：玩家刚在设置页改完 Key，下一句就得用新的。
    // 绑定一次配置会让改动要等重启页面才生效（这是最容易漏的一条接缝）。
    llmCards: deps.llmCardsOverride ?? ((input) => suggestCards({ chat: boundChat() }, input)),
    llmNames:
      deps.llmNamesOverride ??
      ((deckName, sampleFronts) => suggestBossNames({ chat: boundChat() }, { deckName, sampleFronts })),
    llmEgg: deps.llmEggOverride ?? ((deckName, sampleFronts) => suggestEgg({ chat: boundChat() }, { deckName, sampleFronts })),
    setEgg: deps.setEggOverride ?? ((deckId, text) => setEggOnDeck(coord, deckId, text)),

    /* ---- 采新卡：抓取 / 生成 / 清单 / 就地编辑（Plan 8 · T9） ---- */
    /**
     * 抓一个链接。**读取服务只在玩家配了它的时候才带**（默认空串 = 不启用）：
     * 那是"把链接发给第三方"，必须由玩家自己开（设置页里也如实写了这一点）。
     */
    ingestUrl: (url) =>
      ingestUrl(
        {
          fetchPage: (target) => {
            const cfg = llmIo.load();
            const readerUrl = typeof cfg.readerUrl === 'string' ? cfg.readerUrl.trim() : '';
            const fetchImpl = deps.fetchPageImpl ?? fetchPage;
            return fetchImpl(
              target,
              readerUrl.length === 0
                ? undefined
                : { reader: { url: readerUrl, key: typeof cfg.readerKey === 'string' ? cfg.readerKey : '' } },
            );
          },
          digestHtml,
        },
        url,
      ),
    /**
     * 生成候选卡：额度**生成前读、生成后写回**（次数/张数都记在存档里）。
     * 与判卷口同款纪律：`boundChat()` 每次现读配置。
     */
    collectCards: async (input) => {
      const generate =
        deps.collectCardsOverride ??
        ((i: { text: string; deckName: string; want?: number; onStage?: (s: 'outline' | 'cards') => void }) =>
          collectCards({ chat: boundChat() }, {
            text: i.text,
            deckName: i.deckName,
            want: i.want,
            onStage: i.onStage,
            quota: coord.snapshot().settings.llmQuota,
            nowMs: now(),
            tzOffsetMin,
          }));
      const res = await generate({
        text: input.text,
        deckName: input.deckName,
        want: input.want,
        onStage: input.onStage, // D59：进度回调一路透到 knowledgeFlow
      });
      if (res.ok) await setLlmQuota(coord, res.quota);
      return res;
    },
    inbox: deps.inboxOverride ?? { load: loadInbox, save: saveInbox, clear: clearInbox },
    /**
     * 来源库（D53）：读订阅源走 `platform/feedFetch`，玩家那份库走 `platform/sourceStore`。
     * `fetchItems` **不注入 fetchImpl** —— 生产就该用真 fetch；测试用 override 换掉整口。
     */
    /**
     * 玩家身份（D57）：**每次调用现读**（改完昵称立刻生效，与 LLM 配置同一接缝）。
     * 首次取用时补一个短 ID（只生成一次并落盘）。
     */
    profile: deps.profileOverride ?? {
      load: () => ensureProfile(() => `u-${Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0')}`),
      save: (profile) => saveProfile(profile),
    },
    /**
     * 遭遇战名字升级（D58）：**只在校验通过时覆盖**，失败就保留本地兜底名（不打扰玩家）。
     * 这里不 await（结果屏不等它）—— 名字是锦上添花，不该让结算慢一秒。
     */
    onNameRequest:
      deps.onNameRequestOverride ??
      // 注意这层括号：`??` 后面直接跟**同步**箭头函数会被解析成 `(a ?? (input)) => {}`（语法错）。
      // 异步箭头（下面 judge 那种）没这个问题，但这里保持一致写法更省事。
      ((input) => {
        void (async () => {
          const res = await suggestFightTitle({ chat: boundChat() }, { combo: input.combo, kind: input.kind });
          if (!res.ok) return;
          await upgradeRunTitle(coord, { recordId: input.recordId, yahao: res.yahao });
        })().catch(() => undefined);
      }),
    /** 「关于」（D54）：版本显示 + 检查更新（只查不刷；`apply` 才 reload）。 */
    pwa: deps.pwaOverride ?? {
      version: pageBuild,
      check: () => checkForUpdate(),
      apply: reloadPage,
    },
    sources: deps.sourcesOverride ?? {
      /**
       * 读一个订阅源。**读取服务同样只在这玩家配了它时才带**（缺省 = 不启用）：
       * 对"没开跨域"的源（arXiv / OpenAI / DeepMind…）它是唯一的读法，但那意味着
       * **把这个源的地址发给那台服务** —— 与采集文章那条路的账是同一笔（D55）。
       */
      fetchItems: async (source, opts) => {
        const cfg = llmIo.load();
        const readerUrl = typeof cfg.readerUrl === 'string' ? cfg.readerUrl.trim() : '';
        /**
         * **会话内缓存**（D62）：同一个源在这次会话里读过的结果直接用 —— 每一次读都是真花钱
         * （读取服务按内容量计费）。`refresh:true`（屏上「重新读」）绕过缓存。
         */
        // 键里带上读取服务地址：换了服务/关了服务之后，同一个源的读法就变了，
        // 拿旧缓存等于给玩家看"另一条路"的结果（AD#13 就是被这一点绊到的）
        const key = `${source.id}@${source.url}@${readerUrl}`;
        const at = now();
        const hit = feedCache.get(key);
        if (opts?.refresh !== true && hit !== undefined && at - hit.at < FEED_CACHE_TTL_MS) {
          if (hit.result.ok) return { ...hit.result, cached: true };
          // 失败不进缓存（网络抖一下不该让玩家半小时都读不到）
        }
        const res = await fetchSourceItems(source, {
          ...(deps.feedFetchImpl === undefined ? {} : { fetchImpl: deps.feedFetchImpl }),
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
          ...(readerUrl.length === 0
            ? {}
            : { reader: { url: readerUrl, key: typeof cfg.readerKey === 'string' ? cfg.readerKey : '' } }),
        });
        if (res.ok) feedCache.set(key, { at, result: res });
        return res;
      },
      library: { load: loadSources, save: saveSources },
    },
    updateCard: (input) => updateCard(coord, input),

    /* ---- 作答模式（Plan 6 · T7） ---- */
    setAnswerMode: deps.setAnswerModeOverride ?? ((mode) => setAnswerMode(coord, mode)),
    /**
     * 判卷：**先记一次判定额度，再调判卷口**（D42 的两本账之一）。
     *
     * 两个刻意的口径：
     * 1. 额度**先记后判**：那次请求已经发出去了（钱已经花了），失败也照记 —— 否则
     *    "模型老是回垃圾"会变成免费刷额度；到顶时**不调用**、直接回可上屏的原因，
     *    UI 据此回落成玩家自评（额度是成本闸，不该把复习锁住）。
     * 2. 用的是 `boundChat()`：**每次调用现读**配置（玩家刚在设置页换的 Key 立刻生效），
     *    与辅建卡/称号/彩蛋同一条接缝。
     */
    judge:
      deps.judgeOverride ??
      (async (input) => {
        const plan = planJudge(coord.snapshot().settings.llmQuota, now(), tzOffsetMin);
        if (!plan.allowed) {
          return { ok: false as const, reason: '今天的判定额度用完了（300 次），这次你自己定对错。' };
        }
        await setLlmQuota(coord, plan.quota);
        return judgeAnswer({ chat: boundChat() }, input);
      }),

    /**
     * 「重出选项」（D56）：**先记后做**（与判卷同款纪律）—— 一次真实调用 = 1 张卡的额度。
     *
     * 为什么记在**卡片**额度上：它不产出卡，但它是"知识准备"这条路上的开销，和辅建卡/采新卡
     * 共用同一本账最省心（也挡住"连点重出把额度当免费"的用法）。到顶时不调用，如实回原因。
     */
    refreshChoices:
      deps.refreshChoicesOverride ??
      (async ({ cardId }) => {
        const snap = coord.snapshot();
        const card = snap.cards.find((c) => c && c.id === cardId);
        if (card === undefined) return { ok: false as const, reason: '这张卡已经不在了——刷新一下再看看。' };
        const deckName = snap.decks.find((d) => d && d.id === card.deckId)?.name ?? '';
        const charge = planCharge(coord.snapshot().settings.llmQuota, 1, now(), tzOffsetMin);
        // `planCharge` 是**预留**（当场记账）：granted === 0 就是"今天一张都不剩了"，不必调用
        if (charge.granted < 1) {
          return { ok: false as const, reason: `今天的新知识额度用完了（${DAILY_CARD_CAP} 张），明天再来。` };
        }
        await setLlmQuota(coord, charge.quota);
        const res = await suggestChoices({ chat: boundChat() }, { front: card.front ?? '', back: card.back ?? '', deckName });
        if (!res.ok) return { ok: false as const, reason: res.reason };
        const saved = await setCardChoices(coord, { cardId, choices: res.choices });
        if (!saved.ok) return { ok: false as const, reason: saved.reason };
        return { ok: true as const, choices: res.choices };
      }),
  };

  return { ctrl: wrapped, adapters };
}
