/**
 * core 平台纯净性守卫（PRD §1 / Global Constraints #2）：
 * src/core/**.ts 只允许纯逻辑，禁止出现任何 DOM / 平台 API。
 *
 * 做法：递归遍历 src/core 下的 .ts 文件，先剥离注释与字符串字面量，
 * 再对黑名单正则做匹配；命中即打印 文件:行号:内容 并以 exit 1 结束。
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

/** 收集 dir 下所有 .ts 文件路径（导出供测试复用，避免逐字重复实现） */
export function collectTs(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectTs(p, acc);
    else if (e.isFile() && e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

// 字符串字面量与注释的整体匹配（交替式一次扫描）。
// 用 RegExp 构造器 + 字符串模式以避免模板串/正则字面量的转义歧义。
// 五个交替分支依次为：双引号串、单引号串（撇号保守判定）、反引号串、行注释、块注释。
const TOKEN_PATTERN = [
  '"(?:[^"\\\\\\n]|\\\\.)*"', // 双引号串：不含裸换行
  "'(?<![\\w$])(?:[^'\\\\\\n]|\\\\.)*'", // 单引号串：' 仅当行内前一字符非标识符字符时才开启（it's 中缀撇号不算串起始）
  '`(?:[^`\\\\]|\\\\.)*`', // 模板串：可跨行
  '\\/\\/[^\\r\\n]*', // 行注释：到行尾
  '\\/\\*[\\s\\S]*?\\*\\/', // 块注释：非贪婪整体匹配，闭合符之后的同行内容不属于匹配
].join('|');
const TOKEN_RE = new RegExp(TOKEN_PATTERN, 'g');

/**
 * 剥离块注释、行注释与字符串字面量（各替换为一个空格，保持行数与大致列位）。
 *
 * 设计要点（fix round 1 评审后重构，放弃手写跨行状态机——两例漏报均源于状态泄漏）：
 * - 纯正则单趟扫描，无跨调用/跨行可变状态；
 * - 块注释整体非贪婪匹配：`/* wi\n * ndow.location.href = 1; *\/` 注入形态中，
 *   闭合符所在行的星斜杠之后内容必然保留（旧状态机的"行首 * 丢整行"兜底会连带丢弃它）；
 * - 单/双引号串字符类排除裸换行：未闭合串止于行尾，后续行照常扫描；
 * - 撇号保守判定由 (?<![\w$]) lookbehind 承担："it's a trap" 的中缀 ' 不开启字符串态。
 */
export function stripComments(src) {
  return src.replace(TOKEN_RE, ' ');
}

/** 返回结构化命中列表：每项 { file, line, text, blacklisted } */
export function scanFiles(files, rootDir) {
  const hits = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const lines = stripComments(raw).split('\n');
    lines.forEach((line, idx) => {
      for (const { name, re } of FORBIDDEN) {
        if (re.test(line)) {
          hits.push({
            file: relative(rootDir, file),
            line: idx + 1,
            text: line.trim(),
            blacklisted: name,
          });
        }
      }
    });
  }
  return hits;
}

/** 结构化命中的展示格式（CLI 报错信息使用） */
export function formatHit(h) {
  return `${h.file}:${h.line}: ${h.text}  ← 命中黑名单 "${h.blacklisted}"`;
}

// —— CLI 入口（被测试 import 时不执行）——
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const files = collectTs(CORE_DIR);
  const hits = scanFiles(files, root);
  if (hits.length > 0) {
    console.error('✖ src/core 存在平台 API 依赖，违反 PRD §1 逻辑层零 DOM 约束：');
    for (const h of hits) console.error('  ' + formatHit(h));
    process.exit(1);
  }
  console.log(`✔ core purity: ${files.length} 个文件，无平台 API 命中`);
}
