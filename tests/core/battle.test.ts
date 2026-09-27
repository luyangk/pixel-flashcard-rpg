/**
 * battle.ts —— Plan 2 · T4 确定性回合制战斗状态机。
 * 规则 verbatim（brief）：grade ≥ good 命中伤害；grade < good 仅空转敌人不反击；
 * idx 恒 +1；池耗尽 enemyHp≤0→won 否则 lost；enemyHp 先归零立即 won 剩余卡作废；
 * RF#2：重复 cardId → duplicate-card、空池 → empty-pool；非 answering 态 answer 幂等。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState, Stability } from '@core/types';
import { GRADES } from '@core/sm2';
import type { Rng } from '@core/rng';
import { createBattle, answer, type BattlePhase, type BattleState } from '@core/battle';

/** rng≡0.5 → uniform(0.9,1.1) 恰为 1.0，伤害无浮动，便于手算。 */
const HALF: Rng = () => 0.5;

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

/** n 张 review 档卡（stability=review → 倍率 1.0）。 */
function pool(n: number): Card[] {
  return Array.from({ length: n }, (_, i) => makeCard(`c${i}`));
}

// T5 对齐：createBattle 入参现为完整 PlayerStats（stats.ts）。这些是测试夹具，
// 刻意取 atk=10/7 而非 deriveStats(1,0,0) 的 12——战斗公式与属性推导解耦，
// 手算锚点只钉 answer 路径。spi/vit 值仅为使 atk 与派生式自洽的占位。
const STATS_10 = { level: 1, vit: 0, spi: 16, atk: 10, def: 7, maxHp: 100 };

/**
 * brief Step 1 的 AN#1 锚点写「attack=10、倍率 review=1.0、rng≡0.5→浮动1.0、HP=池数×7」。
 * 该组合与公式 verbatim（damage = round(atk × mult × float)）不自洽：atk=10 / mult=1.0 /
 * float=1.0 ⇒ 单卡恒伤 10，而「池数×7」要求单卡伤害 7。裁决 R-T4-p2-b：以实现规则为准、
 * 修测试锚点不动公式。此处保留「HP = 池数 × 单卡伤害」的字面结构，把 attack 取为 7
 * （controller 诊断同口径：「7 对应 atk7」）。全 good 必胜在 atk=10 下由 AN#1b 覆盖。
 */
const STATS_7 = { level: 1, vit: 0, spi: 0, atk: 7, def: 7, maxHp: 100 };

describe('createBattle —— RF#2 入参校验与初始态', () => {
  it('CB#1 重复 cardId → throw Error("duplicate-card")', () => {
    const cards = [makeCard('x'), makeCard('y'), makeCard('x')];
    expect(() => createBattle(cards, 50, STATS_10, HALF)).toThrowError(new Error('duplicate-card'));
  });

  it('CB#2 空池 → throw Error("empty-pool")', () => {
    expect(() => createBattle([], 50, STATS_10, HALF)).toThrowError(new Error('empty-pool'));
  });

  it('CB#3 初始 phase=answering、idx=0、pool 持 cardId 序列、HP 取自 playerStats、log 空', () => {
    const s = createBattle(pool(3), 21, STATS_10, HALF);
    expect(s.phase).toBe('answering');
    expect(s.idx).toBe(0);
    expect(s.pool).toEqual(['c0', 'c1', 'c2']);
    expect(s.enemyHp).toBe(21);
    expect(s.playerHp).toBe(100);
    expect(s.maxPlayerHp).toBe(100);
    expect(s.log).toEqual([]);
  });

  it('CB#4 N-8：createBattle 行为不变——phase 直接落 answering，无 ready 中间态', () => {
    // 'ready' 联合成员已删（N-8）：建战即出第一张题卡，不存在"待开始"相位。
    // 类型层钉子见下方 @ts-expect-error：把 'ready' 赋给 BattlePhase 应编译报错。
    const s = createBattle(pool(2), 14, STATS_10, HALF);
    expect(s.phase).toBe('answering');
    // 运行时穷举：合法相位只可能是三个成员之一。
    const isLegalPhase = (p: BattlePhase): boolean =>
      p === 'answering' || p === 'won' || p === 'lost';
    expect(isLegalPhase(s.phase)).toBe(true);
    // @ts-expect-error —— BattlePhase 联合已收窄，'ready' 不再是合法成员
    const _dead: BattlePhase = 'ready';
    void _dead;
  });
});

