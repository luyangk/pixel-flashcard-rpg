/**
 * RNG 唯一播种点（Plan 3 · T1，全局约束）。
 *
 * rngProvider 是除 core/rng 外唯一碰 Math.random 语义的点——实际上它完全不触碰：
 * 缺省 seed 由 clock.now() 与单调计数器混合出一个 uint32，再交给 mulberry32 出数。
 * 出数永远走可复现的种子流，不直接采平台随机源。
 *
 * 播种口径（R-T1-p3-a 修订，替代 brief 原式）：mixSeed(now(), ++counter)。
 * 原式 (now()*2^21 ^ performance.now?.())>>>0 有高位塌缩缺陷——now()*2^21 经 ToUint32
 * 恒为 0x80000000，performance 缺失时同毫秒多次调用拿到同一种子。详见 makeRng 注释。
 * mixSeed 保留导出（T1 评审裁决），仍可用于显式派生与测试重放。
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

/**
 * 缺省播种的单调计数器（模块私有）。每次 makeRng() 缺省路径 ++counter，
 * 保证同一毫秒、甚至同一 tick 内多次播种拿到互不相同的种子。
 */
let counter = 0;

/**
 * 生成一个 Rng。
 * - 显式 seed：直接 mulberry32(seed)，与时钟无关、不推进内部计数器，同 seed → 同序列。
 * - 缺省 seed：mixSeed(now(), ++counter)。
 *   【R-T1-p3-a】不再沿用 brief 原式 `(now()*2^21 ^ performance.now?.())>>>0` 作唯一熵源：
 *   now() 量级 ~1.76e12，乘 2^21 后在 ToUint32 取模下毫秒低位被整体移出 32 位窗口，
 *   主项恒为 0x80000000——实际熵几乎全来自 performance.now()。宿主 performance 缺失
 *   （或读数在同毫秒内不变）时，同毫秒多次调用会拿到同一种子、开出完全相同的流。
 *   修复：把递增计数器作为 subMs 混入。performance 读数不再参与缺省播种——它的整数部分
 *   与 now() 同源、小数部分受宿主 clamping 策略支配（Node/WebView 精度不一），契约不稳；
 *   需要该熵源的调用方可显式 mixSeed(now(), performance.now()) 传 seed。
 */
export function makeRng(seed?: number): Rng {
  const s = seed === undefined ? mixSeed(now(), ++counter) : seed;
  return mulberry32(s);
}
