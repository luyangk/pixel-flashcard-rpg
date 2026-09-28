/**
 * toast.ts —— Plan 4 · T5：两件最小提示组件（T8 只读态/提醒直接复用）。
 *
 * 分工（刻意的）：
 * - `showToast`：**一次性**消息，到时自摘（snapshot.notice 这类"说完就算"的位）；
 * - `mountBanner`：**常驻**横幅，只在调用方显式解绑时消失（只读保护这类"状态在就得在"的位）。
 *   把两者分开，是因为 T4 的教训——把"状态"当"脉冲"（或反之）就是频闪/永挂的根源；
 *   这里让调用方按语义挑组件，而不是给一个组件加个 flag。
 *
 * 二者都返回**幂等的解绑函数**：卸载路径（battleScreen.unmount / T8 离开只读态）
 * 可以无脑调用，不必先查是否还在。
 */
import { h } from './dom';

export interface ToastOptions {
  /** 自动消失毫秒数；<=0 表示不自动消失（由调用方自己解绑）。缺省 2400。 */
  readonly ms?: number;
}

/**
 * 在 root 里弹一条一次性消息，返回解绑函数（手动提前摘掉，幂等）。
 * 不读时钟、不注册全局监听：唯一副作用是一个 setTimeout，且必然被 clearTimeout 收尾。
 */
export function showToast(root: HTMLElement, text: string, opts?: ToastOptions): () => void {
  const el = h('div', { 'data-ui': 'toast', class: 'toast', role: 'status', text });
  root.appendChild(el);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const dismiss = (): void => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    el.remove();
  };

  const ms = opts?.ms ?? 2400;
  if (ms > 0 && typeof setTimeout === 'function') timer = setTimeout(dismiss, ms);
  return dismiss;
}

/**
 * 挂一条常驻横幅（只读态用），返回解绑函数（幂等）。
 * 常驻 = 不设定时器；只有当调用方说"状态没了"才摘。
 */
export function mountBanner(root: HTMLElement, text: string): () => void {
  const el = h('div', { 'data-ui': 'banner', class: 'banner', role: 'status', text });
  root.appendChild(el);

  let alive = true;
  return (): void => {
    if (!alive) return;
    alive = false;
    el.remove();
  };
}
