/**
 * battleFlow.ts —— Plan 3 · T2 战斗段编排（玩家"打一局"的数据流主干）。
 *
 * 钉住的契约（brief Step 1 verbatim）：
 * - startFight({cards:[]}) → { error:'no-cards', message 含「还没有卡片」}（RF#3 空库引导，值不是 throw）；
 * - size 请求 15 实得 8 → enemyHp 按 8 反推（encounter：ceil(8×10×0.7)=56）且 pool.length===8；
 * - answerCurrent 依序推进 idx、终局 phase='won' 时 current===null；
 * - answerCurrent 不收 card 参数 ⇒ API 层面免疫 RF#4 答错卡主路径；
 *   mismatch 只在 battle.answer 直调面出现（见 tests/core/battle.test.ts AN#6）。
 * 另加：insufficient-cards 的 deckIds 收窄语义、错误返回永不含 throw 的入参消毒面。
 */
import { describe, expect, it } from 'vitest';
import type { Card, Deck, SRSState, Stability } from '@core/types';
import type { Rng } from '@core/rng';
import { GRADES } from '@core/sm2';
import { mulberry32 } from '@core/rng';
import { createBattle } from '@core/battle';
import { answerCurrent, startFight, type FightView } from '../../src/app/battleFlow';
import type { SessionCards } from '../../src/app/sessionTypes';

/** rng≡0.5 → uniform(0.9,1.1) 恰为 1.0，伤害无浮动，便于手算。 */
const HALF: Rng = () => 0.5;

