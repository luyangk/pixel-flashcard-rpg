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
 * 【Plan 3 · T8 补丁（R-T7-p3-a）】落盘前在既有"剥 exportedAt 信封"处**一并剔除
 * `meta.lastExportedAt`**：导入档的该字段记录的是他机/他时刻的导出史，对本机不成立，
 * 留着会让 7 天备份提醒拿着别人的时刻静默失效。剔除 ⇒ 落库形状回到"从未导出"，
 * 闸门 fail-open（宁可多提醒一次）。
 *
 * 平台纯净：本文件不引用 DOM/Node API、不读时钟——serializeSave 的 exportedAt
 * 派生自 SaveFile.meta.savedAt。导出文件名拼装属 UI 关注点，留给平台层（R-T6-b）。
 *
 * Task 8 扩展：Settings 新增 battle.defaultPoolSize（默认 15、域 10–25 整数），
 * migrateSave 为 v2.1 前旧档（无 battle）补默认——DoD5「导入旧进度能正常开局」地基。
 *
 * Plan 3 · T3 扩展（R-P3-a 三段式）：Settings 新增 progress.exp（累计经验，非负整数）。
 * 与 battle 完全同构的两层分工——validateSave 对 progress「在场严检 + 缺席整包拒」
 * （reason 带路径并指路 migrateSave），migrateSave 只为缺 progress 的旧形状档补
 * {exp:0}；schemaVersion 仍恰为 1，不发明新顶层字段。
 *
 * Plan 3 · T7 扩展（R-P3-a 的变体 + R-T5-p3-a）两处，均为"在场严检、缺席语义化"：
 * - Settings.leaderboard?: RunRecord[]（战绩榜落盘位）：缺席**不拒**（可选派生数据，
 *   拒绝会让 T7 前存档全部打不开），migrateSave 补 []；在场逐行九字段严检（类级联
 *   引用 core/leaderboard.RunRecord，权威形状不在此复制）。
 * - meta.lastExportedAt?: number（7 天备份提醒的唯一喂入位）：缺席 = 从未导出，
 *   validateSave 在场严检（有限数且 ≥0，负值/NaN/超界整包拒），**migrateSave 不补默认**
 *   ——补一个假时刻会让 backupReminderDue 静默失效 7 天。写入路径：Coordinator.markExported。
 * schemaVersion 仍恰为 1，顶层键集不变。
 */

import type { SaveFile } from './types';
import type { GameStorage } from '@platform/storage';
// 日键口径唯一权威在 reviewLedger（R-T6-c）：跨模块 import 复用而非复制——
// 两者同属 core、无循环依赖，复制反会制造"两份定义各自漂移"的隐患。
import { DAY_KEY_RE, MAX_EFFECTIVE_DAYS } from './reviewLedger';

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
/** 战绩榜行的枚举域（core/leaderboard.RunRecord）。域外值视为"非 won/非 boss"的语义在
 *  leaderboard 内部是保守回落，但在**落盘形状**上必须整包拒——脏枚举一旦进档就会让
 *  rankRuns 静默丢行。 */
const RUN_RESULTS = ['won', 'lost'] as const;
const RUN_KINDS = ['encounter', 'boss'] as const;

/** settings.battle.defaultPoolSize 合法域与默认值（Task 8，brief verbatim：默认 15、范围 10–25）。 */
const POOL_SIZE_MIN = 10;
const POOL_SIZE_MAX = 25;
export const DEFAULT_POOL_SIZE = 15;

/** settings.progress.exp 默认值（Plan 3 · T3）：整数域裁决见 types.ts ProgressSettings 注释。 */
export const DEFAULT_PROGRESS_EXP = 0;

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

/** 有限正数（ease 域）。 */
function requirePositive(v: unknown, path: string): number {
  assertShape(typeof v === 'number' && Number.isFinite(v) && v > 0, path,
    () => `应为有限正数，实际为 ${describeValue(v)}`);
  return v;
}

/** 非负有限整数（reps/lapses/plays 域）。 */
function requireNonNegInt(v: unknown, path: string): number {
  assertShape(Number.isInteger(v) && (v as number) >= 0, path,
    () => `应为非负整数，实际为 ${describeValue(v)}`);
  return v as number;
}

