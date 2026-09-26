/**
 * saveMigrate —— 存档校验与 JSON 导出/导入（DoD5「导出→清环境→导入进度完整」的地基）。
 *
 * 定位：core 其余函数（sm2.sanitize / reviewLedger）对脏数据是"消毒容忍"策略，
 * 唯 validateSave 承担**整包拒绝**职责——导入的存档一旦有任何畸形，宁可让用户
 * 看到可读的错误，也绝不放行半个坏档进存储。因此本校验器手写且严格（不引 zod，YAGNI）：
 * - schemaVersion 必须恰为 1；未来版本给出"请升级后再导入"提示；
 * - decks/cards/settings/meta 结构与关键字段类型逐项检查，失败 reason 给 JSON 路径
 *   （如 `cards[3].srs.ease`）；
 * - cards[].deckId 必须指向存在的 deck（引用闭合），deck id 不得重复；
 * - 数值必须是有限数（NaN/Infinity/null 一律拦下——JSON 往返会把 NaN 变成 null）。
 *
 * importAndSave 串联 解析→校验→落盘，任一步失败都不触 store.save（Review Focus #2），
 * 保证失败路径下旧档完好。落盘快照深拷贝由 GameStorage 实现负责，调用方不再重复。
 *
 * 平台纯净：本文件不引用 DOM/Node API、不读时钟——serializeSave 的 exportedAt
 * 派生自 SaveFile.meta.savedAt；exportAsJson 的文件名日键由调用方传入时间戳。
 */

import type { SaveFile } from './types';
import type { GameStorage } from '@platform/storage';

// ---------------------------------------------------------------------------
// validateSave
// ---------------------------------------------------------------------------

export type ValidateResult = { ok: true; save: SaveFile } | { ok: false; reason: string };

type Fail = (path: string, detail?: string) => never;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** 谓词守卫：false 即抛带 JSON 路径的内部信号（detail 惰性求值，热路径零开销）。 */
function assertShape(pred: boolean, path: string, detail: () => string): asserts pred {
  if (!pred) throw new ValidationSignal(`${path}: ${detail()}`);
}

const STABILITIES = ['new', 'learning', 'review', 'mastered'] as const;
const SOURCE_TYPES = ['preset', 'hotspot', 'domain', 'manual', 'llm'] as const;
const TIERS = [15, 30, 50] as const;

/** 内部信号：校验失败的路径化原因。不外泄——validateSave 捕获后转成 reason。 */
class ValidationSignal extends Error {}

function fail(path: string, detail: string): never {
  throw new ValidationSignal(`${path}: ${detail}`);
}

function requireObject(v: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(path, `应为对象，实际为 ${describeValue(v)}`);
  return v;
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v); // NaN / Infinity
  return typeof v;
}

function requireString(v: unknown, path: string): string {
  assertShape(typeof v === 'string' && v.length > 0, path, () => `应为非空字符串，实际为 ${describeValue(v)}`);
  return v;
}

function requireFiniteNumber(v: unknown, path: string): number {
  assertShape(isFiniteNumber(v), path, () => `应为有限数字，实际为 ${describeValue(v)}`);
  return v;
}

function requireArray(v: unknown, path: string): unknown[] {
  assertShape(Array.isArray(v), path, () => `应为数组，实际为 ${describeValue(v)}`);
  return v;
}

function requireEnum<T extends string>(v: unknown, path: string, allowed: readonly T[]): string {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(path, `应为 ${allowed.map((s) => `"${s}"`).join(' | ')} 之一，实际为 ${describeValue(v)}`);
  }
  return v;
}

/** 字符串数组（元素逐个给路径，如 `cards[0].tags[2]`）。 */
function requireStringArray(v: unknown, path: string): string[] {
  const arr = requireArray(v, path);
  for (let i = 0; i < arr.length; i++) {
    assertShape(typeof arr[i] === 'string', `${path}[${i}]`, () => `应为字符串，实际为 ${describeValue(arr[i])}`);
  }
  return arr as string[];
}

function validateDeck(raw: unknown, i: number): void {
  const p = `decks[${i}]`;
  const o = requireObject(raw, p);
  requireString(o.id, `${p}.id`);
  requireString(o.name, `${p}.name`);
  assertShape(isBoolean(o.isPreset), `${p}.isPreset`, () => `应为布尔值，实际为 ${describeValue(o.isPreset)}`);
  if ('bossName' in o && o.bossName !== undefined) requireString(o.bossName, `${p}.bossName`);
  if ('purifiedAt' in o && o.purifiedAt !== undefined) requireFiniteNumber(o.purifiedAt, `${p}.purifiedAt`);
}

function validateSrs(raw: unknown, path: string): void {
  const o = requireObject(raw, path);
  requireFiniteNumber(o.ease, `${path}.ease`);
  requireFiniteNumber(o.interval, `${path}.interval`);
  requireFiniteNumber(o.reps, `${path}.reps`);
  requireFiniteNumber(o.lapses, `${path}.lapses`);
  requireFiniteNumber(o.due, `${path}.due`);
  requireEnum(o.stability, `${path}.stability`, STABILITIES);
  requireStringArray(o.effectiveReviewDays, `${path}.effectiveReviewDays`);
}

function validateSource(raw: unknown, path: string): void {
  const o = requireObject(raw, path);
  requireEnum(o.type, `${path}.type`, SOURCE_TYPES);
  if ('url' in o && o.url !== undefined) requireString(o.url, `${path}.url`);
  requireFiniteNumber(o.createdAt, `${path}.createdAt`);
}

