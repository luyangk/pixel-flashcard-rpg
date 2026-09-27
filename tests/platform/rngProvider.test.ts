/**
 * rngProvider.makeRng 契约（Plan 3 · T1）。
 *
 * - seed 显式给出 → 与 mulberry32(seed) 序列逐值全等（确定性可复现）；
 * - seed 缺省 → 以 clock.now() 与 performance.now()（若存在）混合播种，
 *   两次调用应产生不同流；种子算术全部 >>>0 收口到 uint32。
 * 时钟经 vi.mock 冻结——rngProvider 是除 core/rng 外唯一碰 Math.random 语义的点，
 * 而它实际只播种 mulberry32，不直接用它出数。
 */

import { describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '@core/rng';
import type { Rng } from '@core/rng';

vi.mock('@platform/clock', () => ({ now: vi.fn() }));

import { now } from '@platform/clock';
import { makeRng } from '@platform/rngProvider';

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

  it('固定 now、无 performance → 两次调用同种子同流（now()*2^21>>>0 口径）', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    vi.stubGlobal('performance', undefined);
    expect(take(makeRng())).toEqual(take(makeRng()));
    vi.unstubAllGlobals();
  });

  it('有 performance.now 时参与混合：performance 变化即换流', () => {
    nowMock.mockReturnValue(1_761_955_200_000);
    vi.stubGlobal('performance', { now: () => 12.5 });
    const a = take(makeRng());
    vi.stubGlobal('performance', { now: () => 99.25 });
    const b = take(makeRng());
    expect(a).not.toEqual(b);
    vi.unstubAllGlobals();
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
