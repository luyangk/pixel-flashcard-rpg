/**
 * practice.ts —— Plan 7 · T6：「练功」屏（看旧卡 → 勾选 → 练这一域）。
 *
 * ## 这一屏的定位
 * 卡组页是**编辑**（增删改），练功页是**看与练**：只读浏览 + 勾选 + 开局。计划 8 会往这里
 * 再加「采新卡」与「就地编辑」，所以本文件从一开始就按"分区挂载"写：`browse` 区可整块替换。
 *
 * ## 勾选口径（D46）
 * 默认勾**到期卡 + 新卡**——"该练的"就是这个口径（新卡 due=0，天然最紧迫）。池上限 25
 * （与备战屏/Boss 练习关同口径）；超出时**按最紧迫优先**截取并如实说明"还有 N 张没进池"，
 * 绝不静默丢。一张都没勾 ⇒ 按钮禁用（不让玩家开一场空仗）。
 *
 * ## 只读纪律（Plan 8 会加一个就地改内容的写口，Plan 7 这里一个写口都没有）
 * 本屏不 import persist、不 import library：所有"开局"都走注入的 `onDrill`。
 */

import { localDayString } from '@core/reviewLedger';
import type { Card, SourceInfo } from '@core/types';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { h, setHidden } from './dom';
import { mountPracticeCollect, type CollectDeps } from './practiceCollect';
import { showToast } from './toast';

/** 练功池上限（与 bossFightParams 的 min(卡数,25) 同口径）。 */
export const DRILL_POOL_MAX = 25;

export interface PracticeDeps {
  /** 返回主菜单。 */
  readonly onNav?: (target: 'menu') => void;
  /**
   * 初始分区（D49）。卡组页的「采新卡」入口要求"直接开在采新卡分区"；
   * 缺省 `'browse'`（从菜单进来就是看旧卡）。
   */
  readonly initialTab?: 'browse' | 'collect';
  /** 「练这一域」：把勾选的卡交给宿主开局（宿主接 startFight({mode:'drill', cardIds})）。 */
  readonly onDrill?: (input: { readonly cardIds: readonly string[] }) => void;
  /** 「今日新知识额度」那一行（Plan 8 用；缺省则不显示）。 */
  readonly quotaText?: () => string;
  /** 采新卡分区（Plan 8 · T6）：整块依赖面透传给 `mountPracticeCollect`。 */
  readonly collect?: Omit<CollectDeps, 'toastMs' | 'onQuotaChanged'>;
  /**
   * 就地改正一张卡的正/背面（Plan 8 · T7；宿主接 `app/library.updateCard`）。
   * 缺省 ⇒ 卡行不显示「改」入口（不显示点了没反应的按钮）。
   */
  readonly updateCard?: (input: {
    readonly cardId: string;
    readonly front: string;
    readonly back: string;
  }) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** 到期判定的时钟（缺省 0：一切都是"未到期"，测试要确定性就注入）。 */
  readonly now?: () => number;
  readonly tzOffsetMin?: number;
  readonly toastMs?: number;
}

export interface PracticeHandle {
  unmount(): void;
}

/** 来源标签：把 SourceInfo.type 翻成大白话（练功屏要给"这张卡哪来的"一个可读答案）。 */
export function sourceLabel(source: SourceInfo | undefined): string {
  const type = source?.type;
  switch (type) {
    case 'preset':
      return '预置';
    case 'manual':
      return '手写';
    case 'llm':
      return 'AI 辅建';
    case 'hotspot':
      return '采集';
    case 'domain':
      return '领域';
    default:
      return '未标注';
  }
}

/** 稳定度 → 大白话（与战斗屏的「初识/复习」口径一致）。 */
function stabilityLabel(card: Card): string {
  switch (card?.srs?.stability) {
    case 'new':
      return '初识';
    case 'learning':
      return '学习中';
    case 'review':
      return '复习';
    case 'mastered':
      return '已掌握';
    default:
      return '未知';
  }
}

