/**
 * 本机（Android 容器）专属补丁：/sdcard 为 noexec FUSE 挂载，
 * rolldown/lightningcss 的 .node 原生绑定无法从项目目录 dlopen。
 * 本脚本把已安装到 node_modules 内的 .node 复制到可执行卷
 * （PIXEL_NATIVE_DIR，默认 /root/pfrpg/execmods），并重写两个加载器中
 * 引用原生绑定的路径字面量，指向该副本。
 * 每次 npm install/update 之后运行一次即可；标准 Linux/macOS 开发机无需此步。
 *
 * 触发条件（C1 守卫）：仅当「项目根位于 noexec 挂载上、且项目内确有 .node
 * 原生绑定」时才打补丁——用真实 dlopen 探测，而非按 process.platform 猜测
 * （本容器的 process.platform 实际是 'linux'，不是 'android'）。
 * 其他环境一律 skip 并 exit 0，绝不改写任何文件。
 */
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const dest = process.env.PIXEL_NATIVE_DIR ?? '/root/pfrpg/execmods';

/** 收集项目内所有 .node 原生绑定文件 */
function collectNodeFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectNodeFiles(p, acc);
    else if (e.isFile() && e.name.endsWith('.node')) acc.push(p);
  }
  return acc;
}

/** dlopen 一个 .node；noexec 卷上的典型错误是 "failed to map segment from shared object" */
function tryDlopen(file) {
  try {
    process.dlopen({ exports: {} }, file);
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

// —— C1 平台守卫：只有实测 noexec 才继续，否则原样退出 ——
const natives = collectNodeFiles(nm);
if (natives.length === 0) {
  console.log('link-native-bindings: skip — no native .node bindings in this install');
  process.exit(0);
}
let needsShim = false;
for (const f of natives) {
  const err = tryDlopen(f);
  if (err === null) continue; // 能加载，说明该卷可执行
  if (/map segment|permission denied|not permitted/i.test(err)) { needsShim = true; break; }
  // 其他错误（如 glibc 不匹配）不是 noexec 问题，不能据此打补丁
  console.log(`link-native-bindings: dlopen probe on ${f}: ${err.slice(0, 120)}`);
}
if (!needsShim) {
  console.log('link-native-bindings: skip — volume is exec-capable, no shim needed here');
  process.exit(0);
}
console.log(`link-native-bindings: detected noexec volume at project root (${root}); applying shim`);

function copyBinding(srcPkg, dstRel) {
  const src = join(nm, srcPkg);
  if (!existsSync(src)) { console.log(`skip ${srcPkg}: not installed`); return null; }
  const nodeFile = collectNodeFiles(src)[0];
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
  if (!s.includes(from)) {
    // I2：显式高可见度报错后以非零码退出（package.json 的 `|| true` 仍保证不阻塞安装，
    // 但失败原因会出现在 npm install 输出里，不会被静默吞掉）。
    console.error(`link-native-bindings: FAILED — pattern not found in ${file}, vite build may break on this host\n  expected: ${from}`);
    process.exit(1);
  }
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
