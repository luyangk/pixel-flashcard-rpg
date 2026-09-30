/**
 * practiceSources.ts —— 采新卡里的「来源库」（D53）。
 *
 * ## 它解决什么
 * 采新卡原来是"你得先知道去哪找"：给链接、粘正文。现在上面多一块**固定来源**：
 * 选领域 → 选来源 → 看最新条目 → 「用这篇」直接进既有管线（响应里带正文的就地生成，
 * 只带链接的走抓取）。
 *
 * ## 三条纪律
 * 1. **`direct:false` 的源必须打标并说实话**：实测没有 CORS 的源（OpenAI News / arXiv / 量子位…）
 *    在屏上写「需读取服务」，点它会得到"配读取服务或打开原文去复制"这句人话 ——
 *    绝不做出一个点下去必然报错的入口；
 * 2. **维护是玩家的**：加/删源 +「恢复推荐来源」，库只存本机（`platform/sourceStore`）；
 * 3. **本屏不认识网络与存储**：抓取走注入的 `fetchItems`，库走注入的 `library`
 *    （缺任一个 ⇒ 整块或对应部分收起，不显示点了没反应的入口）。
 */
import type { SourceDef, SourceDomain, SourceItem } from '@core/sourceItem';
import { planIngest, prepareItems, validateSourceInput } from '@core/sourceItem';
import type { FetchSourceResult } from '../platform/feedFetch';
import {
  addSource,
  isBuiltinSource,
  KIND_OPTIONS,
  mergeLibrary,
  removeSource,
  restoreBuiltins,
  type UserLibrary,
} from '../app/sourceLibrary';
import { localDayString } from '@core/reviewLedger';
import { h, setHidden } from './dom';
import { showToast } from './toast';

export interface SourcesDeps {
  /** 读一个来源的最新条目（宿主接 `platform/feedFetch.fetchSourceItems`）。 */
  readonly fetchItems?: (
    source: SourceDef,
    opts?: { readonly refresh?: boolean; readonly signal?: AbortSignal },
  ) => Promise<FetchSourceResult>;
  /** 玩家那份库（宿主接 `platform/sourceStore`）。缺省 ⇒ 只能看内置库、不能维护。 */
  readonly library?: {
    readonly load: () => UserLibrary;
    readonly save: (lib: UserLibrary) => boolean;
  };
  /** 「用这篇」且响应里带了正文 ⇒ 直接生成（宿主接既有的 `onGenerate(text)`）。 */
  readonly onUseText?: (input: { readonly title: string; readonly text: string; readonly url: string; readonly sourceName: string }) => void;
  /** 「用这篇」但只有链接 ⇒ 走既有的抓取管线。 */
  readonly onUseUrl?: (url: string) => void;
  /**
   * 「取全文再出卡」（D61）：摘要装不下主线与步骤，能拿全文的条目（论文）给一条更好的路。
   * 缺省 ⇒ 不显示按钮（不假装能取）；取不到全文时调用方会如实回落摘要。
   */
  readonly onUseFullText?: (input: {
    readonly title: string;
    readonly url: string;
    readonly fullTextUrl: string;
    readonly sourceName: string;
  }) => void;
  /** 「打开原文」（不给读取服务时的下一步）。 */
  readonly openUrl?: (url: string) => void;
  readonly now?: () => number;
  readonly tzOffsetMin?: number;
  readonly toastMs?: number;
}

export interface SourcesHandle {
  unmount(): void;
}

/** 条目上限（与 core 的 ITEMS_MAX 同口径；这里只管 DOM 不爆）。 */
const RENDER_MAX = 20;

