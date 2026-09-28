/**
 * controllerTypes.ts —— Plan 4 · T3 会话编排核的**类型面**（brief Interfaces verbatim）。
 *
 * 单独成文件的理由：UI 层（T4/T5/T7 的屏组件）只 import 类型即可与控制器解耦开发，
 * 不必拖进 gameController 的装配依赖（coordinator/battleFlow/results）。
 * 本文件为纯类型声明：零运行时代码；仅 type-only import（isolatedModules +
 * verbatimModuleSyntax 下编译后零残留，不产生跨模块运行时边）。
 */

import type { Grade } from '@core/sm2';
import type { SaveFile } from '@core/types';
import type { FightView } from './battleFlow';
import type { StartError } from './gameController';

/**
 * 会话屏幕位（brief verbatim 六值）。
 * 【T6 注记】'prologue' 的类型位在此保留，屏逻辑归 T6——本任务 boot→menu 直达。
 */
export type ControllerScreen = 'boot' | 'menu' | 'prologue' | 'prepare' | 'fight' | 'result';

/**
 * 一局终局后的结果摘要（brief 环境注记建议形状，字段宁少勿滥——T5/T7 result 屏消费）。
 * - expGained：本场经验（settleFight.exp；lost 恒 0）；
 * - levelBefore/levelAfter：结算落库前后的等级（levelFromExp(exp) 口径）；leveledUp 为其不等价；
 * - misses：本局 log 中 kind==='miss' 的条数（results.buildRunInput 同口径，不按"无伤害"反推）；
 * - poolLen：实际参战池长（降级链凑出的真实规模，非请求 size）。
 */
export type RunSummary = Readonly<{
  won: boolean;
  expGained: number;
  levelBefore: number;
  levelAfter: number;
  leveledUp: boolean;
  misses: number;
  poolLen: number;
}>;

/**
 * 控制器对外快照（每次 intent 完成后整体换新对象 ⇒ 订阅者浅比较可辨，无 mid-intent 中间态）。
 * - fight：当前战斗视图；**终局结算后仍保留**（result 屏要展示终局棋盘与战报），
 *   仅 `finish` / `toMenu` 离场时清空；
 * - save：coord.snapshot() 的权威存档本体（活视图，展示用；改动仍须走 intent/mutate）；
 * - readOnly：SaveReadOnlyError 捕获闩锁位（D29 横幅的数据源，T5/T8 消费）；
 * - reminderDue：备份提醒闸门（backupReminderDue(meta.lastExportedAt, now())），每次快照重算；
 * - lastResult：最近一次终局摘要（finish 前留在 fight 屏供演出；回菜单后清空）；
 * - lastError / notice：两个**互斥用途**的消息位——
 *   lastError：startFight 失败面 {code,message}——**屏停留 prepare**，码供程序分流、
 *     文案供直接上屏；下一次 startFight 成功即清空；answer/toMenu 不清（它是备战屏的
 *     错误，不是全局 toast）；
 *   notice：一次性 toast 消息位（如只读保护提示）。intent 边界统一清旧值再按需置新值，
 *     UI 消费后可经 toMenu 等自然路径清掉。
 */
export type ControllerSnapshot = Readonly<{
  screen: ControllerScreen;
  fight: FightView | null;
  save: SaveFile;
  readOnly: boolean;
  reminderDue: boolean;
  lastResult: RunSummary | null;
  lastError: StartError | null;
  notice: string | null;
}>;

/**
 * 玩家意图（唯一写入口）。
 * - startFight：建战并切 fight 屏；失败走 lastError 分流（invalid-size/no-cards/insufficient-cards）；
 * - answer：作答当前卡；若终局则内部完成 settleFight→recordRun→settleAndRecord 全链；
 * - finish：result→menu 的收口（清 fight/lastResult，回备战起点）；
 * - toMenu：任意时刻弃战回菜单（未终局的仗不落账）；
 * - skipPrologue / seenPrologue：**管道先建**（T6 接 prologue 屏逻辑），本任务
 *   skipPrologue 直达 menu、seenPrologue 为 no-op（prologueSeen 持久属 T6 的 settings.story 三段式）。
 */
export type GameIntent =
  | { type: 'startFight'; size: number; deckIds?: string[]; difficulty?: 'encounter' | 'boss' }
  | { type: 'answer'; grade: Grade }
  | { type: 'finish' }
  | { type: 'toMenu' }
  | { type: 'skipPrologue' }
  | { type: 'seenPrologue' };

/** 会话编排核的公开面（DOM 无关；UI 只消费快照与派发意图）。 */
export interface GameController {
  snapshot(): ControllerSnapshot;
  intent(i: GameIntent): Promise<void>;
  subscribe(cb: (s: ControllerSnapshot) => void): () => void;
}
