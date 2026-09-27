/**
 * deckBuild.ts —— Plan 2 · T6 备战卡池生成（80/20 智能配卡 + 主题筛选 + Boss 达标检查）。
 * verbatim 约束：智能段 = max(1, round(size×0.8))、自选段 = size − 智能段（size=1 → 1+0）；
 * 不足降级链：到期卡(限 deckIds) → 放宽未到期(仍限 deckIds) → 返回全部可用(<size)；0 可用 → []；
 * 输出天然无重复 cardId（衔接 createBattle 的 duplicate-card throw）；同 seed 两次 buildPool 全等。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState, Stability } from '@core/types';
import { mulberry32, type Rng } from '@core/rng';
import { bossCheck, buildPool } from '@core/deckBuild';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0); // 固定时钟锚点（core 不读时钟，测试自备时间戳）
const DAY = 86_400_000;

/** dueOffset < 0 → 已到期；≥ 0 → 未到期。deckId 默认 d-a。 */
function makeCard(
  id: string,
  opts: { deckId?: string; dueOffset?: number; stability?: Stability; days?: string[] } = {},
): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 6,
    reps: 2,
    lapses: 0,
    due: NOW + (opts.dueOffset ?? -DAY),
    stability: opts.stability ?? 'review',
    effectiveReviewDays: opts.days ?? [],
  };
  return { id, deckId: opts.deckId ?? 'd-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

/** 生成 n 张连续命名的到期卡。 */
function dueRun(prefix: string, n: number, deckId = 'd-a'): Card[] {
  return Array.from({ length: n }, (_, i) => makeCard(`${prefix}${i}`, { deckId, dueOffset: -(n - i) * DAY }));
}

/** rng ≡ 0.5：pickWeighted 落点恒在总重中点，选择完全确定，便于手钉。 */
const HALF: Rng = () => 0.5;

const ids = (pool: readonly Card[]): string[] => pool.map((c) => c.id);

function assertNoDuplicateIds(pool: readonly Card[]): void {
  const seen = new Set<string>();
  for (const c of pool) {
    expect(seen.has(c.id), `duplicate cardId in pool: ${c.id}`).toBe(false);
    seen.add(c.id);
  }
}

describe('buildPool —— 80/20 分割取整（verbatim）', () => {
  it('BP#1 size=15 → 智能段 12 + 自选段 3（round(15×0.8)=12）', () => {
    const cards = [...dueRun('s', 20), ...Array.from({ length: 10 }, (_, i) => makeCard(`f${i}`, { dueOffset: DAY }))];
    const pool = buildPool(cards, { size: 15, rng: mulberry32(7), nowMs: NOW });
    expect(pool).toHaveLength(15);
    // 前 12 张来自到期队列（紧迫度升序），后 3 张是剩余池中的卡
    expect(ids(pool).slice(0, 12)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11']);
    const smart = new Set(ids(pool).slice(0, 12));
    for (const c of pool.slice(12)) expect(smart.has(c.id)).toBe(false);
    assertNoDuplicateIds(pool);
  });

  it('BP#2 size=1 → 1+0：只有智能段一张，rng 零消耗', () => {
    const cards = dueRun('x', 5);
    const a = buildPool(cards, { size: 1, rng: mulberry32(1), nowMs: NOW });
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe('x0'); // 最紧迫的一张
    // size=1 时 max(1, round(0.8))=1、自选段 = 1−1 = 0
  });

  it('BP#3 size=2 → 2+0：round(2×0.8)=2，自选段为 0', () => {
    const cards = dueRun('y', 5);
    expect(buildPool(cards, { size: 2, rng: HALF, nowMs: NOW })).toHaveLength(2);
    expect(ids(buildPool(cards, { size: 2, rng: HALF, nowMs: NOW }))).toEqual(['y0', 'y1']);
  });

  it('BP#4 size=5 → 4+1：round(5×0.8)=4，自选段恰 1 张', () => {
    const due = dueRun('p', 4); // 恰好 4 张到期
    const fresh = Array.from({ length: 6 }, (_, i) => makeCard(`q${i}`, { dueOffset: DAY }));
    const pool = buildPool([...due, ...fresh], { size: 5, rng: HALF, nowMs: NOW });
    expect(pool).toHaveLength(5);
    expect(ids(pool).slice(0, 4)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(fresh.some((c) => c.id === pool[4].id)).toBe(true);
  });

  it('BP#5 非法 size（0/负/小数/NaN/Infinity）→ []，永不抛异常', () => {
    const cards = dueRun('z', 5);
    for (const size of [0, -3, 2.5, NaN, Infinity]) {
      expect(buildPool(cards, { size, rng: HALF, nowMs: NOW })).toEqual([]);
    }
  });
});

describe('buildPool —— deckIds 主题筛选', () => {
  it('BP#6 多选过滤生效：池内只含所选卡组', () => {
    const a = dueRun('a', 10, 'd-a');
    const b = dueRun('b', 10, 'd-b');
    const c = dueRun('c', 10, 'd-c');
    const pool = buildPool([...a, ...b, ...c], { size: 15, deckIds: ['d-a', 'd-c'], rng: mulberry32(3), nowMs: NOW });
    expect(pool).toHaveLength(15);
    for (const card of pool) expect(['d-a', 'd-c']).toContain(card.deckId);
    assertNoDuplicateIds(pool);
  });

  it('BP#7 单 deckId 限定下自选段也不越界（剩余池同样过滤）', () => {
    const target = [...dueRun('t', 3, 'd-1'), makeCard('t3', { deckId: 'd-1', dueOffset: DAY })];
    const others = Array.from({ length: 20 }, (_, i) => makeCard(`o${i}`, { deckId: 'd-2', dueOffset: DAY }));
    const pool = buildPool([...target, ...others], { size: 10, deckIds: ['d-1'], rng: mulberry32(9), nowMs: NOW });
    // 智能段 8：3 到期 + 放宽 1 张未到期（仅 d-1）；自选段 2：d-1 剩余池已空 → 收缩为 0
    expect(pool).toHaveLength(4);
    for (const card of pool) expect(card.deckId).toBe('d-1');
    assertNoDuplicateIds(pool);
  });

  it('BP#8 deckIds 命中且总可用 < size → 返回该组全部可用（<size）', () => {
    const target = dueRun('t', 3, 'd-1');
    const others = Array.from({ length: 20 }, (_, i) => makeCard(`o${i}`, { deckId: 'd-2' }));
    const pool = buildPool([...target, ...others], { size: 10, deckIds: ['d-1'], rng: mulberry32(9), nowMs: NOW });
    expect(pool).toHaveLength(3);
    expect(ids(pool)).toEqual(['t0', 't1', 't2']);
  });

  it('BP#9 deckIds 为空数组 → 0 可用 → []', () => {
    const cards = dueRun('e', 8);
    expect(buildPool(cards, { size: 5, deckIds: [], rng: HALF, nowMs: NOW })).toEqual([]);
  });

  it('BP#10 deckIds 与卡组无交集 → []', () => {
    const cards = dueRun('e', 8, 'd-a');
    expect(buildPool(cards, { size: 5, deckIds: ['d-nope'], rng: HALF, nowMs: NOW })).toEqual([]);
  });
});

describe('buildPool —— 不足降级链（到期→放宽未到期→全部可用→[]）', () => {
  it('BP#11 到期不足智能段：放宽至未到期卡补足（仍限 deckIds）', () => {
    const due = dueRun('d', 5); // 5 张到期
    const fresh = Array.from({ length: 5 }, (_, i) => makeCard(`f${i}`, { dueOffset: DAY + i * DAY }));
    const otherDeckFresh = Array.from({ length: 5 }, (_, i) => makeCard(`g${i}`, { deckId: 'd-b', dueOffset: DAY }));
    const pool = buildPool([...due, ...fresh, ...otherDeckFresh], { size: 10, deckIds: ['d-a'], rng: mulberry32(11), nowMs: NOW });
    expect(pool).toHaveLength(10); // 智能段 8 = 5 到期 + 3 放宽；自选段 2 从剩余 d-a 未到期卡抽
    expect(ids(pool).slice(0, 5)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    for (const card of pool) expect(card.deckId).toBe('d-a');
    assertNoDuplicateIds(pool);
  });

  it('BP#12 总可用 < size → 返回全部可用并按实际长度（含智能段吃满+自选段收缩）', () => {
    const cards = [...dueRun('u', 3), makeCard('v0', { dueOffset: DAY }), makeCard('v1', { dueOffset: 2 * DAY })];
    const pool = buildPool(cards, { size: 15, rng: mulberry32(5), nowMs: NOW });
    expect(pool).toHaveLength(5);
    expect(new Set(ids(pool))).toEqual(new Set(['u0', 'u1', 'u2', 'v0', 'v1']));
    assertNoDuplicateIds(pool);
  });

  it('BP#13 全空输入 → []；cards 非数组脏入参 → []（不抛）', () => {
    expect(buildPool([], { size: 10, rng: HALF, nowMs: NOW })).toEqual([]);
    expect(buildPool(null as unknown as Card[], { size: 10, rng: HALF, nowMs: NOW })).toEqual([]);
  });

  it('BP#14 0 可用（全被 deckIds 滤掉）→ []', () => {
    const cards = dueRun('w', 6, 'd-x');
    expect(buildPool(cards, { size: 3, deckIds: ['d-y'], rng: HALF, nowMs: NOW })).toEqual([]);
  });

  it('BP#15 降级顺序钉死：有到期卡时绝不掺未到期卡（到期优先用尽才放宽）', () => {
    const due = dueRun('D', 12); // 12 张到期 ≥ 智能段 12
    const fresh = Array.from({ length: 12 }, (_, i) => makeCard(`F${i}`, { dueOffset: DAY }));
    const pool = buildPool([...due, ...fresh], { size: 15, rng: mulberry32(2), nowMs: NOW });
    expect(pool).toHaveLength(15);
    // 智能段 12 张全是到期卡；自选段 3 张只能从剩余池（8 张到期 + 12 张未到期）抽
    const dueSet = new Set(due.map((c) => c.id));
    expect(ids(pool).slice(0, 12).every((id) => dueSet.has(id))).toBe(true);
    // 放宽段未被触发：前 12 张不含任何 F* 卡
    expect(ids(pool).slice(0, 12).some((id) => id.startsWith('F'))).toBe(false);
  });
});

describe('buildPool —— 不变量：输出无重复 cardId（衔接 createBattle duplicate-card throw）', () => {
  it('BP#16 显式用例：多组随机参数扫描，任何输出的 id 集无重复', () => {
    const cards = [...dueRun('m', 9, 'd-a'), ...Array.from({ length: 9 }, (_, i) => makeCard(`n${i}`, { deckId: 'd-b', dueOffset: i % 2 ? -DAY : DAY }))];
    for (let seed = 0; seed < 25; seed++) {
      for (const size of [1, 3, 7, 15, 20]) {
        const pool = buildPool(cards, { size, deckIds: seed % 2 ? undefined : ['d-a', 'd-b'], rng: mulberry32(seed), nowMs: NOW });
        assertNoDuplicateIds(pool);
        expect(pool.length).toBeLessThanOrEqual(Math.min(size, cards.length));
      }
    }
  });

  it('BP#17 输入含同 id 重复对象时输出仍无重复 id（脏数据防御）', () => {
    const dupA = makeCard('k1');
    const dupB = makeCard('k1'); // 同 id 不同对象
    const pool = buildPool([dupA, dupB, makeCard('k2')], { size: 3, rng: HALF, nowMs: NOW });
    assertNoDuplicateIds(pool);
  });

  it('BP#17b R-T6-c：候选含重复 id 时自选段 i-- 重试，输出仍满额不缩水', () => {
    // 智能段吃满 4 张到期卡；剩余池 [f0, f0dup(同id脏副本), g1, g2]。rng≡HALF 使
    // pickWeighted 落点恒在 index1 = f0dup → take 被拒。修复前该轮空转（len 停在 4）；
    // 修复后 i-- 重试同一轮抽到 g1 → 满额 5。i=1 轮 remaining=[f0,f0dup,g1,g2]、
    // roll=0.5×4=2 → 过 f0(1)、f0dup(1) 后于 g1 处转负，选中 f0dup 的镜像序由实现决定，
    // 故用 HALF 直接钉死确定性结果而非手推分支。
    const due = dueRun('p', 4);
    const fresh = [
      makeCard('f0', { dueOffset: DAY }),
      makeCard('f0', { dueOffset: 2 * DAY }), // 同 id 脏副本
      makeCard('g1', { dueOffset: 3 * DAY }),
      makeCard('g2', { dueOffset: 4 * DAY }),
    ];
    for (const rng of [HALF, mulberry32(7), mulberry32(12)]) {
      const pool = buildPool([...due, ...fresh], { size: 5, rng, nowMs: NOW });
      expect(pool).toHaveLength(5); // 修复前此断言红（输出 4 张）
      assertNoDuplicateIds(pool);
      expect(ids(pool).slice(0, 4)).toEqual(['p0', 'p1', 'p2', 'p3']);
    }
  });

  it('BP#17c R-T6-c：dup 被智能段收编后自选段再遇 dup——i-- 重试不缩水', () => {
    // 构造逐字推演（rng≡HALF）：dueQueue=[a1,a0] 吃智能段前 2；放宽段按 due 升序
    // [f0(+1d), f0dup(+2d), g1(+3d)] 补足 smartWant=4 → f0 入 seen、f0dup 被 take 拒；
    // 自选段 remaining=[g1]（两份 f0 均因同 id 被 filter 剔除），抽中 g1 但 take 必拒
    // （id 已在 seen）→ 修复前该轮空转、输出停在 4；修复后 i-- 重试，remaining 已空、
    // 循环 break——本构造钉"take 拒绝路径不产生重复 id、不死循环"。
    const cards = [
      makeCard('f0', { dueOffset: DAY }),
      makeCard('f0', { dueOffset: 2 * DAY }), // 同 id 脏副本
      makeCard('a0', { dueOffset: -DAY }),
      makeCard('a1', { dueOffset: -2 * DAY }),
      makeCard('g1', { dueOffset: 3 * DAY }),
    ];
    const pool = buildPool(cards, { size: 5, rng: HALF, nowMs: NOW });
    assertNoDuplicateIds(pool);
    expect(new Set(ids(pool))).toEqual(new Set(['a0', 'a1', 'f0', 'g1']));
    // 去重后总可用仅 4 张（<size）→ 降级第二跳按实际长度返回，属规格行为非缩水 bug。
    expect(pool).toHaveLength(4);
  });

  it('BP#18 输出可直接喂 createBattle 不触发 duplicate-card / empty-pool', async () => {
    const { createBattle } = await import('@core/battle');
    const cards = [...dueRun('c', 12), ...Array.from({ length: 8 }, (_, i) => makeCard(`r${i}`, { dueOffset: DAY }))];
    const pool = buildPool(cards, { size: 15, rng: mulberry32(42), nowMs: NOW });
    expect(() =>
      createBattle(pool, 105, { level: 1, vit: 0, spi: 0, atk: 12, def: 7, maxHp: 100 }, HALF),
    ).not.toThrow();
  });
});

describe('buildPool —— 可复现性（同 seed 两次结果全等）', () => {
  it('BP#19 同 seed 两次 buildPool 输出全等（可复现不变量，逐元素深比较）', () => {
    const cards = [...dueRun('s', 10), ...Array.from({ length: 10 }, (_, i) => makeCard(`t${i}`, { deckId: 'd-b', dueOffset: (i - 5) * DAY }))];
    const one = buildPool(cards, { size: 15, rng: mulberry32(2026), nowMs: NOW });
    const two = buildPool(cards, { size: 15, rng: mulberry32(2026), nowMs: NOW });
    expect(one).toHaveLength(15);
    // 全等：id 序列 + 卡对象内容逐字段一致（toEqual 深比较）
    expect(one).toEqual(two);
    assertNoDuplicateIds(one);
  });

  it('BP#20 不同 seed 在同一场景下产生差异（证明 rng 真被消费于自选段）', () => {
    const due = dueRun('s', 4); // 智能段 4 张吃满到期
    // 剩余池按 pickWeighted(HALF) 的落点分界切成两半：seed7 首值 <0.5、seed999 首值 >0.5
    const lo = Array.from({ length: 6 }, (_, i) => makeCard(`f${i}`, { dueOffset: DAY })); // f0..f5
    const hi = Array.from({ length: 6 }, (_, i) => makeCard(`g${i}`, { dueOffset: DAY })); // g0..g5
    const cards = [...due, ...lo, ...hi];
    expect(mulberry32(7)()).toBeLessThan(0.5);
    expect(mulberry32(999)()).toBeGreaterThan(0.5);
    const a = ids(buildPool(cards, { size: 5, rng: mulberry32(7), nowMs: NOW })).slice(4);
    const b = ids(buildPool(cards, { size: 5, rng: mulberry32(999), nowMs: NOW })).slice(4);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(lo.some((c) => c.id === a[0])).toBe(true);
    expect(hi.some((c) => c.id === b[0])).toBe(true);
    expect(a).not.toEqual(b);
  });

  it('BP#21 不改动入参数组与卡对象（不可变契约）', () => {
    const cards = [...dueRun('i', 6), makeCard('j0', { dueOffset: DAY })];
    const before = JSON.stringify(cards);
    buildPool(cards, { size: 5, rng: mulberry32(8), nowMs: NOW });
    expect(JSON.stringify(cards)).toBe(before);
  });
});

describe('bossCheck —— 三态边界与计数透传', () => {
  /** n 张各带 k 个唯一日历日键的卡 → domainReviewCount = Σk。 */
  function ledger(n: number, totalDays: number): Card[] {
    const out: Card[] = [];
    let left = totalDays;
    for (let i = 0; i < n; i++) {
      const k = Math.max(0, Math.min(left, i === n - 1 ? left : Math.ceil(totalDays / n)));
      const days = Array.from({ length: k }, (_, j) => `2026-10-${String(j + 1).padStart(2, '0')}`);
      out.push(makeCard(`L${i}`, { days }));
      left -= k;
    }
    return out;
  }

  it('BC#1 差 1 未达：count=14 / tier15 → ready false', () => {
    expect(bossCheck(ledger(3, 14), 15)).toEqual({ ready: false, count: 14, threshold: 15 });
  });

  it('BC#2 恰达：count=15 / tier15 → ready true（count ≥ threshold 口径）', () => {
    expect(bossCheck(ledger(3, 15), 15)).toEqual({ ready: true, count: 15, threshold: 15 });
  });

  it('BC#3 已过：count=31 / tier30 → ready true；tier50 同数据 → false（三档阈值各自成立）', () => {
    const cards = ledger(4, 31);
    expect(bossCheck(cards, 30)).toEqual({ ready: true, count: 31, threshold: 30 });
    expect(bossCheck(cards, 50)).toEqual({ ready: false, count: 31, threshold: 50 });
  });

  it('BC#4 计数透传：Σ effectiveReviewDays 逐卡累加，跨卡同日也各计（口径属 reviewLedger）', () => {
    const cards = [makeCard('A', { days: ['2026-10-01'] }), makeCard('B', { days: ['2026-10-01', '2026-10-02'] })];
    expect(bossCheck(cards, 15)).toEqual({ ready: false, count: 3, threshold: 15 });
  });

  it('BC#5 空账本 / 空卡组 → count 0、ready false（threshold>0 恒成立故不会误唤醒）', () => {
    expect(bossCheck([], 15)).toEqual({ ready: false, count: 0, threshold: 15 });
    expect(bossCheck([makeCard('Z')], 15)).toEqual({ ready: false, count: 0, threshold: 15 });
  });

  it('BC#6 非法 tier（运行时脏数据）→ 保守未触发，threshold 原样回显', () => {
    const cards = ledger(2, 99);
    // 0 是合法非负阈值（count≥0 恒真），bossReady 的保守拒绝只针对 NaN/Infinity/负数：
    expect(bossCheck(cards, 0 as 15)).toEqual({ ready: true, count: 99, threshold: 0 });
    expect(bossCheck(cards, -1 as unknown as 15)).toEqual({ ready: false, count: 99, threshold: -1 });
    expect(bossCheck(cards, NaN as unknown as 15)).toEqual({ ready: false, count: 99, threshold: NaN });
    expect(bossCheck(cards, Infinity as unknown as 15)).toEqual({ ready: false, count: 99, threshold: Infinity });
  });
});
