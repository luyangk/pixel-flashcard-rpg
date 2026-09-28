/**
 * prepare.ts —— Plan 4 · T7：备战屏（领域多选 + 池子三挡 + 「随机」+ 开战）。
 *
 * 这一屏是 PRD §3 的"选卡组 → 开局"画面化。三条口径：
 *
 * 1. **选择模型只有两个变量**：`selected`（选中的领域 id 集）与 `random`（不限定领域）。
 *    二者互斥且永远有一个成立——这是"请求 deckIds"语义的忠实映射：
 *      - `random === true`  → intent **不带** deckIds（= 全库随机，battleFlow 的口径）；
 *      - `random === false` → intent 带 `deckIds: [...selected]`。
 *    点任一领域 chip ⇒ random=false；把最后一个领域取消 ⇒ 自动回落 random=true。
 *    没有第三种中间态（"随机 + 又选了领域"没有语义，不让它存在）。
 * 2. **三挡池子**：10/15/25（brief verbatim），初值取 `settings.battle.defaultPoolSize`
 *    **就近吸附**到三挡之一（存档里是脏值时也不让屏上没有选中项）。开战时传的是
 *    选中值而不是"跟着存档走"——备战屏的选择权在玩家，落不落回设置位归设置屏（T11）。
 * 3. **错误分流（兑现 T2 deferred）**：`snapshot.lastError` 的 code 决定引导动作——
 *    `no-cards`/`insufficient-cards` ⇒ 引导去卡组页（那儿能加卡/导入备份）；
 *    `invalid-size` ⇒ 提示换一挡。文案直接取 `lastError.message`（battleFlow 已是白话），
 *    本模块只加一句"下一步该干嘛"。
 *
 * 拆除：本屏没有全局监听（无 rAF、无 window 事件），DOM 全在 `screen` 之下，
 * `screen.remove()` 即拆干净；唯一需要显式撤销的是对控制器的订阅。
 */
import type { Card, Deck } from '@core/types';
import type { NameCandidate, ParseResult } from '@core/llmParse';
import type { ControllerSnapshot, GameController, StartErrorCode } from '../app/controllerTypes';
import {
  bossFightParams,
  bossGates,
  bossNameOf,
  defaultBossName,
  type BossNameResult,
} from '../app/bossFlow';
import { h, setHidden } from './dom';
import { showToast } from './toast';

/** 合法池子三挡（PRD §3；与 settings.battle.defaultPoolSize 的合法域一致）。 */
export const POOL_SIZES: readonly number[] = [10, 15, 25];

export interface PrepareDeps {
  /**
   * 屏内导航：'decks' 用于错误引导（缺省则不显示引导按钮）；
   * 'menu' 用于返回按钮（T11 评审判 I-1：备战屏此前没有任何退出入口，是条导航死路）。
   */
  readonly onNav?: (target: 'decks' | 'menu') => void;
  /**
   * 卷灵称号写口（宿主接 app/bossFlow.setBossName）。缺省时**不问称号**、直接开战——
   * 这样没有写口的宿主（测试/降级装配）也不会卡在弹窗上。
   */
  readonly setBossName?: (deckId: string, raw: string) => Promise<BossNameResult>;
  /**
   * AI 起名（Plan 5 · T5；宿主接 `app/llmFlow.suggestBossNames`）。缺省则弹窗里不显示该入口。
   * 它**只回候选**：点候选只把名字填进输入框，入库仍走既有「就用这个名字」→ `setBossName`。
   */
  readonly llmNames?: (deckName: string) => Promise<ParseResult<NameCandidate>>;
  /** toast 存活毫秒（称号回执用；测试给 0 免定时器）。 */
  readonly toastMs?: number;
}

export interface PrepareHandle {
  unmount(): void;
}

/** 存档里的 defaultPoolSize 就近吸附（取距离最小者；并列取更小的挡——偏好短局）。 */
export function nearestPoolSize(value: unknown): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : POOL_SIZES[0];
  let best = POOL_SIZES[0];
  for (const size of POOL_SIZES) {
    if (Math.abs(size - v) < Math.abs(best - v)) best = size;
  }
  return best;
}

/** 每个 code 的"下一步"引导语（message 本体由 battleFlow 给，这里只补动作）。 */
const NEXT_STEP: Record<StartErrorCode, string> = {
  'no-cards': '先去「卡组」加几张，或者导入一份备份。',
  'insufficient-cards': '去「卡组」多攒几张卡再来。',
  'invalid-size': '换个池子大小再试。',
};

