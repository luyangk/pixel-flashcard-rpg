/**
 * profileStore.ts —— **玩家身份**（昵称 + 短 ID，D57；第四个 `localStorage` 归属）。
 *
 * ## 为什么存本机而不是存档
 * 昵称与 ID 是"这台设备上的我是谁"，不是游戏进度：
 * - 进存档就要走三段式（types + 在场严检 + 迁移补默认），而**每次加字段都会让一批
 *   "逐键无损往返"用例与全部夹具跟着改**（`progress.bestStreak` 那次实测就是这样被我否掉的）；
 * - 它还该活过「重置存档」—— 与 AI Key 同款口径（"重置是重新开始玩，不是清空这台设备"）；
 * - 不进备份也就不会把昵称带进别人手里（将来要做"战绩卡"交换时，**由玩家自己点导出**
 *   再把昵称写进那份小文件，比"备份里悄悄带着"更符合最小暴露）。
 *
 * ## 纪律（与 inboxStore / sourceStore 逐条对齐）
 * - **绝不存 Key**：这里只有昵称与一个随机 ID；
 * - **永不抛**：隐私模式/配额满时读侧回默认、写侧回 `false`；
 * - **坏形状就地净化**：昵称截断到 12 码点，ID 只认 `u-` + 短十六进制。
 */
import type { PlayerProfile } from '@core/types';

/** 存储键（前三个是 `zx-xia.llm.v1` / `.inbox.v1` / `.sources.v1`）。 */
export const PROFILE_STORAGE_KEY = 'zx-xia.profile.v1';
/** 昵称上限（码点）：够写"无名侠客"这类四字雅号，也够写一个网名。 */
export const NICKNAME_MAX = 12;
/** 没起昵称时的默认显示名。 */
export const DEFAULT_NICKNAME = '无名侠客';

/** 码点安全截断。 */
function clipPoints(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join('') : text;
}

/** ID 形状：`u-` + 8 位十六进制（短、可读、不暴露任何设备信息）。 */
const ID_RE = /^u-[0-9a-f]{4,16}$/;

/** 净化一份身份：昵称可空（显示时回落默认名），ID 形状不对就当没有。 */
export function sanitizeProfile(raw: unknown): PlayerProfile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { nickname: '', userId: '' };
  }
  const o = raw as Record<string, unknown>;
  const nickname = typeof o.nickname === 'string' ? clipPoints(o.nickname.trim(), NICKNAME_MAX) : '';
  const userIdRaw = typeof o.userId === 'string' ? o.userId.trim() : '';
  const userId = ID_RE.test(userIdRaw) ? userIdRaw : '';
  return { nickname, userId };
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读身份：坏值/坏形状一律净化，**永不抛**。 */
export function loadProfile(): PlayerProfile {
  const store = storageOrNull();
  if (store === null) return { nickname: '', userId: '' };
  try {
    const raw = store.getItem(PROFILE_STORAGE_KEY);
    if (raw === null) return { nickname: '', userId: '' };
    return sanitizeProfile(JSON.parse(raw));
  } catch {
    return { nickname: '', userId: '' };
  }
}

/** 写身份：返回是否真的写进去了（隐私模式/配额满 ⇒ false，调用方要如实提示）。 */
export function saveProfile(profile: PlayerProfile): boolean {
  const store = storageOrNull();
  if (store === null) return false;
  try {
    store.setItem(PROFILE_STORAGE_KEY, JSON.stringify(sanitizeProfile(profile)));
    return true;
  } catch {
    return false;
  }
}

/** 清掉身份（回到"无名侠客"；换人玩这台设备时用）。 */
export function clearProfile(): void {
  const store = storageOrNull();
  if (store === null) return;
  try {
    store.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    /* 清不掉也不能让调用方崩：下次写入会覆盖 */
  }
}

/**
 * 取身份，**必要时补一个 ID**（只生成一次并立刻落盘）。
 *
 * 为什么 ID 要落盘：它是将来"两人交换战绩"时的稳定标识 —— 每次刷新都换一个，
 * 对比就无从谈起。`newId` 由调用方注入（与 `ui/newId` 同一条注入纪律，便于测试）。
 */
export function ensureProfile(newId: () => string): PlayerProfile {
  const current = loadProfile();
  if (current.userId.length > 0) return current;
  const candidate = sanitizeProfile({ nickname: current.nickname, userId: newId() });
  const next: PlayerProfile = { nickname: current.nickname, userId: candidate.userId };
  if (next.userId.length === 0) return next; // 生成器没给出可用的 ID ⇒ 如实回空
  // **写不进去就如实回空 ID**（复查 M4）：返回一个"没存住的随机 ID"更坏 ——
  // 它每次重渲染都会换，而屏上把它当"将来交换战绩的稳定标识"展示。
  return saveProfile(next) ? next : { nickname: next.nickname, userId: '' };
}