describe('answer —— dev 断言（N-9：card 必须等于 pool[idx]）', () => {
  /** 3 张 review 卡、enemyHp 足够大（不提前终局），便于观察 idx。 */
  function mid(): BattleState {
    return createBattle(pool(3), 999, STATS_10, HALF);
  }

  it('AN#5 正确卡 + asserts 回调 → 不产任何断言消息，正常推进', () => {
    const msgs: string[] = [];
    const s = mid();
    // idx=0 ⇒ 当前卡为 c0：传对应 Card 对象即合法路径
    const next = answer(s, makeCard('c0'), GRADES.good, HALF, (m) => msgs.push(m));
    expect(msgs).toEqual([]);
    expect(next.idx).toBe(1);
    expect(next.log[0].kind).toBe('damage');
  });

  it('AN#6 card.id ≠ pool[idx] → asserts("answer-card-mismatch") 且拒绝推进（idx/log/enemyHp 原样）', () => {
    const msgs: string[] = [];
    const s = mid(); // idx=0 ⇒ 当前卡应为 c0
    const wrong = makeCard('c2'); // 时序错乱：拿第 3 张去答第 1 张的题
    const next = answer(s, wrong, GRADES.good, HALF, (m) => msgs.push(m));
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(next).toBe(s); // 同一引用返回：零状态变化
    expect(next.idx).toBe(0);
    expect(next.enemyHp).toBe(999);
    expect(next.log).toEqual([]);
  });

  it('AN#7 mismatch 时 miss 档（grade < good）同样拒绝推进', () => {
    const msgs: string[] = [];
    const s = mid();
    const next = answer(s, makeCard('c1'), GRADES.again, HALF, (m) => msgs.push(m));
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(next).toBe(s);
  });

  it('AN#8 不传 asserts（生产路径零开销）→ mismatch 静默放行，照常推进', () => {
    const s = mid();
    const next = answer(s, makeCard('c2'), GRADES.good, HALF);
    expect(next).not.toBe(s);
    expect(next.idx).toBe(1);
    // 伤害倍率取自入参 card 的 srs（此处两档都是 review=1.0，锚点只钉推进）
    expect(next.enemyHp).toBe(999 - Math.round(10 * 1.0 * 1.0));
  });

  it('AN#9 won 终局态幂等优先于断言：传入非当前卡也不报 mismatch（剩余卡作废是合法调用面）', () => {
    const cards = pool(4);
    let s = createBattle(cards, 7, STATS_10, HALF);
    s = answer(s, cards[0], GRADES.good, HALF); // 立即 won
    expect(s.phase).toBe('won');
    const msgs: string[] = [];
    const next = answer(s, cards[2], GRADES.good, HALF, (m) => msgs.push(m));
    expect(next).toBe(s); // 幂等返回自身
    expect(msgs).toEqual([]);
  });

  it('AN#10 脏池防御：pool[idx] 越界（idx ≥ pool.length）时报 mismatch 并拒进', () => {
    const msgs: string[] = [];
    const s = mid();
    // 手工构造 idx 越界的脏 state（模拟存档回放损坏）
    const dirty: BattleState = { ...s, idx: 5 };
    const next = answer(dirty, makeCard('c0'), GRADES.good, HALF, (m) => msgs.push(m));
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(next).toBe(dirty);
  });

  it('AN#10b 脏池 null 占位：pool[idx] === null 同样报 mismatch 并拒进（与越界对称，T3 捎带）', () => {
    // currentId === undefined 的旧写法漏防 null：null 会穿过防护喂进 damage 路径
    // （card.srs TypeError）。== null 闭合后，null 洞与越界走同一条拒进分支。
    const msgs: string[] = [];
    const holed: BattleState = { ...mid(), pool: [null as unknown as string, 'c1', 'c2'] };
    const next = answer(holed, makeCard('c0'), GRADES.good, HALF, (m) => msgs.push(m));
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(next).toBe(holed);
  });

  it('CB#11 终局态直调不带 asserts → 实测返回同一引用（phase 检查先于一切短路，主体不可达）', () => {
    // lost 经池尽达成：idx === pool.length。若真穿过 phase 检查进入主体，
    // idx+1 与 end 事件都会造出新对象——实测同引用，即该路径不存在。
    let lost = createBattle(pool(3), 999, STATS_10, HALF);
    for (const c of pool(3)) lost = answer(lost, c, GRADES.again, HALF);
    expect(lost.phase).toBe('lost');
    expect(lost.idx).toBe(lost.pool.length);
    expect(answer(lost, makeCard('ghost'), GRADES.again, HALF)).toBe(lost);
    // won 经 enemyHp 先归零达成：idx < pool.length，同样被 phase 检查挡住。
    const cards = pool(3);
    let won = createBattle(cards, 7, STATS_7, HALF);
    won = answer(won, cards[0], GRADES.good, HALF);
    expect(won.phase).toBe('won');
    expect(won.idx).toBeLessThan(won.pool.length);
    expect(answer(won, makeCard('ghost'), GRADES.easy, HALF)).toBe(won);
    // 手工伪造的终局态（idx 在池内）也走同一条幂等短路——主体对任何终局输入都不可达。
    const forged: BattleState = { ...mid(), phase: 'lost', idx: 1 };
    expect(answer(forged, makeCard('c1'), GRADES.good, HALF)).toBe(forged);
  });

  it('CB#12 违规 + mismatch（answering 态、card.id ≠ pool[idx]）→ 同一引用拒绝推进', () => {
    const s = mid(); // answering, idx=0 ⇒ 当前卡 c0
    const msgs: string[] = [];
    // 与 AN#6 同族，钉的是「违规分支返回同一引用」这一契约本身：
    // battleFlow.answerCurrent 修复后不再读引用同一性，此性质由本例独立守护。
    expect(answer(s, makeCard('c1'), GRADES.good, HALF, (m) => msgs.push(m))).toBe(s);
    expect(msgs).toEqual(['answer-card-mismatch']);
  });
});