function makeCard(id: string, stability: Stability = 'review', due = 0, deckId = 'deck-a'): Card {
  const srs: SRSState = {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due,
    stability,
    effectiveReviewDays: [],
  };
  return { id, deckId, front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

function lib(n: number, deckId = 'deck-a'): Card[] {
  return Array.from({ length: n }, (_, i) => makeCard(`c${i}`, 'review', 0, deckId));
}

function session(cards: Card[], decks: Deck[] = [{ id: 'deck-a', name: '领域A', isPreset: true }]): SessionCards {
  return { decks, cards };
}

/** 类型守卫：把 startFight 返回值收窄到成功面（失败即测试当场炸穿）。 */
function ok(view: FightView | { error: string; message: string }): FightView {
  if ('state' in view) return view;
  throw new Error(`startFight 意外失败：${JSON.stringify(view)}`);
}

describe('startFight —— RF#3 空库/不足守卫（error 是值不是 throw）', () => {
  it('SF#1 空库 → { error:"no-cards", message 含"还没有卡片" }，不 throw', () => {
    let result: unknown;
    expect(() => {
      result = startFight(session([]), { size: 15, rng: HALF, nowMs: 0 });
    }).not.toThrow();
    expect(result).toMatchObject({ error: 'no-cards' });
    const err = result as { error: 'no-cards' | 'insufficient-cards'; message: string };
    expect(err.message).toContain('还没有卡片');
    // 功能文本口径（LORE §6 双轨制）：大白话、给下一步动作，不做叙事腔
    expect(err.message).toContain('做几张卡');
  });

  it('SF#2 全库非空但主题筛选命中 0 张 → insufficient-cards（不是 no-cards），message 报缺口', () => {
    const res = startFight(session(lib(5)), { size: 15, deckIds: ['deck-z'], rng: HALF, nowMs: 0 }) as {
      error: 'no-cards' | 'insufficient-cards';
      message: string;
    };
    expect(res.error).toBe('insufficient-cards');
    expect(res.message).toContain('还差 15 张');
  });

  it('SF#3 请求 15 实得 8 → 放行开战，enemyHp 按实际 8 反推（=56）、pool.length===8', () => {
    const view = ok(startFight(session(lib(8)), { size: 15, rng: HALF, nowMs: 0 }));
    expect(view.pool).toHaveLength(8);
    expect(view.state.enemyHp).toBe(56); // ceil(8 × BASE_CARD_DAMAGE(10) × encounter(0.7))
    expect(view.state.phase).toBe('answering');
    expect(view.current?.id).toBe(view.pool[0].id);
  });

  it('SF#4 池 id 序列与 pool 对象数组同序同 id（BattleState.pool 只存 id，视图持对象）', () => {
    const view = ok(startFight(session(lib(10)), { size: 10, rng: HALF, nowMs: 0 }));
    expect(view.state.pool).toEqual(view.pool.map((c) => c.id));
    expect(new Set(view.state.pool).size).toBe(10); // buildPool 的无重复 id 不变量贯穿到建战
  });

  it('SF#5 中间态注释义务兑现：本任务 vit/spi 恒 0、level 恒 1 ⇒ atk=12/maxHp=100', () => {
    const view = ok(startFight(session(lib(3)), { size: 3, rng: HALF, nowMs: 0 }));
    // deriveStats(1,0,0) → atk = 10 + 1*2 + floor(0/8) = 12；maxHp = 100 + (1-1)*10 = 100
    expect(view.state.atk).toBe(12);
    expect(view.state.playerHp).toBe(100);
    expect(view.state.maxPlayerHp).toBe(100);
  });

  it('SF#6 脏输入消毒：非法 size → invalid-size / 缺 cards → no-cards / rng 非函数不 throw', () => {
    // 来历：T3 授权改动（终审 triage「非法 size 文案分流」）——旧版把"请求参数坏"与
    // "库存为空"合并成 no-cards，让设置页脏值也误报"没卡片"。现按错误码分流，
    // 两类用户的下一步动作不同（改设置 vs 去做卡），文案随之分叉。
    const bad: unknown[] = [0, -3, 2.5, NaN, Infinity, undefined, 61];
    for (const size of bad) {
      const res = startFight(session(lib(20)), { size: size as number, rng: HALF, nowMs: 0 }) as {
        error: 'invalid-size' | 'no-cards' | 'insufficient-cards';
        message: string;
      };
      expect(res.error).toBe('invalid-size');
      expect(res.message).toContain('设置');
    }
    // cards 非数组：SessionCards.cards 声明为 Card[]，运行时脏存档仍不得抛
    const dirty = startFight({ decks: [], cards: null as unknown as Card[] }, { size: 15, rng: HALF, nowMs: 0 }) as {
      error: string;
    };
    expect(dirty.error).toBe('no-cards');
    // rng 非函数：buildPool 内部已回落 () => 0，startFight 不因 rng 形状而 throw
    const noRng = ok(startFight(session(lib(4)), { size: 4, rng: null as unknown as Rng, nowMs: 0 }));
    expect(noRng.pool).toHaveLength(4);
  });

  it('SF#6b size 合法域边界：1 与 60 放行（>60 归 invalid-size 但不动合法域）', () => {
    const one = ok(startFight(session(lib(20)), { size: 1, rng: HALF, nowMs: 0 }));
    expect(one.pool).toHaveLength(1);
    const sixty = ok(startFight(session(lib(80)), { size: 60, rng: HALF, nowMs: 0 }));
    expect(sixty.pool).toHaveLength(60);
  });

  it('SF#9 difficulty 管道：boss 档同时切 HP 与反击强度（T8 消费的前置接线）', () => {
    const cards = session(lib(20));
    const enc = ok(startFight(cards, { size: 15, rng: HALF, nowMs: 0 }));
    const boss = ok(startFight(cards, { size: 15, rng: HALF, nowMs: 0, difficulty: 'boss' }));
    // HP：encounter ceil(15×10×0.7)=105 vs boss ceil(15×10×1.5)=225
    expect(enc.state.enemyHp).toBe(105);
    expect(boss.state.enemyHp).toBe(225);
    // 反击强度：power 7 vs 11（POWER_FACTOR 封顶，R-T1-p4-b）
    expect(enc.state.enemyPower).toBe(7);
    expect(boss.state.enemyPower).toBe(11);
    // 缺省即 encounter：不传 difficulty 与显式传同值
    const dflt = ok(startFight(cards, { size: 15, rng: HALF, nowMs: 0, difficulty: undefined }));
    expect(dflt.state.enemyPower).toBe(7);
  });

  it('SF#7 确定性：同 seed 同库 → 同一卡池与同一初始 state', () => {
    const a = ok(startFight(session(lib(20)), { size: 15, rng: mulberry32(42), nowMs: 0 }));
    const b = ok(startFight(session(lib(20)), { size: 15, rng: mulberry32(42), nowMs: 0 }));
    expect(a.pool.map((c) => c.id)).toEqual(b.pool.map((c) => c.id));
    expect(a.state).toEqual(b.state);
  });

  it('SF#8 deckIds 限定后按可用数反推 HP（筛选 6 张 → enemyHp=42），且智能段优先收到期卡', () => {
    // deck-b 只有 6 张，全部到期（due=0 ≤ nowMs=0）；deck-a 有 20 张但未在 deckIds 内
    const cardsB = lib(6, 'deck-b');
    const cards = [...lib(20, 'deck-a'), ...cardsB];
    const view = ok(startFight(session(cards), { size: 15, deckIds: ['deck-b'], rng: HALF, nowMs: 0 }));
    expect(view.pool).toHaveLength(6);
    expect(view.state.enemyHp).toBe(42); // ceil(6 × 10 × 0.7)
    expect(view.pool.every((c) => c.deckId === 'deck-b')).toBe(true);
  });
});

describe('answerCurrent —— 依序推进与终局视图', () => {
  /** 8 张 review 卡、enemyHp=56、atk=12 ⇒ 每 good 伤 12，5 击致死（56−48=8, 8−12≤0）。 */
  function fight(size = 8): FightView {
    return ok(startFight(session(lib(size)), { size, rng: HALF, nowMs: 0 }));
  }

  it('AC#1 逐张作答：idx 与 current 同步前进，current 恒等于 pool[idx]', () => {
    let v = fight();
    expect(v.current?.id).toBe(v.pool[0].id);
    for (let i = 0; i < 4; i++) {
      v = answerCurrent(v, GRADES.good, { rng: HALF });
      expect(v.state.idx).toBe(i + 1);
      expect(v.current?.id).toBe(v.pool[i + 1].id); // 未终局时指向下一张
    }
    expect(v.state.enemyHp).toBe(56 - 4 * 12);
  });

  it('AC#2 won 时 current===null（idx 越出池尾，视图不给悬空卡）', () => {
    let v = fight();
    const msgs: string[] = [];
    for (let i = 0; i < 5 && v.state.phase === 'answering'; i++) {
      v = answerCurrent(v, GRADES.good, { rng: HALF, asserts: (m) => msgs.push(m) });
    }
    expect(v.state.phase).toBe('won');
    expect(v.current).toBeNull();
    expect(msgs).toEqual([]); // 走的是 API 正路，不该有任何 dev 断言
    expect(v.state.log[v.state.log.length - 1].kind).toBe('end');
  });

  it('AC#3 miss 档空转：零伤害、idx 仍 +1、current 前进', () => {
    let v = fight();
    v = answerCurrent(v, GRADES.again, { rng: HALF });
    expect(v.state.enemyHp).toBe(56);
    expect(v.state.idx).toBe(1);
    expect(v.state.log[0]).toEqual({ kind: 'miss', cardId: v.pool[0].id });
    expect(v.current?.id).toBe(v.pool[1].id);
  });

  it('AC#4 池尽敌存 → lost，current===null，视图幂等', () => {
    // 单卡池打 again：idx 到 1、enemyHp 尚存 → lost
    let v = fight(1);
    v = answerCurrent(v, GRADES.again, { rng: HALF });
    expect(v.state.phase).toBe('lost');
    expect(v.current).toBeNull();
    const before = v;
    const after = answerCurrent(v, GRADES.easy, { rng: HALF });
    expect(after).toBe(before); // 终局后再点不动（battle.answer 幂等 + current=null 短路）
  });

  it('AC#5 不可变：answerCurrent 返回新 view，旧 view 与其 state/log 不被改动', () => {
    const v0 = fight();
    const snapshot = JSON.parse(JSON.stringify(v0.state));
    const logRef = v0.state.log;
    const v1 = answerCurrent(v0, GRADES.good, { rng: HALF });
    expect(v1).not.toBe(v0);
    expect(v1.state).not.toBe(v0.state);
    expect(v0.state).toEqual(snapshot);
    expect(v0.state.log).toBe(logRef);
    expect(v0.state.log).toHaveLength(0);
    expect(v1.state.log).not.toBe(logRef);
    // pool 引用共享（同一批 Card 对象，纯编排不复制卡数据）
    expect(v1.pool).toBe(v0.pool);
  });

  it('AC#6 asserts 透传：正常路径零消息；asserts 缺省时不炸', () => {
    const msgs: string[] = [];
    const v = answerCurrent(fight(), GRADES.good, { rng: HALF, asserts: (m) => msgs.push(m) });
    expect(msgs).toEqual([]);
    expect(v.state.idx).toBe(1);
    expect(() => answerCurrent(fight(), GRADES.good, { rng: HALF })).not.toThrow();
  });

  it('AC#7 脏视图防御：pool[idx] 取不到卡 → 拒绝推进并断言 answer-card-mismatch', () => {
    const v = fight();
    const broken: FightView = { ...v, state: { ...v.state, idx: v.pool.length } };
    const msgs: string[] = [];
    const next = answerCurrent(broken, GRADES.good, { rng: HALF, asserts: (m) => msgs.push(m) });
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(next).toBe(broken);
    // 不带 asserts 时同样拒绝推进（静默），绝不把 undefined 喂进 battle.answer
    expect(answerCurrent(broken, GRADES.good, { rng: HALF })).toBe(broken);
  });

  it('AC#7b null 占位脏池防御：pool[idx] 为 null（持久化恢复的洞）→ 拒绝推进，不抛', () => {
    const v = fight();
    // 手工构造含 null 占位的池（模拟存档损坏/恢复出的洞）。
    // Card 类型不含 null，测试侧按既有消毒用例口径显式转型。
    const holedPool = [...v.pool];
    // 洞打在 idx=0（当前题卡位）：现状 `=== undefined` 漏防 null，null 会喂进
    // battle.answer 的 damage 路径 → card.srs TypeError（评审探针复现的正是这一发）。
    holedPool[0] = null as unknown as Card;
    const dirty: FightView = { ...v, pool: holedPool };
    const msgs: string[] = [];
    const next = answerCurrent(dirty, GRADES.good, { rng: HALF, asserts: (m) => msgs.push(m) });
    expect(msgs).toEqual(['answer-card-mismatch']);
    expect(next.state).toBe(v.state); // state 不变
    // 不带 asserts 同样静默拒进，且绝不把 null 喂进 battle.answer（现状此处泄漏 TypeError）
    let result!: FightView;
    expect(() => {
      result = answerCurrent(dirty, GRADES.good, { rng: HALF });
    }).not.toThrow();
    expect(result).toBe(dirty);
    expect(result.state).toBe(v.state);
    // 第二次作答（brief 语义面）：修复后 current 恒 null ⇒ 短路拒进；
    // 若 null 被喂进 battle.answer，这里会直接炸出 TypeError。
    const second = answerCurrent(result, GRADES.again, { rng: HALF });
    expect(second).toBe(dirty);
    expect(second.state).toBe(v.state);
  });
});
