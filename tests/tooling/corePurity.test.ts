/**
 * 守卫脚本自测（TDD 适度）：正反例各一。
 * 正例：真实 src/core 全量扫描应零命中；
 * 反例：含平台 API 的样本必须被检出，且注释中的字面不得误报。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// d.ts 与 mjs 同名相邻放置即可被解析；bundler 模式下需显式去掉 .mjs 扩展
import { stripComments, scanFiles } from '../../scripts/check-core-purity';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = join(root, 'src', 'core');

function collectTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectTs(p, acc);
    else if (e.isFile() && e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** 把伪文件内容写到临时位置供 scanFiles 读取不可行（scanFiles 读真实文件），
 *  因此用 stripComments + 内联正则复刻检测逻辑来验证语义层，另用真实临时文件验证端到端。 */
describe('check-core-purity', () => {
  it('真实 src/core 全部 .ts 零命中（正例）', () => {
    const files = collectTs(coreDir);
    expect(files.length).toBeGreaterThan(0);
    expect(scanFiles(files, root)).toEqual([]);
  });

  it('平台 API 字面被检出、注释字面不误报（反例）', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'purity-'));
    writeFileSync(
      join(dir, 'bad.ts'),
      [
        '// window.foo 在注释里，不该报',
        '/* document.bar',
        ' * localStorage 块注释里，也不该报 */',
        'const a = Date.now();',
        'const b = indexedDB.open("x"); // fetch( 藏在行注释里',
        'export function f() { require("fs"); }',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'clean.ts'),
      ['// 纯逻辑模块', 'export const n = 1 + 1;', "export const s = 'no platform api';"].join('\n'),
    );

    type Hit = { file: string; line: number; text: string; blacklisted: string };
    const hits: Hit[] = scanFiles([join(dir, 'bad.ts'), join(dir, 'clean.ts')], dir);
    const names = hits.map((h) => h.blacklisted);
    expect(new Set(names)).toEqual(new Set(['Date.now(', 'indexedDB', 'require(']));
    expect(hits.every((h) => h.file.endsWith('bad.ts'))).toBe(true);
    // 结构化三元组：行号与文本可核对（注释里的字面绝不进结果集）
    for (const h of hits) {
      expect(h.line).toBeGreaterThan(0);
      expect(h.text).toContain(h.blacklisted.slice(0, 4));
    }
    expect(names).not.toContain('window.');
    expect(names).not.toContain('document.');
    expect(names).not.toContain('localStorage');
    expect(names).not.toContain('fetch(');
  });

  it('stripComments 保留代码、剔除注释', () => {
    const stripped = stripComments('const x = 1; // window.y\n/* a\nb */ const z = 2;');
    expect(stripped).toContain('const x = 1;');
    expect(stripped).not.toContain('window.y');
    expect(stripped).toContain('const z = 2;');
    expect(stripped).not.toContain('b');
  });
});