function validateCard(raw: unknown, i: number): void {
  const p = `cards[${i}]`;
  const o = requireObject(raw, p);
  requireString(o.id, `${p}.id`);
  requireString(o.front, `${p}.front`);
  requireString(o.back, `${p}.back`);
  requireString(o.deckId, `${p}.deckId`);
  validateSrs(o.srs, `${p}.srs`);
  requireStringArray(o.tags, `${p}.tags`);
  if ('source' in o && o.source !== undefined) validateSource(o.source, `${p}.source`);
}

function validateSettings(raw: unknown): void {
  const o = requireObject(raw, 'settings');
  const tier = o.bossThresholdTier;
  if (typeof tier !== 'number' || !(TIERS as readonly number[]).includes(tier)) {
    fail('settings.bossThresholdTier', `应为 15 | 30 | 50 之一，实际为 ${describeValue(tier)}`);
  }
  const sm2 = requireObject(o.sm2Params, 'settings.sm2Params');
  for (const key of ['initialEase', 'minEase', 'firstInterval', 'secondInterval'] as const) {
    requireFiniteNumber(sm2[key], `settings.sm2Params.${key}`);
  }
}

function validateMeta(raw: unknown): void {
  const o = requireObject(raw, 'meta');
  requireFiniteNumber(o.savedAt, 'meta.savedAt');
  requireFiniteNumber(o.plays, 'meta.plays');
}

/**
 * 整包校验一份未知来源的存档（JSON.parse 的结果、或 IDB 里可能损坏的旧值）。
 * 通过则返回强类型 save（同引用，不深拷贝）；任一失败返回可读 reason（含 JSON 路径）。
 */
export function validateSave(raw: unknown): ValidateResult {
  try {
    const root = requireObject(raw, '$');
    const sv = root.schemaVersion;
    if (typeof sv === 'number' && sv > 1) {
      return { ok: false, reason: `schemaVersion: 存档来自更新的版本（${sv}），请升级应用后再导入` };
    }
    if (sv !== 1) {
      fail('schemaVersion', `应为 1，实际为 ${describeValue(sv)}`);
    }
    const decks = requireArray(root.decks, 'decks');
    decks.forEach(validateDeck);
    const seenDeckIds = new Set<string>();
    for (let i = 0; i < decks.length; i++) {
      const id = (decks[i] as { id: string }).id;
      if (seenDeckIds.has(id)) fail(`decks[${i}].id`, `卡组 id 重复："${id}"`);
      seenDeckIds.add(id);
    }
    const cards = requireArray(root.cards, 'cards');
    cards.forEach(validateCard);
    for (let i = 0; i < cards.length; i++) {
      const deckId = (cards[i] as { deckId: string }).deckId;
      if (!seenDeckIds.has(deckId)) {
        fail(`cards[${i}].deckId`, `引用了不存在的卡组 "${deckId}"（悬空 deckId）`);
      }
    }
    validateSettings(root.settings);
    validateMeta(root.meta);
    return { ok: true, save: raw as SaveFile };
  } catch (e) {
    if (e instanceof ValidationSignal) return { ok: false, reason: e.message };
    throw e; // 非校验信号（不应发生）原样上抛，不吞真 bug
  }
}

// ---------------------------------------------------------------------------
// serializeSave / exportAsJson
// ---------------------------------------------------------------------------

/**
 * 序列化为可分享的 JSON 文本：2 空格缩进，附 `exportedAt`。
 * exportedAt 派生自 meta.savedAt——core 层不读时钟（全局约束），
 * "这份存档何时被保存"与"何时被导出"在纯本地单写者场景下同源。
 */
export function serializeSave(f: SaveFile): string {
  return JSON.stringify({ ...f, exportedAt: f.meta.savedAt }, null, 2);
}

/** 文件名日键用的毫秒 → `YYYY-MM-DD`（UTC，仅为文件名稳定可排序，非业务日历口径）。 */
function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 生成下载用文件名 + 内容。nowMs 由调用方传入（core 禁 Date.now()）。 */
export function exportAsJson(
  f: SaveFile,
  nowMs: number,
): { filename: string; text: string } {
  return {
    filename: `pixel-flashcard-save-${utcDayKey(nowMs)}.json`,
    text: serializeSave(f),
  };
}

// ---------------------------------------------------------------------------
// importAndSave
// ---------------------------------------------------------------------------

export type ImportResult = { ok: true } | { ok: false; reason: string };

/**
 * 解析 → 校验 → 落盘。任何一步失败都**不触 store.save**：
 * 旧档在失败路径下保持完好（Review Focus #2 的原子性承诺）。
 * 永不 reject——所有异常（含裸 JSON.parse SyntaxError、配额满）都收敛为 ok:false + reason。
 */
export async function importAndSave(text: string, store: GameStorage): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `不是合法的 JSON 文本：${e instanceof Error ? e.message : String(e)}` };
  }
  const validated = validateSave(parsed);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  // exportedAt 是导出信封字段，不属于 SaveFile——落盘前剔除，保持存储纯净。
  // 浅拷贝即可：validateSave 已确认树形完好，且 GameStorage.save 内部做深拷贝快照。
  const { exportedAt: _envelope, ...save } = validated.save as SaveFile & { exportedAt?: unknown };
  try {
    await store.save(save as SaveFile);
  } catch (e) {
    return { ok: false, reason: `写入存储失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}
