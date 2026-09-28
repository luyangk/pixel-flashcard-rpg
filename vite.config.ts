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
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function copyAssets(): Plugin {
  return {
    name: 'zx-xia:copy-assets',
    apply: 'build',
    closeBundle() {
      const from = `${ROOT}assets`;
      const to = `${ROOT}dist/assets`;
      if (!existsSync(from)) return;
      cpSync(from, to, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [copyAssets()],
  build: {
    // 打包产物避开 dist/assets（那里归游戏素材，见文件头"命名避让"）
    assetsDir: 'bundle',
    // 素材已由上面的插件原样复制：禁止内联成 data URL，免得 `assets/...` 路径在产物里消失
    assetsInlineLimit: 0,
  },
});
