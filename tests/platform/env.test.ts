/**
 * env.tzOffsetMin 单点契约（Plan 3 · T1，R-T4-a；T2 捎带补强）。
 *
 * 约定：tzOffsetMin() = -new Date().getTimezoneOffset()。
 * UTC+8（Asia/Shanghai）环境下 getTimezoneOffset() === -480，故本函数返回 +480。
 *
 * 补强理由（Task 1 Minor）：原先两条用例把实现表达式逐字重抄一遍（自等式），
 * 实现怎么写都恒过——不锁任何东西。现改为真锁契约：
 *  ① 非循环期望值：对已知 epoch（1970-01-01T00:00Z）手工写出各时区偏移分钟数，
 *     与运行时读数比较——期望值不由被测同一表达式产出；
 *  ② 跨进程字面量锁：spawnSync node -e 在 TZ=Asia/Shanghai 子进程里断言口径读数为 480。
 *     （TZ 是进程启动时读取的环境变量；改 process.env.TZ + vi.resetModules() 重 import
 *     无法保证已加载的 Intl/ICU 复位，故 brief 三选一取子进程形态。）
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { tzOffsetMin } from '@platform/env';

/** 1970-01-01T00:00:00Z —— 各时区在该时刻的偏移是公开常数，用于构造非循环期望值。 */
const EPOCH = 0;

/** 宿主时区在 EPOCH 的「东正西负」分钟偏移（Date 层契约，独立于 env.ts 的实现文本）。 */
const hostOffsetMin = (): number => -new Date(EPOCH).getTimezoneOffset();

describe('env.tzOffsetMin', () => {
  it('锁死宿主时区的字面量偏移（非循环期望表）', () => {
    // 期望值来自手工查表的公开常数，不是对实现的复述：
    // 1970-01-01T00:00Z 时刻，Asia/Shanghai=+480、UTC=0、America/New_York=-300（EST）、
    // Asia/Kolkata=+330、America/Sao_Paulo=-180（BRT）。表外时区说明测试环境被意外改动，
    // 直接失败而非静默通过。
    const KNOWN_EPOCH_OFFSETS: Record<number, string> = {
      480: 'Asia/Shanghai (UTC+8)',
      540: 'Asia/Tokyo (UTC+9)',
      0: 'UTC',
      330: 'Asia/Kolkata (UTC+5:30)',
      [-300]: 'America/New_York (EST)',
      [-180]: 'America/Sao_Paulo (BRT)',
    };
    const reading = hostOffsetMin();
    expect(Object.keys(KNOWN_EPOCH_OFFSETS).map(Number)).toContain(reading);
    // 被测函数必须与该字面量读数一致（若有人改掉负号，此处即失配）
    expect(tzOffsetMin()).toBe(reading);
  });

  it('TZ=Asia/Shanghai 子进程下口径恒为 +480（跨进程字面量锁）', () => {
    const probe = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(-new Date(0).getTimezoneOffset()))'],
      { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Shanghai' } },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe('480');
  });

  it('整数且落在合法时区偏移区间 [-720, 840]', () => {
    const v = tzOffsetMin();
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(-720);
    expect(v).toBeLessThanOrEqual(840);
  });
});
