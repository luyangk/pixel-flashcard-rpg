/**
 * library.ts —— Plan 4 · T7：卡库编辑的**写口**（手写加卡 / 新建领域）。
 *
 * ## 为什么单独成文件（R-T7-p4-a）
 * Plan 4 的单向数据流是"视图只渲染 + 意图回传"，但 `GameIntent` 里**没有**加卡/建领域
 * 这一类面：控制器的职责是**会话编排**（开局/作答/结算/回菜单），卡库编辑不属于一局会话。
 * 把 `coord.mutate` 直接写进 `src/ui/decks.ts` 会让视图持有写权限（今天能加卡，明天就能
 * 改 SRS），所以在此立一个 app 层写口：UI 只调本模块的窄函数，落库仍是 `coord.mutate`。
 *
 * ## 与 persist 的分工
 * - 引用闭合（cards[].deckId 必须指向存在的 deck）由 persist 的 `ensureDefaultDeck` 兜底，
 *   但那是**首张卡落地前的空库**兜底；玩家在 UI 上选了一个不存在的 deckId 是**调用方的
 *   错误**，本模块 fail-closed 拒绝，不靠兜底悄悄改写成别的领域。
 * - 时间与 id 一律注入（`nowMs` / `id`）：core/app 不读钟、不生成随机身份，
 *   落盘值与测试期望因此逐字可控。
 *
 * ## 只读态：先给原因，再靠闩锁兜底
 * `coord.readOnly()` 为真时写口**不抛异常**，而是回一条可上屏的大白话——只读会话里
 * 玩家的动作都在 UI 上，抛异常只能被 catch 成同一句 toast，不如让返回值直接表达。
 * 闩锁本身仍是权威：即便有人绕过这道判断，`coord.mutate` 也会抛 SaveReadOnlyError
 * （LB#3 钉住"不写盘"这个真正要紧的事实）。
 *
 * ## 消毒口径（宁可不加，不加脏值）
 * 落盘自检（validateSave）会整包拒含脏值的存档——一张 front 为空的卡能让**所有**改动
 * 一起写不进存储。故本模块在 mutate 之前就把空串/空白串/未知领域/重复 id 挡掉，
 * 把"用户输入不合法"变成可上屏的大白话，而不是一次静默的落盘失败。
 */
import type { Card, Deck } from '@core/types';
import type { Sm2Params } from '@core/types';
import { sanitizeChoices } from '@core/llmParse';
import { MAX_TIME_MS } from '@core/saveMigrate';
import { createInitialSRS } from '@core/sm2';
import type { Coordinator } from './persist';

/** 加卡的入参（front/back/deckId 来自表单；id/nowMs 来自装配层注入）。 */
export interface AddCardInput {
  /**
   * 干扰项（Plan 6 · D41）：模型在生成这张卡时一并产出。经 `core/llmParse.sanitizeChoices`
   * 净化后落盘；**净化后为空则不写该字段**（缺席 = 没有 AI 干扰项，由 core/choices 回落
   * "同领域其他卡的背面"）。只允许手工/辅建这两条路带它，SRS 与 UI 都不产生干扰项。
   */
  readonly choices?: readonly string[];
  readonly front: string;
  readonly back: string;
  readonly deckId: string;
  readonly tags?: readonly string[];
  /** 卡 id（装配层注入，须在现有卡中等价唯一）。 */
  readonly id: string;
  /** 建卡时刻（写入 srs.due 与 source.createdAt）。 */
  readonly nowMs: number;
  /** SM-2 参数（缺省用 core 的规范默认）。 */
  readonly sm2Params?: Sm2Params;
  /**
   * 溯源类型（Plan 5 · T4）：`'llm'` = 模型辅建后经玩家确认入库；缺省 `'manual'`。
   * 域与 `saveMigrate.SOURCE_TYPES` 一致（那边已含 `'llm'`）；域外值一律回落 `'manual'`
   * ——写口不做"猜意图"的事，脏值也不能让落盘自检整包拒。
   */
  readonly sourceType?: 'manual' | 'llm' | 'hotspot';
  /** 来源链接（Plan 8 · D43：`sourceType: 'hotspot'` 时存进 `SourceInfo.url` 供溯源）。 */
  readonly url?: string;
}

/** 建领域的入参。 */
export interface AddDeckInput {
  readonly name: string;
  readonly id: string;
  /** 预置领域（种子内容）与玩家自建的区别；UI 手建恒 false。 */
  readonly isPreset?: boolean;
}

