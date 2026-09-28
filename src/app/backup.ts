/**
 * backup.ts —— Plan 3 · T5 备份信封 + 7 天提醒闸门（PRD §6.1 / DoD5 / RF#5）。
 *
 * 纯本地架构（无后端、无账号）下，"导出 JSON"是用户数据保全的**唯一**手段：
 * 换机、清数据、浏览器配额被回收，都只能靠手里这份文件救回来。因此本模块的
 * 两个职责都按"宁可多说一句大白话，也不让用户拿到半个坏档"的规格写：
 *
 * 1. **信封**：`{format:'zx-xia-backup', version:1, exportedAt, save}`。信封自带
 *    format/version 两个"这是本应用导出的、且是这一代格式"的判别位——用户随手拖进来的
 *    任意 JSON（历史裸存档、别的 App 的导出）都会在**信封层**被拦下，而不是掉进存档校验
 *    里报一堆看不懂的 JSON 路径。
 * 2. **失败分层可读**（LORE §6 功能文本口径：大白话、不牺牲可理解性）：失败 reason 一律
 *    以两个前缀之一开头——`ENVELOPE_ERROR_PREFIX`（信封层：文件本身不对）或
 *    `SAVE_ERROR_PREFIX`（存档层：文件是我们的，但里面的存档内容坏了，附 JSON 路径）。
 *    UI 可直接把 reason 念给用户听，也可按前缀分流文案。
 *
 * **N-3 的兑现点**：内层存档一律**显式**过 `migrateSave`（注入 battle/progress 默认值后
 * 整包校验），而不是裸 `validateSave`。时机上"先迁移再校验"是唯一正确的顺序：
 * v2.1/T3 之前的旧备份缺 settings.battle / settings.progress，裸校验会整包拒——
 * 用户几年前导出的进度就此永久打不开（RF#4 的反面）。migrateSave 对已合法的新档
 * 是零改写透传，故新旧档共用一条路径，无需版本分支。
 *
 * **exportedAt 语义定夺**（Plan 2 终审 R-T6-d 登记的缺口）：
 * - 信封的 exportedAt 由**调用方传入的 nowMs** 决定，即"人为触发导出的那一刻"。
 *   它刻意不复用 `meta.savedAt`（那是"最近一次落盘时刻"，会被自动攒批刷新），
 *   否则"用户上次主动备份是什么时候"会被后台写悄悄顶掉，7 天提醒永远不响。
 * - exportedAt 只存在于信封里，**不写回 SaveFile**：存档本体（core 层 owns 的形状）
 *   不为导出这件事多一个字段，importAndSave 落盘的仍是纯 SaveFile。
 * - `lastExportedAt` 的**持久位**（建议 `meta.lastExportedAt?: number`）本任务未落地：
 *   落它需要在 core/types 声明可选字段 + core/saveMigrate 严格校验（三段式），
 *   超出本任务的授权文件面（详见 task-5-report.md）。因此本模块只做纯函数，
 *   `backupReminderDue` 的入参来源由**调用方**决定，口径钉死如下：
 *     - `null` = 从未导出过（唯一合法缺省，缺席即"从未导出"）；
 *     - 数值 = 最近一次**成功导出**的时刻（与信封 exportedAt 同源同值）；
 *     - 非有限值一律按 null 处理（fail-open：宁可多提醒一次，不可静默永不提醒）；
 *       `nowMs` 非有限同理 fail-open（T6 捎带 item 3，见 backupReminderDue）。
 *   UI 触发与持久位落地归 **T7 兑现**（R-T5-p3-a：`meta.lastExportedAt?: number` 按三段式
 *   在 core/types 声明 + core/saveMigrate 严格校验；本任务只消费本模块的纯函数往返）。
 *
 * **装配层硬契约（R-T4-p3-d）**：凡"我的改动此刻已持久"的语义，必须用
 * `flush() && !dirty()` 收口，不得只信 `flush()` 的 boolean——它只承诺"被认领的那批
 * 已写"，在途 mutate 的那批还没写。导出前与记录 lastExportedAt 前都照此口径收口，
 * 否则导出的文件与"标记为已备份"的进度可能不是同一份（tests/app/backup.test.ts BK#26 取证）。
 *
 * 时间纪律：本文件不读宿主时钟——所有时刻（nowMs）一律入参化（与 persist.ts 同规格）。
 * 纯函数、无 I/O、无 store 依赖：信封文本怎么落成文件属平台/UI 层（R-T6-b）。
 */

import type { SaveFile } from '@core/types';
import { MAX_TIME_MS, migrateSave } from '@core/saveMigrate';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 信封标记：用户见到"导入失败"时，这一位决定它是不是我们的文件。 */
export const BACKUP_FORMAT = 'zx-xia-backup';

