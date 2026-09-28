/**
 * presetContent.ts —— Plan 4 · T11：预置内容种子（4 个领域 + 30 张手写卡）的灌装。
 *
 * ## 什么时候灌（唯一判据：空库）
 * `decks` 与 `cards` **都为空**才灌。这就是"首次启动"的签名——旧档（哪怕只有一张卡）
 * 一律不碰：把预置内容塞进老玩家的卡库会污染他的统计口径（vit/spi 按全库算），
 * 也可能和他的同名领域撞车。代价是"把卡库清空的玩家会重新拿到新手套装"，
 * 这比"老档被塞进 30 张陌生卡"好得多。
 *
 * ## 内容在 mutate 之前先消毒（T7 评审判 I-2 的同款教训）
 * 落盘自检（validateSave）是**整包**拒的：预置 JSON 里一个空 id、一条悬空 deckId
 * 或一张空答案卡，都会让 dirty 永久为真——此后玩家**任何**进度都写不进存储，
 * 而启动时却看不到任何异常。所以内容是数据不是代码，必须在灌之前逐项验完；
 * 验不过就**整份不灌**并回一个可上屏的原因（宁可不给新手套装，不给一个写不进的档）。
 *
 * 时间与 id 由调用方注入（nowMs 决定 `srs.due` 与 `source.createdAt`；卡 id 来自内容文件，
 * 一经发布不得改——它们会进 SRS 与榜首）。
 */
import type { Card, Deck, SaveFile } from '@core/types';
import { MAX_TIME_MS } from '@core/saveMigrate';
import { createInitialSRS } from '@core/sm2';
import type { Coordinator } from './persist';

/** 内容文件里的一张卡（只有文案与 id；溯源与 SRS 由代码生成）。 */
export interface PresetCardContent {
  readonly id: string;
  readonly front: string;
  readonly back: string;
  readonly tags?: readonly string[];
}

/** 内容文件里的一个领域。 */
export interface PresetDeckContent {
  readonly id: string;
  readonly name: string;
  readonly bossName?: string;
  readonly cards: readonly PresetCardContent[];
}

/** 内容文件本体（与 assets/content/preset.json 同形）。 */
export interface PresetContent {
  readonly decks: readonly PresetDeckContent[];
}

/** 灌装结果（`reason` 是可直接上屏的大白话；失败时**一个字都没写**）。 */
export type InstallResult =
  | { readonly installed: true; readonly decks: number; readonly cards: number }
  | { readonly installed: false; readonly reason: string };

/** 空库判据（唯一灌装条件）。 */
export function isFreshLibrary(save: SaveFile): boolean {
  const decks = Array.isArray(save?.decks) ? save.decks : [];
  const cards = Array.isArray(save?.cards) ? save.cards : [];
  return decks.length === 0 && cards.length === 0;
}

/**
 * 内容校验：逐领域、逐卡检查，任何一条不合格就整份拒绝。
 * 检查项与 validateSave 的对应关系写在每行注释里——本函数是"落盘自检之前的那道闸"，
 * 不是它的替代品（自检仍会在 flush 时再跑一次）。
 */
export function validateContent(content: unknown): { ok: true; content: PresetContent } | { ok: false; reason: string } {
  const bad = (why: string): { ok: false; reason: string } => ({
    ok: false,
    reason: `预置内容有问题（${why}），这次没有灌入——你的存档没有被动过。`,
  });
  if (content === null || typeof content !== 'object') return bad('不是内容文件');
  const decks = (content as PresetContent).decks;
  if (!Array.isArray(decks) || decks.length === 0) return bad('没有任何领域');

  const deckIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const deck of decks) {
    if (deck === null || typeof deck !== 'object') return bad('领域不是对象');
    if (typeof deck.id !== 'string' || deck.id.length === 0) return bad('领域 id 为空'); // validateSave: decks[].id 非空串
    if (typeof deck.name !== 'string' || deck.name.trim().length === 0) return bad(`领域 ${deck.id} 没有名字`);
    if (deckIds.has(deck.id)) return bad(`领域 id 重复：${deck.id}`); // validateSave: decks[].id 唯一
    deckIds.add(deck.id);
    if (!Array.isArray(deck.cards)) return bad(`领域 ${deck.id} 的 cards 不是数组`);
    for (const card of deck.cards) {
      if (card === null || typeof card !== 'object') return bad(`领域 ${deck.id} 里有非对象卡`);
      if (typeof card.id !== 'string' || card.id.length === 0) return bad(`领域 ${deck.id} 里有空 id 卡`);
      if (cardIds.has(card.id)) return bad(`卡 id 重复：${card.id}`); // validateSave: cards[].id 唯一
      cardIds.add(card.id);
      if (typeof card.front !== 'string' || card.front.trim().length === 0) return bad(`卡 ${card.id} 的正面为空`);
      if (typeof card.back !== 'string' || card.back.trim().length === 0) return bad(`卡 ${card.id} 的背面为空`);
      const tags = card.tags;
      if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
        return bad(`卡 ${card.id} 的 tags 不是字符串数组`); // validateSave: tags 逐项字符串
      }
    }
  }
  return { ok: true, content: content as PresetContent };
}

