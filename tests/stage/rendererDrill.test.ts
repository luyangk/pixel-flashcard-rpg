/**
 * tests/stage/rendererDrill.test.ts —— Plan 7 · T3：木人桩与耐久条。
 *
 * 判别力：
 * - DD#1 drill 时敌人位画 **dummy**（照旧画 mob 的实现 ⇒ 屏上还是一只怪物在挨打）；
 * - DD#2 缺 dummy ⇒ 回落 mob 且不抛（旧素材集/测试 stub 都能跑）；
 * - DD#3 drill 命中**不闪白**（白闪读作"受伤"，而木桩是练功对象）；但**会晃**（打中了要有反馈）；
 * - DD#4 drill 的耐久条恒满且标签是「耐久 ∞」（照画 `70/70` 会让人以为木桩在掉血）；
 * - DD#5 fight 分支逐字不变（对照组：mob 图 + 闪白 + 数字标签）。
 */
import { describe, expect, it } from 'vitest';
import type { Card, SRSState } from '@core/types';
import type { BattleState } from '@core/battle';
import { answer, createBattle } from '@core/battle';
import { GRADES } from '@core/sm2';
import { deriveStats } from '@core/stats';
import { mulberry32 } from '@core/rng';
import { advanceFx, drawFrame, FX_UNPRIMED, type StageSprites } from '../../src/stage/renderer';
import type { FightView } from '../../src/app/battleFlow';

function card(id: string): Card {
  const srs: SRSState = {
    ease: 2.5, interval: 10, reps: 3, lapses: 0, due: 0, stability: 'review', effectiveReviewDays: [],
  };
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs, tags: [] };
}
const POOL = [card('c0'), card('c1')];
const STATS = deriveStats(1, 0, 0);

/** 记录 (图, x, y) 与文本的 stub ctx。 */
function stubCtx() {
  const draws: Array<{ img: unknown; x: number; y: number; comp: string }> = [];
  const texts: string[] = [];
  let comp = 'source-over';
  const stack: string[] = [];
  const ctx = {
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    get globalCompositeOperation() {
      return comp;
    },
    set globalCompositeOperation(v: string) {
      comp = v;
    },
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => undefined,
    fillRect: () => undefined,
    drawImage: (img: unknown, x: number, y: number) => draws.push({ img, x, y, comp }),
    beginPath: () => undefined,
    ellipse: () => undefined,
    fill: () => undefined,
    save: () => void stack.push(comp),
    restore: () => void (comp = stack.pop() ?? 'source-over'),
    fillText: (t: string) => texts.push(t),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws, texts };
}

const DUMMY = { width: 32, height: 32 };
const SPRITES: StageSprites = {
  hero: { width: 16, height: 24 },
  mob: { width: 16, height: 16 },
  boss: { width: 32, height: 32 },
  bg: { width: 320, height: 240 },
};
const SPRITES_WITH_DUMMY: StageSprites = { ...SPRITES, dummy: DUMMY };

function stateOf(mode: 'fight' | 'drill', grade: number): BattleState {
  const rng = mulberry32(9);
  let st = createBattle(POOL, 999, STATS, rng, 7, mode);
  // 签名是 (state, card, grade, rng) —— 首版把 card 漏了，rng 落进 grade 位（测试当场报
  // "rng is not a function"，比在产物里才发现好得多）
  st = answer(st, POOL[0], grade as never, rng);
  return st;
}

function viewOf(st: BattleState): FightView {
  return { state: st, pool: POOL, current: null, difficulty: 'encounter' };
}

/** 打到"命中一次"之后，再用 advanceFx 拿到脉冲锚点 → 画一帧（与生产路径同源）。 */
function frameWithHit(mode: 'fight' | 'drill', sprites: StageSprites, tMs = 500) {
  const st = stateOf(mode, GRADES.good);
  const primed = advanceFx(FX_UNPRIMED, [], 0);
  const fx = advanceFx(primed, st.log, tMs);
  const { ctx, draws, texts } = stubCtx();
  drawFrame(ctx, st, viewOf(st), sprites, tMs, {
    mobHitElapsedMs: fx.mobHitAt === undefined ? undefined : tMs - fx.mobHitAt,
    heroHitElapsedMs: fx.heroHitAt === undefined ? undefined : tMs - fx.heroHitAt,
  });
  return { st, draws, texts };
}