describe('answer —— 命中路径（grade ≥ good）', () => {
  it('AN#1 全 good 池恰好 won（brief 锚点 HP=池数×7 ⇒ atk=7，见 R-T4-p2-b 注释）', () => {
    const cards = pool(3);
    let s = createBattle(cards, 3 * 7, STATS_7, HALF);
    for (const c of cards) {
      expect(s.phase).toBe('answering');
      s = answer(s, c, GRADES.good, HALF);
    }
    // 7−7=0 → 第 3 张打出后 enemyHp 归零且池同时耗尽 → won
    expect(s.phase).toBe('won');
    expect(s.enemyHp).toBe(0);
    expect(s.idx).toBe(3);
    expect(s.playerHp).toBe(100); // 玩家掉血路径本版不存在
    expect(s.log.map((e) => e.kind)).toEqual(['damage', 'damage', 'damage', 'end']);
  });

  it('AN#1b 同参数下 atk=10：HP=池数×10 亦恰好 won（公式 verbatim 的自洽锚点）', () => {
    const cards = pool(3);
    let s = createBattle(cards, 3 * 10, STATS_10, HALF);
    for (const c of cards) s = answer(s, c, GRADES.good, HALF);
    expect(s.phase).toBe('won');
    expect(s.enemyHp).toBe(0);
    expect(s.log.map((e) => e.amount)).toEqual([10, 10, 10, undefined]);
  });

  it('AN#2 damage = attack × damageMultiplier(stability) × uniform(rng,0.9,1.1)，round 后扣血', () => {
    // 下界：rng≡0 → float=0.9；mastered 倍率 1.5 → round(10×1.5×0.9)=round(13.5)=14
    const zero: Rng = () => 0;
    const mastered = makeCard('m1', 'mastered');
    let a = createBattle([mastered], 20, STATS_10, zero);
    a = answer(a, makeCard('m1', 'mastered'), GRADES.easy, zero);
    expect(a.log[0]).toEqual({ kind: 'damage', cardId: 'm1', amount: 14 });
    expect(a.enemyHp).toBe(6);

    // 中值：rng≡0.5 → float=1.0；learning 倍率 0.5 → round(10×0.5×1.0)=5
    const learning = makeCard('l1', 'learning');
    let b = createBattle([learning], 12, STATS_10, HALF);
    b = answer(b, makeCard('l1', 'learning'), GRADES.good, HALF);
    expect(b.log[0].amount).toBe(5);
    expect(b.enemyHp).toBe(7);

    // 上界：rng→1⁻ → float→1.1⁻；review 倍率 1.0 → round(10×1.0×1.1)=11
    const near: Rng = () => 0.999999;
    const reviewCard = makeCard('r1');
    let c = createBattle([reviewCard], 12, STATS_10, near);
    c = answer(c, makeCard('r1'), GRADES.good, near);
    expect(c.log[0].amount).toBe(11);
    expect(c.enemyHp).toBe(1);
  });

  it('AN#3 stability=new 的卡伤害 0.1×atk 取整可为 0：amount=0 仍记 damage 事件算命中', () => {
    const card = makeCard('n1', 'new');
    // atk=10 → 10×0.1×1.0 = 1（非零）；atk=4 → 0.4 → round 0
    let s = createBattle([card], 5, STATS_10, HALF);
    s = answer(s, card, GRADES.good, HALF);
    expect(s.log[0]).toEqual({ kind: 'damage', cardId: 'n1', amount: 1 });
    expect(s.enemyHp).toBe(4);

    // atk=4 → round(4×0.1×1.0)=round(0.4)=0：零伤害仍记 damage 事件（算命中）
    const lowAtk = { level: 1, vit: 0, spi: 0, atk: 4, def: 7, maxHp: 100 };
    let s2 = createBattle([card], 5, lowAtk, HALF);
    s2 = answer(s2, card, GRADES.good, HALF);
    expect(s2.enemyHp).toBe(5);
    expect(s2.log[0]).toEqual({ kind: 'damage', cardId: 'n1', amount: 0 });
    expect(s2.phase).toBe('lost'); // 池耗尽且 enemyHp>0
    expect(s2.log.map((e) => e.kind)).toEqual(['damage', 'end']);
  });

  it('AN#4 hard 档低于 good ⇒ 走空转（brief verbatim「grade ≥ GRADES.good」才命中）', () => {
    const card = makeCard('h1');
    let s = createBattle([card], 7, STATS_7, HALF);
    s = answer(s, card, GRADES.hard, HALF);
    expect(s.log[0]).toEqual({ kind: 'miss', cardId: 'h1' });
    expect(s.enemyHp).toBe(7); // 零伤害、敌人不反击
    expect(s.phase).toBe('lost'); // 池尽且敌人尚存
    expect(s.idx).toBe(1);
  });

  it('AN#4b easy 档（>good）命中且与 good 同倍率，仅浮动不同', () => {
    const card = makeCard('e1');
    let s = createBattle([card], 7, STATS_7, HALF);
    s = answer(s, card, GRADES.easy, HALF);
    expect(s.log[0]).toEqual({ kind: 'damage', cardId: 'e1', amount: 7 });
    expect(s.phase).toBe('won');
  });

});

