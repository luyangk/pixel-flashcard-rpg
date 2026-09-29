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
 * 亮两帧、灭两帧（FLASH_FRAME_MS 步进），窗口之外一律不亮。
 * miss 回合怪物**完全不动**：不闪、不抖（D28 的 miss 语义在画面上也得看得见）。
 */

import type { BattleEvent, BattleState } from '@core/battle';
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
  /**
   * 木人桩（Plan 7 · T3 / D46）：**可选**——旧素材集/测试 stub 不传就回落到 `mob`，
   * 因此这个字段的加入不会让任何既有夹具变红。drill 形态下敌人位画它。
   */
  readonly dummy?: StageImage;
  readonly bg: StageImage;
}

/** 闪白节拍步进（毫秒）：亮两帧、灭两帧的可数节拍。 */
const FLASH_FRAME_MS = 90;

/**
 * 受击反馈的**一次性窗口**（毫秒）：只在"该事件发生后的这段时间内"闪，
 * 之后自行消失。T4 首版把"日志末项"当作持续状态，导致玩家红闪在整段阅题
 * 时间内无限频闪（评审 Critical）——反馈必须是脉冲而非开关。
 */
export const FLASH_WINDOW_MS = 180;

/** 脚底基线（逻辑像素）：侠客与怪物的 y 对齐点，保证"站在地上"。 */
const GROUND_Y = 178;

/**
 * 角色缩放（终审 I-7）：**只允许整数倍**。
 *
 * PRD §7 明令"禁止非整数缩放导致的像素扭曲"。首版用目标高 76/60/88 去等比拉图，
 * 对 32×32 素材就是 2.375×、对 64×64 是 1.375×——像素被拉成不均匀的方块（虽然
 * 逻辑画布本身是整数倍放大到屏幕的，也救不回画内的失真）。现在改为按素材固有尺寸
 * 取整数倍：杂兵/侠客（32²）用 2×，卷灵（64²）用 2×。
 */
const HERO_SCALE = 2;
const MOB_SCALE = 2;
const BOSS_SCALE = 2;

/** 各角色的**右缘**（素材非方形时左缘随宽高比漂移，故以右缘定位）。 */
const HERO_RIGHT = 84;
const MOB_RIGHT = 236;
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

/**
 * 按**整数倍**摆放素材：w/h 恒为素材固有尺寸 × `scale`（不改宽高比、不插值），
 * 底边贴 GROUND_Y、右缘对齐给定 x。素材尺寸取不到（stub/未解码）时退回 1×1，仍不 NaN。
 */
