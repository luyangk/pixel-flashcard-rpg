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
 * ## 前置条件与跳过语义（两个条件都满足才跑）
 * 1. `dist/` 存在；
 * 2. 环境变量 `DIST_SMOKE=1` —— 由 `npm run smoke:dist` 设置。
 *
 * 为什么需要第 2 条：`npm run verify` 的顺序是 `test → build:only → smoke:dist`，
 * 而**构建前的那次 `npm test` 看到的是上一次构建的 dist**（可能已经过期）。
 * 早期版本没有这个开关，于是"刚改完 UI 但还没构建"时对产物断言会在 `npm test` 阶段假红
 * （产物里当然没有新 UI）——那是一次真实的误报，故改成"显式声明我要测产物"。
 * 跳过不是"假装通过"：`verify` 的最后一段一定会跑它。
 */
const DIST_SMOKE_ON = process.env.DIST_SMOKE === '1';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist');
const INDEX = join(DIST, 'index.html');
const hasDist = existsSync(INDEX);
/** 两个条件都满足才跑（见文件头「跳过语义」）。 */
const runDistSmoke = hasDist && DIST_SMOKE_ON;

/** 线上基址（相对路径的解析基准；也是我们真正要服务的地址）。 */
const LIVE_BASE = 'https://luyangk.github.io/pixel-flashcard-rpg/';

describe.skipIf(!runDistSmoke)('真实产物启动冒烟（dist/）', () => {
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

  it('DB#4 产物里 AI 接线不落空：设置页有 AI 分组、卡组页有辅建入口（漏透传 ⇒ 必红）', async () => {
    const win = (globalThis as unknown as { __bootWin: { document: Document } }).__bootWin;
    const click = (sel: string): boolean => {
      const el = win.document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      el.click();
      return true;
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    };

    // 菜单 → 设置：AI 分组必须在（说明 assembleHost 造出的 llm 依赖真的透传到了屏上）
    expect(click('[data-nav="settings"]'), '菜单里没有设置入口').toBe(true);
    await settle();
    expect(win.document.querySelector('[data-ui="settings-screen"]'), '设置屏没挂上').not.toBeNull();
    expect(win.document.querySelector('[data-ui="llm-group"]'), '设置屏拿不到 llm 依赖（漏透传）').not.toBeNull();

    // 回菜单 → 卡组：辅建卡入口必须在
    expect(click('[data-ui="back"]')).toBe(true);
    await settle();
    expect(click('[data-nav="decks"]')).toBe(true);
    await settle();
    expect(win.document.querySelector('[data-ui="llm-author-open"]'), '卡组屏拿不到 llmCards 依赖').not.toBeNull();
  }, 30_000);

  it('DB#6 产物里作答模式可用：设置页有「作答方式」组、战斗屏出选项按钮', async () => {
    const win = (globalThis as unknown as { __bootWin: { document: Document } }).__bootWin;
    const q = (sel: string): HTMLElement | null => win.document.querySelector(sel) as HTMLElement | null;
    const click = (sel: string): boolean => {
      const el = q(sel);
      if (!el) return false;
      el.click();
      return true;
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    };

    // 上一节可能停在别的一级屏：先回到菜单（本用例不依赖执行顺序）
    if (q('[data-ui="back"]')) {
      click('[data-ui="back"]');
      await settle();
    }
    // 设置屏：作答方式组（两个按钮 + D42 的隐私说明）
    expect(click('[data-nav="settings"]'), '菜单里没有设置入口').toBe(true);
    await settle();
    const group = q('[data-ui="answer-mode-group"]');
    expect(group, '设置屏没有「作答方式」组（Plan 6 的接线漏了）').not.toBeNull();
    expect(group?.hidden).toBe(false);
    expect(q('[data-answer-mode="choice"]'), '没有选择题按钮').not.toBeNull();
    expect(q('[data-answer-mode="qa"]'), '没有问答模式按钮').not.toBeNull();
    // D42 的例外必须写在屏上（把答案发给服务商这件事不能藏着）
    expect(group?.textContent ?? '').toContain('答案');
    expect(group?.textContent ?? '').toContain('服务商');

    // 战斗屏：真的能出选项（走完整链路：备战 → 开战 → 首张卡出选项）
    expect(click('[data-ui="back"]')).toBe(true);
    await settle();
    expect(click('[data-nav="prepare"]')).toBe(true);
    await settle();
    expect(click('[data-ui="start"]')).toBe(true);
    await settle();
    // 首战是教学局（弱化敌人），不影响出题形态
    const choices = win.document.querySelectorAll('button[data-choice]');
    expect(choices.length, '战斗屏没有出选择题（Plan 6 · T6 的接线漏了）').toBeGreaterThan(0);
    // 判定面板此时还没出现（要先作答）
    expect(q('[data-ui="verdict"]')?.hidden).toBe(true);
    // 收尾：退出本局回菜单（别把后续用例留在战斗屏上）
    expect(click('[data-ui="quit"]')).toBe(true);
    await settle();
  }, 40_000);

  it('DB#5 产物里「重置存档」真的能清档重装（main.ts 漏传 presetContent ⇒ 整组不显示）', async () => {
    const win = (globalThis as unknown as { __bootWin: { document: Document } }).__bootWin;
    const q = (sel: string): HTMLElement | null => win.document.querySelector(sel) as HTMLElement | null;
    const click = (sel: string): boolean => {
      const el = q(sel);
      if (!el) return false;
      el.click();
      return true;
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
    };

    // 从任意一级屏回菜单 → 设置（不依赖上一个用例停在哪儿）
    if (q('[data-ui="back"]')) {
      click('[data-ui="back"]');
      await settle();
    }
    expect(click('[data-nav="settings"]')).toBe(true);
    await settle();

    // ① 「存档」分组可见 ⇒ main.ts 把 presetJson 交给了 assembleHost（缺它 resetSave 不接、整组隐藏）
    const saveGroup = q('[data-ui="save-group"]');
    expect(saveGroup, '设置屏里没有存档分组（main.ts 漏传 presetContent）').not.toBeNull();
    expect(saveGroup?.hidden, '存档分组被藏着').toBe(false);

    // ② 两步确认：第一下只展开代价说明，第二下才真清
    expect(click('[data-ui="save-reset"]')).toBe(true);
    await settle();
    expect(q('[data-ui="save-reset-actions"]')?.hidden, '确认面板没展开').toBe(false);
    expect(click('[data-ui="save-reset-confirm"]')).toBe(true);

    // ③ 等真实链路跑完（清存储 → reload → 灌 30 张预置卡 → flush），成功 toast 会报出真数量
    let text = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      text = win.document.body.textContent ?? '';
      if (text.includes('存档已重置')) break;
    }
    expect(text, '产物里重置没有成功（真实链路某一步失败）').toContain('存档已重置');
    expect(text).toContain('4 个领域');
    expect(text).toContain('30 张卡');
  }, 30_000);
});
