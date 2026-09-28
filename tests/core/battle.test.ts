/**
 * battle.ts —— Plan 2 · T4 确定性回合制战斗状态机。
 * 规则 verbatim（brief）：grade ≥ good 命中伤害；grade < good 仅空转敌人不反击；
 * idx 恒 +1；池耗尽 enemyHp≤0→won 否则 lost；enemyHp 先归零立即 won 剩余卡作废；
 * RF#2：重复 cardId → duplicate-card、空池 → empty-pool；非 answering 态 answer 幂等。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState, Stability } from '@core/types';
import { GRADES } from '@core/sm2';
import { mulberry32, type Rng } from '@core/rng';
import { createBattle, answer, type BattlePhase, type BattleState } from '@core/battle';
// 来历：D28——反击强度锚点（enemyPowerFor）属 stats.ts 的授权面，本组测试用它的真实值
// （遭遇战 7 / Boss 11）而非硬编码常数，钉住"power 与 HP 同源反推"这条约束本身。
import { enemyPowerFor } from '@core/stats';
/** rng≡0.5 → uniform(0.9,1.1) 恰为 1.0，伤害无浮动，便于手算。 */
const HALF: Rng = () => 0.5;

/**
 * 来历：D28（Plan 4 · T1）——反击公式同样吃 uniform(rng,0.9,1.1)，rng≡0 把浮动钉在
 * 下界 0.9，用于"恰好归零"这类需要非整数期望的边界样本（round(2.2×0.9)=2）。
 */
const ZERO: Rng = () => 0;

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
    // 来历：D28——此处的 again 三回合各承 1 点反击（def=7 vs power=7），共 3 点 ≪ maxHp=100，
    // lost 的成因仍是池尽；玩家死亡路径由 CB#16 单独钉。
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
    // 来历：D28——本例的击杀发生在第 3 击（enemyHp 与池同时归零），前两回合各承一次反击。
    // def=7 vs encounter power=7 ⇒ round(max(1,0)×1.0)=1/回合，两回合共 2 点，未致死；
    // 末回合反击被"won 优先于承伤"吞掉。若把 def 调低（薄血）此局即转败——
    // "全对必胜"自 D28 起改为"全对且够肉才必胜"（PRD §6.5 第四红线）。
    // 旧断言 playerHp 恒满属过时口径，此处按新语义更新。
    expect(s.playerHp).toBe(98);
    expect(s.log.map((e) => e.kind)).toEqual([
      'damage', 'retaliate', 'damage', 'retaliate', 'damage', 'end',
    ]);
  });

  it('AN#1b 同参数下 atk=10：HP=池数×10 亦恰好 won（公式 verbatim 的自洽锚点）', () => {
    const cards = pool(3);
    let s = createBattle(cards, 3 * 10, STATS_10, HALF);
    for (const c of cards) s = answer(s, c, GRADES.good, HALF);
    expect(s.phase).toBe('won');
    expect(s.enemyHp).toBe(0);
    // 来历：D28——STATS_10 的 def=7、encounter power=7 ⇒ 每非击杀回合承 1 点；
    // 第三击击杀不承伤。事件序列多出两个 retaliate(amount:1)。
    expect(s.log.map((e) => e.amount)).toEqual([10, 1, 10, 1, 10, undefined]);
    expect(s.playerHp).toBe(98);
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
    // 来历：D28——旧断言 `phase==='lost'` 的理由是「池耗尽且 enemyHp>0」，该理由在本夹具
    // 下仍然成立（def=7 vs power=7 ⇒ 单回合仅承 1 点，playerHp=99 远未归零），故 phase
    // 期望不变；但事件序列多出发还击项，log 形状按新语义更新。
    expect(s2.phase).toBe('lost'); // 池耗尽且 enemyHp>0（非气血归零）
    expect(s2.playerHp).toBe(99);
    expect(s2.log.map((e) => e.kind)).toEqual(['damage', 'retaliate', 'end']);
  });

  it('AN#4 hard 档低于 good ⇒ 走空转（brief verbatim「grade ≥ GRADES.good」才命中）', () => {
    const card = makeCard('h1');
    let s = createBattle([card], 7, STATS_7, HALF);
    s = answer(s, card, GRADES.hard, HALF);
    expect(s.log[0]).toEqual({ kind: 'miss', cardId: 'h1' });
    expect(s.enemyHp).toBe(7); // 零伤害——对敌输出仍为零（D28：错题惩罚不变）
    // 来历：D28——"敌人不反击"的旧口径已被 D28 取代：miss 回合**照常承伤**。
    // def=7、encounter power=enemyPowerFor('encounter')=7 ⇒ round(max(1,0)×1.0)=1。
    expect(s.log[1]).toEqual({ kind: 'retaliate', amount: 1 });
    expect(s.playerHp).toBe(99);
    expect(s.phase).toBe('lost'); // 池尽且敌人尚存（气血尚余 99，非被反击打死）
    expect(s.idx).toBe(1);
  });

  it('AN#4b easy 档（>good）命中且与 good 同倍率，仅浮动不同', () => {
    const card = makeCard('e1');
    let s = createBattle([card], 7, STATS_7, HALF);
    s = answer(s, card, GRADES.easy, HALF);
    expect(s.log[0]).toEqual({ kind: 'damage', cardId: 'e1', amount: 7 });
    // 来历：D28——击杀发生在这一击 → won 优先于承伤，本回合无 retaliate 事件。
    expect(s.log.map((e) => e.kind)).toEqual(['damage', 'end']);
    expect(s.playerHp).toBe(100);
    expect(s.phase).toBe('won');
  });

});

