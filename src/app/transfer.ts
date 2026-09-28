/**
 * transfer.ts —— Plan 3 · T8 导入/导出编排守卫（UI 接线前的最后一道闸）。
 *
 * ## 为什么需要这一层
 * core 与 backup 侧的两个函数都是**刻意不设防**的纯函数，各自的边界写在自己的 doc 里：
 * - `exportBackup(save, nowMs)` 不做任何校验（T5 §顾虑 3 的自述口径）——脏入参能产出
 *   **结构残缺的信封**：`save: undefined` 被 JSON.stringify 整键丢弃、`nowMs: NaN`
 *   序列化成 `exportedAt: null`。文件生成成功、导入必被拒，用户无从察觉（T5 评审 M5）。
 * - `parseBackup(text, nowMs)` 对**可预期**失败一律回 `{ok:false, reason}`，但明确保留
 *   一个例外：迁移器内部的真 bug 原样上抛、不伪装成"你的文件坏了"（R-T6-p3-b 引用的 doc）。
 *   UI 直接消费它就可能吃到未捕获异常。
 *
 * 本模块把这**两种"合法但危险"的边界**收口成编排层的返回值语义：调用方（Plan 4 UI）
 * 永远只拿到 `{ok:true,…}` 或 `{ok:false, reason}`，reason 是可直接念给用户的大白话。
 * 这不是给纯函数加防御（那会破坏 backup.ts 的纯净与既有契约），而是把"谁负责防"
 * 从"每个调用点各自记得"变成"只有这一处"。
 *
 * ## 与 core/backup 的分工
 * - 信封格式、迁移时机、失败分层前缀仍归 backup.ts；本模块**不重复实现**任何校验，
 *   只做两件纯函数做不到的事：a) 在调用前拦掉已知会产出坏文件的入参；b) 接住调用后的异常。
 * - `nowMs` 的合法域与信封自己的接受域同界（有限且 |nowMs| ≤ core 的 MAX_TIME_MS）：
 *   守卫放行的时刻，产出的信封必能被 parseBackup 接受（SM#4 边界用例钉住这条一致性）。
 *
 * ## Final Fix Wave · I-1/I-2：最后一米的生产落点
 * 上面两个守卫解决了"脏入参会产出坏文件"，但**导入落盘与导出记时在生产路径上仍无人编排**：
 * - `importAndSave` 在 src/ 零调用点，且它裸吃 SaveFile 字面量——信封（顶层
 *   `{format,version,exportedAt,save}`）会被它判定为"schemaVersion 应为 1，实际为
 *   undefined"而拒。UI 若退化成 `store.save(parsed.save)` 则绕开 R-T7-p3-a 的
 *   lastExportedAt 剔除（本机导出史被别人的时刻代表，7 天闸门静默失效）。
 * - `exportBackupText` 收裸 SaveFile、不碰 coordinator，而 backup.ts 文件头自称
 *   "导出前与记录 lastExportedAt 前都用 flush() && !dirty() 收口"——BK#26 只证明
 *   测试里这么写，生产路径上没有这个编排点。
 * 本波补齐这两个落点：`importBackupAndSave`（parseBackup → importAndSave，串起信封、
 * 迁移、校验、剔除、落盘）与 `exportAndMark`（收口 → 信封 → markExported），失败一律
 * 收敛为 `{ok:false, reason}`，reason 可直接念给用户。
 *
 * 时间纪律：本文件不读宿主时钟（与 backup.ts 同规格），nowMs 一律入参化。
 */