/** 信封版本：与 SaveFile.schemaVersion 同代（恰 1）。更新的版本一律拒并指路升级。 */
export const BACKUP_VERSION = 1;

/** 信封层失败的统一前缀（大白话，UI 可直接展示）。 */
export const ENVELOPE_ERROR_PREFIX = '这不是本应用导出的备份文件：';

/** 存档层失败的统一前缀（后面接 validateSave 的路径化 reason）。 */
export const SAVE_ERROR_PREFIX = '备份里的存档内容有问题：';

/** 备份信封（brief Produces 逐字对齐）。 */
export interface BackupEnvelope {
  format: 'zx-xia-backup';
  version: 1;
  exportedAt: number;
  save: SaveFile;
}

export type BackupParseResult =
  | { ok: true; save: SaveFile; sinceLastBackupDays: number }
  | { ok: false; reason: string };

/** 一天的毫秒数（提醒闸门与 sinceLastBackupDays 的唯一换算基准）。 */
const MS_PER_DAY = 86_400_000;

/** 默认提醒周期（RF#5：每 7 天未备份提醒一次）。 */
const DEFAULT_REMINDER_PERIOD_DAYS = 7;

/** migrateSave 抛错时的固定前缀——转述给用户时剥掉，避免"存档…存档…"套娃。 */
const MIGRATE_ERROR_PREFIX = '存档不合法，无法迁移：';

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 值的人类可读描述（字符串带引号，便于用户对照自己文件里的内容）。 */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `"${v}"`;
  // number/boolean 回实际值而非 typeof（T6 捎带，T5 评审 Minor item 2）：
  // "实际为 number" 对用户毫无对号入座的价值；1e300 / 1.5 / true 才是他文件里看得见的东西。
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeof v;
}

function envelopeError(detail: string): { ok: false; reason: string } {
  return { ok: false, reason: `${ENVELOPE_ERROR_PREFIX}${detail}` };
}

/** 有限时间戳判定（NaN/±Infinity/字符串/超界一律不算）。
 *  上界统一取 core/saveMigrate 的权威常量 MAX_TIME_MS（T8 · R-T7-p3-e-1：
 *  原为本地字面量副本，信封校验与落盘自检的域靠人工同步）。 */
function isTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// exportBackup
// ---------------------------------------------------------------------------

/**
 * 把一份存档封成可分享的 JSON 文本（2 空格缩进，便于用户肉眼检查与手工抢救）。
 *
 * 纯函数：不改动入参、不读时钟、同参同输出。`nowMs` 即"用户按下导出键的那一刻"
 * （语义与持久位口径见文件头）。本函数**不做校验**——调用方交进来的应是
 * coordinator 的权威状态（落盘前自检已整包校验过），校验的关口在导入侧（parseBackup）。
 */
export function exportBackup(save: SaveFile, nowMs: number): string {
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowMs,
    save,
  };
  return JSON.stringify(envelope, null, 2);
}

// ---------------------------------------------------------------------------
// parseBackup
// ---------------------------------------------------------------------------

/**
 * 解析一份导入文本。**可预期**的失败一律不抛异常——都收敛为 `{ok:false, reason}`（可读大白话）；
 * 唯一的例外是迁移器内部的真 bug（非迁移前缀的异常），此类**原样上抛**不伪装成"存档坏了"
 * （T6 捎带，T5 评审 Minor item 4）。
 *
 * 分层判定（reason 前缀即层标）：
 * - **信封层**：JSON 语法、顶层形状、format 缺失/不符、version 缺失/非 1/来自更新版本、
 *   exportedAt 缺失或非法、save 缺失或非对象；
 * - **存档层**：信封完好，但 save 本体经 migrateSave 校验不过（悬空 deckId、ease 域外、
 *   schemaVersion 不符等）——reason 带 JSON 路径（如 `cards[3].srs.ease`）。
 *
 * 成功时同时给出 `sinceLastBackupDays`：从信封 exportedAt 到 nowMs 的**整天天数**
 * （向下取整；时钟回拨导致的负差值钳为 0）。UI 可据此显示"这份备份是 N 天前的"。
 */
