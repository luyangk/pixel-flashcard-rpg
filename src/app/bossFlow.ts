/**
 * bossFlow.ts —— Plan 4 · T8：卷灵（Boss）门槛、净化落账与暗线里程碑的编排层。
 *
 * 这一层把三件**互相咬合**的事收在一个文件里，因为它们共享同一套口径：
 * 1. **门槛（bossGate）**：领域累计有效复习数达标 → 该领域卷灵现身。
 *    计数与阈值判定逐字委托 `core/reviewLedger`（Boss 口径的唯一权威；
 *    `deckBuild.bossCheck` 是同一委托的 core 侧入口，本层只做"全领域批量 + 引导域特调"）。
 * 2. **净化（markPurified）**：`won && difficulty==='boss'` 的终局把 `deck.purifiedAt`
 *    写死一次（已净化不重写——重战当练习关，不刷新时间戳）。
 * 3. **三幕里程碑（LORE §5.3）**：净化第 3/6/9 个领域各解锁一幕暗线，
 *    `settings.story.arcSeen` 记"已露过面"的幕数（0–3）。
 *
 * **引导领域特调 15**（PRD §6.5 D18）：生活常识是首个引导领域，阈值特调 15，
 * 保证新用户 3 天内见到第一头 Boss（DoD2）。这是**逐领域**的覆盖，不改全局设置位——
 * 玩家把设置调成 50 时，引导域仍是 15。
 *
 * 时间与随机一律注入（nowMs）；本模块零 DOM、零时钟读取（与 app 层同纪律）。
 */
import type { Card, Deck, SaveFile } from '@core/types';
import { MAX_TIME_MS } from '@core/saveMigrate';
import { bossCheck } from '@core/deckBuild';
import type { Coordinator } from './persist';

/**
 * 引导领域（生活常识）的**规范 id**：预置内容种子（T11）必须用这个 id 建这个领域，
 * 否则"特调 15"会落空。把常量放在这里而不是内容文件里，是因为它是**规则**的一部分
 * （判定用到它），内容文件只是数据。
 */
export const GUIDE_DECK_ID = 'preset-life';

/** 暗线三幕的净化里程碑（LORE §5.3 verbatim：净化第 3/6/9 个领域）。 */
export const ARC_MILESTONES: readonly number[] = [3, 6, 9];

/** 自建领域 Boss 的默认称号模板（PRD：默认模板 `{卡组名}·卷灵`，可自拟 ≤30 字）。 */
export function defaultBossName(deckName: string): string {
  const name = typeof deckName === 'string' && deckName.trim().length > 0 ? deckName.trim() : '无名';
  return `${name}·卷灵`;
}

/** 一个领域的卷灵门槛快照（prepare 的「卷灵现身」chip 与 codex 的条目都用它）。 */
export interface BossGate {
  readonly deckId: string;
  readonly deckName: string;
  /** 该领域的有效阈值（引导域特调 15，其余取 settings.bossThresholdTier）。 */
  readonly threshold: 15 | 30 | 50;
  readonly count: number;
  readonly ready: boolean;
  readonly purifiedAt: number | undefined;
}

/**
 * 逐领域阈值：引导域恒 15，其余取全局档。非法 tier（运行时脏数据）保守回落 30——
 * 与 settings 的默认档一致，且 `bossCheck` 自身对非法 tier 另有"判未触发"的保守处理。
 */
export function thresholdForDeck(deckId: string, tier: unknown): 15 | 30 | 50 {
  if (deckId === GUIDE_DECK_ID) return 15;
  return tier === 15 || tier === 30 || tier === 50 ? tier : 30;
}

/** 单领域门槛：cards 传**该领域**的卡（本函数不做分组）。 */
export function bossGateForDeck(deck: Deck, deckCards: readonly Card[], tier: unknown): BossGate {
  const threshold = thresholdForDeck(deck.id, tier);
  const check = bossCheck(Array.isArray(deckCards) ? [...deckCards] : [], threshold);
  return {
    deckId: deck.id,
    deckName: typeof deck.name === 'string' ? deck.name : deck.id,
    threshold,
    count: check.count,
    ready: check.ready,
    purifiedAt: deck.purifiedAt,
  };
}

/** 全领域门槛（顺序 = save.decks 顺序；prepare 与 codex 都按它渲染）。 */
export function bossGates(save: SaveFile): BossGate[] {
  const decks = Array.isArray(save?.decks) ? save.decks : [];
  const cards = Array.isArray(save?.cards) ? save.cards : [];
  const byDeck = new Map<string, Card[]>();
  for (const c of cards) {
    if (!c || typeof c.deckId !== 'string') continue;
    const list = byDeck.get(c.deckId);
    if (list) list.push(c);
    else byDeck.set(c.deckId, [c]);
  }
  return decks
    .filter((d): d is Deck => !!d && typeof d.id === 'string')
    .map((d) => bossGateForDeck(d, byDeck.get(d.id) ?? [], save?.settings?.bossThresholdTier));
}

/** 已达标（可开卷灵战）的领域；未净化的也算——重战当练习关是有意允许的。 */
export function readyGates(save: SaveFile): BossGate[] {
  return bossGates(save).filter((g) => g.ready);
}

/** 已净化领域数（三幕里程碑的判据）。 */
export function purifiedCount(save: SaveFile): number {
  const decks = Array.isArray(save?.decks) ? save.decks : [];
  let n = 0;
  for (const d of decks) if (d && typeof d.purifiedAt === 'number' && Number.isFinite(d.purifiedAt)) n += 1;
  return n;
}

