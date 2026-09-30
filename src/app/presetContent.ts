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
import { CHOICES_MAX, CHOICE_TEXT_MAX, sanitizeChoices } from '@core/llmParse';
import type { Coordinator } from './persist';

/** 内容文件里的一张卡（只有文案与 id；溯源与 SRS 由代码生成）。 */
export interface PresetCardContent {
  readonly id: string;
  readonly front: string;
  readonly back: string;
  readonly tags?: readonly string[];
  /**
   * 干扰项（D56）：**每张预置卡都必须自带**。
   *
   * 为什么预置卡尤其需要它：战斗里的干扰项顺序是「卡上自带 → 同领域其他卡」，
   * 而预置卡原来是空的 ⇒ 只能吃池子；多领域合练时就会串味（现场症状：生活常识的题里
   * 出现 AI 的选项）。写进内容文件后，每张预置卡一开局就有**同领域、像常见误解**的选项。
   */
  readonly choices?: readonly string[];
  /**
   * **原文入口**（D66）：这篇卡对应的论文/文章地址（例：arXiv 摘要页）。
   * 有了它，App 里那张卡就会多一个「看原文」（D60）—— 玩家能自己核对总结对不对。
   */
  readonly url?: string;
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
      const choices = card.choices;
      if (choices !== undefined) {
        if (!Array.isArray(choices) || choices.some((c) => typeof c !== 'string' || c.trim().length === 0)) {
          return bad(`卡 ${card.id} 的 choices 不是非空字符串数组`);
        }
        if (choices.length > CHOICES_MAX) return bad(`卡 ${card.id} 的 choices 超过 ${CHOICES_MAX} 条`);
        if (choices.some((c) => Array.from(c).length > CHOICE_TEXT_MAX)) {
          return bad(`卡 ${card.id} 的 choices 有条目超过 ${CHOICE_TEXT_MAX} 字`);
        }
      }
      const cardUrl = card.url;
      if (cardUrl !== undefined && !/^https?:\/\//i.test(String(cardUrl))) {
        return bad(`卡 ${card.id} 的 url 不是 http(s) 链接`);
      }
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
        // D66：预置卡也带原文入口（`source.url` 是「看原文」唯一认的字段）
        source: { type: 'preset', createdAt: nowMs, ...(typeof c.url === 'string' && c.url.length > 0 ? { url: c.url } : {}) },
        srs: createInitialSRS(nowMs),
        tags: Array.isArray(c.tags) ? [...c.tags] : [],
        // 与生成卡同一套消毒：去空白、去掉与答案相同的、去重、按上限截断
        ...(sanitizeChoices(c.choices, c.back).length > 0
          ? { choices: sanitizeChoices(c.choices, c.back) }
          : {}),
      });
    }
  }
  return { decks, cards };
}

/**
 * 增量补装**新增的预置领域**（D66）。
 *
 * ## 为什么需要它
 * 预置内容只在**空库首次启动**时灌入（`installPresetContent` 的唯一条件）。所以"往内容文件里加一个新领域"
 * 对已有存档**完全不生效** —— 玩家会问"你说的 AI 卡组在哪"。这个函数补的就是这一步。
 *
 * ## 三条纪律
 * 1. **只补没见过的领域**，且**只补一次**：靠设备本地的"已送过"记录（`offered` 由调用方传入/写回）。
 *    不这样做，玩家删掉某个预置域之后每次启动又会长回来 —— 那比不补还烦人。
 * 2. **只补不删**：不动玩家已有的领域与卡，也不覆盖任何字段。
 * 3. **空库不插手**：库是空的时候交给 `installPresetContent`（它有"整份灌装"的语义）。
 */
export async function installMissingPresetDecks(
  coord: Coordinator,
  content: PresetContent,
  nowMs: number,
  offered: readonly string[] = [],
): Promise<{ readonly installed: string[]; readonly skipped: string[] }> {
  const decks = Array.isArray(coord.snapshot().decks) ? coord.snapshot().decks : [];
  const cards = Array.isArray(coord.snapshot().cards) ? coord.snapshot().cards : [];
  if (decks.length === 0 && cards.length === 0) return { installed: [], skipped: [] }; // 空库交给首灌
  const have = new Set(decks.map((d) => d?.id));
  const offeredSet = new Set(offered);
  const missing = (content?.decks ?? []).filter(
    (d) => typeof d?.id === 'string' && !have.has(d.id) && !offeredSet.has(d.id),
  );
  const skipped = (content?.decks ?? [])
    .filter((d) => typeof d?.id === 'string' && !have.has(d.id) && offeredSet.has(d.id))
    .map((d) => d.id);
  if (missing.length === 0) return { installed: [], skipped };

  const entities = buildPresetEntities({ decks: missing }, nowMs);
  await coord.mutate((save) => {
    save.decks = [...save.decks, ...entities.decks];
    save.cards = [...save.cards, ...entities.cards];
  });
  return { installed: missing.map((d) => d.id), skipped };
}

/**
 * 给**已经装过**预置内容的存档补上干扰项（D56）。
 *
 * 为什么必须有这一步：预置内容只在**空库首次启动**时灌入，所以"把 choices 写进内容文件"
 * 只对新玩家生效；老玩家的 30 张预置卡永远停在"没有选项"的状态，于是战斗只能吃池子
 * —— 正是现场那个"生活常识的题里出现 AI 选项"的另一半原因。
 *
 * 三条纪律：
 * 1. **只补缺**：只在"这张卡是预置卡、现在没有 choices、内容文件里给了"时才写
 *    （玩家自己重出过的选项一律不动 —— 他的编辑永远优先）；
 * 2. **没有要补的就完全不碰存档**（零写入：免得每次启动都刷 savedAt）；
 * 3. **一次 mutate 批量完成**（30 张卡一次落盘，不是 30 次写）。
 *
 * 幂等：跑第二遍时所有预置卡都已有选项 ⇒ `filled === 0` 且不写。
 */
export async function backfillPresetChoices(
  coord: Coordinator,
  content: PresetContent,
): Promise<{ readonly filled: number }> {
  const byId = new Map<string, string[]>();
  for (const deck of content?.decks ?? []) {
    for (const card of deck?.cards ?? []) {
      const cleaned = sanitizeChoices(card?.choices, card?.back ?? '');
      if (cleaned.length > 0) byId.set(card.id, cleaned);
    }
  }
  if (byId.size === 0) return { filled: 0 };

  const missing = (coord.snapshot().cards ?? []).filter(
    (c) => c && c.source?.type === 'preset' && (c.choices ?? []).length === 0 && byId.has(c.id),
  );
  if (missing.length === 0) return { filled: 0 }; // 零写入

  await coord.mutate((s) => {
    for (const c of s.cards) {
      if (!c || c.source?.type !== 'preset' || (c.choices ?? []).length > 0) continue;
      const fill = byId.get(c.id);
      if (fill !== undefined) c.choices = [...fill];
    }
  });
  return { filled: missing.length };
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
