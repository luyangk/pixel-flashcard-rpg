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

/** 扫描给定 .ts 文件，返回结构化命中列表；空数组即纯净。 */
export declare function scanFiles(files: readonly string[], rootDir: string): PurityHit[];