describe('answer —— 空转路径（grade < good）', () => {
  it('MS#1 miss 事件、零伤害，敌人仍回击（D28：miss 回合不免除反击）', () => {
    const cards = pool(2);
    const s0 = createBattle(cards, 14, STATS_10, HALF);
    const s1 = answer(s0, cards[0], GRADES.again, HALF);
    // 来历：D28——旧断言"敌人不反击、playerHp 恒满"是 D28 前的口径。def=7、
    // power=enemyPowerFor('encounter')=7 ⇒ max(1,0)×1.0=1 点/回合，错题的对敌零输出不变。
    expect(s1.log).toEqual([{ kind: 'miss', cardId: 'c0' }, { kind: 'retaliate', amount: 1 }]);
    expect(s1.enemyHp).toBe(14);
    expect(s1.playerHp).toBe(99);
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
    // 来历：D28——此局三回合皆承伤（def=7 vs power=7 ⇒ 各 1 点），
    // lost 的成因仍是"池尽敌存"而非气血归零（100−3=97）。
    expect(s.playerHp).toBe(97);
    expect(s.log.map((e) => e.kind)).toEqual([
      'damage', 'retaliate', 'miss', 'retaliate', 'damage', 'retaliate', 'end',
    ]);
  });
});

// ---------------------------------------------------------------------------
// D28（PRD v2.2 / Plan 4 · T1）：敌人反击进结算——def/maxHp 不再是摆设。
// verbatim：damageToPlayer = max(1, enemyPower − def) × uniform(rng,0.9,1.1)，round 后扣血；
// enemyPower = ceil(BASE_CARD_DAMAGE × difficulty)（遭遇战 7 / Boss 11，见 stats.enemyPowerFor）；
// 每回合玩家行动后结算（miss 不免除）；phase 顺序：敌≤0→won（当回合不承伤）→ 反击 →
// 己≤0→lost → 池尽→lost。答错仅空转的红线不变（对敌零输出，但敌人照常出手）。
// ---------------------------------------------------------------------------
describe('answer —— 敌人反击（D28）', () => {
  /** brief Step 1 的手算夹具：def=5 ⇒ 遭遇战单回合应承 round(max(1,7−5)×float)=2×float。 */
  const DEF_5 = { level: 1, vit: 0, spi: 0, atk: 10, def: 5, maxHp: 100 };

  it('CB#13 反击公式与事件形状：def=5、power=enemyPowerFor("encounter")=7、rng≡0.5 → 每回合 2 点', () => {
    const cards = pool(3);
    let s = createBattle(cards, 999, DEF_5, HALF);
    s = answer(s, cards[0], GRADES.good, HALF);
    // 命中伤 = round(10×1.0×1.0)=10；反击 = round(max(1,7−5)×1.0)=2
    expect(s.log).toEqual([
      { kind: 'damage', cardId: 'c0', amount: 10 },
      { kind: 'retaliate', amount: 2 },
    ]);
    expect(s.enemyHp).toBe(989);
    expect(s.playerHp).toBe(98);
    expect(s.phase).toBe('answering');
    s = answer(s, cards[1], GRADES.good, HALF);
    expect(s.playerHp).toBe(96); // 逐回合累加，非一次性
    expect(s.maxPlayerHp).toBe(100); // 上限不动，只扣当前值
  });

  it('CB#13b 浮动区间：rng≡0 → ×0.9、rng→1⁻ → ×1.1，均 round 后入账（与伤害同 float 语义）', () => {
    const near: Rng = () => 0.999999;
    const cards = pool(2);
    // def=5、power=7 ⇒ 基数 2：下界 round(2×0.9)=round(1.8)=2；上界 round(2×1.1⁻)=2
    let a = createBattle(cards, 999, DEF_5, ZERO);
    a = answer(a, cards[0], GRADES.again, ZERO);
    expect(a.log[1]).toEqual({ kind: 'retaliate', amount: 2 });
    expect(a.playerHp).toBe(98);
    let b = createBattle(cards, 999, DEF_5, near);
    b = answer(b, cards[0], GRADES.again, near);
    expect(b.log[1].amount).toBe(2);
    // def=0 ⇒ 基数 7：下界 round(6.3)=6、上界 round(7.7)=8 —— 浮动真实生效
    const NO_DEF = { level: 1, vit: 0, spi: 0, atk: 10, def: 0, maxHp: 100 };
    let c = createBattle(cards, 999, NO_DEF, ZERO);
    c = answer(c, cards[0], GRADES.again, ZERO);
    expect(c.log[1].amount).toBe(6);
    let d = createBattle(cards, 999, NO_DEF, near);
    d = answer(d, cards[0], GRADES.again, near);
    expect(d.log[1].amount).toBe(8);
  });

  it('CB#14 def ≥ power 时保底 1 点：max(1, …) 的下钳（高防也掉血，气血条永远在动）', () => {
    const TANK = { level: 9, vit: 0, spi: 0, atk: 10, def: 40, maxHp: 100 };
    const cards = pool(2);
    let s = createBattle(cards, 999, TANK, HALF);
    s = answer(s, cards[0], GRADES.good, HALF);
    // max(1, 7−40) = 1 ⇒ round(1×1.0)=1（若漏掉 max(1,…) 这里会是 0）
    expect(s.log[1]).toEqual({ kind: 'retaliate', amount: 1 });
    expect(s.playerHp).toBe(99);
  });

  it('CB#14b Boss 档经 createBattle 第 5 参接线：power=enemyPowerFor("boss")、def=5 → 每回合承 6', () => {
    // 来历：D28 + EP#1 裁定 power 走封顶系数（ceil(10×1.1)=11，非 ceil(10×DIFFICULTY.boss)
    // =15——后者会让 Boss 反击超过 mastered 倍率的基础输出，全对必胜红线被破）。
    // 本例同时钉住「上层显式传 difficulty 换算值」这条接线面（T3 startFight 的真实用法）。
    expect(enemyPowerFor('boss')).toBe(11);
    const cards = pool(2);
    let s = createBattle(cards, 9999, DEF_5, HALF, enemyPowerFor('boss'));
    s = answer(s, cards[0], GRADES.good, HALF);
    // 命中伤 round(10×1.0×1.0)=10；反击 round(max(1,11−5)×1.0)=6
    expect(s.log[1]).toEqual({ kind: 'retaliate', amount: 6 });
    expect(s.playerHp).toBe(94);
    const TANK10 = { level: 1, vit: 0, spi: 0, atk: 10, def: 10, maxHp: 100 };
    let t = createBattle(cards, 9999, TANK10, HALF, enemyPowerFor('boss'));
    t = answer(t, cards[0], GRADES.again, HALF);
    expect(t.log[1].amount).toBe(1); // max(1, 11−10) 下钳在 Boss 档同样生效
  });

  it('CB#15 miss 回合仍反击（D28 verbatim：miss 不免除）', () => {
    // 来历：D28 接管修正——原池仅 2 张：第二问无论怎么答 idx 都到池尽（good 击杀会
    // won+end、非 good 空转则 lost+end），"slice(2)==['damage','retaliate']"永远多一条
    // end。扩池到 3 张让两回合都留在 answering 态，断言才表达本意（两回合皆反击）。
    const cards = pool(3);
    let s = createBattle(cards, 999, DEF_5, HALF);
    s = answer(s, cards[0], GRADES.again, HALF);
    expect(s.log.map((e) => e.kind)).toEqual(['miss', 'retaliate']);
    expect(s.enemyHp).toBe(999); // 对敌零输出：错题惩罚红线未动
    expect(s.playerHp).toBe(98); // 但敌人照常出手
    // 来历：D28 接管修正——原第二问用 hard 且池仅 2 张：hard 为空转 ⇒ idx=2=池尽
    // ⇒ lost+end，旧断言 slice(2)==['miss','retaliate'] 自相矛盾（漏算了必然的 end）。
    // 改 good 续跑：既保留"两回合皆反击"意图，又避开终局干扰。
    s = answer(s, cards[1], GRADES.good, HALF);
    expect(s.log.slice(2).map((e) => e.kind)).toEqual(['damage', 'retaliate']);
    expect(s.playerHp).toBe(96);
  });

  it('CB#16 气血归零当回合判 lost（idx 未到池尽也算），且 lost 优先于池尽分支', () => {
    // 恰好归零样本：def=5、power=7 ⇒ 基数 2；rng≡0.9 → float=exactly 1.0 → 每回合承 2 点。
    // （注意：JS Math.round 对 .5 向上取整，round(2×0.95)=round(1.9)=2 而非 1——用
    //  rng≡0.9 把浮动钉成恒等，避免依赖半进位的巧合。）
    const NINE: Rng = () => 0.9;
    const cards = pool(6);
    const THIN = { level: 1, vit: 0, spi: 0, atk: 10, def: 5, maxHp: 4 };
    let s = createBattle(cards, 999, THIN, NINE);
    s = answer(s, cards[0], GRADES.good, NINE);
    expect(s.playerHp).toBe(2);
    expect(s.phase).toBe('answering'); // 尚余 2 血，未死
    s = answer(s, cards[1], GRADES.good, NINE);
    expect(s.playerHp).toBe(0); // 恰好归零，不是负数
    expect(s.idx).toBe(2);
    expect(s.phase).toBe('lost'); // idx=2 < pool.length=6：败因是气血，不是池尽
    expect(s.log[s.log.length - 1]).toEqual({ kind: 'end' });
    expect(s.log.map((e) => e.kind)).toEqual([
      'damage', 'retaliate', 'damage', 'retaliate', 'end',
    ]);
    // 终局后幂等：剩余卡作废，log 不再追加
    const frozen = s;
    expect(answer(frozen, cards[2], GRADES.easy, NINE)).toBe(frozen);
    expect(frozen.log).toHaveLength(5);
  });

  it('CB#16b 反击可致死：rng≡0（下界 ×0.9）时基数 2 → round(1.8)=2，两回合磨穿 maxHp=4', () => {
    // 来历：D28——JS Math.round 是 half-up，round(2×0.9)=round(1.8)→2、round(2×0.95)=2。
    // 本例钉"下界浮动同样能打死人"，与 CB#16 的恒等浮动样本互补（两条 float 端点皆判负）。
    const cards = pool(6);
    const THIN = { level: 1, vit: 0, spi: 0, atk: 10, def: 5, maxHp: 4 };
    let s = createBattle(cards, 999, THIN, ZERO);
    s = answer(s, cards[0], GRADES.good, ZERO);
    expect(s.playerHp).toBe(2);
    s = answer(s, cards[1], GRADES.again, ZERO); // miss 回合也承伤
    expect(s.playerHp).toBe(0);
    expect(s.phase).toBe('lost');
    expect(s.idx).toBe(2); // 池远未尽
  });

  it('CB#17 won 优先于承伤：最后一题击杀 → won 且 playerHp 不再扣（反击被胜负短路吞掉）', () => {
    // 血量只剩 2、本回合必承 2 点——但同一击把敌人打死，胜负先判：不承伤、判 won。
    const cards = pool(4);
    const LOW_HP = { level: 1, vit: 0, spi: 0, atk: 10, def: 5, maxHp: 2 };
    let s = createBattle(cards, 10, LOW_HP, HALF);
    s = answer(s, cards[0], GRADES.good, HALF); // dmg 10 → enemyHp 0 → won（首击即杀）
    expect(s.phase).toBe('won');
    expect(s.playerHp).toBe(2); // 未承伤：若实现先扣血再判胜，这里会是 0 且误判 lost
    expect(s.log.map((e) => e.kind)).toEqual(['damage', 'end']);
    // 双杀局面（敌我同回合归零）同样判 won：同花顺局不该双双阵亡
    const cards2 = pool(4);
    const DYING = { level: 1, vit: 0, spi: 0, atk: 10, def: 5, maxHp: 1 };
    let t = createBattle(cards2, 30, DYING, HALF);
    t = answer(t, cards2[0], GRADES.good, HALF); // 承 2 > hp 1，但 enemyHp 尚存 → lost
    expect(t.phase).toBe('lost');
    let u = createBattle(cards2, 10, DYING, HALF);
    u = answer(u, cards2[0], GRADES.good, HALF); // 同回合击杀 → won 优先
    expect(u.phase).toBe('won');
    expect(u.playerHp).toBe(1);
  });

  it('CB#18 确定性：同 seed 同序列 → 反击浮动逐位可复现（rng 消耗序是契约的一部分）', () => {
    // 来历：D28——每回合的 rng 消耗序为「命中伤害 1 掷 + 反击 1 掷；miss 回合仅反击 1 掷」。
    // 两条独立流跑同一作答序列必须逐字段全等；若实现漏掷或多掷，此断言即红。
    const cards = pool(5); // 来历：D28 接管修正——4 张池在第 4 答后 idx===pool.length 追加 end，与本例"确定性消耗序"主题无关的终局噪声；扩到 5 张保持 answering
    const seq = [GRADES.good, GRADES.again, GRADES.easy, GRADES.hard];
    const runOnce = (): BattleState => {
      const rng = mulberry32(7);
      let s = createBattle(cards, 999, DEF_5, rng);
      for (let i = 0; i < seq.length; i++) s = answer(s, cards[i], seq[i], rng);
      return s;
    };
    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b);
    // mulberry32(7) 前 6 掷（一次性探针实测，非手算近似）：
    //   r1..r6 = .011705 .061958 .976908 .699029 .521445 .405522
    // 消耗序：good=dmg(r1)+retal(r2)，again=retal(r3)，easy=dmg(r4)+retal(r5)，
    //         hard=retal(r6)。float=0.9+r×0.2 ⇒ 期望值如下（改序必红）。
    expect(a.log.map((e) => e.kind)).toEqual([
      'damage', 'retaliate', 'miss', 'retaliate', 'damage', 'retaliate', 'miss', 'retaliate',
    ]);
    // 来历：D28 接管修正——原断言按"每回合至多一掷"的旧模型估出累计承伤 8；反击段
    // 实际消耗 dmg(r1)+retal(r2)+retal(r3)+dmg(r4)+retal(r5)+retal(r6)（miss 不掷），
    // r2/r5 的 float≈0.924/0.976 使两回合承伤各为 1。逐位 amount 序列与 playerHp
    // 一并钉死：改任何一掷的顺序或次数都会红。
    // amount 含 damage/miss/retaliate/end 混合，miss/end 无 amount（undefined 保留位序）。
    // good: dmg r1→9 + retal r2→2；again: miss(undef) + retal r3→2；easy: dmg r4→10 +
    // retal r5→2；hard: miss(undef) + retal r6→2。累计承伤 8 ⇒ playerHp 92。
    expect(a.log.map((e) => e.amount)).toEqual([9, 2, undefined, 2, 10, 2, undefined, 2]);
    expect(a.playerHp).toBe(92);
    expect(a.phase).toBe('answering');
  });

  it('CB#19 幂等与 mismatch 行为不受反击影响：终局同引用、mismatch 拒推进且不产生反击', () => {
    const cards = pool(3);
    const s = createBattle(cards, 999, DEF_5, HALF);
    const msgs: string[] = [];
    // mismatch：整段主体不可达 ⇒ 连反击都不该发生（playerHp 原样）
    const rejected = answer(s, makeCard('c2'), GRADES.good, HALF, (m) => msgs.push(m));
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(rejected).toBe(s);
    expect(rejected.playerHp).toBe(100);
    // 终局态：反击路径同样不可达
    const dead = answer(answer(s, cards[0], GRADES.again, HALF), cards[1], GRADES.again, HALF);
    expect(dead.playerHp).toBe(96);
    const won = { ...dead, phase: 'won' as BattlePhase };
    expect(answer(won, cards[2], GRADES.easy, HALF)).toBe(won);
  });

  it('CB#20 不可变返回：反击写回新 state，旧 state 的 playerHp/log 不被改动', () => {
    const cards = pool(2);
    const s0 = createBattle(cards, 999, DEF_5, HALF);
    const s1 = answer(s0, cards[0], GRADES.good, HALF);
    expect(s0.playerHp).toBe(100);
    expect(s0.log).toHaveLength(0);
    expect(s1).not.toBe(s0);
    expect(s1.playerHp).toBe(98);
    expect(s1.log).toHaveLength(2);
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
    // 来历：D28——每回合的 retaliate 落在本回合 damage/miss 之后、end 之前。
    // STATS_10 def=7 vs encounter power=enemyPowerFor('encounter')=7 ⇒ round(max(1,0)×1.0)=1；
    // 第三击击杀 → won 优先，末回合无反击（"end 恒为最后事件"这条不变式不受影响）。
    expect(s.log.map((e) => `${e.kind}:${e.cardId ?? ''}:${e.amount ?? ''}`)).toEqual([
      'damage:c0:10',
      'retaliate::1',
      'miss:c1:',
      'retaliate::1',
      'damage:c2:10',
      'end::',
    ]);
    expect(s.playerHp).toBe(98);
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
    // 来历：D28——atk=1 打不死敌人（enemyHp=1000），三回合各承 1 点反击（def=7 vs power=7），
    // lost 的成因仍是"池尽敌存"；气血归零这条独立败北路径由 CB#16 钉。
    expect(s.phase).toBe('lost');
    expect(s.playerHp).toBe(97);
  });
});
