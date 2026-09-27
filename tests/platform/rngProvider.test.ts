/**
 * rngProvider.makeRng 契约（Plan 3 · T1；T2 捎带修订 R-T1-p3-a）。
 *
 * - seed 显式给出 → 与 mulberry32(seed) 序列逐值全等（确定性可复现）、不推进内部计数器；
 * - seed 缺省 → mixSeed(now(), ++counter)：单调计数器保证同毫秒甚至同 tick 的多次播种
 *   拿到互不相同的种子（原 performance 混入式在高位塌缩后无法做到，见 R-T1-p3-a）；
 *   种子算术全部 >>>0 收口到 uint32。
 * 时钟经 vi.mock 冻结——rngProvider 是除 core/rng 外唯一碰 Math.random 语义的点，
 * 而它实际只播种 mulberry32，不直接用它出数。
 */

import { describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '@core/rng';
import type { Rng } from '@core/rng';

vi.mock('@platform/clock', () => ({ now: vi.fn() }));

import { now } from '@platform/clock';
import { makeRng, mixSeed } from '@platform/rngProvider';

const nowMock = vi.mocked(now);

/** 取前 n 个输出值组成可比数组。 */
function take(rng: Rng, n = 8): number[] {
  return Array.from({ length: n }, () => rng());
}

describe('makeRng(seed)', () => {
  it('makeRng(42) 序列与 mulberry32(42) 全等', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    expect(take(makeRng(42))).toEqual(take(mulberry32(42)));
  });

  it('同一 seed 重复调用得到同一流；seed 不给时钟依赖', () => {
    nowMock.mockReturnValue(0);
    expect(take(makeRng(7))).toEqual(take(mulberry32(7)));
    nowMock.mockReturnValue(999_999);
    expect(take(makeRng(7))).toEqual(take(mulberry32(7)));
  });

  it('负数 / 超 32 位 seed 照常工作（mulberry32 的 |0 归一语义）', () => {
    expect(take(makeRng(-5))).toEqual(take(mulberry32(-5)));
    expect(take(makeRng(4294967297))).toEqual(take(mulberry32(4294967297)));
  });
});

describe('makeRng() 缺省播种', () => {
  it('冻结时钟、performance 不可用时仍产出合法 [0,1) 序列', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    vi.stubGlobal('performance', undefined);
    const seq = take(makeRng(), 16);
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    vi.unstubAllGlobals();
  });

  it('R-T1-p3-a：冻结时钟 + performance 缺失 → 连续两次 makeRng() 产出不同流', () => {
    // 高位塌缩回归钉子：now()*2**21 经 ToUint32 后主项恒 0x80000000（毫秒低位被移出
    // 32 位窗口），performance 缺失时同毫秒多次播种必须由内部递增计数器区分，否则
    // 同一 tick 内开出的多条 rng 流逐值相同。修复口径：缺省种子 = mixSeed(now(), ++counter)。
    nowMock.mockReturnValue(1_761_955_200_000);
    vi.stubGlobal('performance', undefined);
    const a = take(makeRng());
    const b = take(makeRng());
    expect(a).not.toEqual(b);
    // 两条流各自仍是合法 [0,1) 序列（计数器混入不改变出数分布形状）
    for (const v of [...a, ...b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    vi.unstubAllGlobals();
  });

  it('显式 seed 不推进内部计数器（重放不受缺省调用次数干扰）', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    vi.stubGlobal('performance', undefined);
    const d1 = take(makeRng());
    const r1 = take(makeRng(42));
    const r2 = take(makeRng(42));
    expect(r1).toEqual(r2);
    expect(r1).toEqual(take(mulberry32(42)));
    // 穿插两次显式调用后，下一条缺省流仍与「counter +1」的显式重放逐值全等
    let matched = -1;
    for (let k = 1; k <= 4096; k++) {
      if (take(makeRng(mixSeed(1_761_955_200_000, k))).join(',') === d1.join(',')) {
        matched = k;
        break;
      }
    }
    expect(matched).toBeGreaterThan(0);
    expect(take(makeRng()).join(',')).toEqual(
      take(makeRng(mixSeed(1_761_955_200_000, matched + 1))).join(','),
    );
    vi.unstubAllGlobals();
  });

  it('缺省种子 = mixSeed(now(), k) 形态：k 单调递增且相邻 +1', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    vi.stubGlobal('performance', undefined);
    const d1 = take(makeRng());
    const d2 = take(makeRng());
    expect(d1).not.toEqual(d2);
    // 试探定位当前 counter 值：base = (now*2**21)>>>0 = 0x8000_0000（本例 now 的低 11 位
    // ms 恰为 1024，放大后落在 uint32 第 31 位），故 k < 1024 时 base^k 与 k 一一对应、无碰撞。
    let matched = -1;
    for (let k = 1; k <= 4096; k++) {
      if (take(makeRng(mixSeed(1_761_955_200_000, k))).join(',') === d1.join(',')) {
        matched = k;
        break;
      }
    }
    expect(matched).toBeGreaterThan(0); // 缺省路径确实是 mixSeed(now, 整数计数) 形态
    // 相邻两次缺省播种的计数必相邻递增（非随机跳号）
    expect(take(makeRng(mixSeed(1_761_955_200_000, matched + 1))).join(',')).toEqual(d2.join(','));
    vi.unstubAllGlobals();
  });

  it('缺省种子与 performance 读数无关（performance 存在与否同 counter 即同流）', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    // 两条相邻缺省调用分别在「有 / 无 performance」下取样：若实现仍混入 performance，
    // 二者会因读数差异而不可比。这里用显式重放钉住「缺省 = mixSeed(now, k)」的纯形态。
    vi.stubGlobal('performance', { now: () => 12.5 });
    const d1 = take(makeRng());
    vi.stubGlobal('performance', { now: () => 9876.5 });
    const d2 = take(makeRng());
    vi.unstubAllGlobals();
    let matched = -1;
    for (let k = 1; k <= 4096; k++) {
      if (take(makeRng(mixSeed(1_761_955_200_000, k))).join(',') === d1.join(',')) {
        matched = k;
        break;
      }
    }
    expect(matched).toBeGreaterThan(0);
    // performance 读数从 12.5 跳到 9876.5，流仍只由 counter +1 决定
    expect(take(makeRng(mixSeed(1_761_955_200_000, matched + 1))).join(',')).toEqual(d2.join(','));
  });

  it('时钟走动时 5 次采样至少 4 条相异流', () => {
    let t = 1_761_955_200_000;
    nowMock.mockImplementation(() => t++);
    vi.stubGlobal('performance', { now: () => t * 0.5 });
    const streams = new Set(Array.from({ length: 5 }, () => take(makeRng(), 4).join(',')));
    expect(streams.size).toBeGreaterThanOrEqual(4);
    vi.unstubAllGlobals();
  });

  it('缺省路径不触碰 Math.random（只播种 mulberry32）', () => {
    const spy = vi.spyOn(Math, 'random');
    nowMock.mockReturnValue(1_761_955_200_000);
    take(makeRng(), 8);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
