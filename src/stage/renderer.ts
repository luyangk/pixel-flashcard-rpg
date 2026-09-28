/**
 * 战斗舞台渲染器（Plan 4 · T4）—— 一次 drawFrame = 一帧，纯绘制、零 IO、**不读钟**。
 *
 * 三条纪律：
 * 1. **时间只走参数**：闪烁/抖动全部由 tMs 决定（rAF 时间戳由调用方传进来）。
 *    本文件不得读取系统时钟（T10 会把 stage/ui 目录机器化扫描一遍）。
 * 2. **不硬绑 HTMLImageElement**：StageSprites 收 StageImage（CanvasImageSource 或
 *    只带 width/height 的 stub），T6/T10 冒烟直接塞假对象，不需要 happy-dom 解码图片。
 * 3. **像素风**：imageSmoothingEnabled=false（在 mountBattleStage 里设一次，这里每帧
 *    兜底重设），整数缩放由 layout.ts 负责，本文件只按 320×240 逻辑坐标画。
 *
 * 绘制顺序：clear → 背景 → 侠客 → 怪物 → 受击闪白 → 两条血条 + HP 数字。
 * 闪白 = 同帧用 globalCompositeOperation 再叠一次素材（'lighter' 加亮到近白），
 * 亮两帧、灭两帧（FLASH_FRAME_MS 步进），所以"连续两帧闪白"是可数出来的。
 * miss 回合怪物**完全不动**：不闪、不抖（D28 的 miss 语义在画面上也得看得见）。
 */

import type { BattleState } from '@core/battle';
import { enemyHpForPool } from '@core/stats';
import type { FightView } from '../app/battleFlow';
import { LOGICAL_H, LOGICAL_W } from './layout';

/**
 * 可绘制素材的最小形状。真的 CanvasImageSource（HTMLImageElement /
 * HTMLCanvasElement / ImageBitmap…）与测试 stub `{width,height}` 都满足它。
 */
export type StageImage = CanvasImageSource | { readonly width: number; readonly height: number };

/** 舞台素材四件套；bg 铺满，其余按脚底基线摆位。 */
export interface StageSprites {
  readonly hero: StageImage;
  readonly mob: StageImage;
  readonly boss: StageImage;
  readonly bg: StageImage;
}

/** 敌方受击闪白的一档时长（毫秒）：亮两帧 = 180ms，视觉上是一次干脆的白闪。 */
const FLASH_FRAME_MS = 90;

/** 脚底基线（逻辑像素）：侠客与怪物的 y 对齐点，保证"站在地上"。 */
const GROUND_Y = 178;

/** 侠客目标高与左缘；boss 比杂兵大一圈（T3 的 difficulty 决定用哪张图）。 */
const HERO_X = 44;
const HERO_H = 76;
const MOB_H = 60;
const MOB_RIGHT = 236;
const BOSS_H = 88;
const BOSS_RIGHT = 240;

/** 顶部血条几何：玩家在左、敌人在右，各占一半减边距。 */
const BAR_Y = 10;
const BAR_H = 9;
const BAR_MARGIN = 8;
const BAR_W = 140;

/** 让 stub 素材也能安全取尺寸：优先固有尺寸，退化到 1×1 而不是 NaN。 */
function spriteSize(img: StageImage | undefined): { w: number; h: number } {
  const o = img as
    | {
        naturalWidth?: unknown;
        naturalHeight?: unknown;
        width?: unknown;
        height?: unknown;
      }
    | undefined;
  const pick = (...cands: unknown[]): number => {
    for (const c of cands) {
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
    }
    return 0;
  };
  const w = pick(o?.naturalWidth, o?.width);
  const h = pick(o?.naturalHeight, o?.height);
  return { w: Math.max(1, Math.round(w || 1)), h: Math.max(1, Math.round(h || 1)) };
}

/** 按目标高摆放素材：等比出宽（像素取整），底边贴 GROUND_Y。 */
function placeSprite(
  img: StageImage | undefined,
  targetH: number,
  rightEdge: number,
  footY: number,
  dx = 0,
): { x: number; y: number; w: number; h: number } {
  const s = spriteSize(img);
  const h = Math.max(1, Math.round(targetH));
  const w = Math.max(1, Math.round((h * s.w) / s.h));
  const y = Math.round(footY - h);
  const x = Math.round(rightEdge - w + dx);
  return { x, y, w, h };
}

/** drawImage 的类型桥：结构型 stub 在运行期就是图像源，TS 面收窄掉。 */
function blit(
  ctx: CanvasRenderingContext2D,
  img: StageImage | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!img) return;
  ctx.drawImage(img as CanvasImageSource, x, y, w, h);
}

/** 环境光遮蔽式的地面阴影：让角色"踩"在背景上，不额外吃素材。 */
function drawShadow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  footY: number,
  w: number,
): void {
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(cx, footY - 1, Math.max(4, w / 2), 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 归一化血条比例：脏值（NaN/负/超上限）一律收进 [0,1]，血条永不画到框外。 */
function ratio(cur: number, max: number): number {
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, cur / max));
}

