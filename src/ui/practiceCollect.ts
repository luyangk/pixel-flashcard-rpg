/**
 * practiceCollect.ts —— Plan 8 · T6：「采新卡」（练功屏的第二个分区）。
 *
 * ## 它是怎么工作的（D43 的玩家驱动摄入）
 * ```
 * 你给一个链接 / 粘一段正文 / 从系统分享进来
 *        ↓ 抓（能直读就直读，不能就如实说 + 存进待读清单）
 *   栏目页？→ 列出条目，你挑一条 → 再抓那一条（"进入一层"）
 *        ↓
 *   AI 改写成候选卡（分块、去重、受每日额度约束）
 *        ↓
 *   你逐条勾选 / 改措辞 / 选目标领域 → 存入卡库（来源可溯源）
 * ```
 *
 * ## 三条产品纪律
 * 1. **候选默认全不勾**：抓来的页面玩家没读过，替他预勾就是替他背书（与卡组页 AI 辅建卡的
 *    "默认全勾"**刻意不同**：那里的文字是玩家自己粘的）；
 * 2. **抓不到要说清 + 存清单**：把玩家刚给的链接丢掉是最恼人的失败；
 * 3. **本屏不认识网络与存储**：抓取/生成/清单/入库全部经注入的口（`ingestUrl`/`collectCards`/
 *    `inbox`/`addCard`/`addDeck`），因此它的每条分支都能在测试里穷举。
 */

import type { Card, Deck } from '@core/types';
import type { CardCandidate } from '@core/llmParse';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import type { IngestResult } from '../app/ingestFlow';
import type { CollectResult } from '../app/knowledgeFlow';
import type { LibraryResult } from '../app/library';
import type { InboxItem } from '../platform/inboxStore';
import { h, setHidden } from './dom';
import { showToast } from './toast';

/** 粘贴正文的长度上限（码点；与 ingest 侧的口径一致，超出由 app 层分块）。 */
export const PASTE_MAX_UI = 12_000;

export interface SharedInput {
  readonly url?: string;
  readonly text?: string;
  readonly title?: string;
}

export interface CollectDeps {
  /** 抓一个链接（宿主接 `app/ingestFlow.ingestUrl`）。缺省 ⇒ 链接入口不显示。 */
  readonly ingestUrl?: (url: string) => Promise<IngestResult>;
  /** 从正文生成候选（宿主接 `app/knowledgeFlow.collectCards`，并在装配层写回额度）。 */
  readonly collectCards?: (input: { text: string; deckName: string; want?: number }) => Promise<CollectResult>;
  /** 待读清单（宿主接 `platform/inboxStore`）。缺省 ⇒ 清单区不显示。 */
  readonly inbox?: {
    readonly load: () => readonly InboxItem[];
    readonly save: (items: readonly InboxItem[]) => boolean;
    readonly clear: () => void;
  };
  readonly addCard?: (input: {
    front: string;
    back: string;
    deckId: string;
    id: string;
    sourceType?: 'llm' | 'hotspot';
    url?: string;
    choices?: readonly string[];
  }) => Promise<LibraryResult<Card>>;
  readonly addDeck?: (input: { name: string; id: string }) => Promise<LibraryResult<Deck>>;
  readonly newId?: () => string;
  /** 生成/入库后让宿主刷新额度行（额度在存档里，屏自己订阅不到它的变化）。 */
  readonly onQuotaChanged?: () => void;
  /** 系统分享进来的内容（PWA share_target；缺省 = 没有）。 */
  readonly sharedInput?: SharedInput | null;
  /**
   * 时钟（缺省 0）。**本屏不许自己读钟**：`tests/app/fullSession.smoke.test.ts` 的 SM#5
   * 是机器化门禁（`src/**` 除 `platform/clock.ts` 外零 `Date.now(`）——首版在这里写
   * `Date.now()` 存 `addedAt`，被那条门禁当场拦下。
   */
  readonly now?: () => number;
  readonly toastMs?: number;
}

export interface CollectHandle {
  unmount(): void;
}

