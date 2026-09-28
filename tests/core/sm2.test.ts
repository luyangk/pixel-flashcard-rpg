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

/**
 * ΔEF 原式（clamp 上界 ∞）：delta(q) = 0.1 − (5−q)(0.08 + (5−q)·0.02)。
 * D27 门控语义下该式只作用于 again/hard 两档；good 中性、easy 用独立常数 EASE_BONUS=+0.1。
 */
function delta(q: number): number {
  return 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
}

/** D27 门控后的 ease 更新：q≥easy → +0.1；q≤hard → delta(q)；good → 不变。再 clamp 下界。 */
function sm2Ease(ease: number, q: number, minEase: number): number {
  if (q >= GRADES.easy) return Math.max(minEase, ease + 0.1); // EASE_BONUS
  if (q <= GRADES.hard) return Math.max(minEase, ease + delta(q));
  return Math.max(minEase, ease); // good：严格不变
}

/** good 档的 ease 增量：D27 门控后为 0（中性）。 */
const GOOD_DELTA = sm2Ease(0, GRADES.good, Number.NEGATIVE_INFINITY);
/** hard 档增量 −0.32（原式）、easy 档 +0.1（EASE_BONUS，非原式的 +0.14）。 */
const HARD_DELTA = delta(GRADES.hard);

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
// D27 门控修正后 sm2Ease 为中性语义：good 使 EF 严格不变，链式起步时 EF 恒为 2.5，
// brief 锚点 "1→6→15" 在 good-only 链上逐跳成立（round(6×2.5)=15），不再需要
// "EF 恒定才成立"的附加说明。两种读法下 reps=2 档 interval 均与 EF 无关（固定取 secondInterval=6）。
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

  it('ease 按门控语义逐次变化且不低于 minEase', () => {
    let s = state({ ease: 2.5, interval: 6, reps: 2, stability: 'review' });
    for (let i = 0; i < 10; i++) s = review(s, GRADES.good, T0 + (i + 1) * DAY, P);
    expect(s.ease).toBe(2.5); // D27：Δ(good)=0，连击后严格不变
    let up = state({ ease: 2.5, interval: 6, reps: 2 });
    for (let i = 0; i < 5; i++) up = review(up, GRADES.easy, T0 + (i + 1) * DAY, P);
    expect(up.ease).toBeCloseTo(2.5 + 5 * 0.1, 10); // EASE_BONUS=+0.1/次（非原式 +0.14）
    let floor = state({ ease: P.minEase, interval: 6, reps: 2 });
    for (let i = 0; i < 5; i++) floor = review(floor, GRADES.again, T0 + (i + 1) * DAY, P);
    expect(floor.ease).toBe(P.minEase); // clamp 下界生效
  });
});

