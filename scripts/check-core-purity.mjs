/**
 * core 平台纯净性守卫（PRD §1 / Global Constraints #2）：
 * src/core/**.ts 只允许纯逻辑，禁止出现任何 DOM / 平台 API。
 *
 * 做法：递归遍历 src/core 下的 .ts 文件，按行先剥离注释
 * （行 // 与块 /* ... *\/ 的续行 `*` 前缀），再对黑名单正则做匹配；
 * 命中即打印 文件:行号:内容 并以 exit 1 结束。
 *
 * 黑名单：document. window. localStorage indexedDB fetch( Date.now( require(
 * 说明：localDayString 的 tzOffset 是显式入参，不受影响；
 * core 内部模块互相 import（如 saveMigrate → reviewLedger）是合法依赖，不在检测范围。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = join(root, 'src', 'core');

const FORBIDDEN = [
  { name: 'document.', re: /\bdocument\./ },
  { name: 'window.', re: /\bwindow\./ },
  { name: 'localStorage', re: /\blocalStorage\b/ },
  { name: 'indexedDB', re: /\bindexedDB\b/ },
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'Date.now(', re: /\bDate\.now\s*\(/ },
  { name: 'require(', re: /\brequire\s*\(/ },
];

/** 收集 dir 下所有 .ts 文件路径 */
function collectTs(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectTs(p, acc);
    else if (e.isFile() && e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/**
 * 按行剥离注释：
 * - 剔除行内 // 之后的部分（忽略字符串内的 //，如 URL——core 不应有，宁可漏剥不误报？
 *   不：误报比漏报更易排查，这里采用简单策略——找到不在引号内的 // 才截断）；
 * - 若处于块注释中则整行丢弃；行首（去空白后）以 `*` 开头的行视为块注释续行，整行丢弃；
 * - 跟踪未闭合的 /* 使跨行块注释正确生效。
 */
export function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split(/\r?\n/)) {
    let cur = '';
    let i = 0;
    let quote = null; // 当前字符串引号：' " `
    while (i < line.length) {
      const c = line[i];
      const next = line[i + 1];
      if (inBlock) {
        if (c === '*' && next === '/') {
          inBlock = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (quote) {
        cur += c;
        if (c === '\\') {
          cur += next ?? '';
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        cur += c;
        i += 1;
        continue;
      }
      if (c === '/' && next === '/') break; // 行注释：截断
      if (c === '/' && next === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      cur += c;
      i += 1;
    }
    // 块注释续行的常见写法：行首 `*`（此时 cur 已因 inBlock 为空，双保险）
    if (/^\s*\*/.test(line) && inBlock) continue;
    out.push(cur);
  }
  return out.join('\n');
}

export function scanFiles(files, rootDir) {
  const hits = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const lines = stripComments(raw).split('\n');
    lines.forEach((line, idx) => {
      for (const { name, re } of FORBIDDEN) {
        if (re.test(line)) {
          hits.push(`${relative(rootDir, file)}:${idx + 1}: ${line.trim()}  ← 命中黑名单 "${name}"`);
        }
      }
    });
  }
  return hits;
}

// —— CLI 入口（被测试 import 时不执行）——
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const files = collectTs(CORE_DIR);
  const hits = scanFiles(files, root);
  if (hits.length > 0) {
    console.error('✖ src/core 存在平台 API 依赖，违反 PRD §1 逻辑层零 DOM 约束：');
    for (const h of hits) console.error('  ' + h);
    process.exit(1);
  }
  console.log(`✔ core purity: ${files.length} 个文件，无平台 API 命中`);
}
