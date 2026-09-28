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
import { createInitialSRS } from '@core/sm2';
import type { Coordinator } from './persist';

/** 加卡的入参（front/back/deckId 来自表单；id/nowMs 来自装配层注入）。 */
export interface AddCardInput {
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

/** 空白串（含全角空格）判定：只判"没有可见内容"，不做任何规范化改写。 */
function isBlank(s: unknown): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

function findDeck(save: { decks: readonly Deck[] }, deckId: string): Deck | null {
  for (const d of save.decks) if (d && d.id === deckId) return d;
  return null;
}

/**
 * 往卡库加一张手写卡。成功补 `{type:'manual'}` 溯源（PRD §6.2 的来源字段）。
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
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_LIBRARY_REASON };

  const save = coord.snapshot();
  const existing = Array.isArray(save.cards) ? save.cards : [];
  if (findDeck(save, input.deckId) === null) {
    return { ok: false, reason: '这个领域已经不在了——刷新一下卡组页再试。' };
  }
  if (existing.some((c) => c && c.id === input.id)) {
    return { ok: false, reason: '加卡失败：卡片编号和已有的一张撞了。' };
  }

  const card: Card = {
    id: input.id,
    deckId: input.deckId,
    front: input.front,
    back: input.back,
    source: { type: 'manual', createdAt: input.nowMs },
    srs: createInitialSRS(input.nowMs, input.sm2Params),
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
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
