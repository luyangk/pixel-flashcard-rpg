/**
 * files.ts —— Plan 4 · T11：浏览器文件口的**唯一实现点**（导出下载 / 导入选文件）。
 *
 * 为什么单独成文件：`src/ui/**` 是"只渲染、不碰宿主能力"的层（屏组件把这两个动作当
 * deps 注入），真正碰 Blob / URL / input[type=file] 的只有这里——于是"文件口"在一处
 * 可审、可替换（换 Tauri/原生壳时只改这一处），也避免每个屏各自记一遍 URL.revokeObjectURL。
 *
 * 两条纪律：
 * - **`revokeObjectURL` 必定调用**（哪怕 click 抛错）：移动端内存紧，泄漏 blob URL 会让
 *   长会话逐渐吃掉内存；
 * - **取消不是错误**：用户关掉选择器时回 null（调用方据此不弹任何提示），
 *   而读文件失败才回 null 并附带 reason（由调用方决定怎么说）。
 */

/** 触发一次文本下载（Blob + <a download>），返回文件名以便调用方回显。 */
export function downloadText(
  text: string,
  filename: string,
  deps: { doc?: Document; url?: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void } } = {},
): string {
  const doc = deps.doc ?? document;
  const url =
    deps.url ??
    (typeof URL !== 'undefined'
      ? { createObjectURL: (b: Blob) => URL.createObjectURL(b), revokeObjectURL: (u: string) => URL.revokeObjectURL(u) }
      : null);
  if (!url) return filename; // 无 URL 能力（极老环境）：不静默假装下载，调用方仍会 toast

  const blob = new Blob([text], { type: 'application/json' });
  const href = url.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('download', filename);
    a.style.display = 'none';
    doc.body?.appendChild(a);
    a.click();
    a.remove();
  } finally {
    url.revokeObjectURL(href);
  }
  return filename;
}

/** 选文件的结果：`{ok:true,text}` / `{ok:false,reason:'cancelled'|...}`。 */
export type PickTextResult = { ok: true; text: string } | { ok: false; reason: 'cancelled' | 'read-failed' };

/**
 * 让用户挑一个文本文件并读出内容。
 *
 * ## 取消为什么必须显式处理（T11 评审判 I-7）
 * 浏览器在用户"关掉选择器"时**不一定**发 `change`（Chrome/Safari 只在选中文件时发）。
 * 只等 change 的实现会让 Promise 永挂 ⇒ 调用方（卡组屏）的 `busy` 永真 ⇒ 整屏按钮
 * 全部禁用直到离开该屏，而"取消"分支成了死代码。三层兜底，按可靠性排序：
 * 1. `cancel` 事件（现代 Chrome/Safari 支持，最准）；
 * 2. 窗口重新获得焦点后延时检查 `input.files` 仍为空 ⇒ 判定取消（覆盖面最广）；
 * 3. 兜底超时（缺省 5 分钟）——极端情况下宁可让玩家重来一次，也不把屏幕锁死。
 */
export function pickTextFile(
  deps: {
    doc?: Document;
    accept?: string;
    /** 兜底超时（毫秒；<=0 关闭）。 */
    readonly timeoutMs?: number;
    /** 焦点兜底延时（毫秒；<=0 关闭）。 */
    readonly focusDelayMs?: number;
    readonly setTimer?: (cb: () => void, ms: number) => number;
    readonly clearTimer?: (h: number) => void;
    /** 窗口覆盖位（测试注入；缺省取全局 window）。 */
    readonly win?: { addEventListener(type: string, cb: () => void): void; removeEventListener(type: string, cb: () => void): void };
  } = {},
): Promise<PickTextResult> {
  const doc = deps.doc ?? document;
  const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = deps.clearTimer ?? ((h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const timeoutMs = typeof deps.timeoutMs === 'number' ? deps.timeoutMs : 5 * 60_000;
  const focusDelayMs = typeof deps.focusDelayMs === 'number' ? deps.focusDelayMs : 400;

  return new Promise<PickTextResult>((resolve) => {
    const input = doc.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', deps.accept ?? 'application/json,.json,.txt');
    input.style.display = 'none';
    let settled = false;
    let timers: number[] = [];
    const cleanup = (): void => {
      for (const t of timers) clearTimer(t);
      timers = [];
      win?.removeEventListener('focus', onFocus);
      input.remove();
    };
    const done = (r: PickTextResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    /** 焦点回来后再看一眼有没有选中文件——没有就认定用户取消了。 */
    const onFocus = (): void => {
      timers.push(
        setTimer(() => {
          if (settled) return;
          const picked = input.files?.[0];
          if (!picked) done({ ok: false, reason: 'cancelled' });
        }, focusDelayMs),
      );
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        done({ ok: false, reason: 'cancelled' });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        done(text.length > 0 ? { ok: true, text } : { ok: false, reason: 'read-failed' });
      };
      reader.onerror = () => done({ ok: false, reason: 'read-failed' });
      reader.readAsText(file);
    });
    // ① cancel 事件（支持它的浏览器最准）
    input.addEventListener('cancel', () => done({ ok: false, reason: 'cancelled' }));
    // ② 焦点兜底（多数浏览器取消时不发 change）
    win?.addEventListener('focus', onFocus);
    // ③ 兜底超时：宁可让玩家重来，也不把屏幕锁死
    if (timeoutMs > 0) timers.push(setTimer(() => done({ ok: false, reason: 'cancelled' }), timeoutMs));

    doc.body?.appendChild(input);
    input.click();
  });
}