/** 只读态的统一文案（与 persist.READ_ONLY_REASON 同义，此处按"加卡/建领域"的口吻说）。 */
const READ_ONLY_LIBRARY_REASON = '存档没法读取（只读保护中）：现在改不了卡库，你的存档原样保留。';

/** 写口统一的失败面：reason 是可直接上屏的大白话。 */
export type LibraryResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * 落盘自检的**时间域**与 `saveMigrate.requireTimestamp` 同界（有限且 |v| ≤ MAX_TIME_MS）。
 * 为什么必须在这里先挡（T7 评审判 I-2）：`srs.due` / `source.createdAt` 都会把这个值
 * 写进权威档，而落盘自检是**整包**拒的——一个 NaN 会让 dirty 永久为真、此后**任何**
 * 改动都写不进存储，而 UI 却刚提示过"已加入卡库"。同仓先例：transfer.exportBackupText
 * 对"设备时间读数异常"专门设闸。
 */
function isUsableTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS;
}

/** 标签消毒：只接受字符串数组（validateSave 的 tags 是 string[]，非字符串会整包拒）。 */
function usableTags(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') return null;
    out.push(t);
  }
  return out;
}

/** 空白串（含全角空格）判定：只判"没有可见内容"，不做任何规范化改写。 */
function isBlank(s: unknown): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

function findDeck(save: { decks: readonly Deck[] }, deckId: string): Deck | null {
  for (const d of save.decks) if (d && d.id === deckId) return d;
  return null;
}

/**
 * 往卡库加一张手写卡。成功补 `{type:'manual'}` 溯源（PRD §6.2 的来源字段）；
 * `input.sourceType === 'llm'` 时改落 `{type:'llm'}`（Plan 5 · T4：模型辅建后经玩家确认的那条路）。
 *
 * 拒绝面（全部返回 `{ok:false, reason}`，**不触存储**）：
 * - front / back 空白；
 * - deckId 不在现有领域里（引用闭合，见文件头）；
 * - id 空白，或与现有卡重复（重复 id 会让 validateSave 整包拒）。
 *
 * 注：本函数**不**写 `deck.purifiedAt`、不碰任何 SRS 计数——加卡就是加卡。
 */
export async function addCard(coord: Coordinator, input: AddCardInput): Promise<LibraryResult<Card>> {
  if (!input || typeof input !== 'object') return { ok: false, reason: '加卡失败：没有拿到卡片内容。' };
  if (isBlank(input.front)) return { ok: false, reason: '正面不能是空的——写一句问题或提示吧。' };
  if (isBlank(input.back)) return { ok: false, reason: '背面不能是空的——写一句答案吧。' };
  if (isBlank(input.id)) return { ok: false, reason: '加卡失败：卡片编号缺失。' };
  if (isBlank(input.deckId)) return { ok: false, reason: '先选一个领域，再把这题加进去。' };
  if (!isUsableTime(input.nowMs)) {
    return { ok: false, reason: '加卡失败：设备时间读数异常，这张卡没有写进存档。' };
  }
  const tags = usableTags(input.tags);
  if (tags === null) return { ok: false, reason: '加卡失败：标签只能是一串文字。' };
  const back = input.back.trim();
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const save = coord.snapshot();
  const existing = Array.isArray(save.cards) ? save.cards : [];
  if (findDeck(save, input.deckId) === null) {
    return { ok: false, reason: '这个领域已经不在了——刷新一下卡组页再试。' };
  }
  if (existing.some((c) => c && c.id === input.id)) {
    return { ok: false, reason: '加卡失败：卡片编号和已有的一张撞了。' };
  }

  const sourceType: 'manual' | 'llm' | 'hotspot' =
    input.sourceType === 'llm' ? 'llm' : input.sourceType === 'hotspot' ? 'hotspot' : 'manual';
  // 链接只收 http(s)：与待读清单/抓取口同一口径（`javascript:` 之类永远不该进溯源字段）
  const sourceUrl =
    typeof input.url === 'string' && /^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : undefined;
  // 干扰项：净化后为空 ⇒ 不写字段（与 Card.choices 的"可选位、不补默认"同一口径）
  const choices = sanitizeChoices(input.choices, back);
  const card: Card = {
    id: input.id,
    deckId: input.deckId,
    front: input.front,
    back: input.back,
    source: { type: sourceType, createdAt: input.nowMs, ...(sourceUrl === undefined ? {} : { url: sourceUrl }) },
    srs: createInitialSRS(input.nowMs, input.sm2Params),
    tags,
    // 只在净化后有内容时才带这个字段：`choices: []` 与"没有干扰项"是两回事，
    // 而 validateSave 对在场值严检、缺席放行 —— 少写一个空数组，存档更干净。
    ...(choices.length > 0 ? { choices } : {}),
  };

  // 走到这里说明判断放行了；闩锁仍会在 mutate 内再拒一次（fail-closed 的第二道）。
  await coord.mutate((s) => {
    if (!Array.isArray(s.cards)) s.cards = [];
    s.cards.push(card);
  });
  return { ok: true, value: card };
}