export function mountPracticeCollect(
  root: HTMLElement,
  ctrl: GameController,
  deps: CollectDeps = {},
): CollectHandle {
  if (!root || !ctrl) throw new Error('mount-practice-collect: root/controller required');
  let destroyed = false;
  let toastOff: (() => void) | null = null;
  let seq = 0;
  const newId = typeof deps.newId === 'function' ? deps.newId : () => `collect-${++seq}`;

  /** 当前这批候选（含来源信息：入库时要标 hotspot/llm 与 url）。 */
  let candidates: CardCandidate[] = [];
  let candidateSource: { url?: string; via: 'direct' | 'reader' | 'paste' } = { via: 'paste' };
  /**
   * 这批候选来自待读清单里的哪一条（入库成功后按 **id** 出箱）。
   * 为什么不用 url 匹配：只粘了正文的条目**没有 url**，按 url 匹配会让它永远留在清单里。
   */
  let sourceInboxId: string | null = null;
  let busy = false;

  /* ------------------------------------------------------------ DOM */
  const urlInput = h('input', {
    'data-ui': 'source-url',
    class: 'collect-input',
    type: 'url',
    placeholder: 'https://…（公众号 / 新闻 / 博客都行）',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const urlGoBtn = h('button', { 'data-ui': 'source-go', class: 'collect-btn', type: 'button' }, '抓这一页') as HTMLButtonElement;
  urlGoBtn.addEventListener('click', () => void onFetchUrl(urlInput.value));
  const urlRowEl = h('div', { 'data-ui': 'source-url-row', class: 'collect-row' }, [urlInput, urlGoBtn]);

  const textInput = h('textarea', {
    'data-ui': 'source-text',
    class: 'collect-text',
    placeholder: '把正文粘到这里（公众号 / 新闻读完复制过来最稳）',
    rows: '5',
    maxlength: String(PASTE_MAX_UI),
  }) as HTMLTextAreaElement;
  const pasteGoBtn = h(
    'button',
    { 'data-ui': 'source-paste-go', class: 'collect-btn', type: 'button' },
    '用这段文字生成卡',
  ) as HTMLButtonElement;
  pasteGoBtn.addEventListener('click', () => void onGenerate(textInput.value, { via: 'paste' }));

  const statusEl = h('p', { 'data-ui': 'ingest-status', class: 'field-hint' });
  const linksEl = h('div', { 'data-ui': 'ingest-links', class: 'ingest-links', hidden: true });

  const inboxListEl = h('div', { 'data-ui': 'inbox-list', class: 'inbox-list' });
  const inboxClearBtn = h(
    'button',
    { 'data-ui': 'inbox-clear', class: 'collect-btn', type: 'button' },
    '清空待读清单',
  ) as HTMLButtonElement;
  inboxClearBtn.addEventListener('click', () => {
    if (destroyed || busy || !deps.inbox) return;
    deps.inbox.clear();
    renderInbox();
    toast('待读清单已清空。');
  });
  const inboxEl = h('section', { 'data-ui': 'inbox', class: 'collect-section', hidden: true }, [
    h('h4', { class: 'collect-title' }, '待读清单'),
    h(
      'p',
      { class: 'field-hint' },
      '抓不到的链接先放这儿：读完把正文粘到上面，或者点「重试抓取」。入库后自动出箱。',
    ),
    inboxListEl,
    inboxClearBtn,
  ]);

  const deckSelect = h('select', { 'data-ui': 'cand-deck', class: 'collect-select' }) as HTMLSelectElement;
  const newDeckInput = h('input', {
    'data-ui': 'cand-new-deck',
    class: 'collect-input',
    type: 'text',
    placeholder: '或新建一个领域名（留空 = 不新建）',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const candListEl = h('div', { 'data-ui': 'cand-list', class: 'cand-list' });
  const selectAllBtn = h(
    'button',
    { 'data-ui': 'cand-select-all', class: 'collect-btn', type: 'button' },
    '全选',
  ) as HTMLButtonElement;
  let allSelected = false;
  selectAllBtn.addEventListener('click', () => {
    if (destroyed || busy) return;
    allSelected = !allSelected;
    for (const box of Array.from(candListEl.querySelectorAll('[data-candidate-check]'))) {
      (box as HTMLInputElement).checked = allSelected;
    }
    selectAllBtn.textContent = allSelected ? '全不选' : '全选';
  });
  const candSaveBtn = h(
    'button',
    { 'data-ui': 'cand-save', class: 'collect-save', type: 'button' },
    '存入卡库',
  ) as HTMLButtonElement;
  candSaveBtn.addEventListener('click', () => void onSave());
  const candStatusEl = h('p', { 'data-ui': 'cand-status', class: 'field-hint' });
  const candEl = h('section', { 'data-ui': 'cand-section', class: 'collect-section', hidden: true }, [
    h('h4', { class: 'collect-title' }, '候选卡（勾选要留下的）'),
    h(
      'p',
      { class: 'field-hint' },
      '默认一条都不勾：这些是从你还没读过的页面上改写的，请过一眼再决定留哪几条。',
    ),
    candListEl,
    h('div', { class: 'collect-row' }, [selectAllBtn]),
    h('label', { class: 'collect-row' }, [h('span', { class: 'collect-label' }, '存入'), deckSelect]),
    newDeckInput,
    h('div', { class: 'collect-row' }, [candSaveBtn]),
    candStatusEl,
  ]);

  const screen = h('div', { 'data-ui': 'practice-collect', class: 'practice-collect' }, [
    h('p', { class: 'field-hint' }, '把外部知识带进来：给个链接（能直读就直读），或直接粘正文。'),
    urlRowEl,
    h('div', { class: 'collect-row' }, [pasteGoBtn]),
    textInput,
    statusEl,
    linksEl,
    inboxEl,
    candEl,
  ]);
  root.appendChild(screen);

  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  function renderStatus(text: string): void {
    statusEl.textContent = text;
    setHidden(statusEl, text.length === 0);
  }

  /* ------------------------------------------------------------ 抓取与生成 */
  async function onFetchUrl(rawUrl: string): Promise<void> {
    const url = String(rawUrl ?? '').trim();
    if (destroyed || busy || typeof deps.ingestUrl !== 'function') return;
    if (url.length === 0) {
      renderStatus('先贴一个链接。');
      return;
    }
    busy = true;
    renderStatus('正在抓这一页…');
    renderLinks([]);
    // 抓到的正文要**等 busy 落下之后**再生成：`onGenerate` 自己有 busy 守卫，
    // 在抓取窗口里直接调它会被静默挡掉（首版就是这么让"直读 ⇒ 出候选"整条路失效的，
    // PC#2/PC#5 当场抓到）。故这里先把"待生成"记下来，出了抓取窗口再跑。
    let pending: { text: string; source: { via: 'direct' | 'reader' | 'paste'; url?: string } } | null = null;
    try {
      const res = await deps.ingestUrl(url);
      if (!destroyed) pending = handleIngest(res, url);
    } catch (e) {
      if (!destroyed) renderStatus(`抓取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (!destroyed) render();
    }
    if (pending !== null && !destroyed) await onGenerate(pending.text, pending.source);
  }

  /**
   * 抓取结果的三分支（与 `app/ingestFlow` 的契约一一对应）。
   * 返回"需要拿去生成卡片的正文"（article 分支），其余分支返回 null。
   */
  function handleIngest(
    res: IngestResult,
    url: string,
  ): { text: string; source: { via: 'direct' | 'reader' | 'paste'; url?: string } } | null {
    if (res.kind === 'article') {
      renderStatus(`抓到了《${res.title || '这一页'}》，正在生成卡片…`);
      return { text: res.text, source: { via: res.via, url } };
    }
    if (res.kind === 'links') {
      renderStatus(`这一页是个目录（《${res.title || '未命名'}》），选一条进去看：`);
      renderLinks(res.links);
      return null;
    }
    // blocked：如实说清，并把链接**存进待读清单**（别丢掉玩家刚给的东西）
    renderStatus(res.reason);
    if (deps.inbox && url.length > 0) {
      const items = [...deps.inbox.load()];
      if (!items.some((i) => i.url === url)) {
        items.push({
          id: newId(),
          title: url.slice(0, 80),
          url,
          addedAt: typeof deps.now === 'function' ? deps.now() : 0,
        });
        if (deps.inbox.save(items)) renderInbox();
        else toast('没能存进待读清单（浏览器可能禁用了本地存储）。');
      }
    }
    return null;
  }

  function renderLinks(links: readonly { title: string; url: string }[]): void {
    linksEl.replaceChildren();
    setHidden(linksEl, links.length === 0);
    for (const link of links) {
      const b = h(
        'button',
        { 'data-ingest-link': link.url, class: 'ingest-link', type: 'button' },
        link.title,
      ) as HTMLButtonElement;
      // 点一条 = 再抓一次那一条（"进入一层"的全部实现）
      b.addEventListener('click', () => void onFetchUrl(link.url));
      linksEl.appendChild(b);
    }
  }

  async function onGenerate(
    text: string,
    source: { via: 'direct' | 'reader' | 'paste'; url?: string },
  ): Promise<void> {
    if (destroyed || busy || typeof deps.collectCards !== 'function') return;
    const body = String(text ?? '').trim();
    if (body.length === 0) {
      renderStatus('先粘一段正文，或者给个能直读的链接。');
      return;
    }
    busy = true;
    try {
      const res = await deps.collectCards({ text: body, deckName: currentDeckName() });
      if (destroyed) return;
      if (!res.ok) {
        renderStatus(res.reason);
        return;
      }
      candidates = [...res.candidates];
      candidateSource = source.url === undefined ? { via: source.via } : { via: source.via, url: source.url };
      renderStatus(
        res.truncated
          ? `生成了 ${candidates.length} 张候选（这部分资料没能全部处理完，可再点一次接着挖）。`
          : `生成了 ${candidates.length} 张候选（发了 ${res.requests} 次请求），勾选后存入卡库。`,
      );
      renderCandidates();
      deps.onQuotaChanged?.();
    } catch (e) {
      if (!destroyed) renderStatus(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  function currentDeckName(): string {
    const name = newDeckInput.value.trim();
    if (name.length > 0) return name;
    const opt = deckSelect.selectedOptions?.[0];
    return opt?.textContent?.trim() ?? '新知识';
  }

  /* ------------------------------------------------------------ 候选渲染与入库 */
  function renderCandidates(): void {
    candListEl.replaceChildren();
    setHidden(candEl, candidates.length === 0);
    allSelected = false;
    selectAllBtn.textContent = '全选';
    candidates.forEach((c, i) => {
      const check = h('input', {
        'data-candidate-check': String(i),
        class: 'candidate-check',
        type: 'checkbox',
        // **默认不勾**（D47）：抓来的页面玩家没读过，不替他预勾
      }) as HTMLInputElement;
      check.checked = false;
      const front = h('input', {
        'data-candidate-front': String(i),
        class: 'candidate-input',
        type: 'text',
        value: c.front,
      }) as HTMLInputElement;
      const back = h('input', {
        'data-candidate-back': String(i),
        class: 'candidate-input',
        type: 'text',
        value: c.back,
      }) as HTMLInputElement;
      candListEl.appendChild(
        h(
          'div',
          {
            'data-candidate': String(i),
            'data-candidate-choices': (c.choices ?? []).join('\u0001'),
            'data-candidate-tags': (c.tags ?? []).join('\u0001'),
            class: 'candidate',
          },
          [check, front, back],
        ),
      );
    });
  }

  async function onSave(): Promise<void> {
    if (destroyed || busy || typeof deps.addCard !== 'function') return;
    const rows = Array.from(candListEl.children) as HTMLElement[];
    const picked: Array<{ front: string; back: string; choices: string[]; tags: string[] }> = [];
    for (const row of rows) {
      const check = row.querySelector('[data-candidate-check]') as HTMLInputElement | null;
      if (!check || !check.checked) continue; // 没勾的不入库
      const front = (row.querySelector('[data-candidate-front]') as HTMLInputElement | null)?.value ?? '';
      const back = (row.querySelector('[data-candidate-back]') as HTMLInputElement | null)?.value ?? '';
      const split = (attr: string): string[] =>
        (row.getAttribute(attr) ?? '')
          .split('\u0001')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      picked.push({ front, back, choices: split('data-candidate-choices'), tags: split('data-candidate-tags') });
    }
    if (picked.length === 0) {
      candStatusEl.textContent = '先勾几张要留下的（默认一条都没勾）。';
      return;
    }

    busy = true;
    candSaveBtn.disabled = true;
    try {
      // 需要时先建领域（重名/空名都会在这里被如实挡下）
      let deckId = deckSelect.value;
      const newName = newDeckInput.value.trim();
      if (newName.length > 0) {
        if (typeof deps.addDeck !== 'function') {
          candStatusEl.textContent = '这个版本还不能新建领域。';
          return;
        }
        const made = await deps.addDeck({ name: newName, id: newId() });
        if (!made.ok) {
          candStatusEl.textContent = made.reason; // 例如"已经有同名（或同编号）的领域了。"
          return;
        }
        deckId = made.value.id;
      }
      if (deckId.length === 0) {
        candStatusEl.textContent = '先选一个领域（或新建一个）。';
        return;
      }

      let added = 0;
      const failures: string[] = [];
      for (const item of picked) {
        try {
          const res = await deps.addCard({
            front: item.front,
            back: item.back,
            deckId,
            id: newId(),
            // 链接来的标 hotspot 且带 url（可溯源）；纯粘贴的标 llm
            sourceType: candidateSource.url === undefined ? 'llm' : 'hotspot',
            ...(candidateSource.url === undefined ? {} : { url: candidateSource.url }),
            ...(item.choices.length > 0 ? { choices: item.choices } : {}),
          });
          if (res.ok) added += 1;
          else failures.push(res.reason);
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (added > 0) {
        candidates = [];
        renderCandidates();
        candStatusEl.textContent = '';
        toast(`已加入 ${added} 张卡。`);
        // 入库成功 = 这条来源处理完了 ⇒ 从待读清单出箱（按 id，text-only 条目也能出箱）
        if (deps.inbox) {
          const before = deps.inbox.load();
          // **只出箱这一条**：优先按 id（来自清单的那条最准）；没有 id 才按 url 兜底；
          // 两者都没有线索 ⇒ 一条都不动（宁可不删，也不误删玩家别的待读条目）。
          // 首版把两个条件用 `&&` 串起来：对"只有正文、没有链接"的条目，`url !== undefined`
          // 恒假 ⇒ 会把**所有**无链接条目一起放过（PC#3b 的 c 用例当场抓到）。
          const left = before.filter((i) => {
            if (sourceInboxId !== null) return i.id !== sourceInboxId;
            if (candidateSource.url !== undefined) return i.url !== candidateSource.url;
            return true;
          });
          if (left.length !== before.length) {
            deps.inbox.save(left);
            renderInbox();
          }
        }
        sourceInboxId = null;
        deps.onQuotaChanged?.();
      }
      if (failures.length > 0) candStatusEl.textContent = `有 ${failures.length} 张没加进去：${failures[0]}`;
    } finally {
      busy = false;
      candSaveBtn.disabled = false;
      if (!destroyed) render();
    }
  }

  /* ------------------------------------------------------------ 待读清单 */
  function renderInbox(): void {
    if (!deps.inbox) {
      setHidden(inboxEl, true);
      return;
    }
    const items = deps.inbox.load();
    setHidden(inboxEl, items.length === 0);
    inboxListEl.replaceChildren();
    for (const item of items) {
      const hasText = typeof item.text === 'string' && item.text.length > 0;
      const useBtn = h(
        'button',
        { 'data-inbox-use': item.id, class: 'collect-btn', type: 'button' },
        hasText ? '用它的正文生成' : '重试抓取',
      ) as HTMLButtonElement;
      useBtn.addEventListener('click', () => {
        if (destroyed || busy) return;
        if (hasText) {
          sourceInboxId = item.id;
          void onGenerate(item.text ?? '', { via: 'paste', url: item.url });
        }
        else if (item.url !== undefined) void onFetchUrl(item.url);
      });
      const dropBtn = h(
        'button',
        { 'data-inbox-drop': item.id, class: 'collect-btn', type: 'button' },
        '丢掉',
      ) as HTMLButtonElement;
      dropBtn.addEventListener('click', () => {
        if (destroyed || busy || !deps.inbox) return;
        deps.inbox.save(deps.inbox.load().filter((i) => i.id !== item.id));
        renderInbox();
      });
      inboxListEl.appendChild(
        h('div', { 'data-inbox-item': item.id, class: 'inbox-item' }, [
          h('span', { class: 'inbox-title' }, item.title),
          useBtn,
          dropBtn,
        ]),
      );
    }
  }

  /* ------------------------------------------------------------ 领域下拉与总渲染 */
  function renderDeckSelect(snap: ControllerSnapshot): void {
    const decks = Array.isArray(snap.save?.decks) ? snap.save.decks : [];
    const prev = deckSelect.value;
    deckSelect.replaceChildren();
    for (const deck of decks) {
      if (!deck || typeof deck.id !== 'string') continue;
      const opt = h('option', { value: deck.id }, deck.name) as HTMLOptionElement;
      deckSelect.appendChild(opt);
    }
    if (prev.length > 0 && decks.some((d) => d.id === prev)) deckSelect.value = prev;
  }

  /** 只切显隐形/禁用态；候选与清单的内容各自有专门的渲染函数。 */
  function render(): void {
    renderDeckSelect(ctrl.snapshot());
    setHidden(urlRowEl, typeof deps.ingestUrl !== 'function');
    const canGenerate = typeof deps.collectCards === 'function';
    setHidden(pasteGoBtn, !canGenerate);
    setHidden(candSaveBtn.parentElement as HTMLElement, typeof deps.addCard !== 'function');
    candSaveBtn.disabled = busy || candidates.length === 0;
  }

  const unsubscribe = ctrl.subscribe(() => {
    if (!destroyed) render();
  });

  // 分享进来（PWA share_target）：有链接就直接开抓，只有正文就填进粘贴框
  const shared = deps.sharedInput ?? null;
  if (shared?.url !== undefined && shared.url.length > 0) {
    urlInput.value = shared.url;
    renderStatus('从系统分享进来的链接，正在抓取…');
    void onFetchUrl(shared.url);
  } else if (shared?.text !== undefined && shared.text.length > 0) {
    textInput.value = shared.text;
    renderStatus('从系统分享进来的正文，确认无误后点「用这段文字生成卡」。');
  }

  renderInbox();
  render();

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
