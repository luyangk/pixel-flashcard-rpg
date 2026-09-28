/**
 * codex.ts —— Plan 4 · T8：藏书阁（一级页：净化条目 + 彩蛋 + 练习关 + 行记三幕）。
 *
 * 这是"玩家打过的仗变成了什么"的展示面，三块内容各有权威来源：
 * - **条目**：`save.decks` 里 `purifiedAt` 非空的领域，按净化时间**新者前**（老板最后看见
 *   自己刚净化的那一个在最上面）。称号取 `bossFlow.bossNameOf`（存档有就用，否则默认模板）。
 * - **彩蛋**：预置领域取 `assets/narrative/eggs.json`（LORE §5.4）；自建领域自 Plan 5 · T5
 *   起可以有一条自己的 `deck.egg`（AI 产出经玩家点「用这段」后才写进去）。取值优先级是
 *   `deck.egg` → `eggs.json` 的键 → 字面「已净化」：没有彩蛋的领域如实留白，绝不编一段
 *   假冷知识（编造内容比留白更糟）。
 * - **行记**：两块内容——
 *   ① 三幕暗线（LORE §5.3），解锁判据是 `settings.story.arcSeen`（由净化数 3/6/9 驱动，
 *      写口在 app/bossFlow.markArcSeen）。未解锁的幕显示"尚未显现"，已解锁的永久可回看。
 *   ② **历史战报**（T8 评审判 I-1 的补齐）：用 beats 池 + `settings.story.beatIndex`
 *      **确定性回放**已经抽过的那些句子（`nextBeat(pool, i)` 对 i=0..cursor-1 逐个重放——
 *      beats.ts 的排期由 (池长, 轮次) 派生，同一游标恒得同一句，所以回放不是"再抽一次"，
 *      不消耗任何随机源、也不推进游标）。行记因此真的是 LORE §7 说的"战报/暗线阅读区"。
 *
 * 练习关（重战）：已净化领域的入口调 `deps.onPractice(deckId)`——**屏内不自己拼 startFight
 * 参数**（池子上限、难度档、单领域约束的口径在 app/bossFlow.bossFightParams，宿主一处装配）。
 */
import type { Card, Deck, SaveFile } from '@core/types';
import { localDayString } from '@core/reviewLedger';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { bossNameOf, purifiedCount } from '../app/bossFlow';
import { nextBeat, type BeatEntry } from './beats';
import { h, setHidden } from './dom';
import { showToast } from './toast';

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
  /** 战报模板池（缺省 = 历史战报区只显示"还没有战报"）。 */
  readonly beats?: readonly BeatEntry[];
  /** 历史战报最多显示多少条（缺省 20；越久越早的会被截掉）。 */
  readonly beatHistoryLimit?: number;
  /**
   * AI 彩蛋生成（Plan 5 · T5；宿主接 `app/llmFlow.suggestEgg`）。缺省则隐藏该入口。
   * 它**只回文本**：写入仍要玩家点「用这段」→ `setEgg`。
   */
  readonly llmEgg?: (
    deckName: string,
    sampleFronts?: readonly string[],
  ) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /** 彩蛋写口（宿主接 `app/codexFlow.setEggOnDeck`）。缺省则隐藏该入口。 */
  readonly setEgg?: (deckId: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** toast 存活毫秒（彩蛋回执用；测试给 0 免定时器）。 */
  readonly toastMs?: number;
  /** 时区偏移（净化日期显示用；日期本体取 deck.purifiedAt，故不需要时钟）。 */
  readonly tzOffsetMin?: number;
}

export interface CodexHandle {
  unmount(): void;
}