/**
 * 新建一个领域（卡组即知识领域）。名字空白或 id 撞车一律拒绝。
 * 自建领域天然获得 Boss 资格（PRD §6.2/B 决策）——那由 bossCheck 依卡计数派生，
 * 本函数不预写任何 Boss 标记。
 */
export async function addDeck(coord: Coordinator, input: AddDeckInput): Promise<LibraryResult<Deck>> {
  if (!input || typeof input !== 'object') return { ok: false, reason: '新建领域失败：没有拿到名字。' };
  if (isBlank(input.name)) return { ok: false, reason: '领域要有名字——比如「唐诗」「英语词根」。' };
  if (isBlank(input.id)) return { ok: false, reason: '新建领域失败：领域编号缺失。' };
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const save = coord.snapshot();
  const decks = Array.isArray(save.decks) ? save.decks : [];
  if (decks.some((d) => d && (d.id === input.id || d.name === input.name))) {
    return { ok: false, reason: '已经有同名（或同编号）的领域了。' };
  }

  const deck: Deck = { id: input.id, name: input.name, isPreset: input.isPreset === true };
  await coord.mutate((s) => {
    if (!Array.isArray(s.decks)) s.decks = [];
    s.decks.push(deck);
  });
  return { ok: true, value: deck };
}

/* --------------------------------------------------------------------------
 * Plan 5 追加：领域与卡片的**改名 / 删除**（用户实测反馈："新建领域后不知道如何删除或修改"）
 * -------------------------------------------------------------------------- */

/** 领域名上限（与称号同口径的短名称，太长在屏上会折行） */
export const DECK_NAME_MAX = 30;

/** 按码点计长与截断（与 core/llmParse 同一口径；禁止劈开代理对）。 */
function points(text: string): string[] {
  return [...text];
}

/**
 * 重命名领域。
 *
 * 拒绝面（都不触存储）：领域不存在 / 名字空白 / 名字超过 30 字 / 与**其它**领域重名。
 * 允许改成原名（同值不重写，写放大纪律）——玩家点两次不该推开一次落盘窗。
 */
export async function renameDeck(
  coord: Coordinator,
  input: { readonly deckId: string; readonly name: string },
): Promise<LibraryResult<Deck>> {
  const deckId = input?.deckId;
  if (isBlank(deckId)) return { ok: false, reason: '重命名失败：没有指定领域。' };
  const raw = typeof input?.name === 'string' ? input.name.trim() : '';
  if (raw.length === 0) return { ok: false, reason: '领域要有名字——比如「唐诗」「英语词根」。' };
  if (points(raw).length > DECK_NAME_MAX) {
    return { ok: false, reason: `领域名最多 ${DECK_NAME_MAX} 个字，短一点更清楚。` };
  }
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const save = coord.snapshot();
  const deck = findDeck(save, deckId);
  if (deck === null) return { ok: false, reason: '这个领域已经不在了——刷新一下卡组页再试。' };
  if (deck.name === raw) return { ok: true, value: deck }; // 同值不重写
  const dup = (Array.isArray(save.decks) ? save.decks : []).some((d) => d && d.id !== deckId && d.name === raw);
  if (dup) return { ok: false, reason: '已经有同名领域了——换个名字吧。' };

  await coord.mutate((s) => {
    const target = findDeck(s, deckId);
    if (target) target.name = raw;
  });
  return { ok: true, value: { ...deck, name: raw } };
}