/** 需要去卡组页解决的错误码（决定是否显示引导按钮）。 */
function needsLibrary(code: StartErrorCode): boolean {
  return code === 'no-cards' || code === 'insufficient-cards';
}

function cardCountByDeck(cards: readonly Card[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cards) {
    if (!c || typeof c.deckId !== 'string') continue;
    out.set(c.deckId, (out.get(c.deckId) ?? 0) + 1);
  }
  return out;
}

/**
 * 在 root 里挂备战屏。开战期间的连点由 `pending` 挡住：intent 未回来前按钮禁用
 * （与 battleScreen 同款——双开一局会让会话位互相覆盖）。
 */
export function mountPrepare(root: HTMLElement, ctrl: GameController, deps: PrepareDeps = {}): PrepareHandle {
  if (!root || !ctrl) throw new Error('mount-prepare: root/controller required');

  const initial = ctrl.snapshot();
  let random = true;
  const selected = new Set<string>();
  let size = nearestPoolSize(initial.save?.settings?.battle?.defaultPoolSize);
  let pending = false;
  let destroyed = false;
  let toastOff: (() => void) | null = null;
  /** 正在等称号输入的领域 id（null = 没开弹窗）。 */
  let namingDeckId: string | null = null;
  /** AI 起名在途（禁用按钮防连点；**不**禁用确认，玩家随时可以手打名字走既有路径）。 */
  let nameAiBusy = false;
  /** 代际令牌：关窗/重开会让在途的旧请求作废，免得候选写进下一次弹窗。 */
  let nameAiToken = 0;

  /* ------------------------------------------------------------ DOM 外壳 */
  const chipsEl = h('div', { 'data-ui': 'deck-chips', class: 'deck-chips' });
  const chips = new Map<string, HTMLButtonElement>();
  /** 「随机」chip：没有 deckIds 的那条路，永远是合法选择。 */
  const randomChip = h(
    'button',
    { 'data-ui': 'deck-random', class: 'chip chip-random', type: 'button' },
    '随机',
  ) as HTMLButtonElement;
  chipsEl.appendChild(randomChip);

  const sizeEl = h('div', { 'data-ui': 'size-picker', class: 'size-picker' });
  const sizeButtons = new Map<number, HTMLButtonElement>();
  for (const s of POOL_SIZES) {
    const b = h('button', { 'data-size': String(s), class: 'size-btn', type: 'button' }, `${s} 张`) as HTMLButtonElement;
    sizeButtons.set(s, b);
    sizeEl.appendChild(b);
  }

  const bossRowEl = h('div', { 'data-ui': 'boss-row', class: 'boss-row' });
  const bossNameInput = h('input', {
    'data-ui': 'boss-name-input',
    class: 'boss-name-input',
    type: 'text',
    placeholder: '',
  }) as HTMLInputElement;
  const bossNameDefaultBtn = h(
    'button',
    { 'data-ui': 'boss-name-default', class: 'boss-name-default', type: 'button' },
    '用默认称号',
  ) as HTMLButtonElement;
  const bossNameConfirmBtn = h(
    'button',
    { 'data-ui': 'boss-name-confirm', class: 'boss-name-confirm', type: 'button' },
    '就用这个名字',
  ) as HTMLButtonElement;
  /* AI 起名（Plan 5 · T5）：只回候选、只填输入框——入库的唯一路径仍是「就用这个名字」。 */
  const bossNameAiBtn = h(
    'button',
    { 'data-ui': 'boss-name-ai', class: 'boss-name-ai', type: 'button' },
    '让 AI 起几个名',
  ) as HTMLButtonElement;
  const bossNameAiStatusEl = h('p', { 'data-ui': 'boss-name-ai-status', class: 'boss-name-ai-status' });
  const bossNameAiListEl = h('div', { 'data-ui': 'boss-name-ai-list', class: 'boss-name-ai-list' });
  const bossNameDialog = h('div', { 'data-ui': 'boss-name-dialog', class: 'boss-name-dialog', hidden: true }, [
    h('h3', { 'data-ui': 'boss-name-title', class: 'boss-name-title' }, '给它起个称号'),
    h('p', { class: 'boss-name-hint' }, '自建领域的卷灵第一次现身——它的称号由你定，最多 30 字。'),
    bossNameInput,
    bossNameAiBtn,
    bossNameAiStatusEl,
    bossNameAiListEl,
    bossNameDefaultBtn,
    bossNameConfirmBtn,
  ]);
  const totalEl = h('p', { 'data-ui': 'pool-total', class: 'pool-total' });
  const errorEl = h('p', { 'data-ui': 'start-error', class: 'start-error', hidden: true });
  const backBtn = h('button', { 'data-ui': 'back', class: 'back-btn', type: 'button' }, '返回') as HTMLButtonElement;
  const errorGoBtn = h(
    'button',
    { 'data-ui': 'error-go-decks', class: 'error-go', type: 'button' },
    '去卡组',
  ) as HTMLButtonElement;
  const startBtn = h('button', { 'data-ui': 'start', class: 'start-btn', type: 'button' }, '开战') as HTMLButtonElement;

  const screen = h('div', { 'data-ui': 'prepare-screen', class: 'prepare-screen' }, [
    h('header', { class: 'prepare-header' }, [backBtn, h('h2', { class: 'screen-title' }, '备战')]),
    chipsEl,
    h('h3', { class: 'field-title' }, '池子大小'),
    sizeEl,
    totalEl,
    bossRowEl,
    bossNameDialog,
    errorEl,
    errorGoBtn,
    startBtn,
  ]);
  root.appendChild(screen);

  /* ------------------------------------------------------------ 渲染 */
  function renderChips(decks: readonly Deck[], counts: Map<string, number>): void {
    // 领域集合变了才重建 chips 节点（用 id 串当"集合指纹"，避免每次快照都重建 DOM）
    const fingerprint = decks.map((d) => d.id).join('\u0000');
    if (chipsEl.getAttribute('data-decks') !== fingerprint) {
      chipsEl.setAttribute('data-decks', fingerprint);
      chipsEl.replaceChildren(randomChip);
      chips.clear();
      for (const d of decks) {
        const b = h('button', { 'data-deck-id': d.id, class: 'chip', type: 'button' }, d.name) as HTMLButtonElement;
        b.addEventListener('click', () => onToggleDeck(d.id));
        chips.set(d.id, b);
        chipsEl.appendChild(b);
      }
      // 已经消失的领域从选中集里剔除（导入备份把 decks 整体换掉时会发生）
      for (const id of [...selected]) if (!chips.has(id)) selected.delete(id);
      if (selected.size === 0) random = true;
    }

    for (const [id, b] of chips) {
      const deck = decks.find((d) => d.id === id);
      const n = counts.get(id) ?? 0;
      b.textContent = `${deck?.name ?? id}（${n}）`;
      const on = !random && selected.has(id);
      b.setAttribute('aria-pressed', String(on));
      // 空领域点了也开不了局（buildPool 会给出 insufficient-cards）——直接不可选更省事，
      // 但已选中的必须保持可点，否则玩家取消不掉它。
      b.disabled = n === 0 && !on;
    }
    randomChip.setAttribute('aria-pressed', String(random));

    let total = 0;
    for (const n of counts.values()) total += n;
    totalEl.textContent = total === 0 ? '卡库还是空的。' : `卡库共 ${total} 张卡。`;
  }

  /**
   * 卷灵区：只列**已达标**的领域（门槛口径在 app/bossFlow：引导域特调 15，其余取设置档）。
   * 文案带 `已复习 count/threshold`，让玩家知道"差多少"——这是 PRD「苦修」叙事的可见面。
   */
  function renderBossRow(save: ControllerSnapshot['save']): void {
    const gates = bossGates(save);
    const ready = gates.filter((g) => g.ready);
    const fingerprint = ready
      .map((g) => {
        const deck = save.decks.find((d) => d.id === g.deckId);
        return `${g.deckId}:${g.count}/${g.threshold}:${deck ? bossNameOf(deck) : ''}`;
      })
      .join('|');
    if (bossRowEl.getAttribute('data-boss-row') === fingerprint) return;
    bossRowEl.setAttribute('data-boss-row', fingerprint);
    bossRowEl.replaceChildren();
    if (ready.length === 0) return;
    bossRowEl.appendChild(h('h3', { class: 'field-title' }, '卷灵现身'));
    for (const gate of ready) {
      const deck = save.decks.find((d) => d.id === gate.deckId);
      const btn = h(
        'button',
        { 'data-boss': gate.deckId, class: 'boss-chip', type: 'button' },
        `${bossNameOf(deck ?? { id: gate.deckId, name: gate.deckName, isPreset: false })}（${gate.count}/${gate.threshold}）`,
      ) as HTMLButtonElement;
      btn.addEventListener('click', () => onBossChip(gate.deckId));
      bossRowEl.appendChild(btn);
    }
  }

  function render(snap: ControllerSnapshot): void {
    const save = snap.save;
    renderChips(Array.isArray(save?.decks) ? save.decks : [], cardCountByDeck(Array.isArray(save?.cards) ? save.cards : []));
    renderBossRow(save);

    for (const [s, b] of sizeButtons) b.setAttribute('aria-pressed', String(s === size));
    startBtn.disabled = pending;

    // 称号弹窗：只有 namingDeckId 在场时才显示（关闭由两条按钮路径负责）
    const namingDeck = namingDeckId === null ? null : save.decks.find((d) => d.id === namingDeckId) ?? null;
    if (namingDeckId !== null && namingDeck === null) namingDeckId = null; // 领域被导入替换掉了
    setHidden(bossNameDialog, namingDeck === null);
    if (namingDeck) {
      bossNameInput.placeholder = defaultBossName(namingDeck.name);
      setHidden(bossNameDefaultBtn, typeof deps.setBossName !== 'function');
      setHidden(bossNameConfirmBtn, typeof deps.setBossName !== 'function');
      setHidden(bossNameAiBtn, typeof deps.llmNames !== 'function');
    }
    bossNameDefaultBtn.disabled = pending;
    bossNameConfirmBtn.disabled = pending;
    bossNameAiBtn.disabled = pending || nameAiBusy;

    const err = snap.lastError;
    setHidden(errorEl, err === null);
    if (err) errorEl.textContent = `${err.message} ${NEXT_STEP[err.code] ?? ''}`.trim();
    setHidden(errorGoBtn, !(err !== null && needsLibrary(err.code) && typeof deps.onNav === 'function'));
    setHidden(backBtn, typeof deps.onNav !== 'function');
  }

  /* ------------------------------------------------------------ 交互 */
  function onToggleDeck(id: string): void {
    if (destroyed || pending) return;
    random = false;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    if (selected.size === 0) random = true; // 最后一个被取消 ⇒ 回到"随机"
    render(ctrl.snapshot());
  }

  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  /** 卷灵开战：单领域 + 池子取 min(卡数,25) + difficulty='boss'（口径只在 bossFlow 一处）。 */
  async function startBoss(deckId: string): Promise<void> {
    if (destroyed || pending) return;
    pending = true;
    render(ctrl.snapshot());
    const params = bossFightParams(ctrl.snapshot().save, deckId);
    try {
      await ctrl.intent({ type: 'startFight', size: params.size, deckIds: params.deckIds, difficulty: 'boss' });
    } catch {
      // 只读态/意外拒绝：与普通开战同款，快照会带 notice，屏幕不冻住
    } finally {
      if (!destroyed) {
        pending = false;
        render(ctrl.snapshot());
      }
    }
  }

  /**
   * 点「卷灵现身」：自建领域**首次**触发要先问称号（PRD：默认模板或自拟 ≤30 字）；
   * 预置领域（称号手写）与已命名的自建领域直接开战。
   */
  function onBossChip(deckId: string): void {
    if (destroyed || pending) return;
    const deck = ctrl.snapshot().save.decks.find((d) => d.id === deckId);
    const needName = !!deck && deck.isPreset === false && (deck.bossName === undefined || deck.bossName === '');
    if (needName && typeof deps.setBossName === 'function') {
      namingDeckId = deckId;
      bossNameInput.value = '';
      // 每次开窗都把 AI 区清干净，并让上一次的在途请求作废（候选绝不跨窗串台）
      nameAiToken += 1;
      nameAiBusy = false;
      bossNameAiStatusEl.textContent = '';
      bossNameAiListEl.replaceChildren();
      render(ctrl.snapshot());
      return;
    }
    void startBoss(deckId);
  }

  /**
   * 「让 AI 起几个名」：生成中禁用入口 → 渲染候选按钮。
   * 候选**只填输入框**（`bossNameInput.value = name`），绝不直接调 `setBossName`：
   * 入库必须经过玩家再点一次「就用这个名字」，这是"产出不可信"的硬闸门。
   * 失败只把 reason 写进状态行（人话，已是可上屏文案），不抛、不关窗——玩家还能手打。
   */
  async function onAskNames(): Promise<void> {
    if (destroyed || pending || nameAiBusy || !deps.llmNames || namingDeckId === null) return;
    const deckId = namingDeckId;
    const deck = ctrl.snapshot().save.decks.find((d) => d.id === deckId);
    const token = ++nameAiToken;
    nameAiBusy = true;
    bossNameAiListEl.replaceChildren();
    bossNameAiStatusEl.textContent = '正在生成…';
    render(ctrl.snapshot());
    try {
      const res = await deps.llmNames(deck?.name ?? '');
      if (destroyed || token !== nameAiToken) return; // 已关窗/重开：结果作废（零写入）
      if (!res || res.ok !== true) {
        bossNameAiStatusEl.textContent =
          res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : 'AI 没能给出名字。';
        return;
      }
      bossNameAiStatusEl.textContent = res.truncated ? `已截断为前 ${res.value.length} 个。` : '';
      res.value.forEach((candidate, i) => {
        const b = h(
          'button',
          { 'data-name-candidate': String(i), class: 'name-candidate', type: 'button' },
          candidate.name,
        ) as HTMLButtonElement;
        b.addEventListener('click', () => {
          bossNameInput.value = candidate.name; // 只填框；写盘归「就用这个名字」
        });
        bossNameAiListEl.appendChild(b);
      });
    } catch (e) {
      if (!destroyed && token === nameAiToken) {
        bossNameAiStatusEl.textContent = `AI 起名失败：${e instanceof Error ? e.message : String(e)}`;
      }
    } finally {
      if (token === nameAiToken) nameAiBusy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function confirmBossName(useDefault: boolean): Promise<void> {
    const deckId = namingDeckId;
    if (destroyed || pending || deckId === null || !deps.setBossName) return;
    const deck = ctrl.snapshot().save.decks.find((d) => d.id === deckId);
    const raw = useDefault ? defaultBossName(deck?.name ?? '') : bossNameInput.value;
    pending = true;
    render(ctrl.snapshot());
    try {
      const res = await deps.setBossName(deckId, raw);
      // 非法输入不写脏值：setBossName 回落默认并回 ok:false，这里如实告诉玩家一句。
      if (!res.ok && res.reason) toast(res.reason);
    } catch (e) {
      // 只读闩锁下写口会真 reject（SaveReadOnlyError）——必须收成一句提示，
      // 否则玩家点了「就用这个名字」后什么都没有发生（T8 评审判 I-2）。
      toast(`称号没能写进存档：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      namingDeckId = null;
      pending = false;
      if (!destroyed) render(ctrl.snapshot());
    }
    // 称号写失败不该拦住开局：卷灵称号只是叙事皮（存档里仍是默认模板），战斗照打。
    await startBoss(deckId);
  }

  function onPickSize(s: number): void {
    if (destroyed || pending) return;
    size = s;
    render(ctrl.snapshot());
  }

  async function onStart(): Promise<void> {
    if (destroyed || pending) return;
    pending = true;
    render(ctrl.snapshot());
    const intent = random
      ? { type: 'startFight' as const, size }
      : { type: 'startFight' as const, size, deckIds: [...selected] };
    try {
      await ctrl.intent(intent);
    } catch {
      // 只读态/意外拒绝：控制器的快照会带 notice；这里只保证屏幕不被冻住。
    } finally {
      if (!destroyed) {
        pending = false;
        render(ctrl.snapshot());
      }
    }
  }

  randomChip.addEventListener('click', () => {
    if (destroyed || pending) return;
    random = true;
    selected.clear();
    render(ctrl.snapshot());
  });
  for (const [s, b] of sizeButtons) b.addEventListener('click', () => onPickSize(s));
  bossNameDefaultBtn.addEventListener('click', () => void confirmBossName(true));
  bossNameConfirmBtn.addEventListener('click', () => void confirmBossName(false));
  bossNameAiBtn.addEventListener('click', () => void onAskNames());
  startBtn.addEventListener('click', () => void onStart());
  errorGoBtn.addEventListener('click', () => deps.onNav?.('decks'));
  backBtn.addEventListener('click', () => deps.onNav?.('menu'));

  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    render(snap);
  });

  render(initial);

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
