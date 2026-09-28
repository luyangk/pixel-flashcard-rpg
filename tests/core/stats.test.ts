/**
 * stats.ts —— Plan 2 · T5 属性体系与敌人 HP 反推（PRD §6.5 数值基线）。
 * 常数 verbatim：DIFFICULTY={encounter:0.7,boss:1.5}、BASE_CARD_DAMAGE=10、
 * expToNext=ceil(100×L^1.3)、victoryExp=round(30×难度系数+5×mastered释放数)、
 * atk=10+level*2+floor(spi/8)、def=5+level*2+floor(vit/10)、maxHp=100+(level-1)*10。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState, Stability } from '@core/types';
import {
  BASE_CARD_DAMAGE,
  DIFFICULTY,
  applyExp,
  deriveStats,
  enemyHpForPool,
  enemyPowerFor,
  expToNext,
  victoryExp,
} from '@core/stats';

function makeCard(id: string, stability: Stability = 'review'): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due: 0,
    stability,
    effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

describe('DIFFICULTY / BASE_CARD_DAMAGE —— §6.5 verbatim 常数', () => {
  it('C#1 常数逐字：encounter 0.7、boss 1.5、基准单卡伤害 10', () => {
    expect(DIFFICULTY).toEqual({ encounter: 0.7, boss: 1.5 });
    expect(BASE_CARD_DAMAGE).toBe(10);
  });
});

describe('deriveStats —— 等级→属性映射（R-P2-a 口径）', () => {
  // brief Step-1 的两组"手算样本"与其自述公式 verbatim（atk=10+level*2+…、
  // def=5+level*2+…）不自洽：L1/0/0 按公式是 atk=10+2=12、def=5+2=7，而样本写
  // atk10 def5——样本把「基础值」当成了「L1 总值」。裁决同 R-T4-p2-b 口径：
  // 公式为准（全局约束逐字），修锚点不动公式。见 task-5-report.md。
  it('DS#1 L1/0/0 → atk=10+1*2=12 def=5+1*2=7 hp100（公式锚点，非 brief 误标样本）', () => {
    expect(deriveStats(1, 0, 0)).toEqual({ level: 1, vit: 0, spi: 0, atk: 12, def: 7, maxHp: 100 });
  });

  it('DS#2 L5/250/80 → atk=10+10+10=30 def=5+10+25=40 hp140（brief 手算锚点，公式自洽）', () => {
    expect(deriveStats(5, 250, 80)).toEqual({ level: 5, vit: 250, spi: 80, atk: 30, def: 40, maxHp: 140 });
  });

  it('DS#3 floor 边界：spi=7→atk 不加成、spi=8→+1；vit=9→def 不加成、vit=10→+1', () => {
    expect(deriveStats(1, 0, 7).atk).toBe(12); // 10+2+0
    expect(deriveStats(1, 0, 8).atk).toBe(13); // 10+2+1
    expect(deriveStats(1, 9, 0).def).toBe(7); // 5+2+0
    expect(deriveStats(1, 10, 0).def).toBe(8); // 5+2+1
  });

  it('DS#4 字段语义：vit=已入脑卡数原样透传、spi=合格自建卡数原样透传', () => {
    const s = deriveStats(3, 42, 17);
    expect(s.vit).toBe(42);
    expect(s.spi).toBe(17);
    // maxHp 线性：100+(3-1)*10=120
    expect(s.maxHp).toBe(120);
  });

  it('DS#5 非法入参消毒：非有限/负数/小数一律收敛为安全整数，输出永不含 NaN', () => {
    const bad = deriveStats(NaN, -5, 1.9);
    expect(bad.level).toBe(1); // 非法 → 兜底 1
    expect(bad.vit).toBe(0); // 负 → 0
    expect(bad.spi).toBe(1); // 1.9 → floor 1
    expect(Number.isInteger(bad.atk)).toBe(true);
    expect(Number.isInteger(bad.def)).toBe(true);
    expect(Number.isInteger(bad.maxHp)).toBe(true);
    expect(deriveStats(Infinity, Infinity, Infinity).atk).toBe(12); // 溢出回落 L1/0/0
  });
});

describe('enemyHpForPool —— 卡池反推（HP = ceil(poolSize × 10 × 难度系数)）', () => {
  it('EH#1 RF#3 边界：poolSize 0 → throw', () => {
    expect(() => enemyHpForPool(0, 'encounter')).toThrow();
  });

  it('EH#2 RF#3 边界：负数 → throw', () => {
    expect(() => enemyHpForPool(-1, 'boss')).toThrow();
  });

  it('EH#3 RF#3 边界：非整数 → throw', () => {
    expect(() => enemyHpForPool(2.5, 'encounter')).toThrow();
    expect(() => enemyHpForPool(NaN, 'encounter')).toThrow();
    expect(() => enemyHpForPool(Infinity, 'encounter')).toThrow();
  });

  it('EH#4 poolSize 1 encounter → ceil(10×0.7)=7（brief 锚点）', () => {
    expect(enemyHpForPool(1, 'encounter')).toBe(7);
  });

  it('EH#5 size15 两档：encounter 105、boss 225（T7 模拟的 HP 侧数据源）', () => {
    expect(enemyHpForPool(15, 'encounter')).toBe(105); // ceil(150×0.7)
    expect(enemyHpForPool(15, 'boss')).toBe(225); // ceil(150×1.5)
  });

  it('EH#6 未知难度键（运行时脏数据）→ throw，不静默产出 NaN', () => {
    expect(() => enemyHpForPool(5, 'nightmare' as 'encounter')).toThrow();
  });
});

// 来历：D28（PRD v2.2 / Plan 4 · T1）——enemyPower 与 HP 同源反推但独立成数：
// ceil(BASE_CARD_DAMAGE × difficulty)，遭遇战 7 / Boss 11。它是反击公式的强度锚点。
describe('enemyPowerFor —— 敌人反击强度反推（D28：ceil(10 × 难度系数)）', () => {
  it('EP#1 两档锚点：encounter → ceil(10×0.7)=7、boss → ceil(10×1.5)=11（brief verbatim 7/11）', () => {
    expect(enemyPowerFor('encounter')).toBe(7);
    expect(enemyPowerFor('boss')).toBe(11);
  });

  it('EP#2 与池长解耦（性质而非巧合）：enemyPower 是每回合固定强度，enemyHp 才随池缩放', () => {
    // enemyHpForPool(1,'encounter')===enemyPowerFor('encounter')===7 只是单卡池的交点；
    // 15 张池 HP=105 而 power 恒 7——若实现误把 HP 当 power 返回，此断言即红。
    expect(enemyPowerFor('encounter')).toBe(7);
    expect(enemyHpForPool(15, 'encounter')).toBe(105);
    expect(enemyPowerFor('boss')).toBe(11);
    expect(enemyHpForPool(15, 'boss')).toBe(225);
  });

  it('EP#3 未知难度键（运行时脏数据）→ throw invalid-difficulty，与 EH#6 同纪律', () => {
    expect(() => enemyPowerFor('nightmare' as 'encounter')).toThrow(new Error('invalid-difficulty'));
  });
});

describe('expToNext —— 经验曲线 ceil(100 × L^1.3)', () => {
  it('X#1 锚点：L1=100、L2=ceil(100×2.4622…)=247（brief 锚点）', () => {
    expect(expToNext(1)).toBe(100);
    expect(expToNext(2)).toBe(247);
  });

  it('X#2 单调递增且前 5 级增速放缓可见', () => {
    const curve = [1, 2, 3, 4, 5].map(expToNext);
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    expect(curve).toEqual([100, 247, 418, 607, 811]);
  });

  it('X#3 非法 level → throw（与 enemyHpForPool 同口径的域外防御）', () => {
    expect(() => expToNext(0)).toThrow();
    expect(() => expToNext(1.5)).toThrow();
    expect(() => expToNext(-1)).toThrow();
  });
});

describe('applyExp —— 连续升级并消费余数', () => {
  it('AE#1 单级内累积：L1 + 50 → L1 剩 50', () => {
    expect(applyExp(1, 50)).toEqual({ level: 1, exp: 50 });
  });

  it('AE#2 恰达阈值即升：L1 + 100 → L2 剩 0', () => {
    expect(applyExp(1, 100)).toEqual({ level: 2, exp: 0 });
  });

  it('AE#3 跨两级：L1 + 347 → 越 100、247 两级 → L3 剩 0', () => {
    expect(applyExp(1, 347)).toEqual({ level: 3, exp: 0 });
  });

  it('AE#4 跨两级带余数：L1 + 400 → L3 剩 53', () => {
    expect(applyExp(1, 400)).toEqual({ level: 3, exp: 53 });
  });

  it('AE#5 exp 为 0 幂等；非法入参 → throw', () => {
    expect(applyExp(7, 0)).toEqual({ level: 7, exp: 0 });
    expect(() => applyExp(0, 10)).toThrow();
    expect(() => applyExp(1, -1)).toThrow();
    expect(() => applyExp(1, NaN)).toThrow();
  });
});

describe('victoryExp —— round(30 × 难度系数 + 5 × mastered释放数)', () => {
  it('VE#1 零 mastered：encounter round(21)=21、boss round(45)=45', () => {
    expect(victoryExp([], 'encounter')).toBe(21);
    expect(victoryExp([], 'boss')).toBe(45);
  });

  it('VE#2 mastered 计数只算池内：3 张 mastered → 21+15=36', () => {
    const pool = [makeCard('m1', 'mastered'), makeCard('m2', 'mastered'), makeCard('r', 'review'), makeCard('m3', 'mastered')];
    expect(victoryExp(pool, 'encounter')).toBe(36);
  });

  it('VE#3 new/learning 不计释放；全 mastered 池按张数加', () => {
    const pool = [makeCard('a', 'new'), makeCard('b', 'learning'), makeCard('c', 'mastered')];
    expect(victoryExp(pool, 'encounter')).toBe(26); // 21+5
    expect(victoryExp([makeCard('x', 'mastered'), makeCard('y', 'mastered')], 'boss')).toBe(55); // 45+10
  });

  it('VE#4 readonly 数组直接可用，且不改动入参池', () => {
    const pool: readonly Card[] = Object.freeze([makeCard('m', 'mastered'), makeCard('r', 'review')]);
    const before = JSON.stringify(pool);
    expect(victoryExp(pool, 'encounter')).toBe(26);
    expect(JSON.stringify(pool)).toBe(before);
  });

  it('VE#5 未知难度键 → throw', () => {
    expect(() => victoryExp([], 'nope' as 'encounter')).toThrow();
  });
});
