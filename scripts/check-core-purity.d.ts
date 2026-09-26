/** check-core-purity.mjs 的类型声明（守卫脚本本身是纯 Node ESM，不进 core 扫描范围）。 */

export interface PurityHit {
  /** 形如 `src/core/foo.ts:12: <行内容>  ← 命中黑名单 "window."` */
  readonly message: string;
}

/** 按行剥离 // 与块注释后的源码（保留字符串字面量）。 */
export declare function stripComments(src: string): string;

/** 扫描给定 .ts 文件，返回黑名单命中的报告行；空数组即纯净。 */
export declare function scanFiles(files: readonly string[], rootDir: string): string[];