describe('review —— good 链（D27 中性语义：EF 恒定，锚点逐跳成立）', () => {
  it('与 briefNext(old-EF) 逐步一致：链式起步 interval 走 1→6→15→38，ease 恒 2.5', () => {
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
    // D27 后 Δ(good)=0，EF 恒为 initialEase=2.5，第三跳 round(6×2.5)=15、
    // 第四跳 round(15×2.5)=38——brief 的 "1→6→15" 不再依赖参数化假设。
    const chain = createInitialSRS(T0, dayParams);
    const one = review(chain, GRADES.good, T0, dayParams);
    const two = review(one, GRADES.good, T0 + DAY, dayParams);
    const three = review(two, GRADES.good, T0 + 6 * DAY, dayParams);
    const four = review(three, GRADES.good, T0 + 15 * DAY, dayParams);
    expect([one.interval, two.interval]).toEqual([1, 6]);
    expect(three.interval).toBe(15); // round(6 × 2.5)，EF 恒定
    expect(four.interval).toBe(38); // round(15 × 2.5)
    expect(three.reps).toBe(3);
    expect(three.stability).toBe('mastered'); // 15 ≥ 7d，晋升规则使然
    expect([one.ease, two.ease, three.ease, four.ease]).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it('固定 ease 场景精确命中 brief 锚点 15（D27 后 good 链 EF 恒 2.5，解析值即实现值）', () => {
    // 从 reps=2、interval=6、ease=2.5 的中间态起步：乘法用「更新前」EF，
    // interval = round(6 × 2.5) = 15；good 中性语义下与链式起步结果一致。
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
    expect(easy.ease).toBeCloseTo(2.5 + 0.1, 10); // EASE_BONUS（非原式 +0.14）
    expect(hard.ease).toBeCloseTo(2.5 + HARD_DELTA, 10);
  });
});

describe('review —— D27 ΔEF 门控（good 中性 / easy +0.1 / again·hard 原式）', () => {
  it('三连 good 后 ease 严格恒为 initialEase，档位间无浮点漂移', () => {
    expect(GOOD_DELTA).toBe(0); // D27：good 档门控后增量为零（中性）
    let s = state({ ease: 2.5, interval: 6, reps: 2, stability: 'review' });
    for (let i = 0; i < 3; i++) s = review(s, GRADES.good, T0 + (i + 1) * DAY, P);
    expect(s.ease).toBe(2.5); // 非 toBeCloseTo——门控是赋值分支，不是加 −0.14+…
  });

  it('good 不随自定义 initialEase 漂移；easy 恰为 initialEase+0.1', () => {
    const qParams: Sm2Params = { ...P, initialEase: 2.6 };
    let g = createInitialSRS(T0, qParams);
    for (let i = 0; i < 8; i++) g = review(g, GRADES.good, T0 + (i + 1) * DAY, qParams);
    expect(g.ease).toBe(2.6);
    let e = createInitialSRS(T0, qParams);
    e = review(e, GRADES.easy, T0 + DAY, qParams);
    expect(e.ease).toBeCloseTo(2.7, 10); // 2.6 + EASE_BONUS(0.1)，非原式的 2.74
  });

  it('hard 后 ease 下降且严格低于 2.5；again 同式下压', () => {
    const h = review(state({ ease: 2.5, interval: 6, reps: 2 }), GRADES.hard, T0, P);
    expect(h.ease).toBeCloseTo(2.5 + HARD_DELTA, 10); // −0.32 → 2.18
    expect(h.ease).toBeLessThan(2.5);
    const a = review(state({ ease: 2.5, interval: 6, reps: 2 }), GRADES.again, T0, P);
    expect(a.ease).toBeCloseTo(2.5 + delta(GRADES.again), 10); // −0.80 → 1.70
    expect(a.ease).toBeLessThan(h.ease); // again 比 hard 更狠
  });

  it('easy 用独立常数 +0.1，不再是原式的 +0.14', () => {
    const e = review(state({ ease: 2.5, interval: 6, reps: 2 }), GRADES.easy, T0, P);
    expect(e.ease).toBeCloseTo(2.6, 10);
    // 结构断言：门控分支下 easy 增量恰为 EASE_BONUS；旧实现（+0.14）在 2.36 起步时
    // 会得 2.50≠2.46，此断言即可区分两种语义（D27 前该值即本用例的失败点）。
    const mid = review(state({ ease: 2.36, interval: 6, reps: 2 }), GRADES.easy, T0, P);
    expect(mid.ease).toBeCloseTo(2.46, 10);
  });

  it('clamp 下界仍作用于 again/hard：连续 hard 触底 minEase 不再下穿', () => {
    let s = state({ ease: 1.4, interval: 6, reps: 2 });
    for (let i = 0; i < 6; i++) s = review(s, GRADES.hard, T0 + (i + 1) * DAY, P);
    expect(s.ease).toBe(P.minEase);
  });

  it('briefNext(D27 同构器) 与实现逐字段一致（mixed 链，含 clamp 段）', () => {
    const dayParams: Sm2Params = { ...P, firstInterval: 1 };
    let s = createInitialSRS(T0, dayParams);
    const seq = [GRADES.good, GRADES.easy, GRADES.hard, GRADES.again, GRADES.hard, GRADES.hard, GRADES.good];
    for (let i = 0; i < seq.length; i++) {
      const want = briefNext(s, seq[i], dayParams, 'old');
      s = review(s, seq[i], T0 + (i + 1) * DAY, dayParams);
      expect(s.reps).toBe(want.reps);
      expect(s.ease).toBeCloseTo(want.ease, 10);
      expect(s.interval).toBe(want.interval);
    }
  });
});

describe('stability 晋升', () => {
  it('interval≥7d → mastered', () => {
    // D27 中性语义下 Δ(good)=0，单跳 6→round(6×2.5)=15 已 ≥7d：
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
  it('四档映射（Plan 5 数值改进：new 0.1→0.3、learning 0.5→0.7；review/mastered 不动）', () => {
    // 依据：每张卡分摊的敌血恒为 10×难度系数（遭遇战 7），与池长无关；旧值下 L1 的
    // new=1/learning=6 都打不穿 ⇒ 新手期数学上不可能赢（用户实测"两轮都失败"）。
    expect(damageMultiplier(state({ stability: 'new' }))).toBe(0.3);
    expect(damageMultiplier(state({ stability: 'learning' }))).toBe(0.7);
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
