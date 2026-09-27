/**
 * env.tzOffsetMin 单点契约（Plan 3 · T1，R-T4-a）。
 *
 * 约定：tzOffsetMin() = -new Date().getTimezoneOffset()。
 * UTC+8（Asia/Shanghai）环境下 getTimezoneOffset() === -480，故本函数返回 +480。
 * 测试进程 TZ 由 vitest 环境决定——用与实现同源的表达式做恒等断言兜底，
 * 并在确认为 UTC+8 宿主时补一条字面量断言（480），保证口径不漂移。
 */

import { describe, expect, it } from 'vitest';
import { tzOffsetMin } from '@platform/env';

describe('env.tzOffsetMin', () => {
  it('等于 -new Date().getTimezoneOffset()（R-T4-a 定义式）', () => {
    expect(tzOffsetMin()).toBe(-new Date().getTimezoneOffset());
  });

  it('UTC+8 宿主下为 +480（非该时区则跳过字面量断言）', () => {
    const hostOffset = -new Date().getTimezoneOffset();
    if (hostOffset === 480) {
      expect(tzOffsetMin()).toBe(480);
    } else {
      // 记录宿主时区，避免静默通过掩盖口径问题
      expect(tzOffsetMin()).toBe(hostOffset);
    }
  });

  it('是整数且落在合法时区偏移区间 [-720, 840]', () => {
    const v = tzOffsetMin();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(-720);
    expect(v).toBeLessThanOrEqual(840);
  });
});
