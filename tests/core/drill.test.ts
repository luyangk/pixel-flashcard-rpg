/**
 * tests/core/drill.test.ts —— Plan 7 · T1：木桩练功（新的战斗形态）。
 *
 * 这一组守的是"练功不判胜负"在**引擎层**就成立（而不是靠上层特判糊）：
 * 判别力（每条都写清"坏实现为何必红"）：
 * - DR#2 drill 下敌血**不降**（照抄 fight 扣血 ⇒ 打完池子会变成 lost ⇒ 误触发败局演出）；
 * - DR#3 drill 下**没有反击**（保留反击 ⇒ 玩家可能被木桩打死，与"练功不会输"矛盾）；
 * - DR#4 池尽 ⇒ `cleared`（沿用 fight 的 lost 判定 ⇒ BS 那套"没判成"链路全歪）；
 * - DR#6 缺省 mode ⇒ `'fight'`（既有 900+ 用例与既有调用方一字不改）。
 */
import { describe, expect, it } from 'vitest';
import { createBattle, answer as answerCard, type BattleState } from '../../src/core/battle';
import { GRADES } from '../../src/core/sm2';
import { mulberry32 } from '../../src/core/rng';
import type { Card, SRSState } from '../../src/core/types';

function card(id: string, stability: SRSState['stability'] = 'review'): Card {
  return {
    id,
    deckId: 'd1',
    front: `q-${id}`,
    back: `a-${id}`,
    tags: [],
    srs: { ease: 2.5, interval: 10, reps: 3, lapses: 0, due: 0, stability, effectiveReviewDays: [] },
  };
}
const STATS = { level: 1, vit: 10, spi: 0, atk: 12, def: 3, maxHp: 30 };

function drill(pool: Card[], enemyHp = 70): BattleState {
  return createBattle(pool, enemyHp, STATS, mulberry32(7), 7, 'drill');
}
function fight(pool: Card[], enemyHp = 70): BattleState {
  return createBattle(pool, enemyHp, STATS, mulberry32(7), 7);
}

describe('createBattle —— drill 形态（Plan 7 · T1）', () => {
  it('DR#1 drill 建战：mode=drill，初始态与 fight 同形（answering / idx 0 / 满血）', () => {
    const st = drill([card('c1'), card('c2')]);
    expect(st.mode).toBe('drill');
    expect(st.phase).toBe('answering');
    expect(st.idx).toBe(0);
    expect(st.enemyHp).toBe(70);
    expect(st.playerHp).toBe(STATS.maxHp);
  });

  it('DR#2 drill 答对 ⇒ 有伤害事件（要飘字）但**敌血不变**', () => {
    const pool = [card('c1'), card('c2')];
    const st = drill(pool);
    const next = answerCard(st, pool[0], GRADES.good, mulberry32(1));
    const dmg = next.log.find((e) => e.kind === 'damage');
    expect(dmg).toBeDefined();
    expect(dmg?.amount ?? 0).toBeGreaterThan(0); // 反馈仍在
    expect(next.enemyHp).toBe(70); // ← 锁血
  });

  it('DR#3 drill 答错 ⇒ 只有 miss，**没有反击事件**且气血不掉', () => {
    const pool = [card('c1'), card('c2')];
    const next = answerCard(drill(pool), pool[0], GRADES.again, mulberry32(2));
    expect(next.log.some((e) => e.kind === 'miss')).toBe(true);
    expect(next.log.some((e) => e.kind === 'retaliate')).toBe(false);
    expect(next.playerHp).toBe(STATS.maxHp);
  });

  it('DR#4 打完池子 ⇒ phase=cleared（且带 end 事件），绝不是 won/lost', () => {
    const pool = [card('c1'), card('c2')];
    let st = drill(pool);
    st = answerCard(st, pool[0], GRADES.again, mulberry32(3));
    expect(st.phase).toBe('answering');
    st = answerCard(st, pool[1], GRADES.again, mulberry32(4));
    expect(st.phase).toBe('cleared');
    expect(st.log.at(-1)?.kind).toBe('end');
  });

  it('DR#5 drill 全程全错也不会输：25 张打完仍是 cleared、气血满', () => {
    const pool = Array.from({ length: 25 }, (_, i) => card(`c${i}`));
    let st = drill(pool);
    // 用固定的 rng 序列推进，确保每次都是"这一张"的作答
    for (let i = 0; i < pool.length; i += 1) {
      st = answerCard(st, pool[i], GRADES.again, mulberry32(100 + i));
    }
    expect(st.phase).toBe('cleared');
    expect(st.playerHp).toBe(STATS.maxHp);
    expect(st.enemyHp).toBe(70);
  });

  it('DR#6 缺省 mode ⇒ fight（既有调用方与既有用例一字不改）', () => {
    const pool = [card('c1')];
    const st = fight(pool, 10);
    expect(st.mode).toBe('fight');
    const next = answerCard(st, pool[0], GRADES.good, mulberry32(5));
    expect(next.enemyHp).toBeLessThan(10); // fight 照常扣血
  });

  it('DR#7 fight 的败局判定不受影响：池尽而敌人尚存 ⇒ lost（回归钉）', () => {
    const pool = [card('c1')];
    const next = answerCard(fight(pool, 999), pool[0], GRADES.again, mulberry32(6));
    expect(next.phase).toBe('lost');
  });

  it('DR#8 cleared 之后再来一次 ⇒ 幂等返回同一引用（终局不可再推进）', () => {
    const pool = [card('c1')];
    const done = answerCard(drill(pool), pool[0], GRADES.good, mulberry32(9));
    expect(done.phase).toBe('cleared');
    expect(answerCard(done, pool[0], GRADES.good, mulberry32(9))).toBe(done);
  });
});