/**
 * 删除领域。**连同该领域的所有卡一起删**（一次 mutate 内完成）。
 *
 * 为什么必须一起删：`validateSave` 要求 `cards[].deckId` 引用闭合，只删领域会让整包自检失败
 * （落盘静默失败，玩家会以为删掉了）。返回被删掉的卡数，供 UI 如实告知"这一下删掉了多少"。
 * 卡片连带的 SRS 进度随之消失——所以 UI 侧必须两步确认，这是不可逆操作。
 */
export async function removeDeck(
  coord: Coordinator,
  input: { readonly deckId: string },
): Promise<LibraryResult<{ readonly cards: number }>> {
  const deckId = input?.deckId;
  if (isBlank(deckId)) return { ok: false, reason: '删除失败：没有指定领域。' };
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const save = coord.snapshot();
  if (findDeck(save, deckId) === null) {
    return { ok: false, reason: '这个领域已经不在了——刷新一下卡组页再试。' };
  }
  const doomed = (Array.isArray(save.cards) ? save.cards : []).filter((c) => c && c.deckId === deckId).length;

  await coord.mutate((s) => {
    s.decks = (Array.isArray(s.decks) ? s.decks : []).filter((d) => d && d.id !== deckId);
    s.cards = (Array.isArray(s.cards) ? s.cards : []).filter((c) => c && c.deckId !== deckId);
  });
  return { ok: true, value: { cards: doomed } };
}

/**
 * 就地改正一张卡的正/背面（Plan 8 · T7）。
 *
 * 为什么需要：`addCard` 只能加、`removeCard` 只能删 —— "看到错字只能删了重加"是本功能
 * 最别扭的地方（用户实测反馈里点到过"不知道如何修改"）。写入闸门与 `addCard` 同款：
 * 空值/卡不存在/只读态一律可上屏拒绝；**同值不重写**（写放大纪律）。
 *
 * 一处容易漏的连带：**新背面若撞上某条 `choices`（干扰项），那条必须剔掉** ——
 * 否则将来的选择题会出现"干扰项就是正确答案"。其余 `choices` 原样保留。
 * 改的是**文案**，所以 SRS 与来源一律不动。
 */
export async function updateCard(
  coord: Coordinator,
  input: { readonly cardId: string; readonly front: string; readonly back: string },
): Promise<LibraryResult<Card>> {
  if (!input || typeof input !== 'object') return { ok: false, reason: '改卡失败：没有拿到内容。' };
  if (isBlank(input.cardId)) return { ok: false, reason: '改卡失败：没有指定是哪一张。' };
  if (isBlank(input.front)) return { ok: false, reason: '正面不能是空的——写一句问题或提示吧。' };
  if (isBlank(input.back)) return { ok: false, reason: '背面不能是空的——写一句答案吧。' };
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const front = input.front.trim();
  const back = input.back.trim();
  const existing = coord.snapshot().cards.find((c) => c && c.id === input.cardId);
  if (existing === undefined) {
    return { ok: false, reason: '这张卡已经不在了——刷新一下再看看。' };
  }
  if (existing.front === front && existing.back === back) {
    return { ok: true, value: existing }; // 同值不重写
  }

  const keptChoices = (existing.choices ?? []).filter((c) => c !== back);
  const next: Card = {
    ...existing,
    front,
    back,
    ...(keptChoices.length > 0 ? { choices: keptChoices } : {}),
  };
  // 干扰项被剔空 ⇒ 连字段一起去掉（"没有干扰项"与"空数组"是两回事，与 addCard 同口径）
  if (keptChoices.length === 0) delete next.choices;

  await coord.mutate((s) => {
    const idx = s.cards.findIndex((c) => c && c.id === input.cardId);
    if (idx >= 0) s.cards[idx] = next;
  });
  return { ok: true, value: next };
}

/** 删除单张卡（学习过程中发现某张卡写得不好时用）。 */
export async function removeCard(
  coord: Coordinator,
  input: { readonly cardId: string },
): Promise<LibraryResult<{ readonly id: string }>> {
  const cardId = input?.cardId;
  if (isBlank(cardId)) return { ok: false, reason: '删除失败：没有指定卡片。' };
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const save = coord.snapshot();
  const exists = (Array.isArray(save.cards) ? save.cards : []).some((c) => c && c.id === cardId);
  if (!exists) return { ok: false, reason: '这张卡已经不在了——刷新一下卡组页再试。' };

  await coord.mutate((s) => {
    s.cards = (Array.isArray(s.cards) ? s.cards : []).filter((c) => c && c.id !== cardId);
  });
  return { ok: true, value: { id: cardId } };
}
