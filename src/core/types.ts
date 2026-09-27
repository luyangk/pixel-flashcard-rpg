/**
 * 核心领域类型 —— 后续所有 core 模块（SM-2 引擎、复习计数、存储、存档校验）共用。
 *
 * 约束：本文件为纯类型声明，不含任何运行时代码，也不得引用平台 API
 * （浏览器 / Node 全局对象），以保持 core 层的零平台依赖。
 */

/** 卡片稳定度阶段（驱动伤害倍率映射与 Boss 计数口径）。 */
export type Stability = 'new' | 'learning' | 'review' | 'mastered';

/** 来源溯源信息；LLM 生成卡必填（PRD §6.2）。 */
export interface SourceInfo {
  type: 'preset' | 'hotspot' | 'domain' | 'manual' | 'llm';
  url?: string;
  createdAt: number;
}

/** SM-2 变体的可调参数。规范定义归属 Task 3 的 sm2 引擎；此处先行声明，
 *  由 types.ts 拥有、Task 3 从此 import，以免形成循环依赖。 */
export interface Sm2Params {
  initialEase: number;
  minEase: number;
  firstInterval: number;
  secondInterval: number;
}

/** 单张卡的间隔重复状态。 */
export interface SRSState {
  ease: number; // SM-2 难度因子
  interval: number; // 当前间隔（天）
  reps: number; // 连续正确次数
  lapses: number; // 遗忘次数
  due: number; // 下次到期时间戳
  stability: Stability;
  effectiveReviewDays: string[]; // 有效复习日期集（同日只计一次，Boss 计数口径）
}

/** 记忆卡牌（PRD §6.2）。 */
export interface Card {
  id: string;
  deckId: string; // 所属卡组 = 知识领域 = 一头卷灵 Boss
  front: string; // 正面（问题/提示）
  back: string; // 背面（答案）
  source?: SourceInfo;
  srs: SRSState;
  tags: string[]; // 主题筛选依据
}

/** 卡组即知识领域（PRD §6.2，v2）。 */
export interface Deck {
  id: string;
  name: string;
  isPreset: boolean;
  bossName?: string; // 卷灵称号；预置手写，自建默认模板 + 首次触发询问
  purifiedAt?: number; // 净化时间戳（undefined = 未净化）
}

/** 战斗相关设置（Plan 2 · Task 8 新增；v2.1 之前的旧档缺此字段，由 migrateSave 补默认）。 */
export interface BattleSettings {
  /** 备战卡池请求规模。合法域：10–25 的整数；默认 15。 */
  defaultPoolSize: number;
}

/** 玩家设置。 */
export interface Settings {
  bossThresholdTier: 15 | 30 | 50;
  sm2Params: Sm2Params;
  battle: BattleSettings;
}

/** 本地存档容器（本计划新增；导入时须整体通过 validateSave）。 */
export interface SaveFile {
  schemaVersion: 1;
  decks: Deck[];
  cards: Card[];
  settings: Settings;
  meta: { savedAt: number; plays: number };
}