/**
 * interval 域：非负有限；≥1 天必须整数（对齐 sm2「天级取整」），
 * <1 天允许小数（sm2 分钟级设计内，firstInterval=10/60 即此形态）。
 */
function requireInterval(v: unknown, path: string): number {
  assertShape(
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && (v < 1 || Number.isInteger(v)),
    path,
    () => `应为非负有限数字且满 1 天时取整，实际为 ${describeValue(v)}`,
  );
  return v as number;
}

/** Date 可表示时间戳范围（±8.64e15ms ≈ 前后各 271820 年）；超界令 new Date() 变 Invalid Date。
 *
 * 【Plan 3 · T8 导出面变更申报（R-T7-p3-e-1）】本常量自 T8 起为 core 的**公开导出**
 * （此前模块私有）。理由：装配层三处守卫（persist.markExported 域守卫、results.timestampOr
 * 消毒、backup.isTimestamp 信封校验）必须与落盘自检 `requireTimestamp` **完全同域**，
 * 此前各持一份本地字面量副本，值漂移即"放行的值在下次 flush 让 validateSave 整包拒"
 * （I1 的实证后果：dirty 恒 true、无关改动也写不进去）。现由本文件成为唯一权威，
 * 三处改为 import。这是本文件导出面的唯一新增，其余导出不变。 */
export const MAX_TIME_MS = 8.64e15;

/** 时间戳域：|v| ≤ 8.64e15——顺带封死 dueQueue 对 NaN/Invalid 排序失序的入口（m-5）。 */
function requireTimestamp(v: unknown, path: string): number {
  assertShape(typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS, path,
    () => `应为 Date 可表示范围内的有限时间戳（|v| ≤ ${MAX_TIME_MS}），实际为 ${describeValue(v)}`);
  return v as number;
}

/**
 * 非负时间戳域（Plan 3 · T7）：meta.lastExportedAt 的"有限数且 ≥0"严检。
 * 负值虽在 Date 可表示范围内，但对"上次导出时刻"毫无意义——放行只会让
 * `now - last >= 7d` 恒真、提醒永不关闭。故此处比 requireTimestamp 更紧一档。
 */
function requireNonNegTimestamp(v: unknown, path: string): number {
  assertShape(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIME_MS, path,
    () => `应为非负有限时间戳（0 ≤ v ≤ ${MAX_TIME_MS}），实际为 ${describeValue(v)}`);
  return v as number;
}

