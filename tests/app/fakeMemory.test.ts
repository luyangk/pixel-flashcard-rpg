/**
 * fakeMemory.ts —— Plan 3 · T6 假记忆素材池（LORE §5.5 战败演出规则引擎）。
 *
 * LORE §5.5「假记忆注入」：卡池耗尽未杀敌 → 战斗界面短暂闪现 1–2 张**篡改版卡面**
 * → 打叉揭示"假的。幸好你没记住它。"本模块只产**演出素材**，零数值后果
 * （LORE 明令：不修改任何 SRS 数据、不冻结计数）——故本文件的断言围绕四条硬契约：
 *
 * - **不含真答案**：每张 FakeCard 的 tamperedBack ≠ 原 back（否则演出会把错答案
 *   当"假记忆"再念一遍，等于二次强化错误知识）；
 * - **front 保真**：被篡改的只有答案面，问题面逐字不动（玩家先认卡，再被答案惊到）；
 * - **分寸**（LORE §5.5「一眼像错的，细想有点慌」）：扰动是 ±(1..9) 的小幅位移，
 *   且**保持位数外观**（"9" 加 9 回绕成 "8"，而不是变成两位的 "18" 或负号）；
 * - **确定性**：同 seed 同输出，随机源全部经注入（全局约束：禁 Math.random）。
 *
 * 用例编号 FM#N。数字规则的两条精确算例用**常量 RNG 桩**钉死（幅度 1/9、方向 ∓），
 * 与 mulberry32 的内部实现解耦；真实种子只钉"同 seed 同输出"+ 一条独立推导的黄金值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, SRSState } from '@core/types';
import { mulberry32 } from '@core/rng';
import { pickFakes, tamperNumber, tamperWord, type FakeCard } from '../../src/app/fakeMemory';

// —— 仿真锚点 ——
const SAMPLE_DIST = '光年是距离单位，1秒≈30万公里';

function makeCard(id: string, back: string, front = `q-${id}`): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due: 0,
    stability: 'review',
    effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front, back, srs, tags: ['t1'] };
}

/** 常量 RNG 桩：第 1 次调用定幅度 `1 + floor(v*9)`，第 2 次调用定方向（<0.5 取负）。 */
function fixedRng(v: number) {
  let calls = 0;
  const rng = (): number => {
    calls += 1;
    return v;
  };
  return { rng, calls: () => calls };
}

/** 15 张混合池：数字卡与可词替换卡交错（pickFakes 的扫描顺序即数组顺序）。 */
function mixedPool(): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < 15; i++) {
    if (i % 2 === 0) cards.push(makeCard(`num-${i}`, `第${i}章讲了 ${i + 3} 个概念`));
    else cards.push(makeCard(`word-${i}`, `这一页只谈距离与单位`));
  }
  return cards;
}

const WORD_TABLE: ReadonlyMap<string, string> = new Map([['单位', '量纲']]);

afterEach(() => {
  vi.restoreAllMocks(); // FM#10 的 Math.random 探针不跨用例残留
});

// ---------------------------------------------------------------------------
// tamperNumber：第一个 /\d+/ 的 ±(1..9) 扰动
// ---------------------------------------------------------------------------

