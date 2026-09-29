/**
 * hostTypes.ts —— Plan 4 · T11：宿主壳的**依赖面**（类型单独成文件）。
 *
 * 为什么拆出来：`host.ts` 要 import 七个屏组件（菜单/备战/结算/卡组/藏书阁/设置/序章）
 * 与战斗屏，而 `main.ts` 要与 coordinator/transfer/library/settingsFlow 装配。
 * 把"宿主需要外部提供什么"单独声明，`main.ts` 只 import 本文件 + `mountHost`，
 * 屏组件之间也不为此多出运行时依赖（type-only import 在 verbatimModuleSyntax 下零残留）。
 */
import type { AnswerMode, Card, Deck, Sm2Params } from '@core/types';
import type { Rng } from '@core/rng';
import type { CardCandidate, NameCandidate, ParseResult } from '@core/llmParse';
import type { ChatResult, LlmConfig } from '../platform/llmTypes';
import type { BossNameResult } from '../app/bossFlow';
import type { IngestResult } from '../app/ingestFlow';
import type { CollectResult } from '../app/knowledgeFlow';
import type { LibraryResult } from '../app/library';
import type { ResetSaveResult } from '../app/resetFlow';
import type { SettingsWriteResult } from '../app/settingsFlow';
import type { ExportAndMarkResult, ImportAndSaveResult } from '../app/transfer';
import type { InboxItem } from '../platform/inboxStore';
import type { StageSprites } from '../stage/renderer';
import type { SharedInput } from '../ui/practiceCollect';
import type { BattleScreenWindow } from './battleScreen';
import type { BeatEntry } from './beats';
import type { ArcAct } from './codex';
import type { PrologueScene } from './prologue';
import type { LlmSettingsDeps } from './settings';

/** 假记忆战败演出的注入位（与 result.ts / fakeMemory.ts 的形参同构，避免跨模块再定义）。 */
export interface Timers {
  (cb: () => void, ms: number): number;
}

export interface HostAdapters {
  /* 内容与素材（全部由 main.ts 从 assets/ 读入） */
  readonly prologueScenes: readonly PrologueScene[];
  readonly beats: readonly BeatEntry[];
  readonly eggs?: Readonly<Record<string, string>>;
  readonly acts?: readonly ArcAct[];
  readonly sprites: StageSprites;
  /** 假记忆词替换表（assets/narrative/fake-words.json → Map）。 */
  readonly wordTable?: ReadonlyMap<string, string>;
  /** 榜单展示条数（菜单）。 */
  readonly topN?: number;

  /* 随机与时钟 */
  readonly rng: Rng;
  readonly now: () => number;
  readonly tzOffsetMin: number;
  readonly newId: () => string;

