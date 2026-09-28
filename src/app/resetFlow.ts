/**
 * resetFlow.ts —— Plan 5 追加：**重置存档**（用户实测反馈："不知道怎么从头体验"）。
 *
 * ## 语义（四个动作，顺序不能换）
 * 1. `store.clear()` 清掉存储里的档；
 * 2. `coord.reload()` —— 此刻存储是空的，reload 会装上**种子档**并**解除只读闩锁**
 *    （C-1 的"只读是终态"在 reload 上是刻意放宽的：重置正是坏档玩家唯一的自救路径之一）；
 * 3. `installPresetContent()` —— 这时内存里是空库，预置的 4 领域 30 张手写卡会被重新灌上，
 *    玩家不用刷新页面就拿到"新装状态"；
 * 4. `flush()` 收口，保证重置后的档真的落盘。
 *
 * **顺序为什么不能换**：`installPresetContent` 只在"空库"时灌，而清存储**不会**改变
 * coordinator 的内存档——必须先 reload 让内存也变空，否则第 3 步会以"这份存档已经有内容了"
 * 拒绝，玩家会看到一个空卡库（比不重置更糟）。
 *
 * ## 不清什么
 * LLM 的 Key 存在 `localStorage`（**不在存档里**），所以重置后 Key 还在、不用重填；
 * 这一点必须写在 UI 上，否则玩家会以为"重置会不会把我的 Key 也清掉"。
 */
import type { GameStorage } from '@platform/storage';
import { MAX_TIME_MS } from '@core/saveMigrate';
import { installPresetContent } from './presetContent';
import type { Coordinator } from './persist';

/** 重置结果面：`reason` 可直接上屏；成功时回"重装了多少卡/领域"供 UI 如实汇报。 */
export type ResetSaveResult =
  | { readonly ok: true; readonly cards: number; readonly decks: number }
  | { readonly ok: false; readonly reason: string };

export interface ResetSaveDeps {
  readonly coord: Coordinator;
  readonly store: GameStorage;
  /** 预置内容（宿主从 `assets/content/preset.json` 读入后传进来）。 */
  readonly content: unknown;
  readonly nowMs: number;
}

/**
 * 重置存档到"新装状态"。**永不抛**：任何一步失败都给可上屏的原因，
 * 且如实说明"到哪一步为止"（不能假装重置成功）。
 */
export async function resetSave(deps: ResetSaveDeps): Promise<ResetSaveResult> {
  const { coord, store } = deps;
  if (typeof deps.nowMs !== 'number' || !Number.isFinite(deps.nowMs) || Math.abs(deps.nowMs) > MAX_TIME_MS) {
    return { ok: false, reason: '设备时间读数异常，这次没有重置存档。' };
  }

  try {
    await store.clear();
  } catch (e) {
    return {
      ok: false,
      reason: `清空存储失败：${e instanceof Error ? e.message : String(e)}（存档没有被改动）。`,
    };
  }

  // ② 让内存档跟上是"空"的（顺带解除只读闩锁）
  const reloaded = await coord.reload();
  if (!reloaded.ok) {
    return {
      ok: false,
      reason: `存档已清空，但重新载入失败：${reloaded.reason ?? '原因未知'}——刷新一下页面吧。`,
    };
  }

  // ③ 重新灌预置内容（此时是空库，一定会灌）
  const installed = await installPresetContent(coord, deps.content, deps.nowMs);
  if (!installed.installed) {
    return {
      ok: false,
      reason: `存档已清空，但预置内容没能灌入：${installed.reason}（当前是空卡库，可以从头手动加卡）。`,
    };
  }

  // ④ 收口：重置后的档必须真的落盘
  const flushed = await coord.flush();
  if (!flushed) {
    return { ok: false, reason: '重置后的存档没能写进存储——稍后再试，或刷新页面看看。' };
  }

  const save = coord.snapshot();
  return { ok: true, cards: save.cards.length, decks: save.decks.length };
}
