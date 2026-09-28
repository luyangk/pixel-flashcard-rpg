/**
 * codex.ts —— Plan 4 · T8：藏书阁（一级页：净化条目 + 彩蛋 + 练习关 + 行记三幕）。
 *
 * 这是"玩家打过的仗变成了什么"的展示面，三块内容各有权威来源：
 * - **条目**：`save.decks` 里 `purifiedAt` 非空的领域，按净化时间**新者前**（老板最后看见
 *   自己刚净化的那一个在最上面）。称号取 `bossFlow.bossNameOf`（存档有就用，否则默认模板）。
 * - **彩蛋**：`assets/narrative/eggs.json`（预置 4 领域手写；LORE §5.4）。自建领域在 MVP
 *   期**没有**彩蛋——R-P4-a 把 LLM 全线移到 Plan 5，故这里如实显示「已净化」而不是编一段
 *   假冷知识（编造内容比留白更糟）。
 * - **行记**：三幕暗线（LORE §5.3），解锁判据是 `settings.story.arcSeen`（由净化数
 *   3/6/9 驱动，写口在 app/bossFlow.markArcSeen）。未解锁的幕显示"尚未显现"，
 *   已解锁的永久可回看（这是 LORE 明写的"永久可回看"）。
 *
 * 练习关（重战）：已净化领域的入口调 `deps.onPractice(deckId)`——**屏内不自己拼 startFight
 * 参数**（池子上限、难度档、单领域约束的口径在 app/bossFlow.bossFightParams，宿主一处装配）。
 */
import type { Card, Deck, SaveFile } from '@core/types';
import { localDayString } from '@core/reviewLedger';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { bossNameOf, purifiedCount } from '../app/bossFlow';
import { h, setHidden } from './dom';

/** 一幕暗线的展示数据（与 assets/narrative/arc.json 同形）。 */
export interface ArcAct {
  readonly act: number;
  readonly title: string;
  readonly art: string;
  readonly lines: readonly string[];
}

export interface CodexDeps {
  /** 返回主菜单。 */
  readonly onNav?: (target: 'menu') => void;
  /** 练习关（重战卷灵）：把 deckId 交给宿主去装配 startFight。 */
  readonly onPractice?: (deckId: string) => void;
  /** 彩蛋表：deckId → 文案（缺省 = 没有彩蛋，条目显示「已净化」）。 */
  readonly eggs?: Readonly<Record<string, string>>;
  /** 三幕数据（缺省 = 行记区只显示标题占位）。 */
  readonly acts?: readonly ArcAct[];
  /** 时区偏移（净化日期显示用；日期本体取 deck.purifiedAt，故不需要时钟）。 */
  readonly tzOffsetMin?: number;
}

export interface CodexHandle {
  unmount(): void;
}

/** 净化条目（新者前；purifiedAt 相同则按存档顺序——排序稳定，不引入随机）。 */
export interface CodexEntry {
  readonly deck: Deck;
  readonly purifiedAt: number;
}

/** 从存档里挑出已净化领域，新者前。 */
export function purifiedEntries(save: SaveFile): CodexEntry[] {
  const decks = Array.isArray(save?.decks) ? save.decks : [];
  const out: CodexEntry[] = [];
  for (const d of decks) {
    if (!d || typeof d.id !== 'string') continue;
    if (typeof d.purifiedAt !== 'number' || !Number.isFinite(d.purifiedAt)) continue;
    out.push({ deck: d, purifiedAt: d.purifiedAt });
  }
  return out.sort((a, b) => b.purifiedAt - a.purifiedAt);
}

function deckCardCount(cards: readonly Card[], deckId: string): number {
  let n = 0;
  for (const c of cards) if (c && c.deckId === deckId) n += 1;
  return n;
}

/**
 * 在 root 里挂藏书阁。列表按"内容指纹"重建 DOM（净化集合/称号/解锁幕数变了才重建），
 * 避免每次快照都重排整页。
 */
