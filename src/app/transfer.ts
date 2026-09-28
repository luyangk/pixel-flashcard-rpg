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
 * 时间纪律：本文件不读宿主时钟（与 backup.ts 同规格），nowMs 一律入参化。
 */

import type { SaveFile } from '@core/types';
import { MAX_TIME_MS } from '@core/saveMigrate';
import { exportBackup, parseBackup, type BackupParseResult } from './backup';

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
