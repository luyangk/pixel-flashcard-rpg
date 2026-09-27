/**
 * 宿主环境单点（Plan 3 · T1，R-T4-a）。
 *
 * tzOffsetMin 是全仓唯一的本地时区偏移计算点：约定返回「东为正」的分钟数，
 * UTC+8（Asia/Shanghai）环境返回 +480。core/reviewFlow 等消费方只引用此函数，
 * 不得在别处再算 getTimezoneOffset。
 */

/**
 * 本地时区相对 UTC 的偏移（分钟，东正西负）。
 * `getTimezoneOffset()` 返回「UTC 减本地」的分钟数（UTC+8 → -480），取负即得口径。
 */
export function tzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}