function placeSprite(
  img: StageImage | undefined,
  scale: number,
  rightEdge: number,
  footY: number,
  dx = 0,
): { x: number; y: number; w: number; h: number } {
  const s = spriteSize(img);
  const k = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const h = Math.max(1, Math.round(s.h) * k);
  const w = Math.max(1, Math.round(s.w) * k);
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

/**
 * 背景平铺：以素材固有尺寸为步长铺满逻辑画布（1:1 绘制，绝不缩放）。
 * 素材尺寸取不到时退回"铺满一次"（与旧行为同形，避免测试 stub 下什么都不画）。
 */
function tileBackground(ctx: CanvasRenderingContext2D, img: StageImage | undefined): void {
  if (!img) return;
  const s = spriteSize(img);
  const tw = Math.max(1, Math.round(s.w));
  const th = Math.max(1, Math.round(s.h));
  if (tw >= LOGICAL_W || th >= LOGICAL_H) {
    blit(ctx, img, 0, 0, LOGICAL_W, LOGICAL_H); // 素材比画布还大：交回给一次 blit
    return;
  }
  for (let y = 0; y < LOGICAL_H; y += th) {
    for (let x = 0; x < LOGICAL_W; x += tw) {
      blit(ctx, img, x, y, tw, th);
    }
  }
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
  labelText?: string,
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
  // 数字画在血条**内部**居中（首版画在条外侧，两条在 320 宽度下必然叠字——评审 Important）。
  ctx.fillStyle = '#f2f2fa';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label =
    labelText ?? `${Math.max(0, Math.round(cur))}/${Math.max(0, Math.round(max))}`;
  ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
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

/** 帧号（tMs 驱动，输入是**脉冲内已过的毫秒**而非绝对时间）：闪白节拍由此得出。 */
function frameIndex(tMs: number): number {
  const t = typeof tMs === 'number' && Number.isFinite(tMs) && tMs > 0 ? tMs : 0;
  return Math.floor(t / FLASH_FRAME_MS);
}

/**
 * FX 锚点状态（纯数据，便于单测）：记录"上次观测到的日志长度"与两个事件的锚点时刻。
 * `lastLogLen === null` 表示**尚未对齐**——首帧只做对齐、不为历史事件打锚点，
 * 否则在日志非空的 state 上挂载画面（续战/重进）会让历史伤害误闪一次。
 */
export interface FxAnchors {
  readonly lastLogLen: number | null;
  readonly mobHitAt?: number;
  readonly heroHitAt?: number;
}

/** 未对齐的初始锚点。 */
export const FX_UNPRIMED: FxAnchors = { lastLogLen: null };

/**
 * 推进 FX 锚点：只对**新增日志**打时间锚点，并把锚点交给 FrameFx 换算 elapsed。
 * 纯函数（不读钟、不改入参）——battleStage 每帧调用它，测试可直接喂日志序列。
 */
export function advanceFx(prev: FxAnchors, log: readonly BattleEvent[], tMs: number): FxAnchors {
  const events = Array.isArray(log) ? log : [];
  if (prev.lastLogLen === null || events.length < prev.lastLogLen) {
    // 首帧对齐，或日志被重置（新一局）：只记录长度，不为既有历史闪。
    return { lastLogLen: events.length, mobHitAt: prev.mobHitAt, heroHitAt: prev.heroHitAt };
  }
  if (events.length === prev.lastLogLen) return prev;
  const appended = events.slice(prev.lastLogLen);
  return {
    lastLogLen: events.length,
    mobHitAt: appended.some((e) => e?.kind === 'damage') ? tMs : prev.mobHitAt,
    heroHitAt: appended.some((e) => e?.kind === 'retaliate') ? tMs : prev.heroHitAt,
  };
}

/** 由锚点换算本帧的 FrameFx（过期由 pulsing 负责）。 */
export function fxFromAnchors(a: FxAnchors, tMs: number): FrameFx {
  return {
    mobHitElapsedMs: a.mobHitAt === undefined ? undefined : tMs - a.mobHitAt,
    heroHitElapsedMs: a.heroHitAt === undefined ? undefined : tMs - a.heroHitAt,
  };
}

/** 帧内 FX 输入（由 battleStage 依"日志增量 + 注入时间轴"算好后传入；renderer 保持纯函数）。 */
export interface FrameFx {
  /** 距最近一次"命中怪物"的毫秒数；undefined/窗口外 = 不闪。 */
  readonly mobHitElapsedMs?: number;
  /** 距最近一次"被反击"的毫秒数；undefined/窗口外 = 不闪。 */
  readonly heroHitElapsedMs?: number;
}

/** 脉冲判定：落在 [0, FLASH_WINDOW_MS) 内才闪，且按帧节拍亮两帧灭两帧。 */
function pulsing(elapsed: number | undefined, tMs: number): boolean {
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return false;
  if (elapsed < 0 || elapsed >= FLASH_WINDOW_MS) return false;
  return frameIndex(elapsed) % 4 < 2;
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
  fx: FrameFx = {},
): void {
  if (!ctx) return;
  // 反馈来源是**注入的脉冲时长**（frameElapsed），不是"日志末项"这类持续状态——
  // 否则一击的反馈会一直挂着（首版 Critical）。tMs 仅用于节拍。
  const hitMob = pulsing(fx.mobHitElapsedMs, tMs);
  const hitHero = pulsing(fx.heroHitElapsedMs, tMs);
  // miss 回合：不闪、不抖——怪物一动不动是 D28 的可见语义。
  const mobShake = hitMob ? (frameIndex(fx.mobHitElapsedMs ?? 0) % 2 === 0 ? -1 : 1) : 0;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

  // 1) 背景**按素材原尺寸平铺**铺满逻辑画布（终审 I-7）：单次拉伸 64→320×240 是
  //    5×/3.75× 的非整数缩放（竖直方向会糊），而素材本身是按"可无缝平铺"做的
  //    （见 assets/README.md 与素材契约的接缝用例）。平铺既是 1:1 绘制，也终于让
  //    文档里那句话成为事实。右/下边多出的部分被画布自然裁掉。
  tileBackground(ctx, sprites?.bg);

  // 2) 侠客（玩家）——闪红表示被反击。
  const hero = placeSprite(sprites?.hero, HERO_SCALE, HERO_RIGHT, GROUND_Y);
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

  // 3) 敌人（boss 档换图、换尺寸；**drill 换木人桩**）+ 受击反馈。
  const isBoss = view?.difficulty === 'boss';
  const isDrill = st?.mode === 'drill';
  const mobImg = isDrill ? sprites?.dummy ?? sprites?.mob : isBoss ? sprites?.boss : sprites?.mob;
  const mob = placeSprite(mobImg, isBoss ? BOSS_SCALE : MOB_SCALE, isBoss ? BOSS_RIGHT : MOB_RIGHT, GROUND_Y, mobShake);
  drawShadow(ctx, mob.x + mob.w / 2, GROUND_Y, mob.w);
  blit(ctx, mobImg, mob.x, mob.y, mob.w, mob.h);
  // 白闪 = "受伤"的语义。木桩是**练功对象**，打中了要有反馈（上面的晃），但不该读成受伤
  // ——所以 drill 下不给白闪，只保留晃动。
  if (hitMob && !isDrill) {
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
    // drill 的耐久条恒满（敌血在引擎层就锁住了，这里只是把语义写在屏上）
    isDrill ? 1 : ratio(eHp, eMax),
    eHp,
    eMax,
    // 木桩用木色，与"敌人血条"在颜色上区分开
    isDrill ? '#c8a165' : '#e0554f',
    'right',
    isDrill ? '耐久 ∞' : undefined,
  );
}