import type { SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { MAX_TIME_MS, importAndSave } from '@core/saveMigrate';
import { exportBackup, parseBackup, type BackupParseResult } from './backup';
import type { Coordinator } from './persist';

/** 导出失败的统一前缀（大白话；与 backup 的信封/存档分层前缀互不重叠）。 */
export const EXPORT_FAILURE_PREFIX = '导出没能完成：';

/** 导入失败的统一前缀（指的是"导入这件事没做成"，不是"你的文件坏了"）。 */
export const IMPORT_FAILURE_PREFIX = '导入没能完成：';

export type ExportBackupResult = { ok: true; text: string } | { ok: false; reason: string };

/** 值的人类可读描述（与 backup.describeValue 同口径，但此处只用于编排层文案）。 */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 导出的编排入口：先守卫，再封信封。
 *
 * 两类脏入参直接拒绝、**绝不调用 exportBackup**：
 * - `save` 不是对象（undefined / null / 数组 / 标量）——权威存档尚未就绪。这是类型层
 *   已拦（save 为必填 SaveFile）之后的运行期兜底：绕过类型（`as never`、JSON 反序列化
 *   的脏值、UI 状态机写错）时仍不产出缺 `save` 键的残信封。
 * - `nowMs` 非有限或超出 Date 可表示范围——产出的 `exportedAt` 要么是 null、
 *   要么是 parseBackup 必拒的值；这种文件对"7 天提醒"和"换机恢复"都毫无价值，
 *   宁可不生成，也不要让用户以为自己备份成功了。
 */
export function exportBackupText(save: SaveFile, nowMs: number): ExportBackupResult {
  if (save === null || typeof save !== 'object' || Array.isArray(save)) {
    return {
      ok: false,
      reason: `${EXPORT_FAILURE_PREFIX}存档还没准备好（拿到的是 ${describeValue(save)}），这次没有生成备份文件。`,
    };
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_TIME_MS) {
    return {
      ok: false,
      reason: `${EXPORT_FAILURE_PREFIX}设备时间读数异常（${describeValue(nowMs)}），这次没有生成备份文件。`,
    };
  }
  return { ok: true, text: exportBackup(save, nowMs) };
}

/**
 * 导入的编排入口：把 parseBackup 的"可预期失败返回值"与"真 bug 上抛"两种出口
 * 统一成同一种返回值——调用方拿不到异常，只拿到 reason。
 *
 * 接住异常不是吞 bug：reason 里原样带上异常 message（便于排查），且明确告诉用户
 * **他的存档没有被改动**（本函数与 parseBackup 都不触存储，落盘只在 importAndSave）。
 *
 * 第三参 `parse` 是解析器注入位（默认 core 侧的 parseBackup）：它让"兜底 catch 真的
 * 接住了什么"可以被直接取证——否则只能靠构造一个真 bug 才能覆盖（SM#5 ②）。
 */
export function importBackupText(
  text: string,
  nowMs: number,
  parse: (t: string, n: number) => BackupParseResult = parseBackup,
): BackupParseResult {
  try {
    return parse(text, nowMs);
  } catch (e) {
    return {
      ok: false,
      reason: `${IMPORT_FAILURE_PREFIX}${errorText(e)}（你的存档没有被改动）`,
    };
  }
}

// ---------------------------------------------------------------------------
// Final Fix Wave · I-1 —— importBackupAndSave（导入的生产落点）
// ---------------------------------------------------------------------------

/** 导入落盘的结果面（比 BackupParseResult 更窄：只回"成没成 + 为什么"）。 */
export type ImportAndSaveResult = { ok: boolean; reason?: string };

/**
 * 导入的**完整**生产编排：信封解析 → 迁移 → 校验 → 剔除他机字段 → 落盘。
 *
 * 链路与分工（每步都不是本函数自己实现的，本函数只负责把它们接上）：
 * 1. `importBackupText`（= backup.parseBackup + 真 bug 兜底 catch）：信封层/存档层
 *    分层 reason，可预期失败一律 `{ok:false}`；
 * 2. `importAndSave`（core/saveMigrate）：再校验一次并**剔除** `exportedAt` 与
 *    `meta.lastExportedAt`（R-T7-p3-a：导入档来自他机/他时刻，那台机器的"上次备份"
 *    对本机不成立；留着会让 7 天提醒闸门拿着别人的时刻静默失效），然后才 `store.save`。
 *
 * 为何必须由本函数串这两步（I-1 的病灶）：`importAndSave` 吃的是**裸 SaveFile 文本**，
 * 直接喂 backup 信封会被它以 "schemaVersion 应为 1，实际为 undefined" 拒；而绕开它自己
 * `store.save(parsed.save)` 又会跳过上面第 2 步的剔除。两条都是"看着能用、实则漏一条账"。
 *
 * 承诺：解析失败 / 校验失败 / 写失败一律 `{ok:false, reason}`，**且不触存储**——
 * 失败路径下用户的旧档原样保留（Review Focus #2 的原子性由 importAndSave 保证）。
 * 永不 reject（parseBackup 的真 bug 也已被 importBackupText 接住）。
 *
 * 第二参 nowMs 传 0：它只喂 `parseBackup` 的 `sinceLastBackupDays`（导入方根本不用它，
 * 且它不参与任何接受/拒绝判定——信封的 exportedAt 才参与），故此处**不读宿主时钟**，
 * 与文件头时间纪律一致。
 */
export async function importBackupAndSave(
  text: string,
  store: GameStorage,
): Promise<ImportAndSaveResult> {
  const parsed = importBackupText(text, 0);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return importAndSave(JSON.stringify(parsed.save), store);
}

// ---------------------------------------------------------------------------
// Final Fix Wave · I-2 —— exportAndMark（导出的生产落点）
// ---------------------------------------------------------------------------

/** 导出并记时的结果面。失败时 `text` 可能仍在场（见 exportAndMark 的第三段说明）。 */
export type ExportAndMarkResult = { ok: boolean; text?: string; reason?: string };

/**
 * 导出的**完整**生产编排：收口 → 封信封 → 记录导出时刻。
 *
 * R-T4-p3-d / backup.ts 文件头的装配层硬契约在此成为生产事实：
 * 1. **收口**：`flush() && !dirty()`。`flush()` 的 true 只承诺"被认领的那批已写"，
 *    在途 mutate 的那批还没写——只信 boolean 就会把未落盘的进度当成"已备份"
 *    （BK#26 的取证场景）。收口不成立（写失败或并发不断）时**不生成文件、不记时**，
 *    返回失败并说明"稍后再试"：宁可这次不导出，也不给用户一份与进度不一致的备份。
 * 2. **信封**：`exportBackupText(coord.snapshot(), nowMs)`——同一份守卫，脏入参（存档
 *    未就绪 / nowMs 超出可表示域）依旧被挡在生成文件之前。
 * 3. **记时**：`markExported(nowMs)`（M-2 的返回值面）。返回 false = 没记上（只读态 /
 *    非法时刻）或没落净（写失败）——此时**文件已经在手**，故仍把 `text` 交给调用方：
 *    用户的救命文件不该因为一个时间戳没写成而被丢掉；代价只是闸门 fail-open，7 天后
 *    再提醒一次（"宁可多提醒一次，不可静默永不提醒"）。调用方据 `ok:false` 提示用户
 *    "先自己保存好这份文件"。
 *
 * 只读态（C-1：存档读不出来）直接拒绝：此刻的权威内存是种子档，把它封成"你的备份"
 * 发给用户是个陷阱（他日后可能拿这份空档覆盖真档）。
 */
export async function exportAndMark(
  coord: Coordinator,
  nowMs: number,
): Promise<ExportAndMarkResult> {
  if (coord.readOnly()) {
    return {
      ok: false,
      reason: `${EXPORT_FAILURE_PREFIX}存档无法读取（已进入只读保护），这次没有生成备份文件。`,
    };
  }
  const flushed = await coord.flush();
  if (!flushed || coord.dirty()) {
    return {
      ok: false,
      reason: `${EXPORT_FAILURE_PREFIX}改动还没能全部写进存储，这次没有生成备份文件（稍后再试）。`,
    };
  }
  const built = exportBackupText(coord.snapshot(), nowMs);
  if (!built.ok) return built;
  if (!(await coord.markExported(nowMs))) {
    return {
      ok: false,
      text: built.text,
      reason: `${EXPORT_FAILURE_PREFIX}备份文件已生成，但"已备份"记录没能写入存储——请先自己保存好这份文件，应用稍后会再提醒你备份。`,
    };
  }
  return { ok: true, text: built.text };
}
