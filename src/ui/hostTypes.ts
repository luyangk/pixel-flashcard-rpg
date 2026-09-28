/**
 * hostTypes.ts —— Plan 4 · T11：宿主壳的**依赖面**（类型单独成文件）。
 *
 * 为什么拆出来：`host.ts` 要 import 七个屏组件（菜单/备战/结算/卡组/藏书阁/设置/序章）
 * 与战斗屏，而 `main.ts` 要与 coordinator/transfer/library/settingsFlow 装配。
 * 把"宿主需要外部提供什么"单独声明，`main.ts` 只 import 本文件 + `mountHost`，
 * 屏组件之间也不为此多出运行时依赖（type-only import 在 verbatimModuleSyntax 下零残留）。
 */
import type { Card, Deck, Sm2Params } from '@core/types';
import type { Rng } from '@core/rng';
import type { BossNameResult } from '../app/bossFlow';
import type { LibraryResult } from '../app/library';
import type { SettingsWriteResult } from '../app/settingsFlow';
import type { ExportAndMarkResult, ImportAndSaveResult } from '../app/transfer';
import type { StageSprites } from '../stage/renderer';
import type { BattleScreenWindow } from './battleScreen';
import type { BeatEntry } from './beats';
import type { ArcAct } from './codex';
import type { PrologueScene } from './prologue';

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
  readonly addCard?: (input: { front: string; back: string; deckId: string; id: string }) => Promise<LibraryResult<Card>>;
  readonly addDeck?: (input: { name: string; id: string }) => Promise<LibraryResult<Deck>>;
  readonly setBossName?: (deckId: string, raw: string) => Promise<BossNameResult>;
  readonly setTier?: (tier: 15 | 30 | 50) => Promise<SettingsWriteResult>;
  readonly setParams?: (params: Sm2Params) => Promise<SettingsWriteResult>;
  readonly setPoolSize?: (size: number) => Promise<SettingsWriteResult>;
  readonly replayPrologue?: () => Promise<SettingsWriteResult>;
  readonly onBeatDrawn?: (cursor: number) => void;
  readonly onReplay?: () => void;
  readonly onPractice?: (deckId: string) => void;

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
