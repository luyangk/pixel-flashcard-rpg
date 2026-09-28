/**
 * readOnly.ts —— Plan 4 · T8：只读保护条（D29 三件套的前两件）。
 *
 * D29 verbatim：常驻横幅「存档无法读取，本次进度不会保存」+ 坏档原文导出
 * （文件名 `zx-xia-corrupt-<YYYY-MM-DD>.json`）+ `SaveReadOnlyError` 全捕获可见。
 * 本组件负责前两件；第三件在写路径上（控制器 guardedWrite / 屏组件 catch 折叠成 toast）。
 *
 * ## 为什么单独成文件而不是复用 toast.mountBanner
 * `mountBanner` 是"一句话横幅"，而 D29 要求横幅里带一个**动作**（把坏档捞出来交给用户）。
 * 把按钮塞进 banner 会让 toast.ts 的两种语义（脉冲/常驻）之外再多一种"带交互的常驻"，
 * 于是独立成一个组件：它订阅快照（`readOnly` 位），并持有"导出原文"这一条完整链路。
 *
 * ## 诚实边界（R-T8-p4-c）
 * `rawDump` 给的是"存储里当前那份值的等价 JSON 文本"，不是字节级原文快照——
 * 我们的两个存储实现都存结构化对象，不存在未被解析的原始字节。getter 为 null 时
 * （连读都读不出来）本组件如实说"读不出"，**不假装导出了一份空档**：给用户一份假的
 * "你的存档"比什么都不给更危险（他日后可能拿它覆盖真档）。
 */
import { localDayString } from '@core/reviewLedger';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { h, setHidden } from './dom';
import { showToast } from './toast';

/** 只读横幅文案（D29 verbatim；控制器侧的同义文案见 gameController.DEFAULT_NOTICE）。 */
export const READ_ONLY_TEXT = '存档无法读取，本次进度不会保存';

export interface ReadOnlyDeps {
  /** 时钟（坏档文件名用）。 */
  readonly now?: () => number;
  /** 时区偏移（东为正，UTC+8 = 480）。 */
  readonly tzOffsetMin?: number;
  /** 原文读取口（宿主接 Coordinator.rawDump）。缺省则只说"读不出"。 */
  readonly rawDump?: () => Promise<string | null>;
  /** 把文本交给用户（宿主接 Blob + <a download>）。缺省则导出按钮不显示。 */
  readonly saveTextFile?: (text: string, filename: string) => void;
  /** toast 存活毫秒（测试给 0 免定时器）。 */
  readonly toastMs?: number;
}

export interface ReadOnlyHandle {
  unmount(): void;
}

/** 坏档抢救文件名（D29 verbatim）：`zx-xia-corrupt-<本地日期>.json`。 */
export function corruptFileName(nowMs: number, tzOffsetMin = 0): string {
  return `zx-xia-corrupt-${localDayString(nowMs, tzOffsetMin)}.json`;
}

/**
 * 在 root 里挂只读保护条。它订阅快照：`readOnly` 为真时显示，为假时整条隐藏
 * （只读闩锁是终态，但组件不假设这一点——状态归快照，组件只做渲染）。
 */
export function mountReadOnlyBar(root: HTMLElement, ctrl: GameController, deps: ReadOnlyDeps = {}): ReadOnlyHandle {
  if (!root || !ctrl) throw new Error('mount-read-only-bar: root/controller required');
  const now = deps.now ?? (() => 0);
  const tzOffsetMin = typeof deps.tzOffsetMin === 'number' && Number.isFinite(deps.tzOffsetMin) ? deps.tzOffsetMin : 0;
  const canDump = typeof deps.rawDump === 'function' && typeof deps.saveTextFile === 'function';

  const textEl = h('span', { 'data-ui': 'readonly-text', class: 'readonly-text' }, READ_ONLY_TEXT);
  const dumpBtn = h('button', { 'data-ui': 'readonly-dump', class: 'readonly-dump', type: 'button' }, '导出坏档原文') as HTMLButtonElement;
  const bar = h('div', { 'data-ui': 'readonly-bar', class: 'readonly-bar', role: 'status', hidden: true }, [
    textEl,
    dumpBtn,
  ]);
  root.appendChild(bar);

  let destroyed = false;
  let busy = false;
  let toastOff: (() => void) | null = null;

  function render(snap: ControllerSnapshot): void {
    setHidden(bar, !snap.readOnly);
    setHidden(dumpBtn, !canDump);
    dumpBtn.disabled = busy;
  }

  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(bar, text, { ms: deps.toastMs });
  }

  async function onDump(): Promise<void> {
    if (destroyed || busy || !deps.rawDump || !deps.saveTextFile) return;
    busy = true;
    render(ctrl.snapshot());
    try {
      const text = await deps.rawDump();
      if (destroyed) return;
      if (typeof text !== 'string' || text.length === 0) {
        toast('读不出存储里的原文——这份存档已经取不回来了。');
        return;
      }
      deps.saveTextFile(text, corruptFileName(now(), tzOffsetMin));
      toast('已导出坏档原文，请自己留好这份文件。');
    } catch (e) {
      if (!destroyed) toast(`导出没能完成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  dumpBtn.addEventListener('click', () => void onDump());
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
    bar.remove();
  }

  return { unmount: destroy };
}
