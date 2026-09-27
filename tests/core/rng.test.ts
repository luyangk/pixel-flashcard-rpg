import { describe, expect, it } from 'vitest';
import type { Rng } from '@core/rng';
import { mulberry32, pickWeighted, uniform } from '@core/rng';

/**
 * 领域不变量：Rng = () => number，输出域 [0,1)。
 * 本文件同时用类型层断言钉住 Rng 的可调用签名（seed → 发生器可赋值给 Rng）。
 */
const asRng: Rng = mulberry32(7);
void asRng;

describe('mulberry32', () => {
  it('同 seed 序列逐值可复现（两个独立实例前 1000 个值全等）', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it('不同 seed 产生不同序列（首值即分叉）', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('黄金参考序列：seed=0 的前 5 个值（对已知正确的 JS 实现预先固化）', () => {
    // 若本实现偏离标准 mulberry32，此断言先红——测试即规格。
    const f = mulberry32(0);
    expect([f(), f(), f(), f(), f()]).toEqual([
      0.26642920868471265,
      0.0003297457005828619,
      0.2232720274478197,
      0.1462021479383111,
      0.46732782293111086,
    ]);
  });

  it('输出恒 ∈[0,1)：100_000 次采样无越界、无 NaN', () => {
    const f = mulberry32(0xdead_beef);
    for (let i = 0; i < 100_000; i++) {
      const v = f();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('负 seed 与超 32 位 seed 照常工作（内部先归一到 int32），且可复现', () => {
    for (const seed of [-123_456, 0x1_0000_0000 + 5, Number.MAX_SAFE_INTEGER]) {
      const f = mulberry32(seed);
      const v = f();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(mulberry32(seed)()).toBe(v);
    }
  });
});

describe('uniform', () => {
  it('uniform(rng, 0.9, 1.1) 落界内（brief 指定用例）', () => {
    const f = mulberry32(2024);
    for (let i = 0; i < 1000; i++) {
      const v = uniform(f, 0.9, 1.1);
      expect(v).toBeGreaterThanOrEqual(0.9);
      expect(v).toBeLessThan(1.1);
    }
  });

  it('闭区间下界可达、上界不可达；lo===hi 恒等于 lo', () => {
    const f = mulberry32(3);
    expect(uniform(f, 5, 5)).toBe(5);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < 10_000; i++) {
      const v = uniform(f, -2, 7);
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
    }
    expect(mn).toBeGreaterThanOrEqual(-2);
    expect(mx).toBeLessThan(7);
  });

  it('确定性：同一 seed 下两次 uniform 调用序列一致', () => {
    const seq = (g: Rng) => [uniform(g, 0, 100), uniform(g, -1, 1), uniform(g, 50, 60)];
    expect(seq(mulberry32(9))).toEqual(seq(mulberry32(9)));
  });
});

describe('pickWeighted', () => {
  const w = (x: { weight: number }) => x.weight;

  it('空数组返回 null，不抛（weightOf 不得被调用）', () => {
    expect(pickWeighted(mulberry32(1), [] as number[], () => {
      throw new Error('weightOf must not be called on an empty array');
    })).toBeNull();
  });

  it('权重和为 0 返回 null，不抛（全零权重走 null 路径）', () => {
    const items = [{ k: 'a', weight: 0 }, { k: 'b', weight: 0 }];
    expect(pickWeighted(mulberry32(1), items, w)).toBeNull();
  });

  it('权重和为负返回 null，不抛', () => {
    const items = [{ k: 'a', weight: 1 }, { k: 'b', weight: -5 }];
    expect(pickWeighted(mulberry32(1), items, w)).toBeNull();
  });

  it('返回值必属输入集合，且同 seed 选择序列可复现', () => {
    const items = [{ k: 'a', weight: 3 }, { k: 'b', weight: 1 }, { k: 'c', weight: 5 }] as const;
    const run = () => {
      const g = mulberry32(77);
      return Array.from({ length: 200 }, () => pickWeighted(g, items, w));
    };
    const first = run();
    expect(first).toEqual(run());
    for (const p of first) {
      expect(items).toContain(p);
    }
  });

  it('分布冒烟：1000 次加权 3:1，比例粗断 ±15%', () => {
    const items = [
      { k: 'heavy', weight: 3 },
      { k: 'light', weight: 1 },
    ];
    const g = mulberry32(1234);
    let heavy = 0;
    for (let i = 0; i < 1000; i++) {
      if (pickWeighted(g, items, w)?.k === 'heavy') heavy++;
    }
    // 期望占比 75%，容差 ±15%（绝对百分点）
    expect(heavy).toBeGreaterThanOrEqual(600);
    expect(heavy).toBeLessThanOrEqual(900);
  });

  it('单元素非零权重恒选它（含极端权重值）', () => {
    const g = mulberry32(5);
    const tiny = [{ k: 'x', weight: Number.MIN_VALUE }];
    for (let i = 0; i < 50; i++) {
      expect(pickWeighted(g, tiny, w)?.k).toBe('x');
    }
  });
});
