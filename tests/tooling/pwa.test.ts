/**
 * tests/tooling/pwa.test.ts —— Plan 5：PWA 与部署配置的**静态契约**。
 *
 * 为什么值得一套测试（终审 F 的"最危险未覆盖面"第一条）：
 * 「装到手机上能离线打开」这件事在 CI 里没有任何可跑的运行时（无浏览器/SW 环境），
 * 但它由**四处配置**共同决定：manifest、index.html 的元信息、sw.js 的策略、
 * vite 的 base 与注入。这四处任何一处写错，症状都是"手机上打不开/更新不了"——
 * 而 vitest 全绿。所以这里把它们的**结构**钉死（值不值得信任由真机验证，见 README）。
 *
 * 判据刻意做成"结构 + 关键语义"而不是快照：比如 sw.js 必须"只处理同源 GET"、
 * "导航失败回落 index.html"，这是离线可用的最小充分条件。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('manifest.webmanifest —— 装到主屏的最小充分条件', () => {
  const manifest = JSON.parse(read('manifest.webmanifest')) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    orientation?: string;
    background_color?: string;
    theme_color?: string;
    icons?: Array<{ src: string; sizes: string; type: string }>;
  };

  it('PW#1 必备字段齐：名称/启动地址/独立显示/竖屏/主题色', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    // 相对 start_url：Pages 把站点发在 /<仓库名>/ 子路径下，绝对路径会 404
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
    expect(manifest.theme_color).toBeTruthy();
    expect(manifest.background_color).toBeTruthy();
  });

  it('PW#2 图标真实存在（声明的路径不能是空头支票）', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons?.length ?? 0).toBeGreaterThan(0);
    for (const icon of manifest.icons ?? []) {
      expect(icon.type).toBe('image/png');
      expect(icon.sizes).toMatch(/^\d+x\d+$/);
      const rel = icon.src.replace(/^\.\//, '');
      expect(existsSync(join(ROOT, rel)), `缺图标：${icon.src}`).toBe(true);
    }
  });
});

describe('index.html —— 移动端元信息', () => {
  const html = read('index.html');

  it('PW#3 声明 manifest、viewport 与主题色，并允许 iOS 独立全屏', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('viewport-fit=cover'); // 刘海屏安全区（styles.css 用 env(safe-area-inset-*)）
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('apple-mobile-web-app-capable');
  });

  it('PW#3b 入口脚本用相对/模块写法（Vite 会接管），且没有内联脚本（CSP 友好）', () => {
    expect(html).toContain('type="module"');
    expect(/<script(?![^>]*type="module")/.test(html)).toBe(false);
  });
});

describe('src/sw.js —— 离线策略', () => {
  const sw = read('src/sw.js');

  it('PW#4 保留两个构建占位符（版本戳 + 预缓存清单），二者缺一都会让离线/更新语义失效', () => {
    expect(sw).toContain('__ZX_XIA_SW_VERSION__');
    expect(sw).toContain('__ZX_XIA_PRECACHE__');
    // 清单必须是运行时填入的数组字面量，而不是硬编码文件表（硬编码必然与产物漂移）
    expect(sw).toContain('JSON.parse(');
  });

  it('PW#5 只处理同源 GET；导航 network-first 回落 index.html；静态资源 cache-first', () => {
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain('url.origin !== self.location.origin');
    expect(sw).toContain("req.mode === 'navigate'");
    expect(sw).toContain("new URL('index.html', self.location)");
    expect(sw).toContain('caches.match(req)');
    // 子路径安全：匹配用 includes 而不是带前导 / 的锚定正则（Pages 子路径踩过这个坑）
    expect(sw).toContain("path.includes('/bundle/')");
    expect(sw).toContain("path.includes('/assets/')");
  });

  it('PW#5b 激活时清掉旧版本缓存（否则更新后仍吃旧资源）', () => {
    // 链式写法会跨行，故用容忍空白的正则而不是字面量
    expect(/caches\s*\.\s*keys\(\)/.test(sw)).toBe(true);
    expect(/caches\s*\.\s*delete\(k\)/.test(sw)).toBe(true);
    expect(/const CACHE_NAME = 'zx-xia-' \+ VERSION/.test(sw)).toBe(true);
  });
});

describe('构建与注册配置', () => {
  it('PW#6 vite：相对 base（Pages 子路径）+ SW 注入插件（版本戳与预缓存清单在构建期填）', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain("base: './'");
    expect(vite).toContain('injectServiceWorker');
    expect(vite).toContain("'__ZX_XIA_SW_VERSION__'");
    expect(vite).toContain("'__ZX_XIA_PRECACHE__'");
    // 工作文件不进产物（终审 m-7）
    expect(vite).toContain('_contact-sheet');
  });

  it('PW#7 main.ts：SW 只在生产构建注册（dev 下注册会让改代码看不到效果）', () => {
    const main = read('src/main.ts');
    expect(main).toContain('import.meta.env.PROD');
    expect(main).toContain("'serviceWorker' in navigator");
    expect(main).toContain("navigator.serviceWorker.register('./sw.js')");
    // 失败必须静默：SW 是增强不是依赖（http 明文 / 隐私模式 / 老 iOS 都要能照常玩）
    expect(main).toContain('.catch(() => undefined)');
  });

  it('PW#8 部署流水线存在：main 推送 ⇒ 门禁 + 打包 + 发布，权限最小化', () => {
    const wf = read('.github/workflows/deploy.yml');
    expect(wf).toContain('branches: [main]');
    expect(wf).toContain('npm run verify');
    expect(wf).toContain('actions/upload-pages-artifact@v3');
    expect(wf).toContain('actions/deploy-pages@v4');
    expect(wf).toContain('path: dist');
    expect(wf).toContain('pages: write');
    expect(wf).toContain('id-token: write');
  });
});
