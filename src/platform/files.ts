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
 * 让用户挑一个文本文件并读出内容。**不依赖** FileReader 之外的任何东西，
 * 且 accept 只给 json/txt（移动端文件选择器对 accept 很敏感）。
 */
export function pickTextFile(
  deps: { doc?: Document; accept?: string } = {},
): Promise<PickTextResult> {
  const doc = deps.doc ?? document;
  return new Promise<PickTextResult>((resolve) => {
    const input = doc.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', deps.accept ?? 'application/json,.json,.txt');
    input.style.display = 'none';
    let settled = false;
    const done = (r: PickTextResult): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(r);
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
    // 用户直接取消时多数浏览器不发 change——宿主点下一次时旧 input 已被换掉，
    // 这里不注册 window 级监听（避免多实例互相打架），取消的判定交给"没有 change"。
    doc.body?.appendChild(input);
    input.click();
  });
}
