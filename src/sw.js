/**
 * sw.js —— Plan 5 · PWA 离线化：Service Worker（无构建工具依赖的手写版）。
 *
 * ## 为什么手写而不是 workbox
 * 本作是"一个 HTML + 一个 JS chunk + 一个 CSS + 若干 JSON/PNG"的静态小站，workbox 带来的
 * 生成步骤与体积都不划算。三条策略够用：
 * - **导航请求**：network-first，失败回落到缓存的 `index.html`（离线打开仍进游戏）；
 * - **同源的 bundle / assets / manifest**：cache-first（内容哈希命名，改一次版本清一次旧缓存）；
 * - **其余**（跨源等）：不拦截，交给浏览器。
 *
 * ## 为什么敢用 cache-first
 * 存档在 IndexedDB、不在 HTTP 缓存里；本 SW 只读地缓存静态资源，永不写用户数据。
 * 纯本地架构（PRD §6.1）下这是离线可用的全部前提。
 *
 * ## 更新语义
 * 新版本上线后：install 预缓存新列表 → activate 清掉所有非当前版本的旧缓存 →
 * clients.claim()。玩家下次冷启动即拿到新版；正在玩的一局不受打断（不做主动 reload）。
 */

// CACHE_NAME 由 vite.config 的占位符注入（见 replace 插件）；直开本文件调试时退回固定值。
const VERSION = '__ZX_XIA_SW_VERSION__';
const CACHE_NAME = 'zx-xia-' + VERSION;

/** install 期预缓存的清单（由构建注入：dist 里的全部资源 URL，相对根）。 */
const PRECACHE = JSON.parse('__ZX_XIA_PRECACHE__');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new URL(u, self.location).href)))
      // 单个资源 404 不该让整次安装失败（比如可选的图标）
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ① 导航：network-first，断网回落 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(new URL('index.html', self.location).href).then((hit) => hit ?? Response.error()),
      ),
    );
    return;
  }

  // ② 静态资源：cache-first，未命中则回填。
  //    匹配**不能带前导 /**——GitHub Pages 把站点发在 /<仓库名>/ 子路径下，pathname 形如
  //    `/pixel-flashcard-rpg/bundle/index-*.js`（终审 I 项踩过的那类子路径坑）。
  const path = url.pathname;
  const isStatic =
    path.includes('/bundle/') ||
    path.includes('/assets/') ||
    path.endsWith('manifest.webmanifest') ||
    path.endsWith('.webmanifest');
  if (isStatic) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
  // ③ 其余不拦截
});
