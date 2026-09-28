/**
 * settingsFlow.ts —— Plan 4 · T11：设置页的写口（阈值三档 / SM-2 参数 / 默认池子 / 重看序章）。
 *
 * 与 library.ts 同款分工（R-T7-p4-a 的延伸）：`GameIntent` 是**会话**意图（开局/作答/结算），
 * 设置编辑不属于任何一局，所以这里立一个窄写口，UI 只调它，落库仍是 `coord.mutate`。
 *
 * **域检查必须在这里先做一遍**（T7 评审判 I-2 的教训）：`settings` 的每个域在
 * `validateSave` 里都是整包拒的检查点，把一个 `NaN` 或越界值写进权威档，
 * 会让 dirty 永久为真、此后**所有**改动都写不进存储，而 UI 却以为"设置已保存"。
 * 因此本文件的每个函数都是"先验后写"，与 saveMigrate 的域**逐条对齐**（注释里给出对应行）。
 *
 * 一律**同值不重写**（写放大纪律）：玩家反复点同一个档位不该推开一次落盘窗。
 */
import type { Sm2Params } from '@core/types';
import type { Coordinator } from './persist';

/** 设置写入的统一失败面（reason 可直接上屏）。 */
export type SettingsWriteResult = { ok: true } | { ok: false; reason: string };

/** Boss 阈值三档（PRD §6.5 D18：默认 30、三档可配、引导领域特调 15）。 */
export const BOSS_TIERS: readonly (15 | 30 | 50)[] = [15, 30, 50];

/** defaultPoolSize 域（与 saveMigrate 的 POOL_SIZE_MIN/MAX 同值：10–25 整数）。 */
export const POOL_SIZE_MIN = 10;
export const POOL_SIZE_MAX = 25;

/**
 * SM-2 参数的**产品级**域：与 validateSave 的"四个有限数"相比更严一档——
 * 额外要求全为正、且 initialEase ≥ minEase（ease 是"起始难度因子不低于下限"，
 * 反过来会让算法第一步就把间隔压到 0，是个能写进去但会毁掉复习节奏的坑）。
 * core/sm2 的 FALLBACK_PARAMS 与 persist 的种子档都落在这个域内。
 */
export function validateSm2Params(raw: unknown): { ok: true; params: Sm2Params } | { ok: false; reason: string } {
  const bad = (why: string): { ok: false; reason: string } => ({ ok: false, reason: `参数没保存：${why}` });
  if (raw === null || typeof raw !== 'object') return bad('没有拿到参数。');
  const o = raw as Record<string, unknown>;
  const keys = ['initialEase', 'minEase', 'firstInterval', 'secondInterval'] as const;
  const out = {} as Sm2Params;
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`${k} 必须是数字。`);
    if (v <= 0) return bad(`${k} 必须大于 0。`);
    out[k] = v;
  }
  if (out.initialEase < out.minEase) return bad('起始难度因子不能低于难度下限。');
  return { ok: true, params: out };
}

/** 设置 Boss 阈值档（15/30/50）。非法值不写。 */
export async function setBossThresholdTier(coord: Coordinator, tier: unknown): Promise<SettingsWriteResult> {
  if (tier !== 15 && tier !== 30 && tier !== 50) {
    return { ok: false, reason: '阈值只能选 15 / 30 / 50 三档。' };
  }
  if (coord.snapshot().settings.bossThresholdTier === tier) return { ok: true };
  await coord.mutate((save) => {
    save.settings.bossThresholdTier = tier;
  });
  return { ok: true };
}

/** 设置 SM-2 参数（先验后写）。 */
export async function setSm2Params(coord: Coordinator, raw: unknown): Promise<SettingsWriteResult> {
  const checked = validateSm2Params(raw);
  if (!checked.ok) return checked;
  const current = coord.snapshot().settings.sm2Params;
  const same = (['initialEase', 'minEase', 'firstInterval', 'secondInterval'] as const).every(
    (k) => current?.[k] === checked.params[k],
  );
  if (same) return { ok: true };
  await coord.mutate((save) => {
    save.settings.sm2Params = { ...checked.params };
  });
  return { ok: true };
}

/** 设置备战屏的默认池子大小（10–25 整数）。 */
export async function setDefaultPoolSize(coord: Coordinator, size: unknown): Promise<SettingsWriteResult> {
  if (typeof size !== 'number' || !Number.isInteger(size) || size < POOL_SIZE_MIN || size > POOL_SIZE_MAX) {
    return { ok: false, reason: `池子大小只能是 ${POOL_SIZE_MIN}–${POOL_SIZE_MAX} 的整数。` };
  }
  if (coord.snapshot().settings.battle.defaultPoolSize === size) return { ok: true };
  await coord.mutate((save) => {
    save.settings.battle.defaultPoolSize = size;
  });
  return { ok: true };
}

/**
 * 设置作答模式（Plan 6 · D41）：`'choice'`（选择题，默认）或 `'qa'`（问答模式）。
 *
 * 域检查与 `saveMigrate` 的枚举逐条对齐（ANSWER_MODES）：域外值一旦进档，
 * 此后每次落盘自检都会失败 ⇒ dirty 永久为真、玩家所有改动静默写不进去。
 */
export async function setAnswerMode(coord: Coordinator, mode: unknown): Promise<SettingsWriteResult> {
  if (mode !== 'choice' && mode !== 'qa') {
    return { ok: false, reason: '作答方式只能是「选择题」或「问答模式」。' };
  }
  if (coord.snapshot().settings.answerMode === mode) return { ok: true }; // 同值不重写
  await coord.mutate((save) => {
    save.settings.answerMode = mode;
  });
  return { ok: true };
}

/**
 * 写入 LLM 每日额度（Plan 6 · D45）。**只由装配层在生成/判定之后调用**：
 * 额度是计数，不是玩家设置，所以界面上没有直接编辑它的入口。
 *
 * 域检查与 `validateLlmQuota` 逐条对齐：`day` 字符串（允许空串 = 未记录）、两个计数非负整数。
 */
export async function setLlmQuota(coord: Coordinator, quota: unknown): Promise<SettingsWriteResult> {
  const bad = (why: string): { ok: false; reason: string } => ({ ok: false, reason: `额度没记上：${why}` });
  if (quota === null || typeof quota !== 'object') return bad('没有拿到额度对象。');
  const o = quota as Record<string, unknown>;
  // day 允许空串（'' = 还没记过任何一天，与缺省值同形；app/quota 读时按"新的一天"归零）
  if (typeof o.day !== 'string') return bad('日期键缺失。');
  for (const key of ['cards', 'judges'] as const) {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return bad(`${key} 必须是非负整数。`);
  }
  const next = { day: o.day, cards: o.cards as number, judges: o.judges as number };
  const cur = coord.snapshot().settings.llmQuota;
  if (cur && cur.day === next.day && cur.cards === next.cards && cur.judges === next.judges) {
    return { ok: true }; // 同值不重写（额度几乎每局都写一次，写放大在这里最贵）
  }
  await coord.mutate((save) => {
    save.settings.llmQuota = next;
  });
  return { ok: true };
}

/**
 * 把 `settings.story.prologueSeen` 重置为 false（设置页的"重看序章"，LORE §5.1 的
 * "设置页可重看"）。下一次宿主挂屏时 `needsPrologue` 即为真。已为 false 时不写。
 */
export async function replayPrologue(coord: Coordinator): Promise<SettingsWriteResult> {
  if (!coord.snapshot().settings.story.prologueSeen) return { ok: true };
  await coord.mutate((save) => {
    save.settings.story.prologueSeen = false;
  });
  return { ok: true };
}
