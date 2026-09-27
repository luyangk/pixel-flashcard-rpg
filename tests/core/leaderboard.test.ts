/**
 * leaderboard —— 本地战绩榜计分与排序（Plan 2 · T9，PRD §5 首版"本地榜"数据层）。
 *
 * 本层是纯展示派生：不读时钟、不写存储——RunRecord 由上层（战斗结算）组装后传入，
 * id/at 均是调用方注入的数据。测试侧重点：
 * - scoreRun 公式手算锚点（brief verbatim：won ? (cards−misses)×10 + level×5
 *   + (boss?50:0) : 0，下限 0）；
 * - rankRuns 排序稳定性：score 降序、同分 at 新者前、输入数组绝不被 mutate；
 * - 边界：空表、limit 截断与非法 limit 回落默认 20。
 */

import { describe, expect, it } from 'vitest';
import { rankRuns, scoreRun, type RunRecord } from '@core/leaderboard';

const T0 = 1761955200000; // 2025-11-01T00:00Z 附近的中性时间戳，纯数据不作时钟

/** 构造一条战绩记录：over 覆盖计分相关字段。 */
function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r',
    at: T0,
    result: 'won',
    kind: 'encounter',
    domain: 'd1',
    cards: 10,
    misses: 2,
    level: 3,
    score: 0, // score 是派生值，占位——rankRuns 用例里显式给出或用 scoreRun 填
    ...over,
  };
}

type RawRun = Omit<RunRecord, 'score' | 'id'>;

/** scoreRun 入参样本：去掉 id/score 的裸记录。 */
function raw(over: Partial<RawRun> = {}): RawRun {
  const { id: _id, score: _score, ...rest } = rec(over as Partial<RunRecord>);
  return rest;
}

// ---------------------------------------------------------------------------
// scoreRun —— 计分手算三例（Step 1 要求逐字可验）
// ---------------------------------------------------------------------------

describe('scoreRun', () => {
  it('手算例①：won encounter cards=10 misses=2 level=3 → (10−2)×10+3×5+0 = 95', () => {
    expect(scoreRun(raw({ result: 'won', kind: 'encounter', cards: 10, misses: 2, level: 3 }))).toBe(95);
  });

  it('手算例②：won boss cards=15 misses=4 level=6 → (15−4)×10+6×5+50 = 190', () => {
    expect(scoreRun(raw({ result: 'won', kind: 'boss', cards: 15, misses: 4, level: 6 }))).toBe(190);
  });

  it('手算例③：lost → 0（无论其余字段多漂亮）', () => {
    expect(
      scoreRun(raw({ result: 'lost', kind: 'boss', cards: 25, misses: 0, level: 99 })),
    ).toBe(0);
  });

  it('下限 0：misses > cards 的倒挂局不得产出负分', () => {
    expect(scoreRun(raw({ result: 'won', kind: 'encounter', cards: 3, misses: 10, level: 1 }))).toBe(0);
    // 恰好 −5 → clamp 0；+5 → 越线即正
    expect(scoreRun(raw({ result: 'won', cards: 2, misses: 3, level: 1 }))).toBe(0);
    expect(scoreRun(raw({ result: 'won', cards: 2, misses: 2, level: 1 }))).toBe(5);
  });

  it('零张卡也认账：won cards=0 misses=0 level=1 encounter → 5（level 项保底）', () => {
    expect(scoreRun(raw({ result: 'won', kind: 'encounter', cards: 0, misses: 0, level: 1 }))).toBe(5);
  });

  it('非有限数消毒：NaN/Infinity 入各数值字段一律按 0 计，输出永不含 NaN', () => {
    // cards→0：(0−1)<0 clamp 0；level→0：(5−1)×10+0=40；misses→0：5×10+2×5=60
    expect(scoreRun(raw({ cards: NaN, misses: 1, level: 2 }))).toBe(0);
    expect(scoreRun(raw({ cards: Infinity, misses: 1, level: 2 }))).toBe(0);
    expect(scoreRun(raw({ cards: 5, misses: 1, level: NaN }))).toBe(40);
    expect(scoreRun(raw({ cards: 5, misses: NaN, level: 2 }))).toBe(60);
  });

  it('小数向下取整（与 stats.nonNegIntOr 的天级口径同款消毒）', () => {
    // floor(9.7)=9, floor(2.2)=2, floor(3.9)=3 → (9−2)×10+3×5 = 85
    expect(scoreRun(raw({ cards: 9.7, misses: 2.2, level: 3.9 }))).toBe(85);
  });
});

