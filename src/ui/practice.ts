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
import { showToast } from './toast';

/** 练功池上限（与 bossFightParams 的 min(卡数,25) 同口径）。 */
export const DRILL_POOL_MAX = 25;

export interface PracticeDeps {
  /** 返回主菜单。 */
  readonly onNav?: (target: 'menu') => void;
  /** 「练这一域」：把勾选的卡交给宿主开局（宿主接 startFight({mode:'drill', cardIds})）。 */
  readonly onDrill?: (input: { readonly cardIds: readonly string[] }) => void;
  /** 「今日新知识额度」那一行（Plan 8 用；缺省则不显示）。 */
  readonly quotaText?: () => string;
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
  /** 当前打开的领域（null = 还停在领域列表）。 */
  let openDeckId: string | null = null;
  /** 搜索词（大小写不敏感，匹配正面或背面）。 */
  let query = '';
  /** 勾选集合（卡 id）。 */
  const picked = new Set<string>();
  /** 默认勾选时因池上限被截掉的张数（屏上如实说明）。 */
  let cappedOut = 0;

  /* ------------------------------------------------------------ DOM 外壳 */
  const backBtn = h('button', { 'data-ui': 'back', class: 'back-btn', type: 'button' }, '返回') as HTMLButtonElement;
  backBtn.addEventListener('click', () => {
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
  const picksEl = h('p', { 'data-ui': 'practice-picks', class: 'field-hint' });
  const capHintEl = h('p', { 'data-ui': 'practice-cap-hint', class: 'field-hint', hidden: true });
  const drillBtn = h(
    'button',
    { 'data-ui': 'drill-start', class: 'drill-start', type: 'button' },
    '练这一域',
  ) as HTMLButtonElement;
  drillBtn.addEventListener('click', () => {
    if (destroyed || typeof deps.onDrill !== 'function' || picked.size === 0) return;
    // 顺序稳定：按当前列表顺序交出（玩家看到的顺序 = 出题顺序）
    const ids = currentDeckCards(ctrl.snapshot())
      .map((c) => c.id)
      .filter((id) => picked.has(id));
    deps.onDrill({ cardIds: ids });
  });
  const cardsEl = h('section', { 'data-ui': 'practice-deck-view', class: 'practice-deck-view', hidden: true }, [
    searchInput,
    cardListEl,
    picksEl,
    capHintEl,
    drillBtn,
  ]);
  const emptyEl = h(
    'p',
    { 'data-ui': 'practice-empty', class: 'field-hint', hidden: true },
    '卡库里还没有卡片。先去卡组页加几张，或者在计划里的「采新卡」里采一批。',
  );

  const screen = h('div', { 'data-ui': 'practice-screen', class: 'practice-screen' }, [
    headerEl,
    quotaEl,
    emptyEl,
    deckListEl,
    cardsEl,
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

  /** 打开一个领域：重置勾选为"该练的"，并在超上限时如实记账。 */
  function openDeck(deckId: string, snap: ControllerSnapshot): void {
    openDeckId = deckId;
    query = '';
    searchInput.value = '';
    picked.clear();
    cappedOut = 0;
    const nowMs = now();
    const wanted = deckCards(snap, deckId).filter((c) => shouldPickByDefault(c, nowMs));
    // 最紧迫优先：due 小的在前（新卡 due=0，天然排最前）
    const ordered = [...wanted].sort((a, b) => (a.srs?.due ?? 0) - (b.srs?.due ?? 0));
    for (const c of ordered) {
      if (picked.size >= DRILL_POOL_MAX) {
        cappedOut += 1;
        continue;
      }
      picked.add(c.id);
    }
  }

  function renderDecks(snap: ControllerSnapshot): void {
    const decks = Array.isArray(snap.save?.decks) ? snap.save.decks : [];
    const nowMs = now();
    deckListEl.replaceChildren();
    for (const deck of decks) {
      if (!deck || typeof deck.id !== 'string') continue;
      const stats = deckStats(deckCards(snap, deck.id), nowMs);
      const row = h(
        'button',
        { 'data-deck': deck.id, class: 'practice-deck', type: 'button' },
        `${deck.name} · ${stats.total} 张 · 待复习 ${stats.due} · 已掌握 ${stats.mastered}`,
      ) as HTMLButtonElement;
      row.addEventListener('click', () => {
        openDeck(deck.id, ctrl.snapshot());
        render(ctrl.snapshot());
      });
      deckListEl.appendChild(row);
    }
  }

  function renderCards(snap: ControllerSnapshot): void {
    const cards = currentDeckCards(snap);
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
      check.checked = picked.has(card.id);
      check.addEventListener('change', () => {
        if (check.checked) {
          if (picked.size >= DRILL_POOL_MAX) {
            check.checked = false;
            toast(`一次最多练 ${DRILL_POOL_MAX} 张，先取消几张再勾。`);
            return;
          }
          picked.add(card.id);
        } else {
          picked.delete(card.id);
        }
        render(ctrl.snapshot());
      });
      const row = h('div', { 'data-card-row': card.id, class: 'practice-card' }, [
        check,
        h('span', { class: 'practice-front' }, card.front ?? ''),
        h('span', { class: 'practice-back' }, card.back ?? ''),
        h(
          'span',
          { class: 'practice-meta' },
          `${stabilityLabel(card)} · ${sourceLabel(card.source)} · ${dueLabel(card, tzOffsetMin)}`,
        ),
      ]);
      cardListEl.appendChild(row);
    }
    const total = cards.length;
    picksEl.textContent = `已选 ${picked.size} / ${DRILL_POOL_MAX}（这个领域共 ${total} 张）`;
    capHintEl.textContent =
      cappedOut > 0 ? `还有 ${cappedOut} 张该练的没进池（一次最多 ${DRILL_POOL_MAX} 张），练完再来。` : '';
    setHidden(capHintEl, cappedOut === 0);
    drillBtn.disabled = picked.size === 0 || typeof deps.onDrill !== 'function';
    drillBtn.textContent = picked.size === 0 ? '练这一域（先勾几张）' : `练这一域（${picked.size} 张）`;
  }

  function render(snap: ControllerSnapshot): void {
    const cards = Array.isArray(snap.save?.cards) ? snap.save.cards : [];
    setHidden(emptyEl, cards.length > 0);
    setHidden(cardsEl, openDeckId === null);
    setHidden(deckListEl, openDeckId !== null);
    if (typeof deps.quotaText === 'function') {
      quotaEl.textContent = deps.quotaText();
      setHidden(quotaEl, false);
    } else {
      setHidden(quotaEl, true);
    }
    renderDecks(snap);
    if (openDeckId !== null) renderCards(snap);
  }

  const unsubscribe = ctrl.subscribe((snap) => {
    if (!destroyed) render(snap);
  });
  render(ctrl.snapshot());

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    if (toastOff) {
      toastOff();
      toastOff = null;
    }
    screen.remove();
  }

  return { unmount: destroy };
}