export function mountPracticeSources(root: HTMLElement, deps: SourcesDeps = {}): SourcesHandle {
  if (!root) throw new Error('mount-practice-sources: root required');
  let destroyed = false;
  let toastOff: (() => void) | null = null;
  let busy = false;
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const tzOffsetMin = typeof deps.tzOffsetMin === 'number' && Number.isFinite(deps.tzOffsetMin) ? deps.tzOffsetMin : 0;

  let library: UserLibrary = deps.library ? deps.library.load() : { added: [], removed: [] };
  /** 正在读哪个源（D62：busy 时要**看得出来**，而不是静默吞掉点击）。 */
  let busySourceName = '';
  /** 在途请求的取消柄（D62「取消」按钮用它真的掐断请求）。 */
  let inflight: AbortController | null = null;
  let domains: SourceDomain[] = mergeLibrary(library);
  let activeDomainId = domains[0]?.id ?? '';
  let activeSourceId = '';
  let items: SourceItem[] = [];
  let status = '';
  let manageOpen = false;
  /** 最近一次"需读取服务"提示对应的链接（供「打开原文去复制」）。 */
  let blockedUrl = '';

  /* ------------------------------------------------------------ DOM */
  const domainRowEl = h('div', { 'data-ui': 'src-domains', class: 'src-domains' });
  const sourceRowEl = h('div', { 'data-ui': 'src-sources', class: 'src-sources' });
  const cancelBtn = h(
    'button',
    { 'data-ui': 'src-cancel', class: 'collect-btn', type: 'button', hidden: true },
    '取消',
  ) as HTMLButtonElement;
  cancelBtn.addEventListener('click', () => {
    if (destroyed) return;
    inflight?.abort();
    setStatus('已取消这次读取。');
  });
  const statusEl = h('p', { 'data-ui': 'src-status', class: 'field-hint' });
  const itemsEl = h('div', { 'data-ui': 'src-items', class: 'src-items' });
  const openBtn = h(
    'button',
    { 'data-ui': 'src-open', class: 'collect-btn', type: 'button' },
    '打开原文去复制',
  ) as HTMLButtonElement;
  openBtn.addEventListener('click', () => {
    if (blockedUrl.length === 0) return;
    const open = deps.openUrl ?? ((u: string) => void globalThis.open?.(u, '_blank', 'noopener'));
    open(blockedUrl);
  });

  /* 维护区：加源 / 删源 / 恢复推荐 */
  const nameInput = h('input', {
    'data-ui': 'src-new-name',
    class: 'collect-input',
    type: 'text',
    placeholder: '来源名（如：某人的博客）',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const urlInput = h('input', {
    'data-ui': 'src-new-url',
    class: 'collect-input',
    type: 'url',
    placeholder: 'https://…/feed.xml 或 API 地址',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const kindSelect = h('select', { 'data-ui': 'src-new-kind', class: 'collect-select' }) as HTMLSelectElement;
  for (const k of KIND_OPTIONS) {
    const opt = h('option', { value: k }, k) as HTMLOptionElement;
    kindSelect.appendChild(opt);
  }
  const addBtn = h('button', { 'data-ui': 'src-add', class: 'collect-btn', type: 'button' }, '加这个源') as HTMLButtonElement;
  addBtn.addEventListener('click', () => {
    if (destroyed || busy) return;
    const res = validateSourceInput({ name: nameInput.value, url: urlInput.value, kind: kindSelect.value });
    if (!res.ok) {
      setStatus(res.reason);
      return;
    }
    const next = addSource(library, res.value);
    if (!persist(next)) return;
    nameInput.value = '';
    urlInput.value = '';
    activeDomainId = 'mine';
    setStatus(`已加入「${res.value.name}」。第一次读它时如果被跨域拦下，界面上会如实告诉你。`);
  });
  const restoreBtn = h(
    'button',
    { 'data-ui': 'src-restore', class: 'collect-btn', type: 'button' },
    '恢复推荐来源',
  ) as HTMLButtonElement;
  restoreBtn.addEventListener('click', () => {
    if (destroyed || busy) return;
    const next = restoreBuiltins(library);
    if (!persist(next)) return;
    setStatus('推荐来源已恢复（你自己加的源保留）。');
  });
  const removeListEl = h('div', { 'data-ui': 'src-remove-list', class: 'src-remove-list' });
  const manageBtn = h(
    'button',
    { 'data-ui': 'src-manage', class: 'collect-btn', type: 'button' },
    '维护来源',
  ) as HTMLButtonElement;
  manageBtn.addEventListener('click', () => {
    if (destroyed) return;
    manageOpen = !manageOpen;
    render();
  });
  const manageEl = h('div', { 'data-ui': 'src-manage-body', class: 'collect-manage', hidden: true }, [
    h('p', { class: 'field-hint' }, '这一份库只存在这台设备上（不进存档、不进备份）。删掉的内置源不会自己回来，除非点「恢复推荐来源」。'),
    removeListEl,
    h('div', { class: 'collect-row' }, [nameInput]),
    h('div', { class: 'collect-row' }, [urlInput, kindSelect]),
    h('div', { class: 'collect-row' }, [addBtn, restoreBtn]),
  ]);

  const screen = h('section', { 'data-ui': 'src-section', class: 'collect-section' }, [
    h('h4', { class: 'collect-title' }, '来源库（固定来源，一键看最新）'),
    h(
      'p',
      { class: 'field-hint' },
      '选一个来源 → 看它最近的内容 → 「用这篇」直接把这篇喂给生成管线。' +
        '标了「需读取服务」的源没开跨域，浏览器读不到，点它会告诉你下一步。',
    ),
    domainRowEl,
    sourceRowEl,
    h('div', { class: 'collect-row' }, [statusEl, cancelBtn]),
    openBtn,
    itemsEl,
    manageBtn,
    manageEl,
  ]);
  root.appendChild(screen);

  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  /**
   * 立刻把一句话写到状态行上（**不等下一次 render**）。
   *
   * 为什么单独做：校验失败、抓取进行中这些分支当下就要有反馈；等 render 的话，
   * "点了「加这个源」但名字为空"会毫无反应（PS#5 当场抓到）。
   */
  function setStatus(text: string): void {
    status = text;
    statusEl.textContent = text;
    setHidden(statusEl, text.length === 0);
  }

  function persist(next: UserLibrary): boolean {
    if (!deps.library) {
      toast('这个版本没有接上"改来源库"的口，改了也存不住。');
      return false;
    }
    if (!deps.library.save(next)) {
      toast('没能存进本机（浏览器可能禁用了本地存储）。');
      return false;
    }
    library = next;
    domains = mergeLibrary(next);
    if (!domains.some((d) => d.id === activeDomainId)) activeDomainId = domains[0]?.id ?? '';
    activeSourceId = '';
    items = [];
    render();
    return true;
  }

  function activeDomain(): SourceDomain | undefined {
    return domains.find((d) => d.id === activeDomainId) ?? domains[0];
  }

  function dateLabel(item: SourceItem): string {
    if (item.dateMs <= 0) return '日期未知';
    return localDayString(item.dateMs, tzOffsetMin);
  }

  async function loadSource(source: SourceDef, opts: { refresh?: boolean } = {}): Promise<void> {
    if (typeof deps.fetchItems !== 'function') return;
    // D62：busy 时**不再静默吞点击** —— 说清"上一个源还在读"，并告诉玩家可以取消
    if (destroyed || busy) {
      setStatus(`上一个源（${busySourceName || '正在读'}）还在读，读完或点「取消」再试。`);
      return;
    }
    busy = true;
    busySourceName = source.name;
    activeSourceId = source.id; // 按钮据此变成「重读」
    inflight = typeof AbortController === 'function' ? new AbortController() : null;
    setHidden(cancelBtn, inflight === null);
    render();
    items = [];
    blockedUrl = '';
    setStatus(`正在读「${source.name}」…`);
    render();
    try {
      const res = await deps.fetchItems(source, inflight === null ? opts : { ...opts, signal: inflight.signal });
      if (destroyed) return;
      if (res.ok) {
        // 消毒/去重/排序都在 core 里做（这里只负责显示）
        items = prepareItems(res.items, RENDER_MAX);
        setStatus(
          items.length === 0
            ? `「${source.name}」这次没解析出可用条目。`
            : `${source.name}：${items.length} 条最新内容${res.via === 'reader' ? '（经读取服务取回）' : ''}。` +
              // D62：清单太长时如实说明只解析了前一段（不说的话"怎么只有这几条"像 Bug）
              (res.truncatedForParse === true ? '（清单很长，只解析了前一段，最新的排在最前面）' : '') +
              // D62：用缓存要说清楚 —— "怎么这么快"会让玩家怀疑是不是坏了；也顺便让他知道没花钱
              (res.cached === true ? '（用的是这次会话里刚读过的结果，没再花一次钱；要重读点「重读」）' : ''),
        );
      } else {
        items = [];
        blockedUrl = source.url;
        // 读不到就**把下一步递到手里**（与 pageFetch 的 blocked 分支同款口径）。
        // 文案分两种：**没配**读取服务时告诉玩家去配（并说明链接会转一手）；
        // **配了还是读不到**时别再叫他配一遍（他刚配过），改为说清是谁没读到 + 给换一个/复制原文。
        setStatus(
          res.readerTried
            ? `${res.reason}换一个能连上的读取服务，或者点下面的「打开原文去复制」。`
            : res.blocked
              ? `读不到「${source.name}」：这个源没开跨域（CORS），浏览器无权取它。` +
                '要么在「设置 → AI → 读取服务」里配一个（用它会把这个源的地址发给那台服务），要么点下面的「打开原文去复制」。'
              : `${res.reason}`,
        );
      }
    } finally {
      busy = false;
      busySourceName = '';
      inflight = null;
      if (!destroyed) {
        setHidden(cancelBtn, true);
        render();
      }
    }
  }

  function useItem(item: SourceItem): void {
    if (destroyed || busy) return;
    const plan = planIngest(item);
    if (plan.mode === 'text') {
      if (typeof deps.onUseText !== 'function') {
        setStatus('这个版本没有接上"用这段文字生成"的口。');
        return;
      }
      setStatus(`把《${item.title}》交给生成管线…`);
      deps.onUseText({ title: item.title, text: plan.text, url: item.url, sourceName: item.sourceName });
      return;
    }
    if (typeof deps.onUseUrl !== 'function') {
      setStatus('这个版本没有接上"抓链接"的口。');
      return;
    }
    setStatus(`这条只有标题和链接，去抓原文：《${item.title}》…`);
    deps.onUseUrl(item.url);
  }

  function renderDomains(): void {
    domainRowEl.replaceChildren();
    for (const d of domains) {
      const btn = h(
        'button',
        { 'data-src-domain': d.id, class: 'tab-btn', type: 'button' },
        `${d.name}（${d.sources.length}）`,
      ) as HTMLButtonElement;
      btn.setAttribute('aria-pressed', String(d.id === activeDomain()?.id));
      btn.addEventListener('click', () => {
        if (destroyed) return;
        activeDomainId = d.id;
        activeSourceId = '';
        items = [];
        setStatus('');
        render();
      });
      domainRowEl.appendChild(btn);
    }
    setHidden(domainRowEl, domains.length <= 1 && (domains[0]?.sources.length ?? 0) === 0);
  }

  function renderSources(): void {
    sourceRowEl.replaceChildren();
    const domain = activeDomain();
    for (const s of domain?.sources ?? []) {
      const row = h('div', { 'data-src-row': s.id, class: 'src-row' }, [
        h(
          'div',
          { class: 'src-meta' },
          [
            h('span', { class: 'src-name' }, s.name),
            s.direct ? null : h('span', { 'data-src-badge': s.id, class: 'src-badge' }, '需读取服务'),
            s.note ? h('span', { class: 'src-note' }, s.note) : null,
          ].filter((x): x is HTMLElement => x !== null),
        ),
      ]);
      const go = h(
        'button',
        { 'data-src-load': s.id, class: 'collect-btn', type: 'button' },
        s.id === activeSourceId ? '重读' : '看最新',
      ) as HTMLButtonElement;
      go.disabled = typeof deps.fetchItems !== 'function';
      // D62：「重读」= 真的再读一次（绕过会话内缓存）；首次「看最新」走缓存即可
      const alreadyRead = s.id === activeSourceId && items.length > 0;
      go.addEventListener('click', () => void loadSource(s, alreadyRead ? { refresh: true } : {}));
      row.appendChild(go);
      sourceRowEl.appendChild(row);
    }
  }

  function renderItems(): void {
    itemsEl.replaceChildren();
    for (const item of items) {
      const useBtn = h(
        'button',
        { 'data-src-use': item.id, class: 'collect-btn', type: 'button' },
        '用这篇',
      ) as HTMLButtonElement;
      useBtn.addEventListener('click', () => useItem(item));
      /**
       * 「取全文再出卡」（D61）：只在**这条内容真的有全文地址**、且宿主接了那个口时显示。
       * 摘要能出概念卡，但出不了"步骤/因果"——那正是玩家说"缺了最有价值的部分"的地方。
       */
      const fullBtn =
        typeof item.fullTextUrl === 'string' && typeof deps.onUseFullText === 'function'
          ? (h(
              'button',
              { 'data-src-full': item.id, class: 'collect-btn', type: 'button' },
              '取全文再出卡',
            ) as HTMLButtonElement)
          : null;
      fullBtn?.addEventListener('click', () => {
        if (destroyed || busy) return;
        setStatus(`正在取《${item.title}》的全文…`);
        deps.onUseFullText?.({
          title: item.title,
          url: item.url,
          fullTextUrl: item.fullTextUrl as string,
          sourceName: item.sourceName,
        });
      });
      const row = h('div', { 'data-src-item': item.id, class: 'src-item' }, [
        h('span', { class: 'src-item-title' }, item.title),
        h('span', { class: 'src-item-meta' }, `${dateLabel(item)}${item.extra ? ` · ${item.extra}` : ''}`),
        ...(fullBtn === null ? [useBtn] : [useBtn, fullBtn]),
      ]);
      itemsEl.appendChild(row);
    }
    setHidden(itemsEl, items.length === 0);
  }

  function renderRemoveList(): void {
    removeListEl.replaceChildren();
    for (const d of domains) {
      for (const s of d.sources) {
        const btn = h(
          'button',
          { 'data-src-remove': s.id, class: 'collect-btn', type: 'button' },
          isBuiltinSource(s.id) ? '移出推荐' : '删除',
        ) as HTMLButtonElement;
        btn.addEventListener('click', () => {
          if (destroyed || busy) return;
          const next = removeSource(library, s.id);
          if (persist(next)) setStatus(`已移除「${s.name}」。`);
        });
        removeListEl.appendChild(
          h('div', { class: 'src-row' }, [h('span', { class: 'src-name' }, s.name), btn]),
        );
      }
    }
  }

  function render(): void {
    renderDomains();
    renderSources();
    renderItems();
    if (manageOpen) renderRemoveList();
    setHidden(manageEl, !manageOpen);
    setHidden(openBtn, blockedUrl.length === 0);
    setHidden(statusEl, status.length === 0);
    statusEl.textContent = status;
    setHidden(manageBtn, deps.library === undefined || deps.library === null);
    manageBtn.textContent = manageOpen ? '收起维护' : '维护来源';
  }

  render();

  return {
    unmount(): void {
      destroyed = true;
      toastOff?.();
      toastOff = null;
      screen.remove();
    },
  };
}
