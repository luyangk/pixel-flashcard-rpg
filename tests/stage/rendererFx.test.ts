/**
 * tests/stage/rendererFx.test.ts —— Plan 4 · T4 评审 Critical 的回归钉。
 *
 * 首版 renderer 从 `log[log.length-1]` 取"本回合事件"，而 core 的追加顺序保证末项
 * 恒为 retaliate/end ⇒ 怪物闪白永不出现、玩家红闪在整段阅题时间无限频闪，且
 * "闪白 4 次"的旧冒烟用的是 battle.answer 产生不了的夹具。
 *
 * 本文件用**真实 battle 状态**（createBattle/answer）钉三件事：
 *   ① 事件溯源正确：末项是 retaliate 时 turnAction 仍能取回本回合的 damage/miss；
 *   ② 反馈是脉冲：仅在注入的 elapsed ∈ [0, FLASH_WINDOW_MS) 内闪，之后自行消失；
 *   ③ 语义分档：miss 回合怪物不闪（D28 的可见语义），命中闪白、被反击闪红。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState } from '@core/types';
import { mulberry32 } from '@core/rng';
import { GRADES } from '@core/sm2';
import { createBattle, answer, type BattleState } from '@core/battle';
import { deriveStats } from '@core/stats';
import type { FightView } from '../../src/app/battleFlow';
import {
  advanceFx,
  drawFrame,
  fxFromAnchors,
  turnAction,
  turnRetaliated,
  FLASH_WINDOW_MS,
  FX_UNPRIMED,
  type StageSprites,
} from '../../src/stage/renderer';

function card(id: string): Card {
  const srs: SRSState = {
    ease: 2.5, interval: 10, reps: 3, lapses: 0, due: 0, stability: 'review', effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}

const POOL = [card('c0'), card('c1'), card('c2'), card('c3')];
const STATS = deriveStats(1, 0, 0); // L1：atk 12 / def 7 / maxHp 100

function viewOf(st: BattleState, difficulty: 'encounter' | 'boss' = 'encounter'): FightView {
  return { state: st, pool: POOL, current: null, difficulty };
}

/** 可数调用序列的记录式 stub ctx（不需要 DOM）。 */
function stubCtx() {
  const calls: string[] = [];
  const stack: Array<{ comp: string; alpha: number }> = [];
  const ctx = {
    imageSmoothingEnabled: true,
    globalAlpha: 1 as number,
    globalCompositeOperation: 'source-over' as string,
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => calls.push('clearRect'),
    fillRect: () => calls.push('fillRect'),
    drawImage: () => calls.push(`drawImage:${String(ctx.globalCompositeOperation)}`),
    beginPath: () => calls.push('beginPath'),
    ellipse: () => calls.push('ellipse'),
    fill: () => calls.push('fill'),
    // save/restore 必须真的存取上下文状态——否则闪白用的 'lighter' 会"泄漏"到
    // 之后的普通绘制，调用序列的计数就失去意义（首版桩曾因此误报 2 次加亮）。
    save: () => {
      stack.push({ comp: ctx.globalCompositeOperation, alpha: ctx.globalAlpha });
      calls.push('save');
    },
    restore: () => {
      const st = stack.pop();
      if (st) {
        ctx.globalCompositeOperation = st.comp;
        ctx.globalAlpha = st.alpha;
      }
      calls.push('restore');
    },
    fillText: () => calls.push('fillText'),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx };
}

const SPRITES: StageSprites = {
  hero: { width: 16, height: 24 },
  mob: { width: 16, height: 16 },
  boss: { width: 32, height: 32 },
  bg: { width: 320, height: 240 },
};

/** 打完一回合的真实状态。 */
function afterTurn(grade: number): BattleState {
  const rng = mulberry32(9);
  let st = createBattle(POOL, 999, STATS, rng, 7);
  st = answer(st, POOL[0], grade as never, rng);
  return st;
}

