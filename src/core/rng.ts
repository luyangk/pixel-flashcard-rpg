/**
 * 可注入的确定性 RNG（Plan 2 · T2）。
 *
 * 战斗循环与卡池生成需要「同 seed → 同序列」的可复现随机性：
 * core 层禁止直接调用 Math.random（全局约束），一切随机源必须由调用方注入。
 * mulberry32 是纯算术的种子发生器，不触碰任何平台 API；
 * Math.random 的生产包装属于平台层，不在本模块。
 */

/** 随机源约定：每次调用返回 [0,1) 内的一个数。 */
export type Rng = () => number;

/**
 * mulberry32：32 位种子 → [0,1) 序列（公开领域的标准实现，逐字对齐参考写法）。
 * seed 先经 `| 0` 归一到 int32，负数/超 32 位输入照常工作。
 */
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [lo, hi) 均匀采样；lo === hi 时恒等于 lo。 */
export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/**
 * 加权抽取：以 weightOf 读取权重，按累计权重落点选中一项。
 * 防御性契约（全局约束）：空数组、权重和 ≤ 0（含全零、负权重致和为负）、
 * 权重中出现非有限值——一律返回 null，不抛异常。
 * 越界防护：浮点累计误差使落点恰越过总重时回落到最后一个正权重项。
 */
export function pickWeighted<T>(
  rng: Rng,
  items: readonly T[],
  weightOf: (t: T) => number,
): T | null {
  if (items.length === 0) return null;

  let total = 0;
  for (const item of items) {
    const w = weightOf(item);
    if (!Number.isFinite(w)) return null; // NaN/Infinity 权重表视为无效
    total += w;
  }
  if (!(total > 0)) return null; // ≤0 或 NaN 走 null 路径

  let roll = rng() * total;
  for (const item of items) {
    roll -= weightOf(item);
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}