/** 一条血条：外框 + 底色 + 前景 + 右侧 ASCII 数字。 */
function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  cur: number,
  max: number,
  color: string,
  align: 'left' | 'right',
): void {
  ctx.fillStyle = '#101018';
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = '#3a3a4a';
  ctx.fillRect(x, y, w, h);
  const fillW = Math.round(w * frac);
  if (fillW > 0) {
    ctx.fillStyle = color;
    if (align === 'left') ctx.fillRect(x, y, fillW, h);
    else ctx.fillRect(x + w - fillW, y, fillW, h);
  }
  ctx.fillStyle = '#e8e8f0';
  ctx.font = '8px monospace';
  ctx.textAlign = align === 'left' ? 'left' : 'right';
  ctx.textBaseline = 'top';
  const label = `${Math.max(0, Math.round(cur))}/${Math.max(0, Math.round(max))}`;
  ctx.fillText(label, align === 'left' ? x + w + 4 : x - 4, y - 3);
}

/** 敌人满血上限：BattleState 只存当前值，上限由池长 + 难度档反推（与 T3 同源）。 */
function enemyMaxHp(view: FightView): number {
  const poolSize = Array.isArray(view?.pool) ? view.pool.length : 0;
  const difficulty = view?.difficulty === 'boss' ? 'boss' : 'encounter';
  try {
    return enemyHpForPool(poolSize, difficulty);
  } catch {
    // 空池 / 脏值：退化成"当前即上限"，血条画满而不是画 NaN。
    return Math.max(1, view?.state?.enemyHp ?? 1);
  }
}

/** 帧号（tMs 驱动）：闪白的"亮两帧/灭两帧"节拍由此得出。 */
function frameIndex(tMs: number): number {
  const t = typeof tMs === 'number' && Number.isFinite(tMs) && tMs > 0 ? tMs : 0;
  return Math.floor(t / FLASH_FRAME_MS);
}

/** 最近一条战斗事件；空日志返回 null。 */
function lastEvent(st: BattleState): BattleState['log'][number] | null {
  const log = st?.log;
  if (!Array.isArray(log) || log.length === 0) return null;
  return log[log.length - 1] ?? null;
}

/**
 * 画一帧。ctx 必须已经绑定 320×240 逻辑画布（mountBattleStage 负责）。
 *
 * @param st      战斗权威状态（HP / 日志 / 阶段）
 * @param view    战斗视图（池、难度；敌人上限由它反推）
 * @param sprites 四张素材
 * @param tMs     调用方注入的时间戳（毫秒）；本函数不读任何时钟
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  st: BattleState,
  view: FightView,
  sprites: StageSprites,
  tMs: number,
): void {
  if (!ctx) return;
  const ev = lastEvent(st);
  const flash = frameIndex(tMs) % 4 < 2;
  const hitMob = ev?.kind === 'damage' && flash;
  const hitHero = ev?.kind === 'retaliate' && flash;
  // miss 回合：不闪、不抖——怪物一动不动是 D28 的可见语义。
  const mobShake = hitMob ? (frameIndex(tMs) % 2 === 0 ? -1 : 1) : 0;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

  // 1) 背景铺满逻辑画布。
  blit(ctx, sprites?.bg, 0, 0, LOGICAL_W, LOGICAL_H);

  // 2) 侠客（玩家）——闪红表示被反击。
  const hero = placeSprite(sprites?.hero, HERO_H, HERO_X + 40, GROUND_Y);
  drawShadow(ctx, hero.x + hero.w / 2, GROUND_Y, hero.w);
  blit(ctx, sprites?.hero, hero.x, hero.y, hero.w, hero.h);
  if (hitHero) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#ff4040';
    ctx.fillRect(hero.x, hero.y, hero.w, hero.h);
    blit(ctx, sprites?.hero, hero.x, hero.y, hero.w, hero.h);
    ctx.restore();
  }

  // 3) 怪物（boss 档换图、换尺寸）+ 受击闪白。
  const isBoss = view?.difficulty === 'boss';
  const mobImg = isBoss ? sprites?.boss : sprites?.mob;
  const mob = placeSprite(mobImg, isBoss ? BOSS_H : MOB_H, isBoss ? BOSS_RIGHT : MOB_RIGHT, GROUND_Y, mobShake);
  drawShadow(ctx, mob.x + mob.w / 2, GROUND_Y, mob.w);
  blit(ctx, mobImg, mob.x, mob.y, mob.w, mob.h);
  if (hitMob) {
    // 连续两帧的加亮叠加 = 白闪；不改素材本身，也不用离屏画布。
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.65;
    blit(ctx, mobImg, mob.x, mob.y, mob.w, mob.h);
    ctx.restore();
  }

  // 4) 两条血条 + HP 数字（玩家气血在 D28 后真的会掉，所以两条都必须画）。
  const playerHp = st?.playerHp ?? 0;
  const playerMax = st?.maxPlayerHp ?? 0;
  const eHp = st?.enemyHp ?? 0;
  const eMax = enemyMaxHp(view);
  drawBar(
    ctx,
    BAR_MARGIN,
    BAR_Y,
    BAR_W,
    BAR_H,
    ratio(playerHp, playerMax),
    playerHp,
    playerMax,
    '#4fd06a',
    'left',
  );
  drawBar(
    ctx,
    LOGICAL_W - BAR_MARGIN - BAR_W,
    BAR_Y,
    BAR_W,
    BAR_H,
    ratio(eHp, eMax),
    eHp,
    eMax,
    '#e0554f',
    'right',
  );
}
