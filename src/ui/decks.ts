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
import type { CardCandidate, ParseResult } from '@core/llmParse';
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
  readonly addCard?: (input: {
    front: string;
    back: string;
    deckId: string;
    id: string;
    /** Plan 5 · T4：AI 辅建卡走 `'llm'`，手写恒不传（缺省 `'manual'`）。 */
    sourceType?: 'manual' | 'llm';
    /** 主题标签（AI 辅建带过来；PRD §3 主题筛选的依据）。缺省 = 无标签。 */
    tags?: readonly string[];
  }) => Promise<LibraryResult<Card>>;
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
  /**
   * AI 辅建卡（Plan 5 · T4；宿主接 `app/llmFlow.suggestCards`）。缺省则整块隐藏。
   * 它**只回候选**：写入仍由本屏在玩家逐条勾选/编辑后走 `addCard`。
   */
  readonly llmCards?: (input: { text: string; deckName: string; max?: number }) => Promise<ParseResult<CardCandidate>>;
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
  /** AI 辅建卡要**同时**有生成口与入库口：缺一个就不显示（不显示点了没反应的入口）。 */
  const canAuthor = typeof deps.llmCards === 'function' && canAdd;

  let visible = pageSize;
  let busy = false;
  let destroyed = false;
  let toastOff: (() => void) | null = null;
  /** 上次渲染列表所依据的指纹（内容变了才重建 DOM）。 */
  let listKey = '';
  /** AI 辅建卡面板是否展开（展开时隐藏「AI 辅建卡」入口按钮）。 */
  let authorOpen = false;
  /** 生成中：禁用生成与入库按钮（防连点、防"边生成边入库"）；**「取消」保持可用**。 */
  let authorGenerating = false;
  /** 入库中：三个按钮全禁用——逐条写盘跑到一半被取消会留下"写了几张但没说"。 */
  let authorSaving = false;
  /**
   * 代际令牌：取消/重新生成会让在途的旧请求作废。没有它，玩家点「取消」后
   * 旧请求回来的候选会**写进已经关掉的面板**（下次展开时凭空出现一批候选）。
   */
  let authorToken = 0;

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

  /* ------------------------------------------------------------ AI 辅建卡（Plan 5 · T4） */
  const authorText = h('textarea', {
    'data-ui': 'llm-author-text',
    class: 'llm-author-text',
    rows: '5',
    placeholder: '把一段资料粘在这里（课文、笔记、讲义都行）',
  }) as HTMLTextAreaElement;
  const authorRunBtn = h(
    'button',
    { 'data-ui': 'llm-author-run', class: 'llm-author-run', type: 'button' },
    '生成候选',
  ) as HTMLButtonElement;
  const authorStatusEl = h('p', { 'data-ui': 'llm-author-status', class: 'llm-author-status' });
  const authorListEl = h('ul', { 'data-ui': 'llm-author-list', class: 'llm-author-list' });
  const authorConfirmBtn = h(
    'button',
    { 'data-ui': 'llm-author-confirm', class: 'llm-author-confirm', type: 'button' },
    '加入卡库',
  ) as HTMLButtonElement;
  const authorCancelBtn = h(
    'button',
    { 'data-ui': 'llm-author-cancel', class: 'llm-author-cancel', type: 'button' },
    '取消',
  ) as HTMLButtonElement;
  const authorEl = h('div', { 'data-ui': 'llm-author', class: 'llm-author', hidden: true }, [
    authorText,
    authorRunBtn,
    authorStatusEl,
    authorListEl,
    authorConfirmBtn,
    authorCancelBtn,
  ]);
  const authorOpenBtn = h(
    'button',
    { 'data-ui': 'llm-author-open', class: 'llm-author-open', type: 'button' },
    'AI 辅建卡',
  ) as HTMLButtonElement;
  const authorSectionEl = h('section', { 'data-ui': 'llm-author-section', class: 'llm-author-section', hidden: !canAuthor }, [
    h('h3', { class: 'field-title' }, 'AI 辅建卡'),
    h('p', { class: 'field-hint' }, '只把这段文字发给 AI；产出先给你逐条改、逐条确认，确认前不会入库。'),
    authorOpenBtn,
    authorEl,
  ]);

  const screen = h('div', { 'data-ui': 'decks-screen', class: 'decks-screen' }, [
    headerEl,
    listEl,
    emptyEl,
    loadMoreBtn,
    addFormEl,
    newDeckEl,
    authorSectionEl,
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
    // 指纹必须**带内容**（T7 评审判 I-3）：只按条数与领域 id 判缓存时，"导入一份同规模的
    // 另一份备份"（换汤不换药：条数/领域都不变）会让屏上继续显示旧卡 —— 把权威存档显示错
    // 比显示得慢更糟。front/back 都进指纹，卡面文案改了也会刷新。
    const content = cards.map((c) => `${c.id}\u0001${c.front}\u0001${c.back}\u0001${c.deckId}`).join('\u0002');
    const key = `${cards.length}|${shown}|${decks.map((d) => d.id).join(',')}|${content}`;
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
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(c.deckId, (counts.get(c.deckId) ?? 0) + 1);

    // 领域集合变了才**重建** option 节点（否则玩家选中的项会被每次快照重置）；
    // 但文案（领域名与计数）每次 render 都刷新——重建与否不影响"显示对不对"
    // （T7 评审判 I-3：加卡后下拉曾一直显示旧计数）。
    const fingerprint = decks.map((d) => d.id).join('\u0000');
    if (deckSelect.getAttribute('data-decks') !== fingerprint) {
      deckSelect.setAttribute('data-decks', fingerprint);
      deckSelect.replaceChildren();
      for (const d of decks) deckSelect.appendChild(h('option', { value: d.id }, d.name));
      // 空库时不要让 select 悬空：给一个不可提交的占位项，玩家会看到"先新建领域"
      if (decks.length === 0) deckSelect.appendChild(h('option', { value: '' }, '（先新建一个领域）'));
    }
    const options = Array.from(deckSelect.children) as HTMLOptionElement[];
    decks.forEach((d, i) => {
      const option = options[i];
      if (option) option.textContent = `${d.name}（${counts.get(d.id) ?? 0}）`;
    });
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
    // AI 辅建卡：展开时藏入口；生成/入库中把动作按钮禁用（「取消」只在入库中禁用）
    setHidden(authorOpenBtn, authorOpen);
    setHidden(authorEl, !authorOpen);
    authorRunBtn.disabled = authorGenerating || authorSaving;
    authorConfirmBtn.disabled = authorGenerating || authorSaving;
    authorCancelBtn.disabled = authorSaving;
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
    } catch (e) {
      toast(`加卡失败：${e instanceof Error ? e.message : String(e)}`);
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
        // 成功分支的渲染也包在 try 里，故只做不可能抛的事：畸形 ok 结果不该被说成"失败"
        deckNameInput.value = '';
        const name = typeof res.value?.name === 'string' && res.value.name.length > 0 ? res.value.name : '新领域';
        toast(`领域「${name}」已建好。`);
      } else {
        toast(res.reason);
      }
    } catch (e) {
      toast(`新建领域失败：${e instanceof Error ? e.message : String(e)}`);
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
        deps.saveTextFile?.(res.text, backupFileName(now(), tzOffsetMin));
      }
      toast(res.ok ? '备份已导出。' : (res.reason ?? '导出没能完成。'));
    } catch (e) {
      toast(`导出没能完成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function onImport(): Promise<void> {
    if (destroyed || busy || !deps.importBackup || !deps.pickBackupText) return;
    // busy 必须在**开文件选择器之前**置位（T7 评审判 M-2）：否则连点会开出两个选择器
    busy = true;
    render(ctrl.snapshot());
    try {
      const text = await deps.pickBackupText();
      if (destroyed || text === null) return; // 用户取消：不当成错误，也不弹 toast
      const res = await deps.importBackup(text);
      if (!destroyed) toast(res.ok ? '备份已导入。' : (res.reason ?? '导入没能完成。'));
    } catch (e) {
      // 写口在只读闩锁下会真 reject（SaveReadOnlyError）——必须收成一句提示，
      // 绝不让 rejection 逃到事件处理器（D29 的"全捕获可见"）。
      if (!destroyed) toast(`导入没能完成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  /* ------------------------------------------------------------ AI 辅建卡交互 */
  /** 当前下拉选中的领域名（发提示词用；找不到就空串，llmFlow 自己会兜）。 */
  function selectedDeckName(): string {
    const decks = Array.isArray(ctrl.snapshot().save?.decks) ? ctrl.snapshot().save.decks : [];
    const deck = decks.find((d) => d && d.id === deckSelect.value);
    return deck ? deck.name : '';
  }

  /**
   * 收摊：清候选与状态，并让在途请求作废（代际令牌 +1）。
   * `keepText=true`（「加入卡库」之后）保留粘贴的资料——玩家常常想从同一段资料再生成一批；
   * 「取消」则连资料一起清掉（那才是"这次不要了"的语义）。
   */
  function closeAuthor(keepText = false): void {
    authorToken += 1;
    authorOpen = false;
    authorGenerating = false;
    if (!keepText) authorText.value = '';
    authorStatusEl.textContent = '';
    authorListEl.replaceChildren();
  }

  function onAuthorOpen(): void {
    if (destroyed || authorSaving) return;
    closeAuthor();
    authorOpen = true;
    render(ctrl.snapshot());
  }

  /** 渲染候选：**默认全勾**；正反面都是可编辑输入框，入库读的是此刻输入框里的值。 */
  function renderCandidates(list: readonly CardCandidate[]): void {
    authorListEl.replaceChildren();
    list.forEach((candidate, i) => {
      const check = h('input', {
        'data-candidate-check': String(i),
        class: 'candidate-check',
        type: 'checkbox',
      }) as HTMLInputElement;
      check.checked = true;
      const front = h('input', {
        'data-candidate-front': String(i),
        class: 'candidate-input',
        type: 'text',
        placeholder: '正面',
        // 与 core/llmParse 的 200 码点上限对齐（评审 m-7）：手打能超，但这里给个软约束
        maxlength: '200',
      }) as HTMLInputElement;
      front.value = candidate.front;
      const back = h('input', {
        'data-candidate-back': String(i),
        class: 'candidate-input',
        type: 'text',
        placeholder: '背面',
        maxlength: '200',
      }) as HTMLInputElement;
      back.value = candidate.back;
      // 标签是生成时算出来的分类（PRD §3 的主题筛选依据）：这里只读展示 + 挂在行上，
      // 确认入库时随卡一起写（**不**做成可编辑——三个输入框已经够挤，且标签改错影响筛选口径）
      const tagHint = h(
        'span',
        { 'data-candidate-tag-text': String(i), class: 'candidate-tags' },
        candidate.tags.length > 0 ? `标签：${candidate.tags.join('/')}` : '',
      );
      authorListEl.appendChild(
        h(
          'li',
          { 'data-candidate': String(i), 'data-candidate-tags': candidate.tags.join('\u0001'), class: 'candidate' },
          [check, front, back, tagHint],
        ),
      );
    });
  }

  async function onAuthorRun(): Promise<void> {
    if (destroyed || authorGenerating || authorSaving || !deps.llmCards) return;
    const text = authorText.value;
    if (text.trim().length === 0) {
      authorStatusEl.textContent = '先粘一段资料进来。';
      return;
    }
    const token = ++authorToken;
    authorGenerating = true;
    authorListEl.replaceChildren();
    authorStatusEl.textContent = '正在生成…';
    render(ctrl.snapshot());
    try {
      const res = await deps.llmCards({ text, deckName: selectedDeckName() });
      if (destroyed || token !== authorToken) return; // 已被取消/重新生成：结果作废，零写入
      if (!res || res.ok !== true) {
        authorStatusEl.textContent = res && typeof res.reason === 'string' ? res.reason : '生成失败。';
        return;
      }
      renderCandidates(res.value);
      // truncated 是解析器**如实申报**的截断：不静默丢弃，必须让玩家知道少了几条
      authorStatusEl.textContent = res.truncated
        ? `已截断为前 ${res.value.length} 条。`
        : `生成了 ${res.value.length} 条候选，改完再点「加入卡库」。`;
    } catch (e) {
      if (!destroyed && token === authorToken) authorStatusEl.textContent = `生成失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      if (token === authorToken) authorGenerating = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function onAuthorConfirm(): Promise<void> {
    if (destroyed || authorGenerating || authorSaving || !deps.addCard) return;
    const rows = Array.from(authorListEl.children) as HTMLElement[];
    const picked: Array<{ front: string; back: string; tags: string[] }> = [];
    for (const row of rows) {
      const check = row.querySelector('[data-candidate-check]') as HTMLInputElement | null;
      if (!check || !check.checked) continue; // 取消勾选的**不入库**（含默认勾选后手动取消）
      const front = (row.querySelector('[data-candidate-front]') as HTMLInputElement | null)?.value ?? '';
      const back = (row.querySelector('[data-candidate-back]') as HTMLInputElement | null)?.value ?? '';
      // tags 一起带上：它是 PRD §3 主题筛选的依据，生成时算出来的分类不该在入库时丢掉
      const tagText = row.getAttribute('data-candidate-tags') ?? '';
      picked.push({
        front,
        back,
        tags: tagText
          .split('\u0001')
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      });
    }
    if (picked.length === 0) {
      authorStatusEl.textContent = '至少勾一张要加入的卡。';
      return;
    }
    const deckId = deckSelect.value;
    authorSaving = true;
    render(ctrl.snapshot());
    let added = 0;
    const failures: string[] = [];
    try {
      // **逐条 await**：一条卡一个写口调用（来源标 llm），失败不中断其余——
      // 与"整包提交"相比，玩家不会因为第 3 张撞了编号就丢掉前两张。
      for (const item of picked) {
        try {
          const res = await deps.addCard({
            front: item.front,
            back: item.back,
            deckId,
            id: newId(),
            sourceType: 'llm',
            tags: item.tags,
          });
          if (res.ok) added += 1;
          else failures.push(typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '有一张没加进去。');
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      authorSaving = false;
    }
    if (destroyed) return;
    // 失败原因不吞：逐条提示过（下面这行 toast 会覆盖它），故在收尾提示里再带一句最后一次原因
    toast(
      failures.length === 0
        ? `已加入 ${added} 张卡。`
        : `已加入 ${added} 张卡。有 ${failures.length} 张没能加进去：${failures[failures.length - 1]}`,
    );
    closeAuthor(true); // 保留资料：玩家常想从同一段材料再生成一批
    render(ctrl.snapshot());
  }

  backBtn.addEventListener('click', () => deps.onNav?.('menu'));
  loadMoreBtn.addEventListener('click', onLoadMore);
  addBtn.addEventListener('click', () => void onAddCard());
  createDeckBtn.addEventListener('click', () => void onCreateDeck());
  exportBtn.addEventListener('click', () => void onExport());
  importBtn.addEventListener('click', () => void onImport());
  authorOpenBtn.addEventListener('click', onAuthorOpen);
  authorRunBtn.addEventListener('click', () => void onAuthorRun());
  authorConfirmBtn.addEventListener('click', () => void onAuthorConfirm());
  authorCancelBtn.addEventListener('click', () => {
    if (destroyed || authorSaving) return;
    closeAuthor();
    render(ctrl.snapshot());
  });

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