describe('tamperNumber —— 抓 back 里第一个数字做小幅位移', () => {
  it('FM#1 常量 RNG=0（幅度 1、方向负）→ 精确输出 "1"→"0"，其余逐字不动', () => {
    const fake = tamperNumber(makeCard('c1', SAMPLE_DIST), fixedRng(0).rng);
    expect(fake).not.toBeNull();
    expect(fake!.tamperedBack).toBe('光年是距离单位，0秒≈30万公里');
    expect(fake!.rule).toBe('number-shift');
    expect(fake!.tamperedBack).not.toBe(SAMPLE_DIST);
  });

  it('FM#2 常量 RNG=0.99（幅度 9、方向正）→ 多位数精确平移 "1945"→"1954"', () => {
    const fake = tamperNumber(makeCard('c2', '1945年8月，二战结束'), fixedRng(0.99).rng);
    expect(fake!.tamperedBack).toBe('1954年8月，二战结束');
  });

  it('FM#3 保持位数外观：个位 9 加 9 回绕成 8（不是 18，也不是 -9）', () => {
    const fake = tamperNumber(makeCard('c3', '每小时9公里'), fixedRng(0.99).rng);
    expect(fake!.tamperedBack).toBe('每小时8公里');
    expect(fake!.tamperedBack).toMatch(/\d/);
    expect(fake!.tamperedBack).not.toContain('18');
    expect(fake!.tamperedBack).not.toContain('-');
  });

  it('FM#4 只动第一个数字：其余同形数字逐字保留（"30" 不动）', () => {
    const fake = tamperNumber(makeCard('c4', '1秒≈30万公里'), fixedRng(0).rng);
    expect(fake!.tamperedBack).toBe('0秒≈30万公里');
    expect(fake!.tamperedBack).toContain('30万公里');
  });

  it('FM#5 负号原样保留：扰动施加在数字位上，不产出双负号', () => {
    const fake = tamperNumber(makeCard('c5', '绝对零度是 -273.15 摄氏度'), fixedRng(0).rng);
    expect(fake!.tamperedBack).toBe('绝对零度是 -272.15 摄氏度');
    expect(fake!.tamperedBack).not.toContain('--');
  });

  it('FM#6 小数/百分号：只改整数部分，小数位与 % 逐字保留', () => {
    expect(tamperNumber(makeCard('c6', '正确率 3.14%'), fixedRng(0).rng)!.tamperedBack).toBe(
      '正确率 2.14%',
    );
    // 单位数走到 3+9=12 越界，按"保持位数外观"回绕为 2（而不是变成两位的 12）
    expect(tamperNumber(makeCard('c7', 'π≈3.14159'), fixedRng(0.99).rng)!.tamperedBack).toBe(
      'π≈2.14159',
    );
  });

  it('FM#7 无数字可改 → null，且不消耗 rng（降级路径不得偷走随机序列）', () => {
    const probe = fixedRng(0);
    expect(tamperNumber(makeCard('c8', '混沌把这一页的字都吃了'), probe.rng)).toBeNull();
    expect(probe.calls()).toBe(0);
  });

  it('FM#8 保真面：realCardId/front 逐字对齐原卡，rule=number-shift，id 非空', () => {
    const card = makeCard('c9', SAMPLE_DIST, '光年是什么单位？');
    const fake = tamperNumber(card, fixedRng(0).rng)!;
    expect(fake.realCardId).toBe('c9');
    expect(fake.front).toBe('光年是什么单位？');
    expect(fake.front).toBe(card.front);
    expect(fake.tamperedBack).not.toBe(card.back);
    expect(fake.id.length).toBeGreaterThan(0);
  });

  it('FM#9 同 seed 同输出（mulberry32(20260926) 黄金值，由上游原语独立推导）', () => {
    // 幅度 5、方向负：1 - 5 ≡ 6 (mod 10) —— 语感即"一眼像错的，细想有点慌"
    const a = tamperNumber(makeCard('g1', SAMPLE_DIST), mulberry32(20260926));
    const b = tamperNumber(makeCard('g1', SAMPLE_DIST), mulberry32(20260926));
    expect(a!.tamperedBack).toBe('光年是距离单位，6秒≈30万公里');
    expect(a).toStrictEqual(b);
  });

  it('FM#10 全模块不碰 Math.random（随机源只走注入的 rng）', () => {
    const spy = vi.spyOn(Math, 'random');
    tamperNumber(makeCard('c10', SAMPLE_DIST), mulberry32(7));
    tamperWord(makeCard('c11', '只谈距离与单位'), WORD_TABLE, mulberry32(7));
    pickFakes(mixedPool(), 2, { rng: mulberry32(7), wordTable: WORD_TABLE });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// tamperWord：词表命中替换 / 未命中 null
// ---------------------------------------------------------------------------

describe('tamperWord —— 词表命中则换，未命中 null', () => {
  it('FM#11 命中：替换第一个出现处，其余文本逐字保留', () => {
    const fake = tamperWord(
      makeCard('w1', '光年是距离单位，1秒≈30万公里'),
      new Map([['公里', '英里']]),
      fixedRng(0).rng,
    )!;
    expect(fake.tamperedBack).toBe('光年是距离单位，1秒≈30万英里');
    expect(fake.rule).toBe('word-swap');
    expect(fake.realCardId).toBe('w1');
    expect(fake.tamperedBack).not.toBe('光年是距离单位，1秒≈30万公里');
  });

  it('FM#12 未命中（表非空但 back 无任何键）→ null', () => {
    expect(tamperWord(makeCard('w2', '只谈距离与单位'), new Map([['质量', '重量']]), fixedRng(0).rng)).toBeNull();
  });

  it('FM#13 空表 → null（无素材可造，不得凭空编造）', () => {
    expect(tamperWord(makeCard('w3', '只谈距离与单位'), new Map(), fixedRng(0).rng)).toBeNull();
  });

  it('FM#14 多键命中：由注入 rng 决定取哪一个（同 rng 值同结果）', () => {
    const card = makeCard('w4', '距离与单位与速度');
    const table = new Map([
      ['距离', '时间'],
      ['速度', '质量'],
    ]);
    expect(tamperWord(card, table, fixedRng(0).rng)!.tamperedBack).toBe('时间与单位与速度');
    expect(tamperWord(card, table, fixedRng(0.99).rng)!.tamperedBack).toBe('距离与单位与质量');
  });

  it('FM#15 恒等映射（from===to）不算篡改：跳过 → null，绝不产出"假记忆===真答案"', () => {
    expect(tamperWord(makeCard('w5', '只谈距离与单位'), new Map([['单位', '单位']]), fixedRng(0).rng)).toBeNull();
  });

  it('FM#16 空串键跳过（indexOf("") 恒命中，会产出把真答案整段挪位的伪篡改）', () => {
    expect(tamperWord(makeCard('w6', '只谈距离与单位'), new Map([['', 'X']]), fixedRng(0).rng)).toBeNull();
  });

  it('FM#17 字面替换而非正则：键含元字符也按原样匹配', () => {
    const fake = tamperWord(makeCard('w7', 'a+b=1'), new Map([['a+b', 'x']]), fixedRng(0).rng)!;
    expect(fake.tamperedBack).toBe('x=1');
  });

  it('FM#18 保真面：front 逐字不变、rule=word-swap、tamperedBack≠原 back', () => {
    const card = makeCard('w8', '只谈距离与单位', '这一页讲什么？');
    const fake = tamperWord(card, WORD_TABLE, fixedRng(0).rng)!;
    expect(fake.front).toBe('这一页讲什么？');
    expect(fake.tamperedBack).toBe('只谈距离与量纲');
    expect(fake.tamperedBack).not.toBe(card.back);
  });
});

// ---------------------------------------------------------------------------
// pickFakes：依序两规则、产出不足 count 就少产
// ---------------------------------------------------------------------------

describe('pickFakes —— 依序尝试两规则，够不着 count 就少产', () => {
  it('FM#19 15 张池 count=2：≤2 张、每张不含真答案、front 保真、来源卡不重复', () => {
    const pool = mixedPool();
    const fakes = pickFakes(pool, 2, { rng: mulberry32(11), wordTable: WORD_TABLE });
    expect(fakes.length).toBeLessThanOrEqual(2);
    expect(fakes.length).toBeGreaterThan(0);

    const byId = new Map(pool.map((c) => [c.id, c]));
    const used = new Set<string>();
    for (const f of fakes) {
      const src = byId.get(f.realCardId);
      expect(src).toBeDefined();
      expect(f.tamperedBack).not.toBe(src!.back);
      expect(f.front).toBe(src!.front);
      expect(f.id.length).toBeGreaterThan(0);
      expect(used.has(f.realCardId)).toBe(false); // 同一张真卡不重复登场
      used.add(f.realCardId);
    }
    expect(new Set(fakes.map((f) => f.id)).size).toBe(fakes.length); // id 可作渲染 key
  });

  it('FM#20 依序优先 number-shift：数字与词表双命中时取数字规则', () => {
    const card = makeCard('both-1', '第3章只谈距离与单位');
    const fakes = pickFakes([card], 1, { rng: fixedRng(0).rng, wordTable: WORD_TABLE });
    expect(fakes).toHaveLength(1);
    expect(fakes[0].rule).toBe('number-shift');
    expect(fakes[0].tamperedBack).toBe('第2章只谈距离与单位');
  });

  it('FM#21 数字规则无解时降级 word-swap（无数字卡照样能造素材）', () => {
    const card = makeCard('nodigit-1', '这一页只谈距离与单位');
    const fakes = pickFakes([card], 1, { rng: fixedRng(0).rng, wordTable: WORD_TABLE });
    expect(fakes).toHaveLength(1);
    expect(fakes[0].rule).toBe('word-swap');
    expect(fakes[0].tamperedBack).toBe('这一页只谈距离与量纲');
  });

  it('FM#22 两规则都无解 → 少产（3 张全不可篡改的池 + 空表 → 0 张，不抛异常）', () => {
    const pool = [
      makeCard('n1', '混沌吞了这一段'),
      makeCard('n2', '另一段也空了'),
      makeCard('n3', '什么都想不起来'),
    ];
    expect(pickFakes(pool, 3, { rng: mulberry32(3), wordTable: new Map() })).toEqual([]);
  });

  it('FM#23 count 边界：0/负数/NaN → 空；小数向下取整；池不足 count 时少产', () => {
    const pool = mixedPool();
    const deps = () => ({ rng: mulberry32(5), wordTable: WORD_TABLE });
    expect(pickFakes(pool, 0, deps())).toEqual([]);
    expect(pickFakes(pool, -3, deps())).toEqual([]);
    expect(pickFakes(pool, Number.NaN, deps())).toEqual([]);
    expect(pickFakes(pool, 2.9, deps())).toHaveLength(2);

    const tiny = [makeCard('t1', '第1章'), makeCard('t2', '第2章')];
    expect(pickFakes(tiny, 5, deps())).toHaveLength(2); // 战败演出容忍少产，不循环硬凑
  });

  it('FM#24 同 seed 同输出（两次独立调用逐字段相等），序列只由注入 rng 决定', () => {
    const pool = mixedPool();
    const a = pickFakes(pool, 3, { rng: mulberry32(99), wordTable: WORD_TABLE });
    const b = pickFakes(pool, 3, { rng: mulberry32(99), wordTable: WORD_TABLE });
    expect(a).toStrictEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('FM#25 纯演出：不改动入参卡池（back/front/srs 逐字原样，不写回任何字段）', () => {
    const pool = mixedPool();
    const before = structuredClone(pool);
    const fakes: FakeCard[] = pickFakes(pool, 4, { rng: mulberry32(21), wordTable: WORD_TABLE });
    expect(fakes.length).toBeGreaterThan(0);
    expect(pool).toStrictEqual(before);
  });

  it('FM#26 全池扫完的极端：count=池容量时每张 tamperedBack 都不含真答案', () => {
    const pool = mixedPool();
    const fakes = pickFakes(pool, 15, { rng: mulberry32(4), wordTable: WORD_TABLE });
    expect(fakes.length).toBe(15); // 本池每张至少有一条规则可用
    const byId = new Map(pool.map((c) => [c.id, c]));
    for (const f of fakes) {
      expect(f.tamperedBack).not.toBe(byId.get(f.realCardId)!.back);
    }
  });
});