/** 一张卡"该不该默认勾上"：到期（due ≤ now）或新卡。 */
export function shouldPickByDefault(card: Card, nowMs: number): boolean {
  if (card?.srs?.stability === 'new') return true;
  const due = card?.srs?.due;
  return typeof due === 'number' && Number.isFinite(due) && due <= nowMs;
}

/** 到期展示：本地日期；未到期/无值给「—」。 */
function dueLabel(card: Card, tzOffsetMin: number): string {
  const due = card?.srs?.due;
  if (typeof due !== 'number' || !Number.isFinite(due) || due <= 0) return '现在';
  return localDayString(due, tzOffsetMin);
}

export function mountPractice(root: HTMLElement, ctrl: GameController, deps: PracticeDeps = {}): PracticeHandle {
  if (!root || !ctrl) throw new Error('mount-practice: root/controller required');
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const tzOffsetMin = typeof deps.tzOffsetMin === 'number' && Number.isFinite(deps.tzOffsetMin) ? deps.tzOffsetMin : 0;

  let destroyed = false;
  let toastOff: (() => void) | null = null;
  /** 当前正在浏览的领域（null = 还停在领域列表）。 */
  let openDeckId: string | null = null;
  /**
   * **本次练功已纳入的领域**（按打开顺序，D50 多领域合练）。
   *
   * 为什么需要它：领域行要标"这个域在本局里"，以及"打开一个领域就把该练的纳入本次"这条口径
   * 需要一个明确的成员集合（否则"哪些卡该自动补进来"无从判断）。
   */
  let openedDeckIds: string[] = [];
  /** 玩家**显式**勾的卡（D50）。显式勾的卡永远进池（优先占位）。 */
  const picked = new Set<string>();
  /**
   * 玩家**显式取消**的卡（D50）。
   *
   * 为什么必须单独记：自动补齐（到期+新卡）每次渲染都会重算，若不记住"这张是他不要的"，
   * 玩家一取消、下一次渲染又被加回来 —— 那是会让人当场骂人的行为。
   */
  const dropped = new Set<string>();
  /** 搜索词（大小写不敏感，匹配正面或背面）。 */
  let query = '';
  /** 正在就地编辑的那张卡（Plan 8 · T7；null = 没有行处于编辑态）。 */
  let editingId: string | null = null;
  /**
   * 编辑草稿。**必须单独存**：每次渲染都会重建输入框，若 value 一律取自存档里的卡，
   * 那么"保存失败后重绘"会把玩家刚敲的字擦掉（PR#15 当场抓到）。
   */
  let editDraft: { cardId: string; front: string; back: string } | null = null;
  let savingEdit = false;

  /* ------------------------------------------------------------ DOM 外壳 */
  const backBtn = h('button', { 'data-ui': 'back', class: 'back-btn', type: 'button' }, '返回') as HTMLButtonElement;
  backBtn.addEventListener('click', () => {
    if (tab === 'collect') {
      setTab('browse');
      return;
    }
    if (openDeckId !== null) {
      // 在卡列表里 ⇒ 先回领域列表（两段式返回，别把玩家一步弹回主菜单）
      openDeckId = null;
      render(ctrl.snapshot());
      return;
    }
    deps.onNav?.('menu');
  });
  const quotaEl = h('p', { 'data-ui': 'practice-quota', class: 'field-hint', hidden: true });
  const titleEl = h('h2', { class: 'screen-title' }, '练功');
  const headerEl = h('header', { class: 'practice-header' }, [backBtn, titleEl]);

  const deckListEl = h('div', { 'data-ui': 'practice-decks', class: 'practice-decks' });
  const searchInput = h('input', {
    'data-ui': 'practice-search',
    class: 'practice-search',
    type: 'search',
    placeholder: '搜正面或背面…',
    autocomplete: 'off',
  }) as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    render(ctrl.snapshot());
  });
  const cardListEl = h('div', { 'data-ui': 'practice-cards', class: 'practice-cards' });
  /**
   * 卡列表顶部的**显式**换领域入口（D50，现场反馈："选领域后找不到后退的按钮"）。
   *
   * 为什么不能只靠屏顶那个「返回」：它的文案是屏级的（"离开这一屏"），而这里玩家要的是
   * "换个领域接着勾"；长列表一滚，屏顶那一行还看不见。所以把**这一件事**摆到卡列表自己头上。
   */
  const deckSwitchBtn = h('button', { 'data-ui': 'deck-switch', class: 'deck-switch', type: 'button' }, '← 换领域') as HTMLButtonElement;
  deckSwitchBtn.addEventListener('click', () => {
    if (destroyed || openDeckId === null) return;
    openDeckId = null; // 勾选**保留**：多领域合练就靠这一点累加
    render(ctrl.snapshot());
  });
  const deckViewTitleEl = h('span', { 'data-ui': 'deck-view-title', class: 'deck-view-title' });
  const deckViewBarEl = h('div', { class: 'deck-view-bar' }, [deckSwitchBtn, deckViewTitleEl]);
  const picksEl = h('p', { 'data-ui': 'practice-picks', class: 'field-hint' });
  const capHintEl = h('p', { 'data-ui': 'practice-cap-hint', class: 'field-hint', hidden: true });
  const drillBtn = h(
    'button',
    { 'data-ui': 'drill-start', class: 'drill-start', type: 'button' },
    '开始练功',
  ) as HTMLButtonElement;
  drillBtn.addEventListener('click', () => {
    if (destroyed || typeof deps.onDrill !== 'function') return;
    // 顺序稳定：按卡库顺序交出（玩家看到的顺序 = 出题顺序），跨领域也是同一口径
    const ids = selection(ctrl.snapshot()).ids;
    if (ids.length === 0) return;
    deps.onDrill({ cardIds: ids });
  });
  const clearBtn = h('button', { 'data-ui': 'picks-clear', class: 'collect-btn', type: 'button' }, '清空勾选') as HTMLButtonElement;
  clearBtn.addEventListener('click', () => {
    if (destroyed) return;
    openedDeckIds = [];
    picked.clear();
    dropped.clear();
    openDeckId = null;
    render(ctrl.snapshot());
  });
  /**
   * 底部常驻的"本次练功"条（D50）：**领域列表上也在**。
   *
   * 为什么常驻：多领域合练的动作是"打开 A → 换领域 → 打开 B → 开练"，
   * 若开练按钮只在卡列表里，玩家每次都得多点一次才能开打，而且看不到"跨领域一共选了几张"。
   */
  const drillBarEl = h('div', { 'data-ui': 'drill-bar', class: 'drill-bar' }, [
    picksEl,
    capHintEl,
    h('div', { class: 'drill-bar-actions' }, [clearBtn, drillBtn]),
  ]);
  const emptyEl = h(
    'p',
    { 'data-ui': 'practice-empty', class: 'field-hint', hidden: true },
    '卡库里还没有卡片。先去卡组页加几张，或者在计划里的「采新卡」里采一批。',
  );
  const cardsEl = h('section', { 'data-ui': 'practice-deck-view', class: 'practice-deck-view', hidden: true }, [
    deckViewBarEl,
    searchInput,
    cardListEl,
  ]);

  /* ------------------------------------------------------------ 分区切换（看旧卡 / 采新卡） */
  let tab: 'browse' | 'collect' = deps.initialTab === 'collect' ? 'collect' : 'browse';
  const tabBrowseBtn = h('button', { 'data-ui': 'tab-browse', class: 'tab-btn', type: 'button' }, '看旧卡') as HTMLButtonElement;
  const tabCollectBtn = h('button', { 'data-ui': 'tab-collect', class: 'tab-btn', type: 'button' }, '采新卡') as HTMLButtonElement;
  const tabsEl = h('div', { 'data-ui': 'practice-tabs', class: 'tabs' }, [tabBrowseBtn, tabCollectBtn]);
  const collectHostEl = h('div', { 'data-ui': 'collect-host', class: 'collect-host', hidden: true });
  let collectHandle: { unmount(): void } | null = null;

  function setTab(next: 'browse' | 'collect'): void {
    if (tab === next) return;
    tab = next;
    render(ctrl.snapshot());
  }
  tabBrowseBtn.addEventListener('click', () => setTab('browse'));
  tabCollectBtn.addEventListener('click', () => setTab('collect'));

  const screen = h('div', { 'data-ui': 'practice-screen', class: 'practice-screen' }, [
    headerEl,
    quotaEl,
    tabsEl,
    emptyEl,
    deckListEl,
    cardsEl,
    drillBarEl,
    collectHostEl,
  ]);
  root.appendChild(screen);

  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  /** 某个领域的卡（按卡库顺序）。 */
  function deckCards(snap: ControllerSnapshot, deckId: string): Card[] {
    const cards = Array.isArray(snap.save?.cards) ? snap.save.cards : [];
    return cards.filter((c) => c && c.deckId === deckId);
  }

  function currentDeckCards(snap: ControllerSnapshot): Card[] {
    return openDeckId === null ? [] : deckCards(snap, openDeckId);
  }

  /** 领域名（卡列表标题用；找不到就给 null，调用方兜一句人话）。 */
  function deckName(snap: ControllerSnapshot, deckId: string | null): string | null {
    if (deckId === null) return null;
    const decks = Array.isArray(snap.save?.decks) ? snap.save.decks : [];
    const found = decks.find((d) => d && d.id === deckId);
    return found && typeof found.name === 'string' ? found.name : null;
  }

  /** 统计：卡数 / 待复习（到期）/ 已掌握。 */
  function deckStats(cards: readonly Card[], nowMs: number): { total: number; due: number; mastered: number } {
    let due = 0;
    let mastered = 0;
    for (const c of cards) {
      if (c?.srs?.due !== undefined && Number.isFinite(c.srs.due) && c.srs.due <= nowMs) due += 1;
      if (c?.srs?.stability === 'mastered') mastered += 1;
    }
    return { total: cards.length, due, mastered };
  }

  /**
   * 本次练功的**选择**（D50）：每次渲染派生，绝不缓存 —— 缓存过"已选"就会和存档脱钩。
   *
   * 口径（PRD D50，逐条）：
   * 1. 卡池 = **已纳入领域**（`openedDeckIds`）的卡；
   * 2. 玩家**显式勾选**的卡永远进池（优先占位，哪怕它未到期）；
   * 3. 其余按"该练的"（到期 + 新卡）自动补齐，但**显式取消过的**（`dropped`）不许加回来；
   * 4. 上限是**跨领域合计** `DRILL_POOL_MAX`，没进池的如实计 `cappedOut`（不静默丢）。
   */
  function selection(snap: ControllerSnapshot): {
    ids: string[];
    cappedOut: number;
    deckCount: number;
    perDeck: Map<string, number>;
  } {
    const nowMs = now();
    const cards = Array.isArray(snap.save?.cards) ? snap.save.cards : [];
    const opened = new Set(openedDeckIds);
    const pool = cards.filter((c) => c && typeof c.id === 'string' && opened.has(c.deckId));
    /** 池内顺序（= 玩家在卡列表里看到的顺序，也是出题顺序）。 */
    const order = new Map<string, number>();
    pool.forEach((c, i) => order.set(c.id, i + 1));
    const at = (c: Card): number => order.get(c.id) ?? 0;

    const explicit: Card[] = [];
    const auto: Card[] = [];
    for (const c of pool) {
      if (picked.has(c.id)) {
        explicit.push(c); // 玩家点过的一定进池
        continue;
      }
      if (shouldPickByDefault(c, nowMs) && !dropped.has(c.id)) auto.push(c);
    }
    // 最紧迫优先（due 小的在前；新卡 due=0 天然最前），同 due 保持列表顺序
    auto.sort((a, b) => (a.srs?.due ?? 0) - (b.srs?.due ?? 0) || at(a) - at(b));

    const chosen: Card[] = [...explicit];
    let cappedOut = 0;
    for (const c of auto) {
      if (chosen.length >= DRILL_POOL_MAX) {
        cappedOut += 1;
        continue;
      }
      chosen.push(c);
    }
    // 交给出题时按列表顺序（跨领域同一口径：玩家看到的顺序 = 出题顺序）
    chosen.sort((a, b) => at(a) - at(b));

    const ids = chosen.map((c) => c.id);
    const perDeck = new Map<string, number>();
    for (const c of chosen) perDeck.set(c.deckId, (perDeck.get(c.deckId) ?? 0) + 1);
    let deckCount = 0;
    for (const n of perDeck.values()) if (n > 0) deckCount += 1;
    return { ids, cappedOut, deckCount, perDeck };
  }

  /**
   * 打开一个领域 = **把它纳入本次练功**（D50）。已勾的卡**不清**：多领域合练就靠这一点累加。
   * 进池的具体票数由 `selection()` 派生（该练的自动补齐），这里只记"打开了哪些领域"。
   */
  function openDeck(deckId: string): void {
    if (!openedDeckIds.includes(deckId)) openedDeckIds = [...openedDeckIds, deckId];
    openDeckId = deckId;
    query = '';
    searchInput.value = '';
  }

  /** 把一个领域**整块移出本次练功**（D50）：它的勾选与"取消记录"一并清掉。 */
  function removeDeck(deckId: string): void {
    openedDeckIds = openedDeckIds.filter((id) => id !== deckId);
    const snap = ctrl.snapshot();
    const cards = Array.isArray(snap.save?.cards) ? snap.save.cards : [];
    for (const c of cards) {
      if (c && c.deckId === deckId) {
        picked.delete(c.id);
        dropped.delete(c.id);
      }
    }
    if (openDeckId === deckId) openDeckId = null;
    render(ctrl.snapshot());
  }

  function renderDecks(snap: ControllerSnapshot): void {
    const decks = Array.isArray(snap.save?.decks) ? snap.save.decks : [];
    const nowMs = now();
    const sel = selection(snap);
    deckListEl.replaceChildren();
    for (const deck of decks) {
      if (!deck || typeof deck.id !== 'string') continue;
      const stats = deckStats(deckCards(snap, deck.id), nowMs);
      const joined = openedDeckIds.includes(deck.id);
      const mine = sel.perDeck.get(deck.id) ?? 0;
      // 已纳入的领域把"本次已选 N 张"写在行上：玩家一眼看出这次都练了哪几域
      const label =
        `${deck.name} · ${stats.total} 张 · 待复习 ${stats.due} · 已掌握 ${stats.mastered}` +
        (joined ? ` · 本次已选 ${mine} 张` : '');
      const row = h('button', { 'data-deck': deck.id, class: 'practice-deck', type: 'button' }, label) as HTMLButtonElement;
      row.addEventListener('click', () => {
        openDeck(deck.id);
        render(ctrl.snapshot());
      });
      const wrap = h('div', { 'data-deck-row': deck.id, class: 'practice-deck-row' }, [row]);
      if (joined) {
        // 只出现在已纳入的行上：没纳入就没有"移出"这回事（不显示点了没反应的按钮）
        const rm = h(
          'button',
          { 'data-deck-remove': deck.id, class: 'deck-remove', type: 'button' },
          '移出本次',
        ) as HTMLButtonElement;
        rm.addEventListener('click', () => removeDeck(deck.id));
        wrap.appendChild(rm);
      }
      deckListEl.appendChild(wrap);
    }
  }

  function renderCards(snap: ControllerSnapshot): void {
    const cards = currentDeckCards(snap);
    // 勾选框的状态 = **本次选择**（不是"picked 集合"）：自动补齐的卡也必须显示为已勾
    const selected = new Set(selection(snap).ids);
    const q = query.trim().toLowerCase();
    const visible = q.length === 0
      ? cards
      : cards.filter(
          (c) => String(c.front ?? '').toLowerCase().includes(q) || String(c.back ?? '').toLowerCase().includes(q),
        );
    cardListEl.replaceChildren();
    for (const card of visible) {
      const check = h('input', {
        'data-pick': card.id,
        class: 'practice-pick',
        type: 'checkbox',
      }) as HTMLInputElement;
      check.checked = selected.has(card.id);
      check.addEventListener('change', () => {
        if (check.checked) {
          // 显式勾选优先占位，但仍受**合计**上限约束（多领域时按总数算）
          const cur = selection(ctrl.snapshot());
          if (!cur.ids.includes(card.id) && cur.ids.length >= DRILL_POOL_MAX) {
            check.checked = false;
            toast(`一次最多练 ${DRILL_POOL_MAX} 张（几个领域加在一起），先取消几张再勾。`);
            return;
          }
          dropped.delete(card.id);
          picked.add(card.id);
          // 在任何领域里勾卡，都算"这个领域进了本次"（否则清空勾选后再勾会不进池）
          if (!openedDeckIds.includes(card.deckId)) openedDeckIds = [...openedDeckIds, card.deckId];
        } else {
          picked.delete(card.id);
          dropped.add(card.id); // 记住"他不要这张"：自动补齐不许再加回来
        }
        render(ctrl.snapshot());
      });
      const meta = `${stabilityLabel(card)} · ${sourceLabel(card.source)} · ${dueLabel(card, tzOffsetMin)}`;
      const children: HTMLElement[] = [check];
      if (editingId === card.id) {
        // 就地编辑：正/背两个输入框 + 保存/取消。值取自**草稿**（不是存档），
        // 并且每次输入都回写草稿 —— 这样"保存失败后的重绘"不会把玩家敲的字擦掉。
        const draft =
          editDraft !== null && editDraft.cardId === card.id
            ? editDraft
            : { cardId: card.id, front: card.front ?? '', back: card.back ?? '' };
        editDraft = draft;
        const frontInput = h('input', {
          'data-card-edit-front': card.id,
          class: 'candidate-input',
          type: 'text',
          value: draft.front,
        }) as HTMLInputElement;
        frontInput.addEventListener('input', () => {
          if (editDraft !== null && editDraft.cardId === card.id) editDraft.front = frontInput.value;
        });
        const backInput = h('input', {
          'data-card-edit-back': card.id,
          class: 'candidate-input',
          type: 'text',
          value: draft.back,
        }) as HTMLInputElement;
        backInput.addEventListener('input', () => {
          if (editDraft !== null && editDraft.cardId === card.id) editDraft.back = backInput.value;
        });
        const saveBtn = h(
          'button',
          { 'data-card-edit-save': card.id, class: 'collect-btn', type: 'button' },
          savingEdit ? '保存中…' : '保存',
        ) as HTMLButtonElement;
        saveBtn.disabled = savingEdit;
        saveBtn.addEventListener('click', () => void onSaveEdit(card.id, frontInput.value, backInput.value));
        const cancelBtn = h(
          'button',
          { 'data-card-edit-cancel': card.id, class: 'collect-btn', type: 'button' },
          '取消',
        ) as HTMLButtonElement;
        cancelBtn.addEventListener('click', () => {
          if (savingEdit) return;
          editingId = null;
          editDraft = null;
          render(ctrl.snapshot());
        });
        children.push(frontInput, backInput, h('div', { class: 'collect-row' }, [saveBtn, cancelBtn]));
      } else {
        children.push(
          h('span', { class: 'practice-front' }, card.front ?? ''),
          h('span', { class: 'practice-back' }, card.back ?? ''),
          h('span', { class: 'practice-meta' }, meta),
        );
        if (typeof deps.updateCard === 'function') {
          const editBtn = h(
            'button',
            { 'data-ui': 'card-edit', 'data-card-edit': card.id, class: 'collect-btn', type: 'button' },
            '改',
          ) as HTMLButtonElement;
          editBtn.addEventListener('click', () => {
            editingId = card.id;
            editDraft = { cardId: card.id, front: card.front ?? '', back: card.back ?? '' };
            render(ctrl.snapshot());
          });
          children.push(editBtn);
        }
      }
      const row = h('div', { 'data-card-row': card.id, class: 'practice-card' }, children);
      cardListEl.appendChild(row);
    }
    // 底部那条"本次练功"的文案由 render() 统一算（领域列表上也要更新它）
    deckViewTitleEl.textContent = `${deckName(snap, openDeckId) ?? '这个领域'} · 共 ${cards.length} 张`;
  }

  /** 保存就地编辑：失败**保留输入**并如实提示（玩家刚敲的字不能丢）。 */
  async function onSaveEdit(cardId: string, front: string, back: string): Promise<void> {
    if (destroyed || savingEdit || typeof deps.updateCard !== 'function') return;
    // **先把当前输入记进草稿**：保存可能失败，而失败后要原样还给玩家他刚敲的字。
    // 只靠 input 事件同步草稿不够稳（程序化赋值/未来别的改动路径不会触发 input）。
    editDraft = { cardId, front, back };
    savingEdit = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.updateCard({ cardId, front, back });
      if (!destroyed && res.ok) {
        editingId = null;
        editDraft = null;
        toast('改好了。');
      } else if (!destroyed) {
        toast(res.reason ?? '没能保存这次修改。');
      }
    } catch (e) {
      if (!destroyed) toast(`没能保存：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      savingEdit = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  function render(snap: ControllerSnapshot): void {
    const cards = Array.isArray(snap.save?.cards) ? snap.save.cards : [];
    const collecting = tab === 'collect';    // 采新卡分区：进入时才挂（省一次清单读取），离开即拆（子分区自己订阅快照）
    if (collecting && collectHandle === null && deps.collect !== undefined && deps.collect !== null) {
      collectHandle = mountPracticeCollect(collectHostEl, ctrl, {
        ...deps.collect,
        toastMs: deps.toastMs,
        now: deps.now,
        // 额度在存档里，而写它的人是宿主：子分区生成/入库后回调这里重渲染额度行
        onQuotaChanged: () => render(ctrl.snapshot()),
      });
    }
    if (!collecting && collectHandle !== null) {
      collectHandle.unmount();
      collectHandle = null;
    }
    setHidden(collectHostEl, !collecting);
    // 注入口是个**对象**（一组依赖），不是函数 —— 首版按 typeof === 'function' 判，
    // 于是"注入了也永远不显示分区条"（PR#12 当场抓到）
    setHidden(tabsEl, deps.collect === undefined || deps.collect === null);
    tabBrowseBtn.setAttribute('aria-pressed', String(!collecting));
    tabCollectBtn.setAttribute('aria-pressed', String(collecting));
    setHidden(emptyEl, cards.length > 0 || collecting);
    setHidden(cardsEl, collecting || openDeckId === null);
    setHidden(deckListEl, collecting || openDeckId !== null);
    if (typeof deps.quotaText === 'function') {
      quotaEl.textContent = deps.quotaText();
      setHidden(quotaEl, false);
    } else {
      setHidden(quotaEl, true);
    }
    renderDecks(snap);
    if (openDeckId !== null) renderCards(snap);
    // 底部"本次练功"条：**领域列表上也在**（D50），且跨领域合计
    const sel = selection(snap);
    picksEl.textContent =
      `本次已选 ${sel.ids.length} / ${DRILL_POOL_MAX} 张` +
      (sel.deckCount > 0 ? ` · 来自 ${sel.deckCount} 个领域` : '（在一个领域里点开、或直接勾卡，都能加进来）');
    capHintEl.textContent =
      sel.cappedOut > 0
        ? `还有 ${sel.cappedOut} 张该练的没进池（一次最多 ${DRILL_POOL_MAX} 张，几个领域加在一起），练完再来。`
        : '';
    setHidden(capHintEl, sel.cappedOut === 0);
    setHidden(clearBtn, sel.ids.length === 0);
    drillBtn.disabled = sel.ids.length === 0 || typeof deps.onDrill !== 'function';
    drillBtn.textContent = sel.ids.length === 0 ? '开始练功（先勾几张）' : `开始练功（${sel.ids.length} 张）`;
    setHidden(drillBarEl, collecting || cards.length === 0);
  }

  const unsubscribe = ctrl.subscribe((snap) => {
    if (!destroyed) render(snap);
  });
  render(ctrl.snapshot());

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    collectHandle?.unmount();
    collectHandle = null;
    unsubscribe();
    if (toastOff) {
      toastOff();
      toastOff = null;
    }
    screen.remove();
  }

  return { unmount: destroy };
}
