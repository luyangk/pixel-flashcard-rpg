/**
 * 时钟唯一入口（Plan 3 · T1，全局约束）。
 *
 * 全仓唯一允许出现 `Date.now(` 的文件：src/app/** 与 src/core/** 一律经本模块取时间，
 * 测试通过 vi.mock('@platform/clock') 冻结/推进时钟，生产路径读系统毫秒钟。
 * core 层依旧只收显式 nowMs 入参——本模块属于 platform，不受 purity 扫描但保持零副作用 import。
 */

/** 当前 Unix 毫秒时间戳（与 Date.now() 同口径，UTC，不含时区信息）。 */
export function now(): number {
  return Date.now();
}
