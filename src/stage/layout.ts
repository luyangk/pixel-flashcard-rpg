/**
 * 战斗舞台几何（Plan 4 · T4）—— 纯函数，零 DOM、零时钟。
 *
 * 为什么单独一个文件：手机竖屏下 canvas 只有整数倍缩放才不糊；而"多少倍"和"摆在哪"
 * 是纯算术，跟 Canvas API 无关。把它抽出来单独强测，就锁住了 RF#2「永不非整数缩放」
 * 这条最容易在 resize 路径上回退的规则（T5/T8 的 resize 用例只消费这里的输出）。
 *
 * 口径：
 * - 逻辑分辨率恒 320×240（像素风基准），canvas.width/height 用它，CSS 尺寸 = 逻辑×scale。
 * - fitScale 取 min(视口宽比, 视口高比) 后 **floor**，再钳进 [1, maxInt]：
 *   缩放倍数因此恒为整数且 ≥1 —— 宁可裁一点/留黑边，也不给浏览器非整数采样去糊。
 * - letterbox 只做居中偏移，并且 floor 成整数像素（半像素 = 一条糊边）；
 *   视口比舞台小时偏移钳 0，不出现负 left/top（否则画布会被推出可视区）。
 *
 * 本模块不 import 任何东西，也不出现在 core 纯净性扫描范围内（src/core/**）。
 */

/** 逻辑宽：所有素材坐标、血条、HP 数字都按这个坐标系画。 */
export const LOGICAL_W = 320;

/** 逻辑高：同上，16:12（4:3）的像素舞台。 */
export const LOGICAL_H = 240;

/** 默认最大整数倍：手机竖屏 1080×2400 下 320×240 的 4 倍已足够，再大纯属浪费显存。 */
const DEFAULT_MAX_INT = 4;

/** 视口尺寸消毒：非有限 / 负数一律当 0（比"抛异常"更适合 resize 路径上的脏值）。 */
function sanitizeView(v: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** scale 消毒：向下取整，且永不小于 1。 */
function sanitizeScale(scale: number): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  return Math.max(1, Math.floor(scale));
}

/**
 * 按视口算整数缩放倍数。
 *
 * floor(min(viewW/320, viewH/240))，然后 clamp 到 [1, maxInt]。
 * maxInt 缺省 4；非法值（<1 / 非整数 / 非有限）向下取整后不足 1 就当 1，
 * 保证返回值恒为整数且 ≥1（否则 canvas 会退化成 0 尺寸或非整数缩放）。
 */
export function fitScale(viewW: number, viewH: number, maxInt: number = DEFAULT_MAX_INT): number {
  const cap = sanitizeScale(maxInt);
  const w = sanitizeView(viewW);
  const h = sanitizeView(viewH);
  const raw = Math.floor(Math.min(w / LOGICAL_W, h / LOGICAL_H));
  if (!Number.isFinite(raw)) return 1;
  return Math.min(Math.max(raw, 1), cap);
}

/**
 * 居中偏移：返回舞台在视口里的 CSS 落位与尺寸（整数像素）。
 *
 * w/h = 逻辑尺寸 × 已消毒的整数 scale；x/y 由剩余空间对半分后 floor，
 * 且钳 0（视口小于舞台时贴左上角，不产生负偏移）。
 */
export function letterbox(
  viewW: number,
  viewH: number,
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const s = sanitizeScale(scale);
  const w = LOGICAL_W * s;
  const h = LOGICAL_H * s;
  const x = Math.max(0, Math.floor((sanitizeView(viewW) - w) / 2));
  const y = Math.max(0, Math.floor((sanitizeView(viewH) - h) / 2));
  return { x, y, w, h };
}