export function parseBackup(text: string, nowMs: number): BackupParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return envelopeError(`不是合法的 JSON 文本（${errorText(e)}）`);
  }
  if (!isPlainObject(root)) {
    return envelopeError(`顶层应为对象，实际为 ${describeValue(root)}`);
  }

  if (!('format' in root) || root.format === undefined) {
    return envelopeError('缺少 format 标记');
  }
  if (root.format !== BACKUP_FORMAT) {
    return envelopeError(`format 应为 "${BACKUP_FORMAT}"，实际为 ${describeValue(root.format)}`);
  }

  if (!('version' in root) || root.version === undefined) {
    return envelopeError('缺少 version 字段');
  }
  if (root.version !== BACKUP_VERSION) {
    // 来自更新版本的备份：能读懂"更新"这件事，但不敢猜它的字段语义——拒并指路升级。
    // 门槛是 `>= 2` 而非 `> 1`（T6 捎带，T5 评审 Minor item 1）：1.5 这类非整数是**畸形值**
    // 而非"下一代格式"，指路升级会让用户去等一个不存在的版本；故落入通用畸形文案。
    if (typeof root.version === 'number' && Number.isInteger(root.version) && root.version >= 2) {
      return envelopeError(
        `version 应为 ${BACKUP_VERSION}，实际为 ${root.version}——这份备份来自更新的版本，请先升级应用再导入`,
      );
    }
    return envelopeError(`version 应为 ${BACKUP_VERSION}，实际为 ${describeValue(root.version)}`);
  }

  if (!('exportedAt' in root) || root.exportedAt === undefined) {
    return envelopeError('缺少 exportedAt（备份时间）字段');
  }
  if (!isTimestamp(root.exportedAt)) {
    return envelopeError(`exportedAt 应为可表示时间的有限数字，实际为 ${describeValue(root.exportedAt)}`);
  }

  if (!('save' in root) || root.save === undefined) {
    return envelopeError('缺少 save 字段（信封里没有存档本体）');
  }
  if (!isPlainObject(root.save)) {
    return envelopeError(`save 应为对象，实际为 ${describeValue(root.save)}`);
  }

  // N-3 显式时机：先迁移再校验（旧档缺 battle/progress 在此补齐后整包放行）。
  let save: SaveFile;
  try {
    save = migrateSave(root.save);
  } catch (e) {
    const detail = errorText(e);
    // 只有 migrateSave 自己包过的迁移失败才是"用户的存档内容有问题"（T6 捎带，item 4）：
    // 其余异常是内部 bug（validateSave 刻意 rethrow 非 ValidationSignal 正是为此），
    // 伪装成 SAVE 层会让用户以为自己的文件坏了、甚至去删档重来。故告警后原样上抛（fail-closed）。
    if (!detail.startsWith(MIGRATE_ERROR_PREFIX)) {
      console.warn('[backup] migrateSave 抛出非迁移异常，原样上抛（不吞真 bug）：', e);
      throw e;
    }
    return { ok: false, reason: `${SAVE_ERROR_PREFIX}${detail.slice(MIGRATE_ERROR_PREFIX.length)}` };
  }

  return { ok: true, save, sinceLastBackupDays: daysBetween(root.exportedAt, nowMs) };
}

/**
 * 整天天数（向下取整）：不足一天记 0，时钟回拨（nowMs 早于 exportedAt）同样记 0——
 * 负数会让 "已 N 天未备份" 读成 "-3 天前"，对用户毫无意义。
 */
function daysBetween(exportedAt: number, nowMs: number): number {
  const elapsed = nowMs - exportedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.floor(elapsed / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// backupReminderDue
// ---------------------------------------------------------------------------

/**
 * 提醒闸门（RF#5）：距上次备份满 `periodDays` 天才提醒一次，不做每日骚扰。
 *
 * - `lastExportedAt === null` → true（从未导出，正是最该提醒的人）；
 * - 距今 < periodDays → false；≥ periodDays → true（边界闭区间：正好第 7 天即提醒）；
 * - `lastExportedAt` 或 `nowMs` 非有限值 → true（fail-open：读数坏掉时宁可多提醒一次）；
 * - 时钟回拨（lastExportedAt 晚于 nowMs）→ false，不因负差值误判；
 * - `periodDays` 参数化的目的是可测（brief verbatim 其默认值为 7）；
 *   传入非法值（0/负/NaN）时回落默认 7 天，不把闸门永久打开或永久关死。
 *
 * 入参 `lastExportedAt` 的来源与持久位归属见文件头"exportedAt 语义定夺"。
 */
export function backupReminderDue(
  lastExportedAt: number | null,
  nowMs: number,
  periodDays: number = DEFAULT_REMINDER_PERIOD_DAYS,
): boolean {
  if (lastExportedAt === null || !Number.isFinite(lastExportedAt)) return true;
  // nowMs 非有限同样 fail-open（T6 捎带，T5 评审 Minor item 3）：修复前 `NaN - t >= period` 恒 false
  // = 静默永不提醒，正好违背本模块"宁可多提醒一次，不可静默永不提醒"的自述口径。
  if (!Number.isFinite(nowMs)) return true;
  const period = Number.isFinite(periodDays) && periodDays > 0 ? periodDays : DEFAULT_REMINDER_PERIOD_DAYS;
  return nowMs - lastExportedAt >= period * MS_PER_DAY;
}
