/**
 * tests/e2e/dist.boot.test.ts —— Plan 5：**真实产物**的启动冒烟（`dist/` 里的那个 bundle）。
 *
 * ## 为什么必须有这一条（Plan 4 终审 F 项第一条未覆盖面）
 * 全套 824 条用例跑的都是 `src/` 源码（vitest 自己解析别名、自己转译），而玩家拿到的是
 * `dist/bundle/index-*.js`。两者之间隔着一次**真实打包**：模块解析、资源路径、base 前缀、
 * 副作用顺序都可能在打包后变化。Plan 4 期间就发生过一次「dev server 解析不出 `@core/rng`、
 * 而 789 条用例全绿」——那类故障只有"跑真产物"能挡。
 *
 * ## 它做什么
 * 1. 读 `dist/index.html`，抽出被引用的 bundle/CSS/manifest，并断言它们在磁盘上都在；
 * 2. 用 happy-dom 造一个浏览器环境（base 取 Pages 线上地址，验证相对路径在子路径下也对），
 *    把构建产物**当模块 import 进去**——即真的执行一遍启动链路
 *    （openStorage → 灌预置内容 → 建控制器 → 载素材 → 装配 → 挂宿主）；
 * 3. 断言序章屏出现且旁白与 LORE §5.1 第一句逐字一致；再连点 8 屏，断言进菜单
 *    （证事件绑定与快照订阅在产物里也是活的）。
 *
 * ## 前置条件与跳过语义
 * 需要 `dist/` 已构建。`npm run verify` 的顺序是 `test → build:only → smoke:dist`，
 * 所以门禁里它一定跑得到；单独跑 `npm test`（未构建）时本文件**显式跳过**并说明原因——
 * 不假装通过，也不因为缺少产物而红。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist');
const INDEX = join(DIST, 'index.html');
const hasDist = existsSync(INDEX);

/** 线上基址（相对路径的解析基准；也是我们真正要服务的地址）。 */
const LIVE_BASE = 'https://luyangk.github.io/pixel-flashcard-rpg/';

describe.skipIf(!hasDist)('真实产物启动冒烟（dist/）', () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();

  /**
   * 挂/还原全局。Node 24 的 `navigator` 是**只读 getter**（直接赋值会抛
   * "Cannot set property navigator"），故统一走 defineProperty；还原时把原描述符原样放回。
   */
  const setGlobal = (name: string, value: unknown): void => {
    try {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    } catch {
      /* 极少数不可配置的全局：跳过，让它保持原样 */
    }
  };
  const saveGlobal = (name: string): void => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  };

  beforeAll(() => {
    // 只挂这个产物用得到的全局（happy-dom 的 Window 已经实现 DOM/Image/事件）
    return import('happy-dom').then(({ Window }) => {
      const win = new Window({ url: LIVE_BASE });
      const g = globalThis as unknown as Record<string, unknown>;
      const names = [
        'window',
        'document',
        'navigator',
        'location',
        'history',
        'Image',
        'Event',
        'EventTarget',
        'HTMLElement',
        'HTMLImageElement',
        'Node',
        'CustomEvent',
        'MutationObserver',
        'getComputedStyle',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'Blob',
        'URL',
        'crypto',
        'structuredClone',
      ];
      for (const n of names) {
        saveGlobal(n);
        const v = (win as unknown as Record<string, unknown>)[n];
        if (v !== undefined) setGlobal(n, v);
      }
      setGlobal('window', win);
      setGlobal('document', win.document);
      void g;
      (globalThis as unknown as { __bootWin?: unknown }).__bootWin = win;
    });
  }, 30_000);

  afterAll(() => {
    for (const [n, desc] of saved) {
      try {
        if (desc) Object.defineProperty(globalThis, n, desc);
        else delete (globalThis as unknown as Record<string, unknown>)[n];
      } catch {
        /* 不可还原的全局：忽略（本文件独立 worker，不污染其它文件） */
      }
    }
    delete (globalThis as unknown as { __bootWin?: unknown }).__bootWin;
  });

  it('DB#1 index.html 引用的 bundle / CSS / manifest 都在产物里（相对路径，Pages 子路径也成立）', () => {
    const html = readFileSync(INDEX, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(3); // js + css + manifest
    for (const rel of refs) {
      expect(existsSync(join(DIST, rel)), `产物缺被引用的文件：${rel}`).toBe(true);
    }
    expect(refs.some((r) => r.startsWith('bundle/') && r.endsWith('.js'))).toBe(true);
  });

  it('DB#2 产物真的能启动：序章第一屏渲染出来，旁白与 LORE §5.1 逐字一致', async () => {
    const bundle = readdirSync(join(DIST, 'bundle')).find((f) => f.startsWith('index-') && f.endsWith('.js'));
    expect(bundle, 'dist/bundle 下没有 index-*.js').toBeTruthy();
    await import(pathToFileURL(join(DIST, 'bundle', bundle as string)).href);

    // 启动链是异步的（存储 → 预置内容 → 控制器 → 素材）；素材在无头环境走 4s 超时兜底
    const win = (globalThis as unknown as { __bootWin: { document: Document } }).__bootWin;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !win.document.querySelector('[data-ui="prologue-screen"]')) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const prologue = win.document.querySelector('[data-ui="prologue-screen"]');
    expect(prologue, '产物没能启动到序章屏').not.toBeNull();
    expect(win.document.querySelector('[data-ui="prologue-text"]')?.textContent).toBe(
      '知识不再入脑，云端即是记忆。', // LORE §5.1 第一句（逐字契约在 tests/ui/prologue.test.ts）
    );
    expect(win.document.querySelector('[data-ui="prologue-progress"]')?.textContent).toBe('1 / 8');
  }, 30_000);

  it('DB#3 产物里的交互是活的：连点 8 屏演完序章后进菜单（事件与快照订阅都接上了）', async () => {
    const win = (globalThis as unknown as { __bootWin: { document: Document } }).__bootWin;
    for (let i = 0; i < 8; i++) {
      const screen = win.document.querySelector('[data-ui="prologue-screen"]') as HTMLElement | null;
      if (!screen) break;
      screen.click();
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !win.document.querySelector('[data-ui="menu-screen"]')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(win.document.querySelector('[data-ui="menu-screen"]'), '序章演完后没进菜单').not.toBeNull();
    // 菜单上四入口齐备（产物里的屏组件确实渲染了，而不是空壳）
    expect(win.document.querySelectorAll('[data-nav]')).toHaveLength(4);
    // 新装玩家拿到了预置内容（六维面板不是占位符）
    expect(win.document.querySelector('[data-stat="level"]')?.textContent).toBe('1');
  }, 30_000);
});
