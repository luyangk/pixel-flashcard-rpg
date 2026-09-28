/** check-core-purity.mjs 的类型声明（守卫脚本本身是纯 Node ESM，不进 core 扫描范围）。 */

/** 结构化命中：文件绝对路径、1-based 行号、命中所在文本、触发的黑名单项。 */
export interface PurityHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly blacklisted: string;
}

/** 结构化命中的展示格式（CLI 与报错信息共用）。 */
export declare function formatHit(h: PurityHit): string;

/** 剥离 // 与块注释及字符串字面量后的源码（纯正则单趟，无跨行状态；各匹配替换为一个空格并保留其内部换行，行数守恒）。 */
export declare function stripComments(src: string): string;

/** 递归收集 dir 下全部 .ts 文件。 */
export declare function collectTs(dir: string, acc?: string[]): string[];

/** 一条黑名单规则。 */
export interface PurityRule {
  readonly name: string;
  readonly re: RegExp;
}

/** core 的黑名单（DOM/平台 API/时钟/随机/CommonJS）。 */
export declare const FORBIDDEN: readonly PurityRule[];

/** app（编排层）的黑名单：禁 DOM 与平台单例（含 Date.now/Math.random），但允许 setTimeout/fetch。 */
export declare const APP_FORBIDDEN: readonly PurityRule[];

/** 扫描给定 .ts 文件，返回结构化命中列表；空数组即纯净。`forbidden` 缺省用 core 的黑名单。 */
export declare function scanFiles(
  files: readonly string[],
  rootDir: string,
  forbidden?: readonly PurityRule[],
): PurityHit[];