describe('answer —— 空转路径（grade < good）', () => {
  it('MS#1 miss 事件、零伤害、敌人不反击，且不产生负向事件之外的状态变化', () => {
    const cards = pool(2);
    const s0 = createBattle(cards, 14, STATS_10, HALF);
    const s1 = answer(s0, cards[0], GRADES.again, HALF);
    expect(s1.log).toEqual([{ kind: 'miss', cardId: 'c0' }]);
    expect(s1.enemyHp).toBe(14);
    expect(s1.playerHp).toBe(100);
    expect(s1.maxPlayerHp).toBe(100);
    expect(s1.pool).toEqual(s0.pool);
    expect(s1.idx).toBe(1);
    expect(s1.phase).toBe('answering');
  });

  it('MS#2 一 miss → lost：全 good 必胜的同参数池掺一张 again', () => {
    const cards = pool(3);
    let s = createBattle(cards, 3 * 7, STATS_7, HALF); // 与 AN#1 同锚点（atk=7）
    s = answer(s, cards[0], GRADES.good, HALF);
    s = answer(s, cards[1], GRADES.again, HALF); // 空转，少打 7 点
    s = answer(s, cards[2], GRADES.good, HALF);
    expect(s.phase).toBe('lost');
    expect(s.enemyHp).toBe(7);
    expect(s.idx).toBe(3);
  });
});