/** 由净化数推出的"应当已解锁的幕数"（0–3；LORE §5.3 的 3/6/9 阈值）。 */
export function actsUnlockedBy(purifiedCountValue: number): number {
  let n = 0;
  for (const m of ARC_MILESTONES) if (purifiedCountValue >= m) n += 1;
  return n;
}

/**
 * 净化落账：把本次 Boss 战涉及的领域写 `purifiedAt = nowMs`。
 *
 * 三条刻意的口径：
 * - **已净化的不重写**（重战当练习关，不刷新时间戳：codex 的"新者前"排序因此稳定）；
 * - **只认真的打过**：调用方传的是本局参战卡所属 deckId（不是全库），脏 id 被忽略；
 * - **返回值 = 本次新净化的 deckId**（调用方据此决定要不要走里程碑/称号询问）。
 *
 * 只读态：`mutate` 抛 SaveReadOnlyError，由调用方（控制器 guardedWrite）折成只读位。
 * 本模块**不吞**这个异常——它在控制器里是"游戏流程不中断、只是不落盘"的既有语义。
 */
export async function markPurified(
  coord: Coordinator,
  deckIds: readonly string[],
  nowMs: number,
): Promise<string[]> {
  const wanted = new Set<string>();
  for (const id of Array.isArray(deckIds) ? deckIds : []) {
    if (typeof id === 'string' && id.length > 0) wanted.add(id);
  }
  if (wanted.size === 0) return [];
  // 脏时刻不写（fail-closed），**域与 saveMigrate.requireTimestamp 同界**：
  // 只判 Number.isFinite 会放过 1e300 —— 它能通过有限性检查，却会让落盘自检整包拒，
  // 于是 dirty 永久为真、此后任何进度都写不进存储（I-2/I-3 同一类病灶；BF#3b 钉住）。
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_TIME_MS) return [];

  const fresh: string[] = [];
  for (const deck of coord.snapshot().decks) {
    if (wanted.has(deck.id) && deck.purifiedAt === undefined) fresh.push(deck.id);
  }
  if (fresh.length === 0) return [];

  await coord.mutate((save) => {
    for (const deck of save.decks) {
      if (fresh.includes(deck.id)) deck.purifiedAt = nowMs;
    }
  });
  return fresh;
}

/**
 * 记下"第 act 幕已露面"（只前进、不回退）。同值/更小值不写（写放大纪律，与
 * storyState.markPrologueSeen 同款）。act 非 1–3 的整数一律忽略。
 */
export async function markArcSeen(coord: Coordinator, act: number): Promise<boolean> {
  if (!Number.isInteger(act) || act < 1 || act > 3) return false;
  if (coord.snapshot().settings.story.arcSeen >= act) return false;
  await coord.mutate((save) => {
    if (save.settings.story.arcSeen < act) save.settings.story.arcSeen = act;
  });
  return true;
}

/** 称号校验结果（≤30 字、非空；不合法回默认模板而不是报错——玩家不会因此卡住）。 */
export interface BossNameResult {
  readonly ok: boolean;
  readonly name: string;
  readonly reason?: string;
}

/** 称号上限（LORE §6：叙事半文半白短句 ≤30 字；称号按同一上限收）。 */
export const BOSS_NAME_MAX = 30;

/**
 * 规范化玩家输入的卷灵称号：空白/超长一律**回落默认模板**（`{卡组名}·卷灵`），
 * 返回 `ok:false` 让 UI 能提示一句"用了默认称号"，但绝不把无效值写进存档。
 * 长度按**码点**数（`[...s].length`），避免 emoji/代理对被算成两个字而误判。
 */
export function normalizeBossName(raw: unknown, deckName: string): BossNameResult {
  const fallback = defaultBossName(deckName);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return { ok: false, name: fallback, reason: '称号是空的，先用默认的。' };
  if ([...text].length > BOSS_NAME_MAX) {
    return { ok: false, name: fallback, reason: `称号最多 ${BOSS_NAME_MAX} 个字，先用默认的。` };
  }
  return { ok: true, name: text };
}

/**
 * 写卷灵称号（首次触发自建领域 Boss 时问一次）。非法输入不写、返回规范化结果，
 * 调用方据 `ok` 决定要不要提示。
 */
export async function setBossName(
  coord: Coordinator,
  deckId: string,
  raw: unknown,
): Promise<BossNameResult> {
  const deck = coord.snapshot().decks.find((d) => d.id === deckId);
  if (!deck) return { ok: false, name: defaultBossName('无名'), reason: '这个领域已经不在了。' };
  const res = normalizeBossName(raw, deck.name);
  if (deck.bossName === res.name) return res; // 同值不重写
  await coord.mutate((save) => {
    const target = save.decks.find((d) => d.id === deckId);
    if (target) target.bossName = res.name;
  });
  return res;
}

/** 领域的展示称号：存档里有就用它，否则默认模板（预置领域的正式称号由内容种子写入）。 */
export function bossNameOf(deck: Deck): string {
  const name = deck?.bossName;
  return typeof name === 'string' && name.length > 0 ? name : defaultBossName(deck?.name ?? '');
}

/**
 * 卷灵战的**规范参数**：单领域、池子取 `min(该领域卡数, 25)`（PRD §3 上限挡）。
 * prepare 与 codex 的「练习关（重战）」都调它，避免两处各写一份 size 口径。
 */
export function bossFightParams(save: SaveFile, deckId: string): { size: number; deckIds: string[] } {
  const cards = Array.isArray(save?.cards) ? save.cards : [];
  let n = 0;
  for (const c of cards) if (c && c.deckId === deckId) n += 1;
  return { size: Math.max(1, Math.min(n, 25)), deckIds: [deckId] };
}
