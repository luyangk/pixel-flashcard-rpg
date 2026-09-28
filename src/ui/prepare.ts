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
import type { ControllerSnapshot, GameController, StartErrorCode } from '../app/controllerTypes';
import { h, setHidden } from './dom';

/** 合法池子三挡（PRD §3；与 settings.battle.defaultPoolSize 的合法域一致）。 */
export const POOL_SIZES: readonly number[] = [10, 15, 25];

export interface PrepareDeps {
  /** 屏内导航（错误引导用；缺省则不显示引导按钮）。 */
  readonly onNav?: (target: 'decks') => void;
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

  const totalEl = h('p', { 'data-ui': 'pool-total', class: 'pool-total' });
  const errorEl = h('p', { 'data-ui': 'start-error', class: 'start-error', hidden: true });
  const errorGoBtn = h(
    'button',
    { 'data-ui': 'error-go-decks', class: 'error-go', type: 'button' },
    '去卡组',
  ) as HTMLButtonElement;
  const startBtn = h('button', { 'data-ui': 'start', class: 'start-btn', type: 'button' }, '开战') as HTMLButtonElement;

  const screen = h('div', { 'data-ui': 'prepare-screen', class: 'prepare-screen' }, [
    h('h2', { class: 'screen-title' }, '备战'),
    chipsEl,
    h('h3', { class: 'field-title' }, '池子大小'),
    sizeEl,
    totalEl,
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

  function render(snap: ControllerSnapshot): void {
    const save = snap.save;
    renderChips(Array.isArray(save?.decks) ? save.decks : [], cardCountByDeck(Array.isArray(save?.cards) ? save.cards : []));

    for (const [s, b] of sizeButtons) b.setAttribute('aria-pressed', String(s === size));
    startBtn.disabled = pending;

    const err = snap.lastError;
    setHidden(errorEl, err === null);
    if (err) errorEl.textContent = `${err.message} ${NEXT_STEP[err.code] ?? ''}`.trim();
    setHidden(errorGoBtn, !(err !== null && needsLibrary(err.code) && typeof deps.onNav === 'function'));
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
  startBtn.addEventListener('click', () => void onStart());
  errorGoBtn.addEventListener('click', () => deps.onNav?.('decks'));

  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    render(snap);
  });

  render(initial);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    screen.remove();
  }

  return { unmount: destroy };
}
