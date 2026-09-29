/**
 * sourceStore.ts —— 采新卡「来源库」里**玩家自己维护**的那部分（第三个 `localStorage` 归属，D53）。
 *
 * ## 为什么用 localStorage 而不是存档
 * 这是**工具配置**，不是游戏进度：它不该撑大备份文件、不该在"重置存档"时被清掉
 * （重置是"重新开始玩"，不是"清空这台设备"——与 AI Key、待读清单同款口径）。
 * 代价也一样如实登记：换设备要重加，清浏览器数据会丢。
 *
 * ## 纪律（与 inboxStore 逐条对齐）
 * - **只存本机**：`zx-xia.sources.v1`，不进存档、不进备份；
 * - **绝不存 Key**：这里只有名称/链接/类型（`tests/tooling/llmSafety.test.ts` 的 LS#3 白名单
 *   与 LS#3b 同款守卫）；
 * - **永不抛**：隐私模式/配额满时读侧回空库、写侧回 `false`（调用方据此如实提示）；
 * - **形状坏掉就地净化**：内置库永远在代码里，删掉的只记 id 墓碑，所以最坏情况就是"回到内置库"。
 */
import type { SourceDef, SourceKind } from '@core/sourceItem';
import { SOURCE_KINDS, usableUrl } from '@core/sourceItem';
import type { UserLibrary } from '../app/sourceLibrary';

/** 存储键（前两个是 `zx-xia.llm.v1` 与 `zx-xia.inbox.v1`）。 */
export const SOURCE_STORAGE_KEY = 'zx-xia.sources.v1';
/** 玩家最多加多少个源（再多列表就没法看了）。 */
export const USER_SOURCES_MAX = 40;
/** 墓碑上限（内置源目前不到 20 个，留一倍余量）。 */
export const REMOVED_MAX = 60;

/** 码点安全截断。 */
function clipPoints(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join('') : text;
}

/** 净化一个玩家源：id/名称/链接/类型缺一不可，类型不认识就整条丢。 */
function sanitizeSource(raw: unknown): SourceDef | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const url = usableUrl(o.url);
  const kind = typeof o.kind === 'string' ? o.kind : '';
  if (id.length === 0 || name.length === 0 || url === null) return null;
  if (!SOURCE_KINDS.includes(kind as SourceKind)) return null;
  const note = typeof o.note === 'string' ? clipPoints(o.note.trim(), 120) : undefined;
  return {
    id: clipPoints(id, 300),
    name: clipPoints(name, 40),
    url,
    kind: kind as SourceKind,
    direct: o.direct === true,
    ...(note === undefined || note.length === 0 ? {} : { note }),
  };
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读玩家那份库：坏值/坏形状一律净化，**永不抛**（读不出来就当没加过）。 */
export function loadSources(): UserLibrary {
  const store = storageOrNull();
  if (store === null) return { added: [], removed: [] };
  let parsed: unknown;
  try {
    const raw = store.getItem(SOURCE_STORAGE_KEY);
    if (raw === null) return { added: [], removed: [] };
    parsed = JSON.parse(raw);
  } catch {
    return { added: [], removed: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { added: [], removed: [] };
  }
  const o = parsed as { added?: unknown; removed?: unknown };
  const added: SourceDef[] = [];
  for (const row of Array.isArray(o.added) ? o.added : []) {
    const s = sanitizeSource(row);
    if (s !== null) added.push(s);
  }
  const removed: string[] = [];
  for (const row of Array.isArray(o.removed) ? o.removed : []) {
    if (typeof row === 'string' && row.trim().length > 0) removed.push(clipPoints(row.trim(), 300));
  }
  return {
    added: added.slice(-USER_SOURCES_MAX),
    removed: [...new Set(removed)].slice(-REMOVED_MAX),
  };
}

/** 写玩家那份库：返回是否真的写进去了（隐私模式/配额满 ⇒ false，调用方要如实提示）。 */
export function saveSources(lib: UserLibrary): boolean {
  const store = storageOrNull();
  if (store === null) return false;
  const added: SourceDef[] = [];
  for (const row of Array.isArray(lib?.added) ? lib.added : []) {
    const s = sanitizeSource(row);
    if (s !== null) added.push(s);
  }
  const removed = [...new Set((Array.isArray(lib?.removed) ? lib.removed : []).map((x) => String(x)))]
    .filter((x) => x.length > 0)
    .slice(-REMOVED_MAX);
  try {
    store.setItem(
      SOURCE_STORAGE_KEY,
      JSON.stringify({ added: added.slice(-USER_SOURCES_MAX), removed }),
    );
    return true;
  } catch {
    return false;
  }
}

/** 清掉玩家那份库（回到纯内置）。 */
export function clearSources(): void {
  const store = storageOrNull();
  if (store === null) return;
  try {
    store.removeItem(SOURCE_STORAGE_KEY);
  } catch {
    /* 清不掉也不能让调用方崩：下次写入会覆盖 */
  }
}
