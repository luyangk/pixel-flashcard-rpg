/**
 * decks.ts —— Plan 4 · T7：卡组页（分页卡表 + 手写加卡 + 新建领域 + 导入/导出备份）。
 *
 * ## 分页是硬要求，不是优化（Review Focus #5）
 * 数百张卡一次性建 DOM 会让手机卡顿。本屏**只挂前 `pageSize`（默认 50）条**，
 * 「加载更多」每次 +pageSize。判据写进测试：120 张卡首屏的卡行 ≤ 50 个 DOM 节点。
 *
 * ## 写口全在 deps 里（视图不持存储）
 * 加卡/建领域走 `deps.addCard`/`deps.addDeck`（宿主接 app/library + coordinator），
 * 导入/导出走 `deps.exportBackup`/`deps.importBackup`（宿主接 app/transfer），
 * 文件选择与下载也注入（`deps.pickBackupText`/`deps.saveTextFile`）——因此本模块在
 * happy-dom 里能完整测到"点了按钮到底调了什么、调了几次"，而真机行为归宿主壳（T11）。
 *
 * ## FFW-p3-b 义务：导出失败也**不能丢文本**
 * `exportAndMark` 有一类失败是"文件已生成、但'已备份'时刻没记上"（`ok:false` 且带
 * `text`）。那种情况下把文本扔掉等于让用户白等一场——本屏的规矩是：**只要拿到 text
 * 就触发下载**，然后用 toast 说清"文件已生成，但备份记录没写上，请自己留好"。
 *
 * 时间与 id 全部注入（`now`/`newId`）：UI 层不读钟、不自己造身份，
 * 导出的文件名因此可逐字断言。
 */
import type { Card, Deck } from '@core/types';
import { localDayString } from '@core/reviewLedger';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import type { LibraryResult } from '../app/library';
import type { ExportAndMarkResult, ImportAndSaveResult } from '../app/transfer';
import { h, setHidden } from './dom';
import { showToast } from './toast';

/** 每页条数（Review Focus #5 的数字；测试按它设断言）。 */
export const PAGE_SIZE = 50;

export interface DecksDeps {
  /** 分页大小覆盖位（缺省 PAGE_SIZE）。 */
  readonly pageSize?: number;
  /** 返回上一屏（缺省不显示返回按钮）。 */
  readonly onNav?: (target: 'menu') => void;
  /** 加卡写口（宿主接 app/library.addCard）。缺省则加卡表单不显示。 */
  readonly addCard?: (input: { front: string; back: string; deckId: string; id: string }) => Promise<LibraryResult<Card>>;
  /** 建领域写口（宿主接 app/library.addDeck）。缺省则新建领域表单不显示。 */
  readonly addDeck?: (input: { name: string; id: string }) => Promise<LibraryResult<Deck>>;
  /** 导出编排（宿主接 transfer.exportAndMark）。缺省则导出按钮不显示。 */
  readonly exportBackup?: () => Promise<ExportAndMarkResult>;
  /** 导入编排（宿主接 transfer.importBackupAndSave）。缺省则导入按钮不显示。 */
  readonly importBackup?: (text: string) => Promise<ImportAndSaveResult>;
  /** 选文件（宿主用 <input type="file">；返回 null = 用户取消）。缺省则导入按钮不显示。 */
  readonly pickBackupText?: () => Promise<string | null>;
  /** 真正把文本交到用户手里（宿主用 Blob + <a download>）。 */
  readonly saveTextFile?: (text: string, filename: string) => void;
  /** 时钟（导出文件名用；缺省 0 = 1970-01-01，测试可注入固定时刻）。 */
  readonly now?: () => number;
  /** 时区偏移（东为正，与 platform/env.tzOffsetMin 同口径；缺省 0）。 */
  readonly tzOffsetMin?: number;
  /** id 生成位（宿主注入；缺省优先 crypto.randomUUID）。 */
  readonly newId?: () => string;
  /** toast 存活毫秒（透传 showToast；测试给 0 免定时器）。 */
  readonly toastMs?: number;
}

export interface DecksHandle {
  unmount(): void;
}

/**
 * 备份文件名（导出到用户手里时可见的那一行字）：`zx-xia-backup-<本地日期>.json`。
 * 与 D29 的坏档抢救文件名（`zx-xia-corrupt-…`）同一命名家族——用户一眼能分清
 * "我备的份"与"抢救出来的原文"。日期口径委托 core 的 `localDayString`（唯一权威）。
 */
export function backupFileName(nowMs: number, tzOffsetMin = 0): string {
  return `zx-xia-backup-${localDayString(nowMs, tzOffsetMin)}.json`;
}

function defaultNewId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 极老环境的降级：进程内计数器（不读钟、不用 Math.random——后者的可复现性更差）
  fallbackSeq += 1;
  return `zx-local-${fallbackSeq}`;
}
let fallbackSeq = 0;

