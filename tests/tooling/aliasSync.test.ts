/**
 * tests/tooling/aliasSync.test.ts —— Plan 4 · T11：路径别名**三处声明必须逐字一致**。
 *
 * 为什么值得一条测试：别名只影响"解析"，不影响"类型"。T11 首版给 `vite.config.ts`
 * 漏了别名——`vitest`（自带 alias）789 条全绿、`vite build` 也能出包，**只有 dev server
 * 的 transform 会红屏**（`Failed to resolve import "@core/rng"`）。三处声明分散在
 * 三个文件里，靠人记必然漂移，故用一条机械比对钉住。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('路径别名三处同步', () => {
  it('tsconfig.paths / vite.config.resolve.alias / vitest.config.resolve.alias 都声明 @core 与 @platform', () => {
    const tsconfig = JSON.parse(read('tsconfig.json')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const paths = tsconfig.compilerOptions?.paths ?? {};
    expect(Object.keys(paths).sort()).toEqual(['@core/*', '@platform/*']);
    expect(paths['@core/*']).toEqual(['src/core/*']);
    expect(paths['@platform/*']).toEqual(['src/platform/*']);

    // 两个配置文件都必须出现两条别名的键（值用 fileURLToPath 拼，故只比键与其目标目录）
    for (const file of ['vite.config.ts', 'vitest.config.ts']) {
      const text = read(file);
      expect(text, `${file} 缺 @core/ 别名`).toContain("'@core/'");
      expect(text, `${file} 缺 @platform/ 别名`).toContain("'@platform/'");
      expect(text, `${file} 的 @core 指向非 src/core`).toContain("'./src/core/'");
      expect(text, `${file} 的 @platform 指向非 src/platform`).toContain("'./src/platform/'");
    }
  });
});
