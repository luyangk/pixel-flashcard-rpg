import { describe, expect, it } from 'vitest';
import type { Card, Sm2Params, SRSState } from '@core/types';
import { createInitialSRS, damageMultiplier, dueQueue, GRADES, review } from '@core/sm2';

const P: Sm2Params = {
  initialEase: 2.5,
  minEase: 1.3,
  firstInterval: 10 / 60, // 分钟级：10 分钟用天表示
  secondInterval: 6,
};

const T0 = 1_761_955_200_000; // 固定时间戳，core 不得依赖 Date.now()
const DAY = 86_400_000;

/** 逐字取自 brief 的 ease 公式（clamp 上界 ∞），供测试独立复算锚点。 */
function sm2Ease(ease: number, q: number, minEase: number): number {
  return Math.max(minEase, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
}

/** good 档的 ease 增量：0.1 − (5−3)(0.08 + (5−3)·0.02) = −0.14。 */
const GOOD_DELTA = sm2Ease(0, GRADES.good, Number.NEGATIVE_INFINITY);
/** hard 档增量 −0.28、easy 档 +0.14（同式）。 */
const HARD_DELTA = sm2Ease(0, GRADES.hard, Number.NEGATIVE_INFINITY);

// —— brief 公式的「可解释转写」（与实现独立，测试即规格）——
// again → reps=0、interval=firstInterval、lapses+1；
// good/hard/easy → reps+1，reps=1→firstInterval、reps=2→secondInterval、
// reps≥2→interval×EF，easy ×1.3、hard ÷1.2。
// 对 brief 伪码的两处必要解释：
//  a) secondInterval 是「目标值」：reps=2 直接取其值（Anki 式 I(2)=secondInterval），
//     后续 reps≥3 用 round(interval × EF) 演进；
//  b) 天级取整、分钟级（<1d）保留小数——否则 10 分钟间隔会被 round 归零。
// EF 语义可切换：'old' = 乘法用「更新前」EF（标准 SM-2 语义，实现采用此读法）；
// 'new' = 字面读法（先更新 EF 再乘）。
// 注意：brief 锚点 "1→6→15" 的第三跳只在 EF 恒定时成立（round(6×2.5)=15）；
// 链式起步时 Δ(good)=−0.14 使旧 EF 逐跳下降，第三跳实为 round(6×2.22)=13。
// 两种读法下 reps=2 档 interval 均与 EF 无关（固定取 secondInterval=6）。
type EfSemantics = 'old' | 'new';
function briefNext(
  s: SRSState,
  q: number,
  p: Sm2Params,
  ef: EfSemantics = 'old',
): { ease: number; interval: number; reps: number } {
  const days = (v: number): number => (v >= 1 ? Math.round(v) : v);
  const ease = sm2Ease(s.ease, q, p.minEase);
  if (q === GRADES.again) return { ease, interval: p.firstInterval, reps: 0 };
  const mult = ef === 'old' ? s.ease : ease;
  const reps = s.reps + 1;
  let interval: number;
  if (reps === 1) interval = p.firstInterval;
  else if (reps === 2) interval = p.secondInterval;
  else interval = days(s.interval * mult);
  if (q === GRADES.easy) interval = days(interval * 1.3);
  if (q === GRADES.hard) interval = days(interval / 1.2);
  return { ease, interval, reps };
}

/** 构造任意字段的 SRS 态（基于初始态覆盖）。 */
function state(over: Partial<SRSState>): SRSState {
  return { ...createInitialSRS(T0), ...over };
}

function card(id: string, srs: SRSState): Card {
  return { id, deckId: 'd1', front: 'f', back: 'b', srs, tags: [] };
}

describe('GRADES 常量表', () => {
  it('取值逐字照 brief', () => {
    expect(GRADES).toEqual({ again: 0, hard: 2, good: 3, easy: 5 });
  });
});

describe('createInitialSRS', () => {
  it('初始态字段符合签名', () => {
    const s = createInitialSRS(T0);
    expect(s.ease).toBe(2.5);
    expect(s.interval).toBe(0);
    expect(s.reps).toBe(0);
    expect(s.lapses).toBe(0);
    expect(s.due).toBe(T0);
    expect(s.stability).toBe('new');
    expect(s.effectiveReviewDays).toEqual([]);
  });

  it('ease 回落 p.initialEase 而非硬编码', () => {
    expect(createInitialSRS(T0, { ...P, initialEase: 2.2 }).ease).toBe(2.2);
  });
});

describe('review —— again', () => {
  it('清 reps、lapse+1、interval 回退 firstInterval、stability 降 learning', () => {
    const before = state({ ease: 2.5, interval: 15, reps: 4, lapses: 1, stability: 'review' });
    const after = review(before, GRADES.again, T0 + DAY, P);
    expect(after.reps).toBe(0);
    expect(after.lapses).toBe(2);
    expect(after.interval).toBeCloseTo(P.firstInterval, 10);
    expect(after.stability).toBe('learning');
    expect(after.due).toBeCloseTo(T0 + DAY + P.firstInterval * DAY, 3);
  });

  it('ease 按公式逐次递增且不低于 minEase', () => {
    let s = state({ ease: 2.5, interval: 6, reps: 2, stability: 'review' });
    for (let i = 0; i < 10; i++) s = review(s, GRADES.good, T0 + (i + 1) * DAY, P);
    expect(s.ease).toBe(P.minEase); // 该 Δ(good)=−0.14，连击后触底 clamp
    let up = state({ ease: 2.5, interval: 6, reps: 2 });
    for (let i = 0; i < 5; i++) up = review(up, GRADES.easy, T0 + (i + 1) * DAY, P);
    expect(up.ease).toBeCloseTo(2.5 + 5 * sm2Ease(0, GRADES.easy, Number.NEGATIVE_INFINITY), 10);
    let floor = state({ ease: P.minEase, interval: 6, reps: 2 });
    for (let i = 0; i < 5; i++) floor = review(floor, GRADES.again, T0 + (i + 1) * DAY, P);
    expect(floor.ease).toBe(P.minEase); // clamp 下界生效
  });
});

describe('review —— good 链（brief 公式复算，EF 语义显式声明）', () => {
  it('与 briefNext(old-EF) 逐步一致：链式起步 interval 走 1→6→13（ΔEF 下压）', () => {
    const dayParams: Sm2Params = { ...P, firstInterval: 1 };
    let s = createInitialSRS(T0, dayParams);
    for (let i = 0; i < 4; i++) {
      const want = briefNext(s, GRADES.good, dayParams, 'old');
      s = review(s, GRADES.good, T0 + i * DAY, dayParams);
      expect(s.reps).toBe(want.reps);
      expect(s.ease).toBeCloseTo(want.ease, 10);
      expect(s.interval).toBe(want.interval);
    }
    // 具体锚点：reps=1→1d、reps=2→6d（secondInterval，与 EF 无关）。
    // 第三跳用「更新前」EF：链式起步时 ease 已随 Δ(good)=−0.14 降至 2.22，
    // 故 round(6×2.22)=13 而非 15。brief 的 "1→6→15" 是 EF 恒定时的参数化示例
    // （原文注明 "ease 2.6 时允许 ±1 容差断言具体数"），精确锚定见下一用例。
    const chain = createInitialSRS(T0, dayParams);
    const one = review(chain, GRADES.good, T0, dayParams);
    const two = review(one, GRADES.good, T0 + DAY, dayParams);
    const three = review(two, GRADES.good, T0 + 6 * DAY, dayParams);
    expect([one.interval, two.interval]).toEqual([1, 6]);
    expect(three.interval).toBe(13); // round(6 × 旧EF 2.22)
    expect(three.reps).toBe(3);
    expect(three.stability).toBe('mastered'); // 13 ≥ 7d，晋升规则使然
  });

  it('固定 ease 场景精确命中 brief 锚点 15（15 是 EF=2.5 恒定时的解析值）', () => {
    // 从 reps=2、interval=6、ease=2.5 的中间态起步：乘法用「更新前」EF，
    // interval = round(6 × 2.5) = 15，与链式起步的实际漂移无关。
    const s = review(state({ ease: 2.5, interval: 6, reps: 2, stability: 'review' }), GRADES.good, T0, P);
    expect(s.interval).toBe(15);
    expect(s.reps).toBe(3);
    expect(s.stability).toBe('mastered'); // 15 ≥ 7d → mastered（brief 晋升规则）
  });

  it('默认分钟级参数下 good 首跳不取整归零（10min 保精度）', () => {
    const one = review(createInitialSRS(T0, P), GRADES.good, T0, P);
    expect(one.interval).toBeCloseTo(P.firstInterval, 10); // 10/60 天
    expect(one.due).toBeCloseTo(T0 + P.firstInterval * DAY, 3);
  });
});

describe('review —— hard / easy 修饰', () => {
  it('reps≥2 时 easy ×1.3、hard ÷1.2', () => {
    const base = state({ ease: 2.5, interval: 10, reps: 3, stability: 'review' });
    const easy = review(base, GRADES.easy, T0 + DAY, P);
    const hard = review(base, GRADES.hard, T0 + DAY, P);
    expect(easy.interval).toBe(briefNext(base, GRADES.easy, P).interval); // round(10×2.5×1.3)=33
    expect(hard.interval).toBe(briefNext(base, GRADES.hard, P).interval); // round(10×2.5/1.2)=21
    expect(easy.ease).toBeCloseTo(2.5 + sm2Ease(0, GRADES.easy, Number.NEGATIVE_INFINITY), 10);
    expect(hard.ease).toBeCloseTo(2.5 + HARD_DELTA, 10);
  });
});

describe('stability 晋升', () => {
  it('interval≥7d → mastered', () => {
    // 逐字 brief 公式下 Δ(good)=−0.14，单跳 6→round(6×2.5)=15 已 ≥7d：
    const s = review(state({ ease: 2.5, interval: 6, reps: 3 }), GRADES.good, T0, P);
    expect(s.interval).toBe(15);
    expect(s.stability).toBe('mastered');
    // easy 连击同样晋升
    let e = state({ ease: 2.5, interval: 3, reps: 2 });
    e = review(e, GRADES.easy, T0, P);
    expect(e.stability).toBe('mastered');
  });

  it('reps≥1 且 interval≥1d → review；不足 1d → learning', () => {
    const dayParams: Sm2Params = { ...P, firstInterval: 1 };
    const oneDay = review(createInitialSRS(T0, dayParams), GRADES.good, T0, dayParams);
    expect(oneDay.stability).toBe('review');
    const minutes = review(createInitialSRS(T0, P), GRADES.good, T0, P);
    expect(minutes.stability).toBe('learning'); // firstInterval=10min < 1d
  });
});

describe('dueQueue', () => {
  it('只保留到期卡（due ≤ nowMs）并按 due 升序', () => {
    const a = card('a', state({ due: T0 - 10 })); // 逾期最久 → 最前
    const b = card('b', state({ due: T0 - 100 }));
    const c = card('c', state({ due: T0 })); // due === nowMs 视为到期
    const future = card('z', state({ due: T0 + DAY }));
    const out = dueQueue([a, b, future, c], T0);
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('空数组与全未到期返回空', () => {
    expect(dueQueue([], T0)).toEqual([]);
    expect(dueQueue([card('z', state({ due: T0 + DAY }))], T0)).toEqual([]);
  });
});

describe('damageMultiplier', () => {
  it('四档映射', () => {
    expect(damageMultiplier(state({ stability: 'new' }))).toBe(0.1);
    expect(damageMultiplier(state({ stability: 'learning' }))).toBe(0.5);
    expect(damageMultiplier(state({ stability: 'review' }))).toBe(1.0);
    expect(damageMultiplier(state({ stability: 'mastered' }))).toBe(1.5);
  });
});

describe('不可变性', () => {
  it('review 不改前值、返回新对象', () => {
    const before = createInitialSRS(T0, P);
    const snapshot = JSON.parse(JSON.stringify(before)) as SRSState;
    const after = review(review(before, GRADES.good, T0, P), GRADES.easy, T0 + DAY, P);
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(after.effectiveReviewDays).not.toBe(before.effectiveReviewDays);
  });

  it('effectiveReviewDays 由 reviewLedger 独占写入：review 只透传不追加（R-T4-c）', () => {
    // 引擎不再产生日键：无论同日还是跨日反复 review，账本内容都保持入参原样。
    // 若此处出现任何日期字符串，说明双写回来了——Boss 计数会被灌水。
    let s = createInitialSRS(T0, P);
    for (const t of [T0, T0 + 3_600_000, T0 + 2 * DAY, T0 + 9 * DAY]) {
      s = review(s, GRADES.good, t, P);
      expect(s.effectiveReviewDays).toEqual([]);
    }
    // 已有账本原样带过（值相等、且是副本而非同一引用）
    const seeded = state({ effectiveReviewDays: ['2025-10-30', '2025-11-01'] });
    const out = review(seeded, GRADES.good, T0 + DAY, P);
    expect(out.effectiveReviewDays).toEqual(['2025-10-30', '2025-11-01']);
    expect(out.effectiveReviewDays).not.toBe(seeded.effectiveReviewDays);
  });
});

describe('域外输入防御（Review Focus #4）', () => {
  const hostile: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['负 ease', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['字符串混入', undefined as unknown as number],
  ];

  it('非法 grade / NaN 参数输出仍为有限数', () => {
    for (const [, badEase] of hostile) {
      const s = state({ ease: badEase });
      for (const g of [GRADES.again, GRADES.good, GRADES.easy, GRADES.hard, Number.NaN, -3, 99]) {
        const out = review(s, g as typeof GRADES.good, T0, P);
        expect(Number.isFinite(out.ease)).toBe(true);
        expect(Number.isFinite(out.interval)).toBe(true);
        expect(Number.isFinite(out.due)).toBe(true);
        expect(Number.isInteger(out.reps)).toBe(true);
        expect(Number.isInteger(out.lapses)).toBe(true);
        expect(['new', 'learning', 'review', 'mastered']).toContain(out.stability);
      }
    }
  });

  it('p 参数含 NaN 时回落默认，不产出 NaN', () => {
    const bad: Sm2Params = {
      initialEase: Number.NaN,
      minEase: Number.NaN,
      firstInterval: Number.NaN,
      secondInterval: Number.NaN,
    };
    const out = review(createInitialSRS(T0, bad), GRADES.good, T0, bad);
    expect(Number.isFinite(out.ease)).toBe(true);
    expect(Number.isFinite(out.interval)).toBe(true);
    expect(Number.isFinite(out.due)).toBe(true);
  });

  it('nowMs / srs 字段为 NaN 也不炸', () => {
    const out = review(state({ due: Number.NaN }), GRADES.good, Number.NaN, P);
    expect(Number.isFinite(out.due)).toBe(true);
    expect(() => dueQueue([card('n', state({ due: Number.NaN }))], T0)).not.toThrow();
  });
});
