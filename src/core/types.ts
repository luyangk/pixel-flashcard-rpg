/**
 * 核心领域类型 —— 后续所有 core 模块（SM-2 引擎、复习计数、存储、存档校验）共用。
 *
 * 约束：本文件为纯类型声明，不含任何运行时代码，也不得引用平台 API
 * （浏览器 / Node 全局对象），以保持 core 层的零平台依赖。
 */

import type { RunRecord } from './leaderboard';

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

/**
 * 成长进度（Plan 3 · T3 新增，R-P3-a 三段式扩域）：等级不单独存储——
 * level 是 exp 的纯派生量（growth.levelFromExp），只存累计经验这一权威位，
 * 杜绝 "level 与 exp 各说各话" 的双写漂移。exp 为**非负整数**（validateSave 严检；
 * expToNext/victoryExp/applyExp 消费后全程整数域，小数无合法来源）。
 * v2.1 形状前的旧档缺此字段，由 migrateSave 补默认 {exp:0}。
 */
export interface ProgressSettings {
  exp: number;
}

/**
 * 叙事进度（Plan 4 · T6，R-P4-preflight-c 三段式：**types 必填** + validateSave 在场严检
 * 且缺席整包拒 + migrateSave 为缺席档补 {prologueSeen:false, beatIndex:0, arcSeen:0}；
 * T8 起 migrateSave 还会为"story 在场但缺 arcSeen"的 T6/T7 形状档补 arcSeen）。
 *
 * - prologueSeen：序章是否已演出过。跳过与看完**同待遇**（LORE §5.1「可跳过」），
 *   写成 true 之后宿主不再挂序章（读侧见 app/storyState.needsPrologue）；
 * - beatIndex：战报碎片抽取游标，语义是**累计抽取数**（不是池内下标）——由
 *   ui/beats.nextBeat 返回的 next 回写，落盘后重开游戏不重头抽。非负整数域
 *   （validateSave 拒 -1/2.5/'x'：小数游标无合法来源）。
 *
 * 与 leaderboard 的分工差异：它是可选派生位（缺席不拒），本字段是**必填**——
 * 序章"没看过"与"字段不存在"对宿主是两回事（前者要演出，后者只能靠迁移补齐才敢演出），
 * 故缺席走 validateSave 整包拒 + migrateSave 补默认（与 battle/progress 同构）。
 *
 * 【Plan 4 · T8 扩位】`arcSeen`：已解锁的暗线幕数（0–3，LORE §5.3 的 3/6/9 净化里程碑）。
 * 它是"里程碑**已经露过面**"的唯一记录——判据是净化数派生（purifiedCount ≥ 3/6/9），
 * 但"每幕只演一次、不重复"必须有个游标，故在此落一个 0–3 的整数。
 * 三段式与 story 整体同规格：types 必填 + validateSave 在场严检 + migrateSave 补 0。
 */
export interface StorySettings {
  prologueSeen: boolean;
  beatIndex: number;
  /** 已解锁的暗线幕数：0 = 一幕未现，3 = 三幕齐（LORE §5.3）。 */
  arcSeen: number;
}

/** 玩家设置。 */
export interface Settings {
  bossThresholdTier: 15 | 30 | 50;
  sm2Params: Sm2Params;
  battle: BattleSettings;
  progress: ProgressSettings;
  /** 叙事进度（Plan 4 · T6 必填位，见 StorySettings 注释）。 */
  story: StorySettings;
  /**
   * 本地战绩榜（Plan 3 · T7，PRD §5 首版"本地榜"的落盘位）。
   *
   * 三段式（R-P3-a 的 T7 变体）：**types 可选** + validateSave 在场严检（元素九字段）+
   * migrateSave 为缺席档补 []。与 battle/progress 的分工差异在于"缺席是否整包拒"：
   * 榜单只是展示派生数据，缺席不威胁存档可用性，故 validateSave **不拒缺席**——
   * 这是刻意的：把可选位做成拒绝点会让 T7 前写下的存档全部打不开（RF#4 的反面）。
   * 权威形状定义在 core/leaderboard.RunRecord（本文件只引用，不复制字段）。
   */
  leaderboard?: RunRecord[];
}

/** 存档容器元信息。 */
export interface SaveMeta {
  savedAt: number;
  plays: number;
  /**
   * 最近一次**成功导出备份**的时刻（Plan 3 · T7，R-T5-p3-a；7 天提醒闸门 backupReminderDue
   * 的唯一数据源）。三段式：types 可选 + validateSave 严检（有限数且 ≥0）+ **migrateSave
   * 不补默认**——缺席是语义化的"从未导出"，补一个假时刻会让闸门静默失效 7 天。
   * 写入路径：Coordinator.markExported(nowMs)（装配层）。
   */
  lastExportedAt?: number;
}

/** 本地存档容器（本计划新增；导入时须整体通过 validateSave）。 */
export interface SaveFile {
  schemaVersion: 1;
  decks: Deck[];
  cards: Card[];
  settings: Settings;
  meta: SaveMeta;
}