describe('drawFrame —— 木人桩形态（Plan 7 · T3）', () => {
  it('DD#1 drill 时敌人位画 dummy；fight 时画 mob（同一套代码，只换图）', () => {
    const drill = frameWithHit('drill', SPRITES_WITH_DUMMY);
    const dummyDraws = drill.draws.filter((d) => d.img === DUMMY);
    // dummy 只画一次（受击闪白在 drill 下不该有；见 DD#3）
    expect(dummyDraws).toHaveLength(1);

    const fight = frameWithHit('fight', SPRITES_WITH_DUMMY);
    expect(fight.draws.some((d) => d.img === DUMMY)).toBe(false);
    expect(fight.draws.some((d) => d.img === SPRITES.mob)).toBe(true);
  });

  it('DD#2 缺 dummy 精灵 ⇒ 回落 mob，且不抛（旧素材集也能跑）', () => {
    expect(() => frameWithHit('drill', SPRITES)).not.toThrow();
    const { draws } = frameWithHit('drill', SPRITES);
    expect(draws.some((d) => d.img === SPRITES.mob)).toBe(true);
  });

  it('DD#3 drill 命中不闪白（无 lighter 叠加），但会晃（受击有反馈）', () => {
    const drill = frameWithHit('drill', SPRITES_WITH_DUMMY);
    expect(drill.draws.filter((d) => d.comp === 'lighter')).toHaveLength(0);
    // 晃：命中帧的木桩 x 与"未命中帧"不同（同一 tMs 下不给脉冲）
    const { ctx, draws: still } = stubCtx();
    const st = stateOf('drill', GRADES.good);
    drawFrame(ctx, st, viewOf(st), SPRITES_WITH_DUMMY, 500, {});
    const dummyStill = still.find((d) => d.img === DUMMY);
    const dummyHit = drill.draws.find((d) => d.img === DUMMY);
    expect(dummyStill).toBeDefined();
    expect(dummyHit?.x).not.toBe(dummyStill?.x);

    // 对照组：fight 命中帧确实闪白（说明"不闪"是 drill 专属而不是把闪白整个弄坏了）
    const fight = frameWithHit('fight', SPRITES_WITH_DUMMY);
    expect(fight.draws.some((d) => d.comp === 'lighter')).toBe(true);
  });

  it('DD#4 drill 耐久条恒满且标签是「耐久 ∞」；fight 仍画数字', () => {
    const drill = frameWithHit('drill', SPRITES_WITH_DUMMY);
    expect(drill.texts).toContain('耐久 ∞');
    expect(drill.texts.some((t) => /^\d+\/\d+$/.test(t))).toBe(true); // 玩家那条仍是数字

    const fight = frameWithHit('fight', SPRITES_WITH_DUMMY);
    expect(fight.texts).not.toContain('耐久 ∞');
    expect(fight.texts.filter((t) => /^\d+\/\d+$/.test(t)).length).toBe(2); // 两条都数字
  });

  it('DD#5 drill 打完全程（cleared）后耐久条仍是满的、标签不变', () => {
    const rng = mulberry32(3);
    let st = createBattle(POOL, 999, STATS, rng, 7, 'drill');
    st = answer(st, POOL[0], GRADES.good, rng);
    st = answer(st, POOL[1], GRADES.good, rng);
    expect(st.phase).toBe('cleared');
    const { ctx, texts } = stubCtx();
    drawFrame(ctx, st, viewOf(st), SPRITES_WITH_DUMMY, 100, {});
    expect(texts).toContain('耐久 ∞');
  });
});
