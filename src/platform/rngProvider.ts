/**
 * RNG 唯一播种点（Plan 3 · T1，全局约束）。
 *
 * rngProvider 是除 core/rng 外唯一碰 Math.random 语义的点——实际上它完全不触碰：
 * 缺省 seed 由 clock.now() 与 performance.now()（若存在）混合出一个 uint32，
 * 再交给 mulberry32 出数。出数永远走可复现的种子流，不直接采平台随机源。
 *
 * 播种口径（brief 逐字）：(now()*2^21 ^ performance.now?.())>>>0；
 * performance API 可能不存在——typeof 守卫，缺省只用 now() 播种。
 */

import type { Rng } from '@core/rng';
import { mulberry32 } from '@core/rng';
import { now } from '@platform/clock';

/**
 * 混入 subMs 得到 uint32 种子：主时钟放大 2^21 位后与亚秒钟异或。
 * 全部运算 >>>0 收口到 uint32；subMs 传 null/undefined 时跳过（仅 now 播种）。
 */
export function mixSeed(mainMs: number, subMs: number | null | undefined): number {
  const base = (mainMs * 2 ** 21) >>> 0;
  if (subMs == null || !Number.isFinite(subMs)) return base;
  return (base ^ (subMs >>> 0)) >>> 0;
}

/** 当前可用的亚秒时钟读数；performance 缺失或不完整时返回 null。 */
function readSubMs(): number | null {
  if (typeof performance === 'undefined' || performance == null) return null;
  if (typeof performance.now !== 'function') return null;
  return performance.now();
}

/**
 * 生成一个 Rng。
 * - 显式 seed：直接 mulberry32(seed)，与时钟无关，同 seed → 同序列（测试注入固定 seed）。
 * - 缺省 seed：以 (now()*2^21 ^ performance.now?.())>>>0 混合播种；
 *   performance 不可用时只用 now()。
 */
export function makeRng(seed?: number): Rng {
  const s = seed === undefined ? mixSeed(now(), readSubMs()) : seed;
  return mulberry32(s);
}
