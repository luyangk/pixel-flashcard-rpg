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
import { APP_FORBIDDEN, stripComments, scanFiles } from '../../scripts/check-core-purity';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = join(root, 'src', 'core');
const appDir = join(root, 'src', 'app');

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

  it('真实 src/app 全部 .ts 零命中：编排层不直接碰 DOM/平台单例（T11 终审自查补的守卫）', () => {
    const files = collectTs(appDir);
    expect(files.length).toBeGreaterThan(0);
    // 用 app 的黑名单（比 core 宽松：允许 setTimeout/fetch，但禁 DOM 与平台单例）
    expect(scanFiles(files, root, APP_FORBIDDEN)).toEqual([]);
  });

  it('app 黑名单有牙：document./requestAnimationFrame/Date.now( 都必须被检出', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'appurity-'));
    writeFileSync(
      join(dir, 'bad-app.ts'),
      [
        '// document. 在注释里不该报',
        'export function f() { return document.getElementById("x"); }',
        'export const raf = requestAnimationFrame(() => {});',
        'export const t = Date.now();',
        'export const s = window.localStorage;',
      ].join('\n'),
    );
    const hits = scanFiles([join(dir, 'bad-app.ts')], root, APP_FORBIDDEN);
    const names = hits.map((h) => h.blacklisted).sort();
    expect(names).toContain('document.');
    expect(names).toContain('requestAnimationFrame');
    expect(names).toContain('Date.now(');
    expect(names).toContain('localStorage');
    // 注释里的字面不误报
    expect(hits.every((h) => !h.text.includes('在注释里'))).toBe(true);
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
        '// Math.random( 只活在注释里，不该报',
        'const a = Date.now();',
        'const b = indexedDB.open("x"); // fetch( 藏在行注释里',
        'export function f() { require("fs"); }',
        'export const r = Math.random();',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'clean.ts'),
      ['// 纯逻辑模块', 'export const n = 1 + 1;', "export const s = 'no platform api';"].join('\n'),
    );

    type Hit = { file: string; line: number; text: string; blacklisted: string };
    const hits: Hit[] = scanFiles([join(dir, 'bad.ts'), join(dir, 'clean.ts')], dir);
    const names = hits.map((h) => h.blacklisted);
    expect(new Set(names)).toEqual(new Set(['Date.now(', 'indexedDB', 'require(', 'Math.random(']));
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
    // Math.random( 的调用形态被检出、且只检出代码行那一次（第 8 行），注释行的字面不误报
    const rndHits = hits.filter((h) => h.blacklisted === 'Math.random(');
    expect(rndHits.length).toBe(1);
    expect(rndHits[0].line).toBe(8);
  });

  it('stripComments 保留代码、剔除注释', () => {
    const stripped = stripComments('const x = 1; // window.y\n/* a\nb */ const z = 2;');
    expect(stripped).toContain('const x = 1;');
    expect(stripped).not.toContain('window.y');
    expect(stripped).toContain('const z = 2;');
    expect(stripped).not.toContain('b');
  });

  it('多行模板字面量剥离不吞行（行数守恒）', () => {
    const input = 'const a = `\nx=1;\nwindow.location.href=1;\n`;';
    expect(input.split('\n').length).toBe(4); // brief 输入：3 个换行、4 行
    const stripped = stripComments(input);
    expect(stripped.split('\n').length).toBe(input.split('\n').length);
  });

  it('模板后的真实代码行仍被检出且 line 号正确（行序守恒）', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'purity-tpl-'));
    const file = join(dir, 'tpl.ts');
    writeFileSync(
      file,
      [
        'const a = `', // 1
        'x=1;', // 2
        'window.location.href=1;', // 3 — 模板内容，剥离后不报（已接受权衡）
        '`;', // 4
        'window.alert(1)', // 5 — 真实代码行，必须报且 line=5
      ].join('\n'),
    );
    type Hit = { file: string; line: number; text: string; blacklisted: string };
    const hits: Hit[] = scanFiles([file], dir);
    // 模板内部命中为零
    expect(hits.some((h) => h.text.includes('location'))).toBe(false);
    // 紧随模板之后的真实代码行照常检出，行号不因剥离错位
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(5);
    expect(hits[0].text).toContain('window.alert(1)');
    expect(hits[0].blacklisted).toBe('window.');
  });
});