/** 内容里的卡总数（UI/日志用；不做校验，脏数据按 0 计）。 */
export function contentCardCount(content: PresetContent | null | undefined): number {
  const decks = content && Array.isArray(content.decks) ? content.decks : [];
  let n = 0;
  for (const d of decks) if (Array.isArray(d?.cards)) n += d.cards.length;
  return n;
}

/**
 * 按内容造出可落库的 decks/cards（**纯函数**，不碰存储）。
 * - 卡 id 直接用内容 id（跨存档稳定：SRS 与榜首都认得它）；
 * - srs = `createInitialSRS(nowMs)`（stability 'new'、due = nowMs）；
 * - source = `{type:'preset', createdAt: nowMs}`——预置卡不给 spi（§6.4：公共资产），
 *   但溯源字段仍要写：validateSave 对 source 是"在场才严检"，写了更利于日后排查。
 */
export function buildPresetEntities(
  content: PresetContent,
  nowMs: number,
): { decks: Deck[]; cards: Card[] } {
  const decks: Deck[] = [];
  const cards: Card[] = [];
  for (const d of content.decks) {
    const deck: Deck = { id: d.id, name: d.name, isPreset: true };
    if (typeof d.bossName === 'string' && d.bossName.length > 0) deck.bossName = d.bossName;
    decks.push(deck);
    for (const c of d.cards) {
      cards.push({
        id: c.id,
        deckId: d.id,
        front: c.front,
        back: c.back,
        source: { type: 'preset', createdAt: nowMs },
        srs: createInitialSRS(nowMs),
        tags: Array.isArray(c.tags) ? [...c.tags] : [],
      });
    }
  }
  return { decks, cards };
}

/**
 * 首次启动灌装。三道闸按顺序：空库（唯一条件）→ 时刻可用（落盘自检同界）→ 内容合法。
 * 任一不过都**不写**（installed:false + 原因），绝不半灌。
 * 只读态：`mutate` 抛 SaveReadOnlyError 由调用方（宿主）捕获——启动路径上宿主会把它
 * 折成只读横幅，而不是让启动崩掉。
 */
export async function installPresetContent(
  coord: Coordinator,
  content: unknown,
  nowMs: number,
): Promise<InstallResult> {
  if (!isFreshLibrary(coord.snapshot())) {
    return { installed: false, reason: '这份存档已经有内容了，不灌预置内容。' };
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_TIME_MS) {
    return { installed: false, reason: '设备时间读数异常，这次没有灌入预置内容。' };
  }
  // 只读态（坏档接管）：不灌、也不抛——启动路径上抛异常会直接白屏。
  // 第二道闩锁（mutate 抛 SaveReadOnlyError）仍由下面的 catch 兜住。
  if (coord.readOnly()) {
    return { installed: false, reason: '存档无法读取（只读保护），这次没有灌入预置内容。' };
  }
  const checked = validateContent(content);
  if (!checked.ok) return { installed: false, reason: checked.reason };

  const { decks, cards } = buildPresetEntities(checked.content, nowMs);
  try {
    await coord.mutate((save) => {
      // 再判一次空库：mutate 是异步排队的，两次之间可能有别的写入（例如玩家已经手建了领域）
      if (!isFreshLibrary(save)) return;
      save.decks = decks;
      save.cards = cards;
    });
  } catch (e) {
    // 灌内容失败不该阻断启动（玩家仍可手写卡开局）——回一句原因即可
    return { installed: false, reason: `没能灌入预置内容：${e instanceof Error ? e.message : String(e)}` };
  }
  return { installed: true, decks: decks.length, cards: cards.length };
}