describe('终局与幂等', () => {
  /** 走到「enemyHp 先归零、池尚有余卡」的中间态。 */
  function earlyWin(): { s: BattleState; cards: Card[] } {
    const cards = pool(4);
    let s = createBattle(cards, 7, STATS_10, HALF);
    s = answer(s, cards[0], GRADES.good, HALF); // 7−7=0，idx=1 < 4
    return { s, cards };
  }

  it('EW#1 enemyHp 先归零 → 立即 won，剩余卡作废，log 记 end', () => {
    const { s } = earlyWin();
    expect(s.phase).toBe('won');
    expect(s.idx).toBe(1);
    expect(s.log.map((e) => e.kind)).toEqual(['damage', 'end']);
  });

  it('EW#2 won 后 answer 幂等返回自身（同一引用），log 不再追加', () => {
    const { s, cards } = earlyWin();
    const again = answer(s, cards[1], GRADES.good, HALF);
    expect(again).toBe(s);
    expect(again.log.length).toBe(2);
  });

  it('EW#3 lost 后 answer 幂等返回自身', () => {
    const cards = pool(1);
    let s = createBattle(cards, 99, STATS_10, HALF);
    s = answer(s, cards[0], GRADES.again, HALF);
    expect(s.phase).toBe('lost');
    expect(answer(s, cards[0], GRADES.good, HALF)).toBe(s);
  });

  it('EV#1 log 追加序正确：终局 end 恒为最后一个事件', () => {
    const cards = pool(3);
    let s = createBattle(cards, 20, STATS_10, HALF);
    s = answer(s, cards[0], GRADES.good, HALF); // dmg 10 → hp10
    s = answer(s, cards[1], GRADES.again, HALF); // miss
    s = answer(s, cards[2], GRADES.easy, HALF); // dmg 10 → hp0 且池尽 → won+end
    expect(s.log.map((e) => `${e.kind}:${e.cardId ?? ''}:${e.amount ?? ''}`)).toEqual([
      'damage:c0:10',
      'miss:c1:',
      'damage:c2:10',
      'end::',
    ]);
    expect(s.phase).toBe('won');
  });

  it('IM#1 不可变性：answer 返回新对象，旧 state 与 log 数组不被改动', () => {
    const cards = pool(2);
    const s0 = createBattle(cards, 14, STATS_10, HALF);
    const snapshot: BattleState = JSON.parse(JSON.stringify(s0));
    const logRef = s0.log;
    const s1 = answer(s0, cards[0], GRADES.good, HALF);
    expect(s0).toEqual(snapshot);
    expect(s0.log).toBe(logRef);
    expect(s0.log).toHaveLength(0);
    expect(s1).not.toBe(s0);
    expect(s1.log).not.toBe(logRef);
    // idx 单调 +1
    expect(s1.idx).toBe(s0.idx + 1);
  });

  it('IDX#1 idx 恒 +1（含 miss 与零伤害 damage）直至池尽', () => {
    const cards = pool(3);
    let s = createBattle(cards, 1000, { level: 1, vit: 0, spi: 0, atk: 1, def: 7, maxHp: 100 }, HALF);
    for (let i = 0; i < cards.length; i++) {
      const g = i === 1 ? GRADES.again : GRADES.good;
      s = answer(s, cards[i], g, HALF);
      expect(s.idx).toBe(i + 1);
    }
    expect(s.phase).toBe('lost');
  });
});