/**
 * 在 root 里挂卡组页。列表按**存档顺序**展示（新卡在后），不做排序——
 * 排序口径若将来要改，改动点应只有一处，这里不预先发明规则。
 */
export function mountDecks(root: HTMLElement, ctrl: GameController, deps: DecksDeps = {}): DecksHandle {
  if (!root || !ctrl) throw new Error('mount-decks: root/controller required');

  const pageSize =
    typeof deps.pageSize === 'number' && Number.isFinite(deps.pageSize) && deps.pageSize > 0
      ? Math.floor(deps.pageSize)
      : PAGE_SIZE;
  const newId = deps.newId ?? defaultNewId;
  const now = deps.now ?? (() => 0);
  const tzOffsetMin = typeof deps.tzOffsetMin === 'number' && Number.isFinite(deps.tzOffsetMin) ? deps.tzOffsetMin : 0;
  const canAdd = typeof deps.addCard === 'function';
  const canCreateDeck = typeof deps.addDeck === 'function';
  const canExport = typeof deps.exportBackup === 'function' && typeof deps.saveTextFile === 'function';
  const canImport = typeof deps.importBackup === 'function' && typeof deps.pickBackupText === 'function';

  let visible = pageSize;
  let busy = false;
  let destroyed = false;
  let toastOff: (() => void) | null = null;
  /** 上次渲染列表所依据的指纹（内容变了才重建 DOM）。 */
  let listKey = '';

  /* ------------------------------------------------------------ DOM 外壳 */
  const backBtn = h('button', { 'data-ui': 'back', class: 'back-btn', type: 'button' }, '返回') as HTMLButtonElement;
  const countEl = h('span', { 'data-ui': 'card-count', class: 'card-count' });
  const headerEl = h('header', { class: 'decks-header' }, [backBtn, h('h2', { class: 'screen-title' }, '卡组'), countEl]);

  const listEl = h('ul', { 'data-ui': 'card-list', class: 'card-list' });
  const emptyEl = h('p', { 'data-ui': 'card-empty', class: 'card-empty' }, '卡库还是空的——手写第一张，或者导入一份备份。');
  const loadMoreBtn = h('button', { 'data-ui': 'load-more', class: 'load-more', type: 'button' }, '加载更多') as HTMLButtonElement;

  const frontInput = h('input', { 'data-ui': 'add-front', class: 'add-input', type: 'text', placeholder: '正面（问题）' }) as HTMLInputElement;
  const backInput = h('input', { 'data-ui': 'add-back', class: 'add-input', type: 'text', placeholder: '背面（答案）' }) as HTMLInputElement;
  const deckSelect = h('select', { 'data-ui': 'add-deck', class: 'add-select' }) as HTMLSelectElement;
  const addBtn = h('button', { 'data-ui': 'add-submit', class: 'add-submit', type: 'button' }, '加入卡库') as HTMLButtonElement;
  const addFormEl = h('section', { 'data-ui': 'add-form', class: 'add-form', hidden: !canAdd }, [
    h('h3', { class: 'field-title' }, '手写一张卡'),
    frontInput,
    backInput,
    deckSelect,
    addBtn,
  ]);

  const deckNameInput = h('input', { 'data-ui': 'new-deck-name', class: 'add-input', type: 'text', placeholder: '新领域名（如「唐诗」）' }) as HTMLInputElement;
  const createDeckBtn = h('button', { 'data-ui': 'create-deck', class: 'create-deck', type: 'button' }, '新建领域') as HTMLButtonElement;
  const newDeckEl = h('section', { 'data-ui': 'new-deck-form', class: 'new-deck-form', hidden: !canCreateDeck }, [
    h('h3', { class: 'field-title' }, '新建领域'),
    deckNameInput,
    createDeckBtn,
  ]);

  const exportBtn = h('button', { 'data-ui': 'export', class: 'export-btn', type: 'button' }, '导出备份') as HTMLButtonElement;
  const importBtn = h('button', { 'data-ui': 'import', class: 'import-btn', type: 'button' }, '导入备份') as HTMLButtonElement;
  const transferEl = h('section', { 'data-ui': 'transfer', class: 'transfer' }, [
    h('h3', { class: 'field-title' }, '备份'),
    exportBtn,
    importBtn,
  ]);

  const screen = h('div', { 'data-ui': 'decks-screen', class: 'decks-screen' }, [
    headerEl,
    listEl,
    emptyEl,
    loadMoreBtn,
    addFormEl,
    newDeckEl,
    transferEl,
  ]);
  root.appendChild(screen);

  /* ------------------------------------------------------------ 渲染 */
  function cardRow(card: Card, decks: readonly Deck[]): HTMLElement {
    const deck = decks.find((d) => d.id === card.deckId);
    return h('li', { 'data-card-id': card.id, class: 'card-row' }, [
      h('span', { class: 'card-front' }, card.front),
      h('span', { class: 'card-back' }, card.back),
      h('span', { 'data-ui': 'card-deck', class: 'card-deck' }, deck?.name ?? card.deckId),
    ]);
  }

  function renderList(cards: readonly Card[], decks: readonly Deck[]): void {
    const shown = Math.min(visible, cards.length);
    const key = `${cards.length}|${shown}|${decks.map((d) => d.id).join(',')}`;
    if (key !== listKey) {
      listKey = key;
      listEl.replaceChildren();
      for (let i = 0; i < shown; i++) listEl.appendChild(cardRow(cards[i], decks));
      setHidden(emptyEl, cards.length > 0);
      setHidden(loadMoreBtn, shown >= cards.length);
      loadMoreBtn.disabled = busy;
    }
    countEl.textContent = cards.length === 0 ? '空卡库' : `共 ${cards.length} 张 · 已显示 ${shown} 张`;
  }

  function renderDeckOptions(decks: readonly Deck[], cards: readonly Card[]): void {
    // 领域集合变了才重建 select（否则玩家选中的项会被每次快照重置）
    const fingerprint = decks.map((d) => d.id).join('\u0000');
    if (deckSelect.getAttribute('data-decks') === fingerprint) return;
    deckSelect.setAttribute('data-decks', fingerprint);
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(c.deckId, (counts.get(c.deckId) ?? 0) + 1);
    deckSelect.replaceChildren();
    for (const d of decks) {
      deckSelect.appendChild(
        h('option', { value: d.id }, `${d.name}（${counts.get(d.id) ?? 0}）`),
      );
    }
    // 空库时不要让 select 悬空：给一个不可提交的占位项，玩家会看到"先新建领域"
    if (decks.length === 0) deckSelect.appendChild(h('option', { value: '' }, '（先新建一个领域）'));
  }

  function render(snap: ControllerSnapshot): void {
    const decks = Array.isArray(snap.save?.decks) ? snap.save.decks : [];
    const cards = Array.isArray(snap.save?.cards) ? snap.save.cards : [];
    renderList(cards, decks);
    renderDeckOptions(decks, cards);
    addBtn.disabled = busy || decks.length === 0;
    createDeckBtn.disabled = busy;
    exportBtn.disabled = busy;
    importBtn.disabled = busy;
    setHidden(backBtn, typeof deps.onNav !== 'function');
    setHidden(exportBtn, !canExport);
    setHidden(importBtn, !canImport);
  }

  /* ------------------------------------------------------------ 交互 */
  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  function onLoadMore(): void {
    if (destroyed || busy) return;
    visible += pageSize;
    render(ctrl.snapshot());
  }

  async function onAddCard(): Promise<void> {
    if (destroyed || busy || !deps.addCard) return;
    const deckId = deckSelect.value;
    busy = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.addCard({
        front: frontInput.value,
        back: backInput.value,
        deckId,
        id: newId(),
      });
      if (res.ok) {
        frontInput.value = '';
        backInput.value = '';
        toast('已加入卡库。');
      } else {
        toast(res.reason);
      }
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function onCreateDeck(): Promise<void> {
    if (destroyed || busy || !deps.addDeck) return;
    busy = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.addDeck({ name: deckNameInput.value, id: newId() });
      if (res.ok) {
        deckNameInput.value = '';
        toast(`领域「${res.value.name}」已建好。`);
      } else {
        toast(res.reason);
      }
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function onExport(): Promise<void> {
    if (destroyed || busy || !deps.exportBackup || !deps.saveTextFile) return;
    busy = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.exportBackup();
      if (res.text) {
        // FFW-p3-b：只要有文本就先交到用户手里——哪怕 ok:false（见文件头）。
        deps.saveTextFile(res.text, backupFileName(now(), tzOffsetMin));
      }
      toast(res.ok ? '备份已导出。' : (res.reason ?? '导出没能完成。'));
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function onImport(): Promise<void> {
    if (destroyed || busy || !deps.importBackup || !deps.pickBackupText) return;
    const text = await deps.pickBackupText();
    if (destroyed || text === null) return; // 用户取消：不当成错误，也不弹 toast
    busy = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.importBackup(text);
      toast(res.ok ? '备份已导入。' : (res.reason ?? '导入没能完成。'));
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  backBtn.addEventListener('click', () => deps.onNav?.('menu'));
  loadMoreBtn.addEventListener('click', onLoadMore);
  addBtn.addEventListener('click', () => void onAddCard());
  createDeckBtn.addEventListener('click', () => void onCreateDeck());
  exportBtn.addEventListener('click', () => void onExport());
  importBtn.addEventListener('click', () => void onImport());

  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    render(snap);
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
