/**
 * vite.config.ts —— Plan 4 · T11：构建期把 `assets/` 整棵树复制进 `dist/`。
 *
 * 为什么需要它：运行时的素材路径是**字符串**（`assets/sprites/hero.png`、
 * `assets/narrative/prologue.json` 里每屏的 art），它们不是 ESM 导入，Vite 因此不会
 * 自动把它们当构建产物——dev 服务器能直接读仓库文件，而 `vite build` 出来的 `dist/`
 * 会缺图（T11 派单时已核对：`public/` 目录不存在，素材在仓库根的 `assets/`）。
 *
 * 两个选择与理由：
 * - **不用 publicDir='assets'**：那会把 URL 变成 `/sprites/x.png`，而 JSON 里的路径与
 *   测试里的存在性断言都是 `assets/sprites/...`（T6/T9 的契约），改路径等于改契约；
 * - **不用第三方 copy 插件**：本任务只需一次递归复制，Node 的 `cpSync` 一行就够，
 *   引一个依赖只为了 15 行代码不划算（PRD D01：不引入游戏引擎与多余框架）。
 *
 * 另有一处命名避让：Vite 默认把打包产物放在 `dist/assets/`，与本插件复制的游戏素材
 * **同名目录**。故 `build.assetsDir` 改成 `bundle`——产物在 `dist/bundle/`，
 * 游戏素材在 `dist/assets/`，两边互不覆盖（也让"哪些是代码、哪些是素材"一眼可分）。
 *
 * dev 侧无需处理：Vite 的静态中间件本来就服务仓库根下的文件，`/assets/...` 直接可读。
 */
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * 本次构建的版本戳（同一次构建里 SW 缓存名与页面里显示的版本**必须是同一个数**）。
 *
 * 为什么要单独提出来：玩家问"我更新到新版了吗"，答案只能靠"页面里的版本号"与
 * "SW 的缓存名"对得上 —— 两个来源若各算各的时间戳，就会出现"显示新版本、其实跑旧缓存"
 * 这种最糟糕的状态（PRD D54）。SW 用 `zx-xia-<BUILD>` 当缓存名，页面用 `__ZX_XIA_BUILD__`。
 */
const BUILD = String(Date.now());

/**
 * 路径别名——**必须与 visconfig(tsconfig) 的 `compilerOptions.paths` 和
 * `vitest.config.ts` 的 `resolve.alias` 三处一致**。
 *
 * 为什么不能只靠 tsconfig：TypeScript 的 paths 只影响**类型检查**；真正的模块解析由
 * 打包器/测试运行时负责。T11 首版漏了这里的别名，症状极隐蔽——`vitest` 有自己的 alias
 * 所以 789 条用例全绿、`vite build` 也能出包，唯独 **dev server 的 transform** 会
 * 报 `Failed to resolve import "@core/rng"`（浏览器里直接是红屏）。T11 复审前由
 * "起 dev server 抓一次模块"这条手工冒烟抓到，故一并加一条工具测试防回归
 * （tests/tooling/aliasSync.test.ts 逐字比对三处声明）。
 */
const ALIAS = {
  '@core/': fileURLToPath(new URL('./src/core/', import.meta.url)),
  '@platform/': fileURLToPath(new URL('./src/platform/', import.meta.url)),
};

function copyAssets(): Plugin {
  return {
    name: 'zx-xia:copy-assets',
    apply: 'build',
    closeBundle() {
      const from = `${ROOT}assets`;
      const to = `${ROOT}dist/assets`;
      if (!existsSync(from)) return;
      // 排除工作文件（T11 评审 m-7）：`_contact-sheet.png` 是目检拼图、`*.md` 是文档，
      // 两者都不该进游戏包（assets/README.md 自己也是这么写的）。
      const skip = (src: string): boolean =>
        src.includes('_contact-sheet') || src.endsWith('.md');
      cpSync(from, to, { recursive: true, filter: (src: string) => !skip(src) });
    },
  };
}

/**
 * Service Worker 注入（Plan 5 · PWA）：
 * `src/sw.js` 里留了两个占位符——版本戳与预缓存清单。构建结束后扫一遍 `dist/`
 * （除 sw.js 外全部资源）填进去，写到 `dist/sw.js`。这样 precache 永远与产物一致，
 * 不需要手工维护文件列表（列表一旦漏项，离线就会缺素材——比漏更糟的是静默缺）。
 */
function injectServiceWorker(): Plugin {
  return {
    name: 'zx-xia:inject-sw',
    apply: 'build',
    closeBundle() {
      const src = `${ROOT}src/sw.js`;
      const distDir = `${ROOT}dist`;
      if (!existsSync(src) || !existsSync(distDir)) return;
      const files: string[] = [];
      const walk = (dir: string, rel: string): void => {
        for (const e of readdirSync(dir)) {
          const abs = join(dir, e);
          const r = rel ? `${rel}/${e}` : e;
          if (statSync(abs).isDirectory()) walk(abs, r);
          else if (e !== 'sw.js') files.push(`./${r}`);
        }
      };
      walk(distDir, '');
      const code = readFileSync(src, 'utf8')
        .replace('__ZX_XIA_SW_VERSION__', BUILD)
        .replace('__ZX_XIA_PRECACHE__', JSON.stringify(files));
      writeFileSync(`${distDir}/sw.js`, code);
      console.log(`✔ sw injected: ${files.length} 个预缓存项，版本 ${BUILD}`);
    },
  };
}

export default defineConfig({
  /**
   * 把构建戳注入页面代码（`platform/pwaUpdate` 读它显示"当前版本"）。
   * 与 SW 的缓存名同源（同一个 `BUILD`）—— 见上面那段注释。
   */
  define: { __ZX_XIA_BUILD__: JSON.stringify(BUILD) },
  // **相对基址**：GitHub Pages 把项目发到 `/<仓库名>/` 子路径下。写死 `/bundle/...`
  // 的绝对路径会在子路径里 404（Plan 5 上线前的已知缺口，终审 I 项登记过）。
  // 相对 base 同时兼容"整个 dist 拷到任意子目录/本地 file:// 之外"的用法；
  // 唯一代价是 SPA 深链不可用——本作是单页无路由，不受影响。
  base: './',
  plugins: [copyAssets(), injectServiceWorker()],
  resolve: { alias: ALIAS },
  build: {
    // 打包产物避开 dist/assets（那里归游戏素材，见文件头"命名避让"）
    assetsDir: 'bundle',
    // 素材已由上面的插件原样复制：禁止内联成 data URL，免得 `assets/...` 路径在产物里消失
    assetsInlineLimit: 0,
  },
});