describe('T4 评审 Critical 回归 —— 事件溯源与脉冲式反馈', () => {
  it('RF#1 真实日志末项是 retaliate，但 turnAction 取回本回合的 damage（旧实现的死路径）', () => {
    const hit = afterTurn(GRADES.good);
    expect(hit.log[hit.log.length - 1]?.kind).toBe('retaliate'); // 末项恒非动作事件
    expect(turnAction(hit)).toBe('damage'); // ← 首版据此判闪白必为 false（永不闪）
    expect(turnRetaliated(hit)).toBe(true);
  });

  it('RF#2 miss 回合：turnAction 为 miss、怪物不闪（D28 可见语义）', () => {
    const miss = afterTurn(GRADES.again);
    expect(turnAction(miss)).toBe('miss');
    // 失手回合：即便给了 hero 脉冲，也不该有怪物的白闪叠加
    const { ctx, calls } = stubCtx();
    drawFrame(ctx, miss, viewOf(miss), SPRITES, 0, { heroHitElapsedMs: 0 });
    const lighter = calls.filter((c) => c === 'drawImage:lighter');
    expect(lighter).toHaveLength(1); // 只有侠客闪红，没有怪物闪白
  });

  it('RF#3 命中回合：怪物闪白 + 侠客闪红（各自脉冲在同一帧可见）', () => {
    const hit = afterTurn(GRADES.good);
    const { ctx, calls } = stubCtx();
    drawFrame(ctx, hit, viewOf(hit), SPRITES, 0, { mobHitElapsedMs: 0, heroHitElapsedMs: 0 });
    expect(calls.filter((c) => c === 'drawImage:lighter')).toHaveLength(2); // hero + mob 各一次
    expect(calls.filter((c) => c === 'drawImage:source-over').length).toBeGreaterThanOrEqual(3);
  });

  it('RF#4 脉冲会自行过期：elapsed ≥ FLASH_WINDOW_MS 后不再闪（首版无限频闪的修复钉）', () => {
    const hit = afterTurn(GRADES.good);
    for (const elapsed of [FLASH_WINDOW_MS, FLASH_WINDOW_MS + 1, 1000, 60_000]) {
      const { ctx, calls } = stubCtx();
      drawFrame(ctx, hit, viewOf(hit), SPRITES, elapsed, {
        mobHitElapsedMs: elapsed,
        heroHitElapsedMs: elapsed,
      });
      expect(calls.filter((c) => c === 'drawImage:lighter')).toHaveLength(0);
    }
  });

  it('RF#5 无 fx（battleStage 未观测到增量）时不闪：反馈不会凭"状态看起来如何"自行开火', () => {
    const hit = afterTurn(GRADES.good);
    const { ctx, calls } = stubCtx();
    drawFrame(ctx, hit, viewOf(hit), SPRITES, 0);
    expect(calls.filter((c) => c === 'drawImage:lighter')).toHaveLength(0);
  });

  it('RF#6 HP 数字画在血条内部（居中）：两条文案各自落在自己条的横向范围内，不叠字', () => {
    const hit = afterTurn(GRADES.good);
    const { ctx, raw, calls } = stubCtx();
    const texts: Array<{ text: string; x: number }> = [];
    (raw as unknown as { fillText: (t: string, x: number, y: number) => void }).fillText = (t, x) => {
      texts.push({ text: t, x });
      calls.push('fillText');
    };
    drawFrame(ctx, hit, viewOf(hit), SPRITES, 0);
    expect(texts).toHaveLength(2); // 玩家 + 敌人
    const [player, enemy] = texts;
    // 判别力版本（二轮评审指出旧断言对"旧叠字实现"同样通过）：
    // 玩家条 [8,148]、敌人条 [172,312]，label 中心必须各自落在自己条的区间内。
    expect(player.x).toBeGreaterThanOrEqual(8);
    expect(player.x).toBeLessThanOrEqual(148);
    expect(enemy.x).toBeGreaterThanOrEqual(172);
    expect(enemy.x).toBeLessThanOrEqual(312);
    expect(player.text).toContain('/');
    expect(enemy.text).toContain('/');
  });
});

describe('T4 二轮 —— advanceFx 锚点状态机（首帧对齐 / 增量 / 重置）', () => {
  it('AF#1 首帧对齐：在"日志非空"的 state 上挂载不为历史事件误闪（续战/重进场景）', () => {
    const hit = afterTurn(GRADES.good); // 已有 [damage, retaliate]
    const a1 = advanceFx(FX_UNPRIMED, hit.log, 1000);
    expect(a1.lastLogLen).toBe(hit.log.length);
    expect(a1.mobHitAt).toBeUndefined(); // ← 关键：历史伤害不打锚点
    expect(a1.heroHitAt).toBeUndefined();
    expect(fxFromAnchors(a1, 1000).mobHitElapsedMs).toBeUndefined();
  });

  it('AF#2 增量锚点：新追加 [damage, retaliate] 才开火，且 elapsed 从锚点起算', () => {
    const hit = afterTurn(GRADES.good);
    const base = advanceFx(FX_UNPRIMED, [], 0);
    const after = advanceFx(base, hit.log, 500);
    expect(after.mobHitAt).toBe(500);
    expect(after.heroHitAt).toBe(500);
    expect(fxFromAnchors(after, 520).mobHitElapsedMs).toBe(20);
  });

  it('AF#3 空增量保持锚点不变（同帧重复 frame 不刷新反馈）', () => {
    const hit = afterTurn(GRADES.good);
    const a = advanceFx(advanceFx(FX_UNPRIMED, [], 0), hit.log, 500);
    const again = advanceFx(a, hit.log, 700);
    expect(again).toBe(a); // 引用相等：无新日志即无状态变化
    expect(fxFromAnchors(again, 700).mobHitElapsedMs).toBe(200); // 已过期 ⇒ 不闪
  });

  it('AF#4 miss 回合只开 hero 锚点（怪物不闪的机器保证）', () => {
    const miss = afterTurn(GRADES.again);
    const a = advanceFx(advanceFx(FX_UNPRIMED, [], 0), miss.log, 100);
    expect(a.mobHitAt).toBeUndefined();
    expect(a.heroHitAt).toBe(100);
  });

  it('AF#5 日志重置（新一局）时只重新对齐、不误闪', () => {
    const hit = afterTurn(GRADES.good);
    const a = advanceFx(advanceFx(FX_UNPRIMED, [], 0), hit.log, 500);
    const reset = advanceFx(a, [], 900); // 新局开局：日志清空
    expect(reset.lastLogLen).toBe(0);
    const next = advanceFx(reset, hit.log, 1000);
    expect(next.mobHitAt).toBe(1000); // 清空后再出现的才是新事件
  });
});
