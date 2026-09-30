/**
 * presetOfferStore.ts —— **"这台设备上送过哪些预置领域"**（D66，第五个 `localStorage` 归属）。
 *
 * ## 为什么需要它
 * 预置内容只在**空库首次启动**时灌入，所以"往内容文件里加一个新领域"对已有存档不生效；
 * 于是启动时要做一次**增量补装**（`installMissingPresetDecks`）。但补装必须能回答一个问题：
 * **玩家是"还没收到过"，还是"收到过但自己删了"？** 前者要补，后者再塞回去就是骚扰。
 *
 * 存档里没有"删除记录"这种东西（也不值得为它加字段、动三分法与一批往返用例），
 * 所以把答案放在**本机**：记住已经送过的领域 id（与昵称/ID 同款口径：它不是游戏进度，
 * 换设备重来一次也无所谓，而重置存档不该让它复活已删的领域）。
 *
 * ## 纪律（与前三个归属逐条对齐）
 * - 只存**领域 id 字符串**，不存任何玩家内容；
 * - **永不抛**：读写失败一律当作"没有记录"（最坏情况：把玩家删过的域又送一次）；
 * - 坏形状就地净化（非字符串/空串/超长一律丢）。
 */
/** 存储键（前四个是 `zx-xia.llm.v1` / `.inbox.v1` / `.sources.v1` / `.profile.v1`）。 */
export const PRESET_OFFER_KEY = 'zx-xia.presetOffers.v1';

/** 领域 id 的形状：小写字母/数字/连字符，够用且能挡住垃圾。 */
const DECK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 净化一份记录：只留合法领域 id，去重。 */
export function sanitizeOffers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!DECK_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** 读"已送过"记录：坏值/坏形状一律净化，**永不抛**。 */
export function loadOffers(): string[] {
  const store = storageOrNull();
  if (store === null) return [];
  try {
    const raw = store.getItem(PRESET_OFFER_KEY);
    return raw === null ? [] : sanitizeOffers(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 把新的领域 id 并进记录（返回合并后的全集；写失败不抛出，最坏是下次再送一次）。 */
export function addOffers(ids: readonly string[]): string[] {
  const merged = sanitizeOffers([...loadOffers(), ...ids]);
  const store = storageOrNull();
  if (store === null) return merged;
  try {
    store.setItem(PRESET_OFFER_KEY, JSON.stringify(merged));
  } catch {
    /* 写不进去就当没记：宁可信"送过"会重送一次，也不让启动崩 */
  }
  return merged;
}

/** 清掉记录（重置存档时用：让玩家重新走一遍"新装状态"）。 */
export function clearOffers(): void {
  const store = storageOrNull();
  if (store === null) return;
  try {
    store.removeItem(PRESET_OFFER_KEY);
  } catch {
    /* 清不掉也无害 */
  }
}
