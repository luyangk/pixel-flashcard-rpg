/**
 * dom.ts —— Plan 4 · T5：极简 DOM 助手（无框架、无 innerHTML）。
 *
 * 为什么自己写：本任务只需要"建元素 / 设属性 / 挂子节点"三件事，引入框架会把
 * 依赖与心智成本抬到收益之上。两条硬规矩：
 * 1. **零 innerHTML**：文本一律走 textContent —— 卡面正反面是用户内容，
 *    拼字符串进 HTML 就是注入面。
 * 2. **事件走 addEventListener**：`onClick` 这类键名被明确拒绝（见下），
 *    避免"字符串当处理器"的旧式写法混进来。
 *
 * 属性键的解析顺序（从上往下第一个命中即用）：
 * - `style`      ：对象 ⇒ 逐条 style[prop]=value；字符串 ⇒ 整体 cssText；
 * - `text`       ：textContent（唯一的文本入口，永远转义安全）；
 * - `class`      ：className；
 * - `dataset`    ：逐条 dataset[k]；
 * - `on<事件>`   ：函数 ⇒ addEventListener('<事件>' 小写)；
 * - `true`       ：布尔属性存在（如 disabled/hidden）；
 * - `false/null/undefined`：跳过（属性不存在）；
 * - 其余         ：setAttribute(name, String(value))。
 */
export type DomChild = Node | string | number | false | null | undefined | DomChild[];
export type DomAttrs = Record<string, unknown>;

const EVENT_KEY = /^on[A-Z]/;

/** 布尔属性用"存在/不存在"表达；null 与 false 等价于不存在。 */
function setAttr(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) return;
  if (value === true) {
    el.setAttribute(name, '');
    return;
  }
  el.setAttribute(name, String(value));
}

function applyStyle(el: HTMLElement, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    el.setAttribute('style', value);
    return;
  }
  if (typeof value !== 'object') return;
  const style = el.style as unknown as Record<string, string> & {
    setProperty?: (p: string, v: string) => void;
  };
  for (const [prop, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof style.setProperty === 'function') style.setProperty(prop, String(v));
    else style[prop] = String(v);
  }
}

function appendChildren(el: Node, kids: DomChild | readonly DomChild[] | undefined): void {
  if (kids === undefined || kids === null || kids === false) return;
  if (Array.isArray(kids)) {
    for (const k of kids) appendChildren(el, k as DomChild);
    return;
  }
  if (typeof kids === 'number') {
    el.appendChild(document.createTextNode(String(kids)));
    return;
  }
  if (typeof kids === 'string') {
    el.appendChild(document.createTextNode(kids));
    return;
  }
  if (kids instanceof Node) el.appendChild(kids);
}

/**
 * 建一个元素。用法：`h('div', { class: 'x', 'data-ui': 'card' }, ['文本', otherEl])`。
 * 返回类型是 `HTMLElement`（调用处按需窄化；本文件刻意不做 tag→类型的泛型映射，
 * 那样只会把签名写得难读，收益是零）。
 */
export function h(tag: string, attrs?: DomAttrs | null, children?: DomChild | readonly DomChild[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'style') {
        applyStyle(el, value);
      } else if (key === 'text') {
        if (value !== null && value !== undefined) el.textContent = String(value);
      } else if (key === 'class' || key === 'className') {
        setAttr(el, 'class', value);
      } else if (key === 'dataset') {
        if (value && typeof value === 'object') {
          for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
            if (dv !== null && dv !== undefined) el.dataset[dk] = String(dv);
          }
        }
      } else if (EVENT_KEY.test(key)) {
        if (typeof value === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        }
      } else {
        setAttr(el, key, value);
      }
    }
  }
  appendChildren(el, children);
  return el;
}

/** 显隐的唯一写法（属性 + 一致语义），避免各处混用 hidden/style.display。 */
export function setHidden(el: HTMLElement, isHidden: boolean): void {
  if (isHidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

/** 取文档：宿主元素的 ownerDocument 优先，退到全局 document（测试/iframe 友好）。 */
export function docOf(el: Element | null | undefined): Document {
  return el?.ownerDocument ?? document;
}
