/**
 * T4 · 舞台几何纯函数（layout.ts）。
 *
 * 口径来源：task-4-brief.md Step 1 + 环境注记「整数缩放」/ RF#2「永不非整数缩放」。
 * 本文件只吃纯函数，不需要 DOM 环境（vitest environment: node）。
 */
import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, fitScale, letterbox } from '../../src/stage/layout';

describe('LOGICAL_W / LOGICAL_H', () => {
  it('画布逻辑尺寸钉在 320×240', () => {
    expect(LOGICAL_W).toBe(320);
    expect(LOGICAL_H).toBe(240);
  });
});

describe('fitScale', () => {
  it('640×480 → 2', () => {
    expect(fitScale(640, 480)).toBe(2);
  });

  it('1280×720 → 3（floor(720/240)=3 比 1280/320=4 小，取小然后取整）', () => {
    expect(fitScale(1280, 720)).toBe(3);
  });

  it('比逻辑尺寸还小的视口 → 钳到 1（不出现 0 倍或小数）', () => {
    expect(fitScale(319, 239)).toBe(1);
    expect(fitScale(1, 1)).toBe(1);
  });

  it('非整数比一律向下取整', () => {
    expect(fitScale(700, 500)).toBe(2); // min(2.1875, 2.0833) → 2
    expect(fitScale(959, 719)).toBe(2); // min(2.9969, 2.9958) → 2
    expect(fitScale(960, 720)).toBe(3);
  });

  it('maxInt 钳制上界', () => {
    expect(fitScale(2000, 2000, 2)).toBe(2);
    expect(fitScale(1280, 720, 8)).toBe(3);
    expect(fitScale(2000, 2000, 1)).toBe(1);
  });

  it('缺省 maxInt = 4', () => {
    expect(fitScale(5000, 5000)).toBe(4);
  });

  it('非法 maxInt（<1 / 非有限）按 1 处理，不影响 ≥1 保证', () => {
    expect(fitScale(5000, 5000, 0)).toBe(1);
    expect(fitScale(5000, 5000, -3)).toBe(1);
    expect(fitScale(5000, 5000, Number.NaN)).toBe(1);
    expect(fitScale(5000, 5000, 2.9)).toBe(2);
  });

  it('非法视口（非有限 / 负数）按 0 处理 → 1', () => {
    expect(fitScale(Number.NaN, 480)).toBe(1);
    expect(fitScale(640, Number.POSITIVE_INFINITY)).toBe(1); // 非有限视口按 0 处理
    expect(fitScale(-100, -100)).toBe(1);
  });

  it('返回值恒为 ≥1 的整数', () => {
    for (let w = 0; w <= 1400; w += 37) {
      for (let h = 0; h <= 1400; h += 53) {
        const s = fitScale(w, h);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe('letterbox', () => {
  it('整倍贴合视口：偏移为 0，尺寸 = 逻辑×scale', () => {
    expect(letterbox(640, 480, 2)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    expect(letterbox(960, 720, 3)).toEqual({ x: 0, y: 0, w: 960, h: 720 });
  });

  it('宽出部分左右均分（居中偏移公式）', () => {
    expect(letterbox(700, 480, 2)).toEqual({ x: 30, y: 0, w: 640, h: 480 });
  });

  it('偏移取整（半像素会糊）：30.5 floor 成 30，1.5 floor 成 1', () => {
    expect(letterbox(701, 481, 2)).toEqual({ x: 30, y: 0, w: 640, h: 480 });
    expect(letterbox(701, 483, 2)).toEqual({ x: 30, y: 1, w: 640, h: 480 });
  });

  it('上下留黑边', () => {
    expect(letterbox(640, 600, 2)).toEqual({ x: 0, y: 60, w: 640, h: 480 });
  });

  it('视口小于舞台时偏移不出现负数（钳 0）', () => {
    expect(letterbox(400, 200, 3)).toEqual({ x: 0, y: 0, w: 960, h: 720 });
    expect(letterbox(319, 239, 1)).toEqual({ x: 0, y: 0, w: 320, h: 240 });
  });

  it('非整数 scale 先向下取整再算尺寸（RF#2：永不非整数缩放）', () => {
    expect(letterbox(700, 480, 2.5)).toEqual({ x: 30, y: 0, w: 640, h: 480 });
    expect(letterbox(960, 720, 2.999)).toEqual({ x: 160, y: 120, w: 640, h: 480 });
  });

  it('非法 scale / 视口退化仍返回整数几何且不为负', () => {
    const box = letterbox(Number.NaN, Number.NaN, Number.NaN);
    expect(box).toEqual({ x: 0, y: 0, w: 320, h: 240 });
    const s0 = letterbox(640, 480, 0);
    expect(s0).toEqual({ x: 160, y: 120, w: 320, h: 240 }); // scale 消毒成 1 后仍居中
    for (const v of Object.values(letterbox(-5, -5, 2))) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('与 fitScale 串联恒等于「整数缩放 + 不溢出的居中」', () => {
    for (const [w, h] of [
      [360, 640],
      [412, 915],
      [720, 1280],
      [1080, 2400],
      [319, 239],
    ] as const) {
      const s = fitScale(w, h);
      const box = letterbox(w, h, s);
      expect(Number.isInteger(s)).toBe(true);
      expect(box.w).toBe(LOGICAL_W * s);
      expect(box.h).toBe(LOGICAL_H * s);
      // 落位必须是整数像素（半像素会让整幅像素画糊掉）——比"等于公式"更强的不变量。
      expect(Number.isInteger(box.x)).toBe(true);
      expect(Number.isInteger(box.y)).toBe(true);
      expect(box.x + box.w).toBeLessThanOrEqual(Math.max(w, box.w));
      expect(box.y + box.h).toBeLessThanOrEqual(Math.max(h, box.h));
      // 两侧留白差不超过 1px（居中）
      expect(Math.abs((w - box.w) / 2 - box.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((h - box.h) / 2 - box.y)).toBeLessThanOrEqual(1);
    }
  });
});