export function mountCodex(root: HTMLElement, ctrl: GameController, deps: CodexDeps = {}): CodexHandle {
  if (!root || !ctrl) throw new Error('mount-codex: root/controller required');
  const eggs = deps.eggs ?? {};
  const acts = Array.isArray(deps.acts) ? deps.acts : [];
  const tzOffsetMin = typeof deps.tzOffsetMin === 'number' && Number.isFinite(deps.tzOffsetMin) ? deps.tzOffsetMin : 0;

  const backBtn = h('button', { 'data-ui': 'back', class: 'back-btn', type: 'button' }, '返回') as HTMLButtonElement;
  const countEl = h('span', { 'data-ui': 'codex-count', class: 'codex-count' });
  const headerEl = h('header', { class: 'codex-header' }, [
    backBtn,
    h('h2', { class: 'screen-title' }, '藏书阁'),
    countEl,
  ]);

  const listEl = h('ul', { 'data-ui': 'codex-list', class: 'codex-list' });
  const emptyEl = h(
    'p',
    { 'data-ui': 'codex-empty', class: 'codex-empty' },
    '还没有净化过任何领域。复习攒够次数，卷灵自会现身。',
  );
  const journalEl = h('section', { 'data-ui': 'journal', class: 'journal' }, [
    h('h3', { class: 'field-title' }, '行记'),
  ]);

  const screen = h('div', { 'data-ui': 'codex-screen', class: 'codex-screen' }, [
    headerEl,
    listEl,
    emptyEl,
    journalEl,
  ]);
  root.appendChild(screen);

  let destroyed = false;
  let listKey = '';
  let journalKey = '';

  /* ------------------------------------------------------------ 条目 */
  function entryRow(entry: CodexEntry, cards: readonly Card[]): HTMLElement {
    const deck = entry.deck;
    const egg = typeof eggs[deck.id] === 'string' ? eggs[deck.id] : '';
    const n = deckCardCount(cards, deck.id);
    const practice = h(
      'button',
      { 'data-practice': deck.id, class: 'practice-btn', type: 'button' },
      '重战（练习关）',
    ) as HTMLButtonElement;
    if (typeof deps.onPractice === 'function') practice.addEventListener('click', () => deps.onPractice?.(deck.id));
    else practice.disabled = true;

    return h('li', { 'data-codex-entry': deck.id, class: 'codex-entry' }, [
      h('h3', { 'data-ui': 'entry-name', class: 'entry-name' }, bossNameOf(deck)),
      h('div', { 'data-ui': 'entry-meta', class: 'entry-meta' }, [
        `${n} 张卡 · 净化于 ${localDayString(entry.purifiedAt, tzOffsetMin)}`,
      ]),
      h('p', { 'data-ui': 'entry-egg', class: 'entry-egg' }, egg.length > 0 ? egg : '已净化'),
      practice,
    ]);
  }

  /* ------------------------------------------------------------ 行记（三幕） */
  function renderJournal(arcSeen: number): void {
    const key = `seen:${arcSeen}|acts:${acts.map((a) => a.act).join(',')}`;
    if (key === journalKey) return;
    journalKey = key;
    journalEl.replaceChildren(h('h3', { class: 'field-title' }, '行记'));
    for (const act of acts) {
      const unlocked = arcSeen >= act.act;
      const row = h('article', {
        'data-act': String(act.act),
        'data-unlocked': String(unlocked),
        class: 'act-row',
      });
      if (!unlocked) {
        row.appendChild(h('h4', { 'data-ui': 'act-title', class: 'act-title' }, '尚未显现'));
        row.appendChild(h('p', { 'data-ui': 'act-locked', class: 'act-locked' }, '净化更多领域，这一页会自己显形。'));
      } else {
        row.appendChild(h('h4', { 'data-ui': 'act-title', class: 'act-title' }, act.title));
        const art = h('img', {
          'data-ui': 'act-art',
          class: 'act-art',
          src: act.art,
          alt: act.title,
          draggable: 'false',
          style: { 'pointer-events': 'none' },
        });
        row.appendChild(art);
        for (const line of act.lines) row.appendChild(h('p', { 'data-ui': 'act-line', class: 'act-line' }, line));
      }
      journalEl.appendChild(row);
    }
  }

  /* ------------------------------------------------------------ 渲染 */
  function render(snap: ControllerSnapshot): void {
    const save = snap.save;
    const entries = purifiedEntries(save);
    const cards = Array.isArray(save?.cards) ? save.cards : [];

    const key = entries.map((e) => `${e.deck.id}:${e.deck.bossName ?? ''}:${e.purifiedAt}`).join('|') + `#${cards.length}`;
    if (key !== listKey) {
      listKey = key;
      listEl.replaceChildren();
      for (const entry of entries) listEl.appendChild(entryRow(entry, cards));
      setHidden(emptyEl, entries.length > 0);
    }
    countEl.textContent = entries.length === 0 ? '空卷' : `已净化 ${purifiedCount(save)} 个领域`;

    renderJournal(save.settings.story.arcSeen);
    setHidden(backBtn, typeof deps.onNav !== 'function');
  }

  backBtn.addEventListener('click', () => deps.onNav?.('menu'));
  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    render(snap);
  });
  render(ctrl.snapshot());

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    screen.remove();
  }

  return { unmount: destroy };
}