/** 行记最多回放多少条（见 renderBeatHistory 的上限说明）。 */
const HISTORY_SCAN_MAX = 500;

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
  const beats = Array.isArray(deps.beats) ? deps.beats : [];
  const historyLimit =
    typeof deps.beatHistoryLimit === 'number' && Number.isFinite(deps.beatHistoryLimit) && deps.beatHistoryLimit > 0
      ? Math.floor(deps.beatHistoryLimit)
      : 20;
  const tzOffsetMin = typeof deps.tzOffsetMin === 'number' && Number.isFinite(deps.tzOffsetMin) ? deps.tzOffsetMin : 0;
  /** 生成口与写入口**都在**才显示「让 AI 写彩蛋」（缺一个就是不显示点了没反应的入口）。 */
  const canAuthorEgg = typeof deps.llmEgg === 'function' && typeof deps.setEgg === 'function';
  let toastOff: (() => void) | null = null;
  /** 正在生成彩蛋的领域 id（null = 没有在途请求）；生成中禁用所有「让 AI 写彩蛋」。 */
  let eggBusyDeckId: string | null = null;
  /** 「用这段」在途（写入中禁用两键，免得半途重复提交）。 */
  let eggAccepting = false;
  /** 预览归属的领域与其正文（null = 没有预览）。 */
  let previewDeckId: string | null = null;
  let previewText = '';
  /** 每个条目行上的「让 AI 写彩蛋」按钮（render 里逐个刷 disabled，不重建整个列表）。 */
  const eggButtons = new Map<string, HTMLButtonElement>();

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
  /** 历史战报区（独立于三幕，故各自一个指纹）。 */
  const beatHistoryEl = h('ol', { 'data-ui': 'beat-history', class: 'beat-history', hidden: true });
  const beatEmptyEl = h('p', { 'data-ui': 'beat-history-empty', class: 'field-hint' }, '还没有战报。打一场吧。');
  const beatSectionEl = h('section', { 'data-ui': 'beat-section', class: 'beat-section' }, [
    h('h4', { class: 'field-title' }, '战报'),
    beatEmptyEl,
    beatHistoryEl,
  ]);
  journalEl.appendChild(beatSectionEl);

  /**
   * AI 彩蛋预览区（Plan 5 · T5）：**全屏一个**（不是每行一个），因为同一时刻只该有一份
   * 待确认的产出——多份预览会让"「用这段」到底写进哪个领域"变得含糊。
   */
  const eggPreviewTextEl = h('p', { 'data-ui': 'egg-preview-text', class: 'egg-preview-text' });
  const eggAcceptBtn = h('button', { 'data-ui': 'egg-accept', class: 'egg-accept', type: 'button' }, '用这段') as HTMLButtonElement;
  const eggDiscardBtn = h('button', { 'data-ui': 'egg-discard', class: 'egg-discard', type: 'button' }, '不要') as HTMLButtonElement;
  const eggPreviewEl = h('section', { 'data-ui': 'egg-preview', class: 'egg-preview', hidden: true }, [
    h('h4', { class: 'field-title' }, 'AI 写的彩蛋'),
    eggPreviewTextEl,
    eggAcceptBtn,
    eggDiscardBtn,
  ]);

  const screen = h('div', { 'data-ui': 'codex-screen', class: 'codex-screen' }, [
    headerEl,
    listEl,
    emptyEl,
    eggPreviewEl,
    journalEl,
  ]);
  root.appendChild(screen);

  let destroyed = false;
  let listKey = '';
  let journalKey = '';
  let historyKey = '';

  /* ------------------------------------------------------------ 条目 */
  function entryRow(entry: CodexEntry, cards: readonly Card[]): HTMLElement {
    const deck = entry.deck;
    // 取值优先级（Plan 5 · T5）：自建领域的 `deck.egg` → 预置 eggs.json 的键 → 字面「已净化」。
    // 自建领域优先读自己的字段，玩家 AI 写过的彩蛋因此不会被空白的预置表盖掉。
    const presetEgg = typeof eggs[deck.id] === 'string' ? eggs[deck.id] : '';
    const ownEgg = typeof deck.egg === 'string' ? deck.egg : '';
    const egg = ownEgg.length > 0 ? ownEgg : presetEgg;
    const n = deckCardCount(cards, deck.id);
    const practice = h(
      'button',
      { 'data-practice': deck.id, class: 'practice-btn', type: 'button' },
      '重战（练习关）',
    ) as HTMLButtonElement;
    if (typeof deps.onPractice === 'function') practice.addEventListener('click', () => deps.onPractice?.(deck.id));
    else practice.disabled = true;

    const kids: HTMLElement[] = [
      h('h3', { 'data-ui': 'entry-name', class: 'entry-name' }, bossNameOf(deck)),
      h('div', { 'data-ui': 'entry-meta', class: 'entry-meta' }, [
        `${n} 张卡 · 净化于 ${localDayString(entry.purifiedAt, tzOffsetMin)}`,
      ]),
      h('p', { 'data-ui': 'entry-egg', class: 'entry-egg' }, egg.length > 0 ? egg : '已净化'),
      practice,
    ];

    // 「让 AI 写彩蛋」：**只对还没有彩蛋的领域**显示（既非预置键、也没有 deck.egg）——
    // 已有彩蛋的领域再挂一个生成入口，只会诱使玩家覆盖掉自己已经满意的那段。
    if (canAuthorEgg && egg.length === 0) {
      const aiBtn = h(
        'button',
        { 'data-ui': 'egg-ai', 'data-egg-deck': deck.id, class: 'egg-ai-btn', type: 'button' },
        '让 AI 写彩蛋',
      ) as HTMLButtonElement;
      aiBtn.addEventListener('click', () => void onWriteEgg(deck.id));
      eggButtons.set(deck.id, aiBtn);
      kids.push(aiBtn);
    }

    return h('li', { 'data-codex-entry': deck.id, class: 'codex-entry' }, kids);
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
    // 三幕重建用的是 replaceChildren ⇒ 会连带摘掉历史战报区，这里把它挂回去
    // （appendChild 对已在树上的节点是"移动"，不会产生第二份）。
    journalEl.appendChild(beatSectionEl);
  }

  /**
   * 历史战报：确定性回放（见文件头）。`cursor <= 0` 或池为空 ⇒ 只显示空态。
   * 回放出的空句（脏游标/脏模板）直接跳过——它们是"没内容"，不该在行记里占一行。
   */
  function renderBeatHistory(cursor: number): void {
    // 回放上限（Plan 4 终审 Minor）：游标是外部存档来的，`beatIndex=1e9` 的脏档会让
    // 这里循环十亿次当场卡死藏书阁。行记本来也只当"最近的战报"读，故封顶到
    // HISTORY_SCAN_MAX 次回放（超出部分不显示，绝不为了显示历史而冻结界面）。
    const raw = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
    const wanted = Math.min(raw, HISTORY_SCAN_MAX);
    const key = `${wanted}|${beats.length}|${historyLimit}`;
    if (key === historyKey) return;
    historyKey = key;

    const texts: string[] = [];
    for (let i = 0; i < wanted; i++) {
      const draw = nextBeat(beats, i);
      if (draw.text.length > 0) texts.push(draw.text);
    }
    const shown = texts.slice(Math.max(0, texts.length - historyLimit));
    beatHistoryEl.replaceChildren();
    for (const text of shown) {
      beatHistoryEl.appendChild(h('li', { 'data-beat': '', class: 'beat-line' }, text));
    }
    setHidden(beatHistoryEl, shown.length === 0);
    setHidden(beatEmptyEl, shown.length > 0);
  }

  /* ------------------------------------------------------------ 渲染 */
  function render(snap: ControllerSnapshot): void {
    const save = snap.save;
    const entries = purifiedEntries(save);
    const cards = Array.isArray(save?.cards) ? save.cards : [];

    // 指纹带**逐领域**卡数（评审 m-6）：只用全库 cards.length 时，卡在两个领域间搬移
    // （总数不变）不会刷新条目里的「N 张卡」——T7 的卡组页刚因同类问题修过。
    // 【Plan 5 · T5 扩指纹】`deck.egg` 也必须进指纹：否则「用这段」写进去之后快照虽变、
    // 条目却继续显示「已净化」（内容变了不重建 = 屏上违背权威存档）。
    const key = entries
      .map(
        (e) =>
          `${e.deck.id}:${e.deck.bossName ?? ''}:${e.purifiedAt}:${deckCardCount(cards, e.deck.id)}:${e.deck.egg ?? ''}`,
      )
      .join('|');
    if (key !== listKey) {
      listKey = key;
      eggButtons.clear(); // 列表重建 ⇒ 旧按钮全部作废（避免 Map 里留着已摘掉的节点）
      listEl.replaceChildren();
      for (const entry of entries) listEl.appendChild(entryRow(entry, cards));
      setHidden(emptyEl, entries.length > 0);
    }
    countEl.textContent = entries.length === 0 ? '空卷' : `已净化 ${purifiedCount(save)} 个领域`;

    // 生成/写入在途 ⇒ 所有「让 AI 写彩蛋」禁用；预览区只由 previewDeckId 驱动显隐
    for (const btn of eggButtons.values()) btn.disabled = eggBusyDeckId !== null || eggAccepting;
    setHidden(eggPreviewEl, previewDeckId === null);
    eggAcceptBtn.disabled = eggAccepting;
    eggDiscardBtn.disabled = eggAccepting;

    renderJournal(save.settings.story.arcSeen);
    renderBeatHistory(save.settings.story.beatIndex);
    setHidden(backBtn, typeof deps.onNav !== 'function');
  }

  /* ------------------------------------------------------------ AI 彩蛋（Plan 5 · T5） */
  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  /** 收起预览（零写入）：预览只是"待确认的草稿"，丢掉它不碰存档。 */
  function clearPreview(): void {
    previewDeckId = null;
    previewText = '';
    eggPreviewTextEl.textContent = '';
    setHidden(eggPreviewEl, true);
  }

  /**
   * 「让 AI 写彩蛋」：生成中禁用 → 把正文放进预览区等玩家确认。
   * 失败只 toast 一句人话（不抛、不写盘）；**成功也不写盘**——写入要等「用这段」。
   */
  async function onWriteEgg(deckId: string): Promise<void> {
    if (destroyed || eggBusyDeckId !== null || eggAccepting || !deps.llmEgg) return;
    const deck = ctrl.snapshot().save?.decks.find((d) => d.id === deckId);
    eggBusyDeckId = deckId;
    clearPreview(); // 一次只留一份待确认产出（见 eggPreviewEl 的注释）
    render(ctrl.snapshot());
    try {
      // 同 prepare：带上 ≤5 条正面样例（只正面，不发答案）
      const cardFronts = (ctrl.snapshot().save.cards ?? [])
        .filter((c) => c && c.deckId === deckId)
        .slice(0, 5)
        .map((c) => String(c.front ?? ''));
      const res = await deps.llmEgg(deck?.name ?? '', cardFronts);
      if (destroyed || eggBusyDeckId !== deckId) return; // 屏已拆/已换目标：结果作废
      if (!res || res.ok !== true) {
        toast(res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : 'AI 没能写出彩蛋。');
        return;
      }
      previewDeckId = deckId;
      previewText = res.text;
      eggPreviewTextEl.textContent = res.text;
      setHidden(eggPreviewEl, false);
    } catch (e) {
      if (!destroyed) toast(`AI 写彩蛋失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (eggBusyDeckId === deckId) eggBusyDeckId = null;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  /** 「用这段」：唯一写入口（`deps.setEgg` → app/codexFlow.setEggOnDeck → deck.egg）。 */
  async function onAcceptEgg(): Promise<void> {
    if (destroyed || eggAccepting || previewDeckId === null || !deps.setEgg) return;
    const deckId = previewDeckId;
    const text = previewText;
    eggAccepting = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.setEgg(deckId, text);
      if (destroyed) return;
      if (res && res.ok) {
        clearPreview();
        toast('彩蛋已写进图鉴。');
      } else {
        // 写失败时**保留预览**：玩家的文本还在，可以再点一次（而不是白等一场）
        toast(res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '彩蛋没能写进存档。');
      }
    } catch (e) {
      if (!destroyed) toast(`彩蛋没能写进存档：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      eggAccepting = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  backBtn.addEventListener('click', () => deps.onNav?.('menu'));
  eggAcceptBtn.addEventListener('click', () => void onAcceptEgg());
  eggDiscardBtn.addEventListener('click', () => {
    if (destroyed || eggAccepting) return;
    clearPreview();
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
