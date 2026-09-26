/**
 * 本机（Android 容器）专属补丁：/sdcard 为 noexec FUSE 挂载，
 * rolldown/lightningcss 的 .node 原生绑定无法从项目目录 dlopen。
 * 本脚本把已安装到 node_modules 内的 .node 复制到可执行卷
 * （PIXEL_NATIVE_DIR，默认 /root/pfrpg/execmods），并重写两个加载器中
 * 引用原生绑定的路径字面量，指向该副本。
 * 每次 npm install/update 之后运行一次即可；标准 Linux/macOS 开发机无需此步。
 */
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const dest = process.env.PIXEL_NATIVE_DIR ?? '/root/pfrpg/execmods';

function findNodeFile(pkgDir) {
  const hits = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() && e.name.endsWith('.node')) hits.push(join(d, e.name));
      else if (e.isDirectory()) walk(join(d, e.name));
    }
  })(pkgDir);
  return hits;
}

function copyBinding(srcPkg, dstRel) {
  const src = join(nm, srcPkg);
  if (!existsSync(src)) { console.log(`skip ${srcPkg}: not installed`); return null; }
  const nodeFile = findNodeFile(src)[0];
  if (!nodeFile) throw new Error(`no .node found under ${src}`);
  const dst = join(dest, dstRel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(nodeFile, dst);
  console.log(`copied ${nodeFile} -> ${dst}`);
  return dst;
}

function patch(file, from, to) {
  const p = join(nm, file);
  if (!existsSync(p)) { console.log(`skip patch ${file}: not found`); return; }
  let s = readFileSync(p, 'utf8');
  if (s.includes(to)) { console.log(`already patched: ${file}`); return; }
  if (!s.includes(from)) throw new Error(`pattern missing in ${file}: ${from}`);
  s = s.split(from).join(to);
  writeFileSync(p, s);
  console.log(`patched ${file}`);
}

// rolldown（vite 8 打包内核）
const rb = copyBinding('@rolldown/binding-linux-arm64-gnu', '@rolldown/binding-linux-arm64-gnu.node');
if (rb) {
  const bindingFile = readdirSync(join(nm, 'rolldown/dist/shared')).find((f) => f.startsWith('binding-') && f.endsWith('.mjs'));
  patch(`rolldown/dist/shared/${bindingFile}`,
    '__require("@rolldown/binding-linux-arm64-gnu")',
    `__require(${JSON.stringify(rb)})`);
}

// lightningcss（vite CSS minify）
const lb = copyBinding('lightningcss-linux-arm64-gnu', 'lightningcss-linux-arm64-gnu/lightningcss.linux-arm64-gnu.node');
if (lb) {
  patch('lightningcss/node/index.js',
    'native = require(`lightningcss-${parts.join(\'-\')}`);',
    `native = require(${JSON.stringify(lb)});`);
}
console.log('native-binding shim done');
