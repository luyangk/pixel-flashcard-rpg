/**
 * 分层纯净性守卫（PRD §1 / Global Constraints #2 / §10）——两个根、两张黑名单：
 *
 * 1. **`src/core/**.ts` = 纯逻辑**：禁 DOM / 平台 API / 时钟 / 随机 / CommonJS。
 *    黑名单：document. window. localStorage indexedDB fetch( Date.now( require( Math.random(
 * 2. **`src/app/**.ts` = 编排层**：允许 `setTimeout`（攒批窗）与纯计算，但**不得直接碰
 *    DOM 或平台能力**——那两件事必须走 `src/platform/**`。这条在 Plan 4 之前只是口头纪律
 *    （`src/app` 一直干净，却没有任何机器检查）；T11 终审自查时补上：
 *    黑名单：document. window. localStorage indexedDB sessionStorage requestAnimationFrame
 *    navigator.（`Date.now(` 与 `Math.random(` 也在内——app 层同样只接受注入的时钟与随机源）。
 *
 * 做法：递归遍历目标目录的 .ts 文件，先剥离注释与字符串字面量，再对黑名单正则匹配；
 * 命中即打印 文件:行号:内容 并以 exit 1 结束。
 *
 * 说明：localDayString 的 tzOffset 是显式入参，不受影响；
 * 层内模块互相 import（如 app 内互引、core 内互引）是合法依赖，不在检测范围。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = join(root, 'src', 'core');
const APP_DIR = join(root, 'src', 'app');

const FORBIDDEN = [
  { name: 'document.', re: /\bdocument\./ },
  { name: 'window.', re: /\bwindow\./ },
  { name: 'localStorage', re: /\blocalStorage\b/ },
  { name: 'indexedDB', re: /\bindexedDB\b/ },
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'Date.now(', re: /\bDate\.now\s*\(/ },
  { name: 'require(', re: /\brequire\s*\(/ },
  { name: 'Math.random(', re: /\bMath\.random\s*\(/ },
];

/**
 * app（编排层）的黑名单：比 core 宽松在"没有 fetch/require 限制"（app 允许未来接
 * LLM/持久化），但**更明确地禁止一切 DOM 与平台单例**——这些只能出现在 src/platform。
 */
export const APP_FORBIDDEN = [
  { name: 'document.', re: /\bdocument\s*\./ },
  { name: 'window.', re: /\bwindow\s*\./ },
  { name: 'localStorage', re: /\blocalStorage\b/ },
  { name: 'sessionStorage', re: /\bsessionStorage\b/ },
  { name: 'indexedDB', re: /\bindexedDB\b/ },
  { name: 'requestAnimationFrame', re: /\brequestAnimationFrame\b/ },
  { name: 'navigator.', re: /\bnavigator\s*\./ },
  { name: 'Date.now(', re: /\bDate\.now\s*\(/ },
  { name: 'Math.random(', re: /\bMath\.random\s*\(/ },
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
 * 剥离块注释、行注释与字符串字面量（各替换为一个空格并保留其内部换行，行数守恒；
 * 字符串内容本身不再参与匹配——设计权衡：无心使用+防误报优先，非对抗防护）。
 *
 * 设计要点（fix round 1 评审后重构，放弃手写跨行状态机——两例漏报均源于状态泄漏）：
 * - 纯正则单趟扫描，无跨调用/跨行可变状态；
 * - 模板串等可跨行匹配整体替换时逐字保留其中的 \n，后续代码行的行序不错位；
 * - 块注释整体非贪婪匹配：`/* wi\n * ndow.location.href = 1; *\/` 注入形态中，
 *   闭合符所在行的星斜杠之后内容必然保留（旧状态机的"行首 * 丢整行"兜底会连带丢弃它）；
 * - 单/双引号串字符类排除裸换行：未闭合串止于行尾，后续行照常扫描；
 * - 撇号保守判定由 (?<![\w$]) lookbehind 承担："it's a trap" 的中缀 ' 不开启字符串态。
 */
export function stripComments(src) {
  return src.replace(TOKEN_RE, (m) => ' ' + '\n'.repeat((m.match(/\n/g) ?? []).length));
}

/** 返回结构化命中列表：每项 { file, line, text, blacklisted } */
export function scanFiles(files, rootDir, forbidden = FORBIDDEN) {
  const hits = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const lines = stripComments(raw).split('\n');
    lines.forEach((line, idx) => {
      for (const { name, re } of forbidden) {
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
  const coreFiles = collectTs(CORE_DIR);
  const coreHits = scanFiles(coreFiles, root, FORBIDDEN);
  const appFiles = collectTs(APP_DIR);
  const appHits = scanFiles(appFiles, root, APP_FORBIDDEN);

  if (coreHits.length > 0) {
    console.error('✖ src/core 存在平台 API 依赖，违反 PRD §1 逻辑层零 DOM 约束：');
    for (const h of coreHits) console.error('  ' + formatHit(h));
  }
  if (appHits.length > 0) {
    console.error('✖ src/app 直接触碰 DOM/平台单例，违反分层约束（应走 src/platform）：');
    for (const h of appHits) console.error('  ' + formatHit(h));
  }
  if (coreHits.length > 0 || appHits.length > 0) process.exit(1);
  console.log(`✔ purity: core ${coreFiles.length} 个文件 / app ${appFiles.length} 个文件，无命中`);
}
