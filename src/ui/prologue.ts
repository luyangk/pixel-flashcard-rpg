/**
 * prologue.ts —— Plan 4 · T6：序章演出（LORE §5.1 八屏 + 右上跳过）。
 *
 * 纯 DOM 组件，**不认识控制器**：`mountPrologue(root, scenes, onDone)` 只做"逐屏点击推进"
 * 这一件事，收尾时回调 `onDone`。宿主契约（见 app/storyState.ts 头注释）：
 *
 *   if (needsPrologue(ctrl.snapshot().save)) {
 *     const h = mountPrologue(root, prologueJson.scenes, () => { void ctrl.intent({type:'seenPrologue'}); });
 *   }
 *
 * 三条刻意的设计：
 * 1. **逐屏点击推进 + 右上「跳过」**（brief Interfaces）：跳到哪一屏都算看过——跳过与看完
 *    在落盘侧同待遇（settings.story.prologueSeen），故本组件只需在收尾时回调一次。
 * 2. **onDone 恰一次**：点完末屏、点跳过、以及"屏列表为空"三条路径共用同一个 once 闸门；
 *    收尾时**先**摘 DOM 与监听**再**回调，宿主可以放心地在 onDone 里立刻挂下一屏。
 * 3. **文案双轨制**（LORE §6）：屏上旁白是叙事文本（来自 prologue.json，逐字照 LORE §5.1，
 *    本文件一个字都不改写）；「跳过」「轻触继续」「轻触开始」是功能文本——大白话，
 *    不为氛围牺牲可理解性。
 *
 * 插画：`scene.art` 直接当 `<img src>`（占位件是 assets/sprites/prologue-*.png 的 64×64
 * 灰阶 PNG，T9 原地换正稿，本文件与 JSON 都不用改）。
 */
import { h } from './dom';

/** 一屏序章：`{text, art}` 是 brief 要求的占位字段，其余为可选增强。 */
export interface PrologueScene {
  readonly id?: string;
  /** 旁白（LORE §5.1 逐字；第 8 屏是标题屏，text 为《知识侠客》）。 */
  readonly text: string;
  /** 插画路径（占位件；T9 换正稿时路径不变）。 */
  readonly art: string;
  /** 分屏标题（如「云端盛世」）——仅供美术/调试对图，不上屏。 */
  readonly label?: string;
  /** true = 标题屏（末屏，hint 改说"轻触开始"）。 */
  readonly title?: boolean;
}

/** 挂载句柄：unmount 幂等（收尾已卸载后再调也安全）。 */
export interface PrologueHandle {
  unmount(): void;
}

const SKIP_TEXT = '跳过';
const HINT_MORE = '轻触继续';
const HINT_START = '轻触开始';

/**
 * 在 root 里挂一屏序章。`scenes` 为空列表时立即 `onDone()`（不空转、不留死屏）。
 * 返回句柄用于宿主提前拆除（收尾后自动拆除，句柄调用是幂等的兜底）。
 */
export function mountPrologue(
  root: HTMLElement,
  scenes: readonly PrologueScene[],
  onDone: () => void,
): PrologueHandle {
  if (!root) throw new Error('mount-prologue: root required');
  if (typeof onDone !== 'function') throw new Error('mount-prologue: onDone required');
  const list = Array.isArray(scenes) ? scenes : [];

  /* ------------------------------------------------------------ DOM 外壳 */
  // draggable='false' + pointer-events:none：真机上长按/拖动插画会吞掉包裹层的 click，
  // 而"点哪都能推进"是这一屏唯一交互 —— 插画不该参与命中测试。
  const artEl = h('img', {
    'data-ui': 'prologue-art',
    class: 'prologue-art',
    alt: '',
    draggable: 'false',
    style: { 'pointer-events': 'none' },
  }) as HTMLImageElement;
  const textEl = h('div', { 'data-ui': 'prologue-text', class: 'prologue-text' });
  const hintEl = h('div', { 'data-ui': 'prologue-hint', class: 'prologue-hint' }, HINT_MORE);
  const progressEl = h('div', { 'data-ui': 'prologue-progress', class: 'prologue-progress' });
  // 「跳过」常驻右上：绝对定位是"右上"的可测事实（不是靠外部 CSS 文件碰运气）。
  const skipBtn = h(
    'button',
    {
      'data-ui': 'prologue-skip',
      class: 'prologue-skip',
      type: 'button',
      'aria-label': '跳过序章',
      style: { position: 'absolute', top: '0.5rem', right: '0.5rem' },
    },
    SKIP_TEXT,
  ) as HTMLButtonElement;
  const screen = h(
    'div',
    {
      'data-ui': 'prologue-screen',
      class: 'prologue-screen',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '序章',
    },
    [artEl, textEl, hintEl, progressEl, skipBtn],
  );
  root.appendChild(screen);

  let idx = 0;
  let destroyed = false;
  let finished = false;

  /* ------------------------------------------------------------ 渲染 */
  function render(): void {
    const scene = list[idx];
    if (!scene) return;
    artEl.setAttribute('src', scene.art);
    artEl.setAttribute('alt', scene.text);
    textEl.textContent = scene.text;
    // 给 CSS 一个钩子区分"叙事屏"与"标题屏"（视觉归 T9；这里只落一个可测的事实）。
    screen.setAttribute('data-scene', scene.title === true ? 'title' : 'body');
    progressEl.textContent = `${idx + 1} / ${list.length}`;
    hintEl.textContent = idx === list.length - 1 ? HINT_START : HINT_MORE;
  }

  /* ------------------------------------------------------------ 收尾与推进 */
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    screen.removeEventListener('click', onScreenClick);
    skipBtn.removeEventListener('click', onSkipClick);
    screen.remove();
  }

  /** 唯一收尾口：once 闸门 + 先摘干净再回调（宿主可在 onDone 里立刻换屏）。 */
  function finish(): void {
    if (finished) return;
    finished = true;
    destroy();
    onDone();
  }

  function onScreenClick(): void {
    if (destroyed || finished) return;
    if (idx + 1 >= list.length) {
      finish(); // 末屏（标题屏）点完即开演
      return;
    }
    idx += 1;
    render();
  }

  /** 跳过：与"点完末屏"走同一个收尾口，并掐断冒泡（免得同一次点击再推一屏）。 */
  function onSkipClick(ev: Event): void {
    ev.stopPropagation();
    finish();
  }

  screen.addEventListener('click', onScreenClick);
  skipBtn.addEventListener('click', onSkipClick);

  if (list.length === 0) finish();
  else render();

  return { unmount: destroy };
}
