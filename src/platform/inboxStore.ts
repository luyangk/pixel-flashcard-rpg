/**
 * inboxStore.ts —— Plan 8 · T5：**待读清单**（第二个 `localStorage` 归属）。
 *
 * ## 为什么需要它（D43 / D47）
 * 浏览器读不了公众号/知乎/新闻（没有 CORS 头，实测），所以"给一个站点链接、要能进一层"
 * 在纯前端只有一条诚实的路：**把抓不到的链接先记下来**。玩家照着清单去读、回来粘正文，
 * 入库后这条自动出箱 —— 清单是"知识准备"这件事的收件箱。
 *
 * ## 纪律
 * - **只存本机**（`localStorage`），不进备份、不落存档：正文可能是有版权的原文片段，
 *   它只该待在这台设备上，而且随时可一键清空；
 * - **绝不存 Key**：这里只放链接/标题/玩家粘的正文，与 `llmConfig` 的 Key 是两个抽屉
 *   （`tests/tooling/llmSafety.test.ts` 的 LS#3 白名单 + LS#3b 钉住）；
 * - **永不抛**：本地存储在隐私模式/配额满时会直接抛，读侧一律回空、写侧回 `false`
 *   （调用方据此如实提示"没能存进清单"）。
 */
import type { GameStorage } from './storage';

/** 清单的存储键（第二个 localStorage 归属；第一个是 llmConfig 的 `zx-xia.llm.v1`）。 */
export const INBOX_STORAGE_KEY = 'zx-xia.inbox.v1';
/** 条数上限：再多就不叫"待读"了，叫"再也不看"。 */
export const INBOX_MAX = 30;
/** 单条正文上限（码点）：一篇长文的一节足够，多了会撑爆 localStorage 配额。 */
export const INBOX_TEXT_MAX = 4000;

export interface InboxItem {
  readonly id: string;
  readonly title: string;
  /** 来源链接（只接受 http(s)；抓不到正文时它是唯一线索）。 */
  readonly url?: string;
  /** 玩家粘进来的正文（有它就可以直接生成，不必再联网）。 */
  readonly text?: string;
  readonly addedAt: number;
}

/** 码点安全截断。 */
function clipPoints(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join('') : text;
}

/** 单个条目的净化：缺 id/标题就整条丢掉；脏字段就地回落而不是丢整条。 */
function sanitizeItem(raw: unknown): InboxItem | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (id.length === 0 || title.length === 0) return null;
  const rawUrl = typeof o.url === 'string' ? o.url.trim() : '';
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
  const rawText = typeof o.text === 'string' ? o.text.trim() : '';
  const text = rawText.length > 0 ? clipPoints(rawText, INBOX_TEXT_MAX) : undefined;
  const addedAtRaw = o.addedAt;
  const addedAt =
    typeof addedAtRaw === 'number' && Number.isFinite(addedAtRaw) && addedAtRaw >= 0 ? addedAtRaw : 0;
  return {
    id,
    title: clipPoints(title, 200),
    ...(url === undefined ? {} : { url }),
    ...(text === undefined ? {} : { text }),
    addedAt,
  };
}

/** 取 localStorage（拿不到就回 null —— 隐私模式下访问本身就可能抛）。 */
function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读清单：坏值/坏形状一律就地净化，**永不抛**。 */
export function loadInbox(): readonly InboxItem[] {
  const store = storageOrNull();
  if (store === null) return [];
  let parsed: unknown;
  try {
    const raw = store.getItem(INBOX_STORAGE_KEY);
    if (raw === null) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: InboxItem[] = [];
  for (const row of parsed) {
    const item = sanitizeItem(row);
    if (item !== null) out.push(item);
  }
  return out.slice(0, INBOX_MAX);
}

/**
 * 写清单：净化 → 超过上限时**丢最旧的**（按 addedAt 升序，同刻按原顺序）→ 落盘。
 * 返回是否真的写进去了（隐私模式/配额满 ⇒ false，调用方要如实提示）。
 */
export function saveInbox(items: readonly InboxItem[]): boolean {
  const store = storageOrNull();
  if (store === null) return false;
  const clean: InboxItem[] = [];
  for (const row of Array.isArray(items) ? items : []) {
    const item = sanitizeItem(row);
    if (item !== null) clean.push(item);
  }
  const kept = [...clean].sort((a, b) => a.addedAt - b.addedAt).slice(-INBOX_MAX);
  try {
    store.setItem(INBOX_STORAGE_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/** 清空清单（一键"我读完了/不想留了"）。 */
export function clearInbox(): void {
  const store = storageOrNull();
  if (store === null) return;
  try {
    store.removeItem(INBOX_STORAGE_KEY);
  } catch {
    /* 清不掉也不该让调用方崩：下次写入会覆盖 */
  }
}

/** 类型占位：保持与其它 platform 模块一致的依赖形状（本模块不接 GameStorage）。 */
export type InboxStorageLike = Pick<GameStorage, 'load' | 'save' | 'clear'>;