/** 真实历法日键：形状过 DAY_KEY_RE 且回读 UTC 分量一致（拒 9999-99-99、2025-02-30、闰年外 02-29）。 */
function isRealDayKey(s: string): boolean {
  if (!DAY_KEY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 有效复习日账本：元素逐个真实日键 + 长度 ≤ MAX_EFFECTIVE_DAYS（与 ledger 滚动上限同域）。 */
function requireDayLedger(v: unknown, path: string): void {
  const arr = requireStringArray(v, path);
  for (let i = 0; i < arr.length; i++) {
    assertShape(isRealDayKey(arr[i]), `${path}[${i}]`,
      () => `应为真实存在的日历日键 YYYY-MM-DD，实际为 "${arr[i]}"`);
  }
  assertShape(arr.length <= MAX_EFFECTIVE_DAYS, path,
    () => `条目数不得超过账本滚动上限 ${MAX_EFFECTIVE_DAYS}，实际为 ${arr.length}`);
}

function validateDeck(raw: unknown, i: number): void {
  const p = `decks[${i}]`;
  const o = requireObject(raw, p);
  requireString(o.id, `${p}.id`);
  requireString(o.name, `${p}.name`);
  assertShape(isBoolean(o.isPreset), `${p}.isPreset`, () => `应为布尔值，实际为 ${describeValue(o.isPreset)}`);
  if ('bossName' in o && o.bossName !== undefined) requireString(o.bossName, `${p}.bossName`);
  if ('purifiedAt' in o && o.purifiedAt !== undefined) requireTimestamp(o.purifiedAt, `${p}.purifiedAt`);
}

function validateSrs(raw: unknown, path: string): void {
  const o = requireObject(raw, path);
  requirePositive(o.ease, `${path}.ease`);
  requireInterval(o.interval, `${path}.interval`);
  requireNonNegInt(o.reps, `${path}.reps`);
  requireNonNegInt(o.lapses, `${path}.lapses`);
  requireTimestamp(o.due, `${path}.due`);
  requireEnum(o.stability, `${path}.stability`, STABILITIES);
  requireDayLedger(o.effectiveReviewDays, `${path}.effectiveReviewDays`);
}

function validateSource(raw: unknown, path: string): void {
  const o = requireObject(raw, path);
  requireEnum(o.type, `${path}.type`, SOURCE_TYPES);
  if ('url' in o && o.url !== undefined) requireString(o.url, `${path}.url`);
  requireTimestamp(o.createdAt, `${path}.createdAt`);
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

/**
 * 战绩榜行（Plan 3 · T7）：core/leaderboard.RunRecord 的**九字段**逐项严检
 * （id/at/result/kind/domain/cards/misses/level/score）。
 *
 * 与 leaderboard 内部的"消毒容忍"分工不同：rankRuns/scoreRun 对脏行是剔除/回落，
 * 而**落盘形状**必须整包拒——脏行一旦进档，榜单页就会拿到无法解释的行，
 * 且"榜上有几条"与"存储里有几条"会永久不一致。score 采非负整数域
 * （scoreRun 输出恒为整数，下限 0 由公式保证；-1/小数无合法来源）。
 */
function validateRunRecord(raw: unknown, path: string): void {
  const o = requireObject(raw, path);
  requireString(o.id, `${path}.id`);
  requireTimestamp(o.at, `${path}.at`);
  requireEnum(o.result, `${path}.result`, RUN_RESULTS);
  requireEnum(o.kind, `${path}.kind`, RUN_KINDS);
  requireString(o.domain, `${path}.domain`);
  requireNonNegInt(o.cards, `${path}.cards`);
  requireNonNegInt(o.misses, `${path}.misses`);
  requireNonNegInt(o.level, `${path}.level`);
  requireNonNegInt(o.score, `${path}.score`);
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
  // battle 域（Task 8）：在场严检——battle 一旦存在必须是对象且
  // defaultPoolSize ∈ 10–25 整数；缺席与否的裁决在下方统一收尾。
  if ('battle' in o && o.battle !== undefined) {
    const battle = requireObject(o.battle, 'settings.battle');
    assertShape(
      Number.isInteger(battle.defaultPoolSize)
        && (battle.defaultPoolSize as number) >= POOL_SIZE_MIN
        && (battle.defaultPoolSize as number) <= POOL_SIZE_MAX,
      'settings.battle.defaultPoolSize',
      () => `应为 ${POOL_SIZE_MIN}–${POOL_SIZE_MAX} 的整数，实际为 ${describeValue(battle.defaultPoolSize)}`,
    );
  }
  // v2.1 起 battle 必填（brief Step 1 两层分工：validate 拒缺 battle、migrateSave 补）。
  // 缺席走 fail() 而非 requireObject(undefined)——后者报"应为对象，实际为 undefined"，
  // 前者把迁移语义写进 reason，导入方一眼看懂该走 migrateSave。
  if (!('battle' in o) || o.battle === undefined) {
    fail('settings.battle', '缺失（v2.1 前旧档形状），请经 migrateSave 迁移后再导入');
  }
  // progress 域（Plan 3 · T3）：与 battle 同构的「在场严检 + 缺席整包拒」。
  // exp 采整数口径（Number.isInteger && ≥0）：expToNext/victoryExp/applyExp 全程整数域，
  // 小数 exp 无合法来源——出现即视为脏档，宁拒不改（域畸形归 validateSave）。
  if ('progress' in o && o.progress !== undefined) {
    const progress = requireObject(o.progress, 'settings.progress');
    assertShape(
      Number.isInteger(progress.exp) && (progress.exp as number) >= 0,
      'settings.progress.exp',
      () => `应为非负整数，实际为 ${describeValue(progress.exp)}`,
    );
  }
  if (!('progress' in o) || o.progress === undefined) {
    fail('settings.progress', '缺失（T3 前旧档形状），请经 migrateSave 迁移后再导入');
  }
  // leaderboard 域（Plan 3 · T7）：**可选位**——在场才严检（逐行九字段，路径带下标，
  // 如 `settings.leaderboard[3].score`）；缺席不拒（与 battle/progress 的分工差异见
  // types.Settings 注释：拒绝缺席会让 T7 前写下的存档全部打不开）。
  // 长度不设上限：榜单是展示派生数据，recordRun 写入侧恒截 50；导入一份 500 行的榜
  // 至多是"显示得长一点"，不威胁存档可用性（宁松勿误拒，域畸形仍逐行走上面拒绝）。
  if ('leaderboard' in o && o.leaderboard !== undefined) {
    const rows = requireArray(o.leaderboard, 'settings.leaderboard');
    for (let i = 0; i < rows.length; i++) validateRunRecord(rows[i], `settings.leaderboard[${i}]`);
  }
}

function validateMeta(raw: unknown): void {
  const o = requireObject(raw, 'meta');
  requireTimestamp(o.savedAt, 'meta.savedAt');
  requireNonNegInt(o.plays, 'meta.plays');
  // lastExportedAt（Plan 3 · T7，R-T5-p3-a）：可选持久位，**缺席是语义化的"从未导出"**，
  // 故与 leaderboard 同构地"在场严检、缺席放行"；migrateSave 不补默认（补假时刻会让
  // 7 天提醒闸门静默失效）。在场值经 requireNonNegTimestamp：NaN/Infinity/负值/超界一律
  // 整包拒——闸门的输入若成垃圾，提醒会以"永不响"或"天天响"的形式坏掉。
  if ('lastExportedAt' in o && o.lastExportedAt !== undefined) {
    requireNonNegTimestamp(o.lastExportedAt, 'meta.lastExportedAt');
  }
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
    // 卡片 id 唯一性与 deck 同标准（R-T6-a）：Task 4 已把"牌组唯一性由校验层保证"移交本层。
    const seenCardIds = new Set<string>();
    for (let i = 0; i < cards.length; i++) {
      const id = (cards[i] as { id: string }).id;
      if (seenCardIds.has(id)) fail(`cards[${i}].id`, `卡片 id 重复 "${id}"`);
      seenCardIds.add(id);
    }
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
// migrateSave
// ---------------------------------------------------------------------------

/**
 * 旧档迁移（RF#4）：validate 通过后补齐默认字段，返回强类型 SaveFile。
 *
 * 两层分工（brief Step 1 既定语义）：**validateSave 拒缺 battle，migrateSave 补**——
 * validateSettings 对 battle「在场严检 + 缺席整包拒」：存在则必须是对象且
 * defaultPoolSize ∈ 10–25 整数（99/3.5/'x' 一律拒，reason 带路径）；缺失报
 * `settings.battle: 缺失…请经 migrateSave 迁移`。域畸形始终归 validateSave，
 * 本函数绝不做消毒改写。**幂等声明的适用边界**：仅当输入已是"battle / progress /
 * leaderboard 三者皆在场且整包合法的新档"时，本函数同引用透传、零 mutate
 * （validateSave 同引用返回 + 现状核实其对未知多余键容忍，故无需拷贝重建）；
 * 任一项缺席的 legacy 档经注入后返回的是新建浅拷贝对象，不在此列。另注意：
 * **返回值与入参共享嵌套引用**（decks/cards 数组本体不复制），需独立副本请自行
 * structuredClone。
 *
 * 范围克制（R-T6-d 延伸）：迁移只做"缺省补值"这一件事，现有三档——settings.battle
 * → {defaultPoolSize:15}、settings.progress → {exp:0}、settings.leaderboard → []；
 * "上次备份时刻"（meta.lastExportedAt）**不补**（缺席 = 从未导出，补默认有害），
 * schemaVersion 保持恰 1，不发明新顶层字段。
 * 失败形态与校验器一致：抛 Error，message 即含 JSON 路径的可读 reason。
 */
export function migrateSave(raw: unknown): SaveFile {
  // 旧形状档（无 battle / 无 progress）在 validateSettings 处即被拒，故先注入默认再整包校验：
  // 这正是 brief Step 1 的「migrateSave 注入 {battle:{defaultPoolSize:15}} 后再 validate 过」
  // （T3 起 progress 同待遇：注入 {progress:{exp:0}}；T7 起 leaderboard：注入 {leaderboard:[]}）。
  const migrated = injectLeaderboardDefault(injectProgressDefaults(injectBattleDefault(raw)));
  const validated = validateSave(migrated);
  if (!validated.ok) throw new Error(`存档不合法，无法迁移：${validated.reason}`);
  return validated.save;
}

/**
 * settings.battle 缺省时补 `{defaultPoolSize:15}`——仅当 settings 是对象且 battle
 * 缺席才浅拷贝注入（其余形态原样返回，交给 validateSave 逐项拒绝并给路径）。
 * 已含合法 battle 的新档走"原样返回"分支，保证 migrate(migrate(x)) deepEqual migrate(x)。
 */
function injectBattleDefault(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const settings = raw.settings;
  if (!isPlainObject(settings)) return raw;
  if ('battle' in settings && settings.battle !== undefined) return raw;
  return { ...raw, settings: { ...settings, battle: { defaultPoolSize: DEFAULT_POOL_SIZE } } };
}

/**
 * settings.progress 缺省时补 `{exp:0}`（Plan 3 · T3）——与 injectBattleDefault 完全同构：
 * 只在 settings 为对象且 progress 缺席时浅拷贝注入；在场但畸形一律原样透传给
 * validateSave 拒绝（域检查归校验器，本函数绝不消毒改写）。两次注入对同一份
 * 全新档都是"原样返回"，幂等声明不受扩域影响。
 */
function injectProgressDefaults(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const settings = raw.settings;
  if (!isPlainObject(settings)) return raw;
  if ('progress' in settings && settings.progress !== undefined) return raw;
  return { ...raw, settings: { ...settings, progress: { exp: DEFAULT_PROGRESS_EXP } } };
}

/**
 * settings.leaderboard 缺省时补 `[]`（Plan 3 · T7）——与上两个注入器同构：
 * 只在 settings 为对象且 leaderboard 缺席时浅拷贝注入；在场（哪怕是空数组）一律原样
 * 透传给 validateSave 逐行拒绝。缺省值是 [] 而非拒绝，因为榜单是展示派生数据：
 * 缺席等价于"还没打过一局"，拒绝它会把 T7 前写下的存档全部锁死（RF#4 的反面）。
 *
 * **meta.lastExportedAt 刻意不在此列**：它的缺席语义是"从未导出"，补一个时刻
 * 会让 7 天提醒闸门静默失效——默认值在这里是有害的，故本函数只做 leaderboard。
 */
function injectLeaderboardDefault(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const settings = raw.settings;
  if (!isPlainObject(settings)) return raw;
  if ('leaderboard' in settings && settings.leaderboard !== undefined) return raw;
  return { ...raw, settings: { ...settings, leaderboard: [] } };
}

// ---------------------------------------------------------------------------
// serializeSave
// ---------------------------------------------------------------------------

/**
 * 序列化为可分享的 JSON 文本：2 空格缩进，附 `exportedAt`。
 * exportedAt 派生自 meta.savedAt——core 层不读时钟（全局约束），
 * "这份存档何时被保存"与"何时被导出"在纯本地单写者场景下同源。
 * 文件名拼装属 UI 关注点，由平台层负责（R-T6-b）。
 */
export function serializeSave(f: SaveFile): string {
  return JSON.stringify({ ...f, exportedAt: f.meta.savedAt }, null, 2);
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
  // 落盘前剔除两个"信封 / 他机"字段，保持存储形状纯净：
  // - exportedAt：导出信封自带的"何时导出"，从不属于 SaveFile；
  // - meta.lastExportedAt（R-T7-p3-a）：本机备份史。导入档来自他机/他时刻，那台机器的
  //   "上次备份"对本机不成立——留着会让 7 天提醒闸门拿着别人的时刻静默失效。剔除后
  //   落库形状回到"从未导出"，闸门 fail-open（宁可多提醒一次），与 T7 定下的方向一致。
  // 浅拷贝即可：validateSave 已确认树形完好（meta 必为对象），且 GameStorage.save
  // 内部做深拷贝快照。
  const { exportedAt: _envelope, meta, ...rest } = validated.save as SaveFile & { exportedAt?: unknown };
  const { lastExportedAt: _foreignExportStamp, ...cleanMeta } = meta;
  const save = { ...rest, meta: cleanMeta } as SaveFile;
  try {
    await store.save(save as SaveFile);
  } catch (e) {
    return { ok: false, reason: `写入存储失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}
