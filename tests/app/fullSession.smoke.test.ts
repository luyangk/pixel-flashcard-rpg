/**
 * fullSession.smoke.test.ts —— Plan 3 · T8 headless 整局冒烟（DoD1 的可执行证据链）。
 *
 * 「无画面的可玩游戏」在这里被端到端跑一遍：种子档导入 30 张卡 → startFight(size 15)
 * → 逐张 answerCurrent（seeded 70% good / 30% again）→ settleFight 落账 → settleAndRecord
 * → flush()&&!dirty() → 备份导出 → 重开 coordinator 恢复 → 断言 SRS / domainReviewCount /
 * leaderboard / exp 全链一致 → exportBackup→parseBackup 往返无损 → 导回空环境。
 *
 * 时间纪律（全局约束）：全程无真实时钟——vi.useFakeTimers + vi.setSystemTime 冻结宿主轴，
 * coordinator 的 now 由 platform/clock 注入（与生产同一条缝），时区由 platform/env mock 固定为
 * UTC+8。因此断言里的每个时间戳都是可复算的常量，不存在"跑得快慢影响结果"。
 *
 * 本节（SM#4/SM#5）：导入/导出编排守卫。整局链路（SM#1–SM#3）、假记忆演出（SM#6）
 * 与源码扫描门禁（SM#7）见文件下半部。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, SaveFile } from '@core/types';
import { exportBackup, parseBackup } from '../../src/app/backup';
import { exportBackupText, importBackupText } from '../../src/app/transfer';

// —— 仿真锚点：2026-10-26T04:00Z，UTC+8 下本地日键为 2026-10-26（与仓内既有夹具同源）——
const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const DAY = 86_400_000;
const TZ = 480; // UTC+8（platform/env mock 后的固定值）

/** 一份整包合法的存档（validateSave / parseBackup 都能接受的最小形状）。 */
function makeSave(cards: Card[] = [], over: Partial<SaveFile> = {}): SaveFile {
  return {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '领域A', isPreset: true }],
    cards,
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
    ...over,
  };
}

describe('Plan 3 · T8 导入/导出编排守卫', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * T5 评审 M5（R-T5-p3-c：归 T8 守卫）。exportBackup 是刻意不校验入参的纯函数
   * （T5 §顾虑 3 的自述口径），因此脏入参能产出**结构残缺的信封**：
   * `save: undefined` 会被 JSON.stringify 整键丢弃，`nowMs: NaN` 会序列化成 `null`。
   * 这样的文件用户看不见问题、却在导入时被拒——正是"M5 归 UI 守卫"的理由。
   *
   * 用例分两半：先**演示**未守卫时的真实后果（证明守卫不是装饰），再断言编排层
   * （src/app/transfer.exportBackupText）把这两种入参挡在"生成文件"之前。
   */
  it('SM#4 导出脏入参守卫：不产出缺 save 键 / exportedAt:null 的信封（T5 M5）', () => {
    // ① 未守卫的真实后果：类型层已拦（@ts-expect-error 由 typecheck 强制），
    //    运行期它照样会生成一份"残信封"——这就是要防的东西。
    const degenerate = (() => {
      // @ts-expect-error save 为必填 SaveFile：类型层不接受 undefined
      return exportBackup(undefined, NaN);
    })();
    const raw = JSON.parse(degenerate) as Record<string, unknown>;
    expect('save' in raw).toBe(false); // 缺 save 键（JSON.stringify 丢弃 undefined）
    expect('exportedAt' in raw).toBe(true);
    expect(raw.exportedAt).toBe(null); // NaN → null：导入侧 isTimestamp 必拒

    // ② 编排守卫：脏入参直接失败，绝不落到 exportBackup
    const noSave = exportBackupText(undefined as unknown as SaveFile, NOW);
    expect(noSave.ok).toBe(false);
    if (!noSave.ok) expect(noSave.reason).toContain('存档还没准备好');

    for (const badNow of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      const r = exportBackupText(makeSave(), badNow);
      expect(r.ok).toBe(false);
    }

    // ③ 守卫与信封的接受域同界：合法时刻产出的信封必被 parseBackup 接受（边界值含在内）
    for (const goodNow of [NOW, 0, 8.64e15]) {
      const r = exportBackupText(makeSave(), goodNow);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const parsed = parseBackup(r.text, NOW);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.save).toStrictEqual(makeSave());
      }
    }
  });

  /**
   * R-T6-p3-b：parseBackup 的 doc 明说"唯一的例外是迁移器内部的真 bug，此类原样上抛
   * 不伪装成存档坏了"。UI 直接调它就可能吃到未捕获异常——导入路径必须 try/catch。
   *
   * 用例覆盖两条路径：①真实的畸形串（parseBackup 自身已收敛为信封层 ok:false）；
   * ②模拟那个"原样上抛"的真 bug（注入抛错解析器），断言编排层接住并给出可读 reason。
   */
  it('SM#5 导入编排 try/catch：畸形串不抛，内部真 bug 也被接住（R-T6-p3-b）', () => {
    // ① 畸形串：用户随手粘进来的东西
    const bad = importBackupText('这不是 JSON，只是随手粘的一段话', NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('JSON');
    // 空串 / 半个信封 / 别的应用的文件 同样只回 reason
    for (const text of ['', '   ', '{', '{"format":"other"}', '[]']) {
      expect(() => importBackupText(text, NOW)).not.toThrow();
      expect(importBackupText(text, NOW).ok).toBe(false);
    }

    // ② 真 bug 路径：parseBackup 会把非迁移前缀的异常原样上抛，编排层必须接住
    const boom = (): never => {
      throw new Error('boom: 迁移器内部错误');
    };
    expect(() => importBackupText('{"format":"zx-xia-backup"}', NOW, boom)).not.toThrow();
    const caught = importBackupText('{"format":"zx-xia-backup"}', NOW, boom);
    expect(caught.ok).toBe(false);
    if (!caught.ok) {
      expect(caught.reason).toContain('导入没能完成');
      expect(caught.reason).toContain('boom');
      expect(caught.reason).toContain('没有被改动'); // 给用户的定心话
    }
  });
});