  /* 写口（全部来自 app 层） */
  readonly addCard?: (input: {
    front: string;
    back: string;
    deckId: string;
    id: string;
    /**
     * Plan 5 · T4：AI 辅建卡标 `'llm'`；Plan 8：从链接采集来的标 `'hotspot'`（带 url 溯源）；
     * 手写不传（缺省 `'manual'`）。
     */
    sourceType?: 'manual' | 'llm' | 'hotspot';
    /** 主题标签（AI 辅建带过来；PRD §3 主题筛选的依据）。缺省 = 无标签。 */
    tags?: readonly string[];
    /** 干扰项（Plan 6 · D41）。 */
    choices?: readonly string[];
    /** 来源标 `hotspot`（Plan 8：从链接采集来的卡）+ 来源链接（可溯源）。 */
    url?: string;
  }) => Promise<LibraryResult<Card>>;
  readonly addDeck?: (input: { name: string; id: string }) => Promise<LibraryResult<Deck>>;
  /** 领域改名（Plan 5 追加：用户实测反馈"新建领域后不知道如何删除或修改"）。 */
  readonly renameDeck?: (input: { deckId: string; name: string }) => Promise<LibraryResult<Deck>>;
  /** 删除领域**及其全部卡**（不可逆；UI 侧两步确认）。 */
  readonly removeDeck?: (input: { deckId: string }) => Promise<LibraryResult<{ cards: number }>>;
  /** 删除单张卡。 */
  readonly removeCard?: (input: { cardId: string }) => Promise<LibraryResult<{ id: string }>>;
  readonly setBossName?: (deckId: string, raw: string) => Promise<BossNameResult>;
  readonly setTier?: (tier: 15 | 30 | 50) => Promise<SettingsWriteResult>;
  readonly setParams?: (params: Sm2Params) => Promise<SettingsWriteResult>;
  readonly setPoolSize?: (size: number) => Promise<SettingsWriteResult>;
  readonly replayPrologue?: () => Promise<SettingsWriteResult>;
  /** 彩蛋写口（Plan 5 · T5；接 app/codexFlow.setEggOnDeck）。 */
  readonly setEgg?: (deckId: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
  readonly onBeatDrawn?: (cursor: number) => void;
  readonly onReplay?: () => void;
  readonly onPractice?: (deckId: string) => void;
  /**
   * 「练这一域」（Plan 7 · T6）：把练功屏勾选的卡交给控制器开局
   * （`startFight({ mode:'drill', cardIds })`）。缺省 ⇒ 练功屏的按钮禁用。
   */
  readonly onDrill?: (input: { readonly cardIds: readonly string[] }) => void;
  /** 练功屏顶部的今日额度行（与设置页同一句口径）。 */
  readonly practiceQuotaText?: () => string;
  /* ---- 采新卡（Plan 8 · T9）：抓取 / 生成 / 清单 / 就地编辑 ---- */
  /** 抓一个链接（接 `app/ingestFlow.ingestUrl` + `platform/pageFetch`，含可选读取服务）。 */
  readonly ingestUrl?: (url: string) => Promise<IngestResult>;
  /** 从正文生成候选卡（接 `app/knowledgeFlow.collectCards`；额度当场写回存档）。 */
  readonly collectCards?: (input: {
    readonly text: string;
    readonly deckName: string;
    readonly want?: number;
  }) => Promise<CollectResult>;
  /** 待读清单（接 `platform/inboxStore`）。 */
  readonly inbox?: {
    readonly load: () => readonly InboxItem[];
    readonly save: (items: readonly InboxItem[]) => boolean;
    readonly clear: () => void;
  };
  /** 就地改正一张卡（接 `app/library.updateCard`）。 */
  readonly updateCard?: (input: {
    readonly cardId: string;
    readonly front: string;
    readonly back: string;
  }) => Promise<LibraryResult<Card>>;
  /** 系统分享进来的内容（`main.ts` 从 query 解析；缺省 null）。 */
  readonly sharedInput?: SharedInput | null;

  /* AI（Plan 5 · T4/T5；全部可选——没有它们时对应 UI 整块隐藏） */
  /** 设置屏「AI（可选）」分组的读写口（Key 的唯一存放点 + 唯一网络出口）。 */
  readonly llm?: LlmSettingsDeps;
  /** 卡组页「AI 辅建卡」（接 app/llmFlow.suggestCards）。 */
  readonly llmCards?: (input: { text: string; deckName: string; max?: number }) => Promise<ParseResult<CardCandidate>>;
  /** 备战屏「让 AI 起几个名」（接 app/llmFlow.suggestBossNames）。 */
  /**
   * 称号建议。`sampleFronts` = 该领域 ≤5 条卡片正面（**只发正面，不发答案**）：
   * PRD D38 承诺"发领域名 + ≤5 条卡面"，安全评审判 I-2 发现生产上从不传它
   * （签名只有 deckName）⇒ 提示词拿不到任何领域材料、文档与实际不符。现已接上。
   */
  readonly llmNames?: (deckName: string, sampleFronts?: readonly string[]) => Promise<ParseResult<NameCandidate>>;
  /** 藏书阁「让 AI 写彩蛋」（接 app/llmFlow.suggestEgg）。 */
  /**
   * 问答模式的判卷口（Plan 6 · T7 / D42）。**这是全应用唯一会把"这张卡的答案"发出去的路径**：
   * 范围锁死在问答模式 + 玩家点提交那一刻 + 单张卡。装配层在调用前先记一次判定额度
   * （到顶则不调用、直接回可上屏原因，UI 回落成玩家二选一自评）。
   */
  readonly judge?: (input: {
    readonly front: string;
    readonly answer: string;
    readonly reply: string;
  }) => Promise<
    { readonly ok: true; readonly match: boolean; readonly reason: string; readonly missing: readonly string[] }
    | { readonly ok: false; readonly reason: string }
  >;
  /** 作答模式写口（接 `app/settingsFlow.setAnswerMode`）；缺省 ⇒ 战斗屏不显示切换按钮。 */
  readonly setAnswerMode?: (mode: AnswerMode) => Promise<SettingsWriteResult>;
  /** 彩蛋生成（同样支持 ≤5 条卡面样例，理由见 llmNames）。 */
  readonly llmEgg?: (
    deckName: string,
    sampleFronts?: readonly string[],
  ) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

  /* 存档重置（Plan 5 追加：「不知道怎么从头体验」） */
  /**
   * 重置存档（接 `app/resetFlow.resetSave`）。缺省 = 设置屏的「存档」分组整组隐藏
   * （`assembleHost` 只在宿主给了 `presetContent` 时才接这个口）。
   */
  readonly resetSave?: () => Promise<ResetSaveResult>;
  /**
   * 重置前的自救出口：「先导出备份」一键导出**当下这份**档并按默认文件名下载。
   * 与 `exportBackup` 的区别只在"谁拼文件名"——本口是给设置屏用的 boolean 面，
   * 免得设置屏为了一行文件名去认识时钟与文件口。
   */
  readonly exportBackupNow?: () => Promise<{ readonly ok: boolean; readonly reason?: string }>;

  /* 导入导出与抢救 */
  readonly exportBackup?: () => Promise<ExportAndMarkResult>;
  readonly importBackup?: (text: string) => Promise<ImportAndSaveResult>;
  readonly pickBackupText?: () => Promise<string | null>;
  readonly saveTextFile?: (text: string, filename: string) => void;
  readonly rawDump?: () => Promise<string | null>;

  /* 战斗屏的可注入面（测试用；生产走浏览器默认） */
  readonly win?: BattleScreenWindow;
  readonly raf?: (cb: (tMs: number) => void) => number;
  readonly caf?: (handle: number) => void;

  /* 演出节奏与提示（测试可给 0 值免定时器） */
  readonly toastMs?: number;
  readonly flashMs?: number;
  readonly holdMs?: number;
  readonly setTimer?: Timers;
  readonly clearTimer?: (handle: number) => void;
  readonly readOnlyText?: string;
}