// ---------------------------------------------------------------------------
// rankRuns —— 排序规则
// ---------------------------------------------------------------------------

describe('rankRuns', () => {
  /** 便捷：把裸记录补上 score 与 id 变成完整 RunRecord。 */
  function full(id: string, over: Partial<RunRecord> = {}): RunRecord {
    const base = rec({ id, ...over });
    return { ...base, score: over.score ?? scoreRun(base) };
  }

  it('score 降序排列', () => {
    const a = full('a', { cards: 5, misses: 0, level: 1 }); // 55
    const b = full('b', { cards: 10, misses: 0, level: 1 }); // 105
    const c = full('c', { cards: 7, misses: 0, level: 1 }); // 75
    expect(rankRuns([a, b, c]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('同分按 at 新者前（先到的旧纪录让位给刷新者）', () => {
    const old1 = full('old', { at: T0, cards: 5, misses: 0, level: 1 });
    const new1 = full('new', { at: T0 + 86_400_000, cards: 5, misses: 0, level: 1 });
    // 输入顺序新旧颠倒也要排成新在前——排序键与输入序无关
    expect(rankRuns([new1, old1]).map((r) => r.id)).toEqual(['new', 'old']);
    expect(rankRuns([old1, new1]).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('at 也相同的同分记录保持输入相对顺序（稳定排序承诺）', () => {
    const x = full('x', { at: T0, cards: 5, misses: 0, level: 1 });
    const y = full('y', { at: T0, cards: 5, misses: 0, level: 1 });
    expect(rankRuns([x, y]).map((r) => r.id)).toEqual(['x', 'y']);
    expect(rankRuns([y, x]).map((r) => r.id)).toEqual(['y', 'x']);
  });

  it('空表 → 空数组', () => {
    expect(rankRuns([])).toEqual([]);
  });

  it('limit 截断：只返回前 limit 名', () => {
    const list = Array.from({ length: 30 }, (_, i) =>
      full(`r${i}`, { at: T0 + i, cards: i + 1, misses: 0, level: 1 }),
    );
    const top5 = rankRuns(list, 5);
    expect(top5).toHaveLength(5);
    expect(top5.map((r) => r.id)).toEqual(['r29', 'r28', 'r27', 'r26', 'r25']);
  });

  it('limit 缺省为 20', () => {
    const list = Array.from({ length: 25 }, (_, i) =>
      full(`r${i}`, { at: T0 + i, cards: i + 1, misses: 0, level: 1 }),
    );
    expect(rankRuns(list)).toHaveLength(20);
  });

  it('非法 limit（0/负/小数/NaN/超大）安全回落：≤0 与 NaN 回落默认 20，超长按全量截尾', () => {
    const list = Array.from({ length: 25 }, (_, i) =>
      full(`r${i}`, { at: T0 + i, cards: i + 1, misses: 0, level: 1 }),
    );
    for (const bad of [0, -3, Number.NaN]) expect(rankRuns(list, bad)).toHaveLength(20);
    expect(rankRuns(list, 1.5)).toHaveLength(1); // 小数向下取整
    expect(rankRuns(list, 1e9)).toHaveLength(25); // 超界不炸，自然截到尾
  });

  it('绝不 mutate 输入数组：原序原样，返回值是新数组', () => {
    const list = [
      full('a', { cards: 1, misses: 0, level: 1 }),
      full('b', { cards: 9, misses: 0, level: 1 }),
    ];
    const snapshot = [...list];
    const ranked = rankRuns(list);
    expect(list).toEqual(snapshot);
    expect(list.map((r) => r.id)).toEqual(['a', 'b']); // 输入序未被就地打乱
    expect(ranked).not.toBe(list);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('脏元素（null/非对象/缺 score）剔除，不产 undefined 行', () => {
    const good = full('g', { cards: 4, misses: 0, level: 1 });
    const dirty = [good, null, 42, { id: 'h' }] as unknown as RunRecord[];
    expect(rankRuns(dirty)).toEqual([good]);
  });

  it('scoreRun 纯函数：不改写入参对象', () => {
    const r = raw({ cards: 8, misses: 3, level: 2 });
    const before = { ...r };
    scoreRun(r);
    expect(r).toEqual(before);
  });
});
