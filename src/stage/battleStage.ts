/**
 * 舞台挂载（Plan 4 · T4）—— 管 canvas 元素 / 整数缩放 / 居中，管绘制的是 renderer。
 *
 * 职责切分刻意的：
 * - 逻辑坐标系恒 320×240（canvas.width/height 永不随视口变），所以每帧都画在整数像素上；
 * - CSS 尺寸 = 逻辑 × **整数** scale，并居中（letterbox 的 x/y）——RF#2「永不非整数缩放」
 *   的唯一落地点；onResize 只是重算这两个量，不做任何重排魔法；
 * - 不读钟、不注册 rAF、不自己监听 window.resize：时间戳与 resize 都由调用方注入
 *   （T6/T8 负责 rAF 循环与旋转/软键盘事件），本模块因此在测试里可完全脱离浏览器。
 */

import type { BattleState } from '@core/battle';
import type { FightView } from '../app/battleFlow';
import { LOGICAL_H, LOGICAL_W, fitScale, letterbox } from './layout';
import { drawFrame, type StageSprites } from './renderer';

/** 挂载依赖：素材必填，其余可选（doc 仅供非浏览器环境注入）。 */
export interface BattleStageDeps {
  readonly sprites: StageSprites;
  /** 缩放倍数上限，缺省 4（layout.fitScale 的默认）。 */
  readonly maxInt?: number;
  /** 文档对象覆盖位：缺省取 host.ownerDocument，再退到全局 document。 */
  readonly doc?: Document;
}

/** 挂载句柄：三个方法就是全部对外面（T6/T8 只依赖它们）。 */
export interface BattleStage {
  /** 画一帧；tMs 由调用方（rAF 时间戳）注入，stage 内部不读钟。 */
  frame(st: BattleState, view: FightView, tMs: number): void;
  /** 视口尺寸变化：重算整数倍 + 居中；destroy 后为 no-op。 */
  onResize(viewW: number, viewH: number): void;
  /** 拆掉 canvas；幂等，可重复调用。 */
  destroy(): void;
}

/** 样式写入的安全通道：真 CSSStyleDeclaration 与 stub style 都能吃下。 */
function setStyle(el: unknown, prop: string, value: string): void {
  const style = (el as { style?: Record<string, unknown> } | undefined)?.style;
  if (!style) return;
  const withSetter = style as { setProperty?: (p: string, v: string) => void };
  if (typeof withSetter.setProperty === 'function') withSetter.setProperty(prop, value);
  else style[prop] = value;
}

/** 量视口：clientWidth/Height 优先（布局值），退化到 rect，再退化到 0（→ scale 1）。 */
function measure(host: HTMLElement): { w: number; h: number } {
  const cw = typeof host.clientWidth === 'number' ? host.clientWidth : 0;
  const ch = typeof host.clientHeight === 'number' ? host.clientHeight : 0;
  if (cw > 0 && ch > 0) return { w: cw, h: ch };
  const rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
  const rw = rect && Number.isFinite(rect.width) ? rect.width : 0;
  const rh = rect && Number.isFinite(rect.height) ? rect.height : 0;
  return { w: rw, h: rh };
}

/**
 * 在 host 里挂一个 320×240 逻辑分辨率的战斗舞台。
 *
 * 返回的 onResize(viewW, viewH) 由调用方在视口变化时调用（旋转、软键盘收放），
 * 内部只会产生整数 scale（fitScale 已保证），因此不存在"非整数缩放"的第二条路径。
 */
export function mountBattleStage(host: HTMLElement, deps: BattleStageDeps): BattleStage {
  const doc =
    deps?.doc ??
    host?.ownerDocument ??
    (typeof document !== 'undefined' ? document : null) ??
    null;
  if (!host || !doc) throw new Error('mount-battle-stage: host/document required');

  const canvas = doc.createElement('canvas');
  // 逻辑分辨率恒定：这是"像素对齐"的前提，绝不能写成 CSS 尺寸。
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  setStyle(canvas, 'position', 'absolute');
  setStyle(canvas, 'left', '0px');
  setStyle(canvas, 'top', '0px');
  setStyle(canvas, 'display', 'block');
  // CSS 面也声明像素化：缩放交给整数倍 + 浏览器 nearest-neighbour。
  setStyle(canvas, 'image-rendering', 'pixelated');
  // 居中偏移以 host 为基准。
  setStyle(host, 'position', 'relative');
  host.appendChild(canvas);

  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (ctx) ctx.imageSmoothingEnabled = false;

  const maxInt = deps?.maxInt;
  let destroyed = false;

  function applyScale(viewW: number, viewH: number): void {
    const scale = fitScale(viewW, viewH, maxInt);
    const box = letterbox(viewW, viewH, scale);
    setStyle(canvas, 'width', `${box.w}px`);
    setStyle(canvas, 'height', `${box.h}px`);
    setStyle(canvas, 'left', `${box.x}px`);
    setStyle(canvas, 'top', `${box.y}px`);
    // resize 后上下文状态可能被重置，兜底再关一次平滑。
    if (ctx) ctx.imageSmoothingEnabled = false;
  }

  // 首帧前先摆好位置（host 尺寸未就绪时 fitScale 给 1，不抛不糊）。
  const initial = measure(host);
  applyScale(initial.w, initial.h);

  return {
    frame(st: BattleState, view: FightView, tMs: number): void {
      if (destroyed || !ctx) return;
      drawFrame(ctx, st, view, deps.sprites, tMs);
    },
    onResize(viewW: number, viewH: number): void {
      if (destroyed) return;
      applyScale(viewW, viewH);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      const parent = canvas.parentNode;
      if (parent && typeof parent.removeChild === 'function') parent.removeChild(canvas);
    },
  };
}
