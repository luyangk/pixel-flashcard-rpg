/**
 * pwaUpdate.ts —— 「我更新到新版了吗」的只读探针（D54）。
 *
 * ## 为什么需要它
 * 装到主屏之后，更新全发生在网页层（SW 预缓存 + `skipWaiting`/`clients.claim`），
 * 玩家手上**没有任何可见的版本信息** —— 于是"刷了没变"到底是"还没更新"还是"更新了但没变化"，
 * 只能靠感觉。这一层把两件事变成可读的：
 * 1. **当前版本**：SW 的缓存名是 `zx-xia-<构建戳>`，而页面里的 `__ZX_XIA_BUILD__` 是**同一个戳**
 *    （`vite.config.ts` 里同源，见那边的注释）。两者对得上，才说明"页面与缓存是同一批"；
 * 2. **检查更新**：`registration.update()` 让浏览器去比对 `sw.js` 字节；新 SW 会 `skipWaiting()`
 *    立刻接管（我们就是这么写的），所以"缓存名变了"就是"真的来了新版"。
 *
 * ## 三条纪律
 * - **永不抛**：环境没有 SW、隐私模式、`caches` 不可用 —— 一律回 `unsupported`/`unknown`；
 * - **不自己刷新页面**：`reload()` 单独暴露，由 UI 在玩家点了「立即更新」之后调
 *   （打一半的一局不能被自动刷掉）；
 * - **只读**：本模块不写缓存、不写存储、不碰存档。
 */

/** 构建期注入的版本戳（dev/测试下没有 ⇒ `'dev'`）。 */
declare const __ZX_XIA_BUILD__: string | undefined;

const CACHE_PREFIX = 'zx-xia-';

/** 页面这一份的版本（构建戳）。 */
export function pageBuild(): string {
  return typeof __ZX_XIA_BUILD__ === 'string' && __ZX_XIA_BUILD__.length > 0 ? __ZX_XIA_BUILD__ : 'dev';
}

/** 缓存里的版本戳（SW 当前用的那份）。读不到 ⇒ `null`。 */
export async function cachedBuild(): Promise<string | null> {
  try {
    if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return null;
    const keys = await caches.keys();
    const hit = keys.find((k) => k.startsWith(CACHE_PREFIX));
    return hit === undefined ? null : hit.slice(CACHE_PREFIX.length);
  } catch {
    return null;
  }
}

export interface UpdateStatus {
  /** `updated` = 来了新版；`current` = 已是最新；`unsupported` = 这个环境没有 SW（dev/隐私模式）。 */
  readonly status: 'updated' | 'current' | 'unsupported';
  /** 检查之后的缓存版本（读不到就是 null）。 */
  readonly build: string | null;
  /** 人话（UI 直接显示，不必自己拼）。 */
  readonly message: string;
}

/** 我们要用到的那一小块 `ServiceWorkerContainer`（只读探针，不需要更多）。 */
export interface SwContainerLike {
  readonly getRegistration?: () =>
    | Promise<{ readonly update?: () => Promise<unknown> } | undefined>
    | { readonly update?: () => Promise<unknown> }
    | undefined;
}

export interface UpdateDeps {
  /** 注入位（测试用假 navigator/caches）。 */
  readonly serviceWorker?: SwContainerLike | null;
  readonly cacheNames?: () => Promise<string[]>;
  /** 等新 SW 接管的最长时间（默认 6s；每 200ms 看一次缓存名）。 */
  readonly waitMs?: number;
  /** 睡一下（测试注入零延迟）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 检查有没有新版。**不刷新页面**。
 *
 * 判据是"缓存名变了"而不是 `registration.waiting`：我们的 SW 在 install 里就 `skipWaiting()`，
 * 新版根本不会在 `waiting` 停留 —— 按 `waiting` 判会永远得到"已是最新"（首版就是这么错的）。
 */
export async function checkForUpdate(deps: UpdateDeps = {}): Promise<UpdateStatus> {
  const nav: SwContainerLike | null =
    deps.serviceWorker !== undefined
      ? deps.serviceWorker
      : typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? (navigator.serviceWorker as unknown as SwContainerLike)
        : null;
  const names = deps.cacheNames ?? (async () => {
    try {
      return typeof caches === 'undefined' ? [] : await caches.keys();
    } catch {
      return [];
    }
  });
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = Number.isFinite(deps.waitMs) && (deps.waitMs as number) > 0 ? (deps.waitMs as number) : 6_000;

  const readBuild = async (): Promise<string | null> => {
    const keys = await names();
    const hit = keys.find((k) => k.startsWith(CACHE_PREFIX));
    return hit === undefined ? null : hit.slice(CACHE_PREFIX.length);
  };

  if (nav === null || typeof nav.getRegistration !== 'function') {
    return { status: 'unsupported', build: await readBuild(), message: '这个环境没有离线缓存（开发版或隐私模式），不用更新。' };
  }

  let reg: { readonly update?: () => Promise<unknown> } | undefined;
  try {
    reg = await nav.getRegistration?.();
  } catch {
    reg = undefined;
  }
  if (!reg || typeof reg.update !== 'function') {
    return { status: 'unsupported', build: await readBuild(), message: '离线缓存还没注册好，稍后再试。' };
  }

  const before = await readBuild();
  try {
    await reg.update();
  } catch {
    return { status: 'current', build: before, message: '检查更新时断网了，稍后再试。' };
  }

  // 新 SW 接管是异步的（install 预缓存 → activate 换缓存名），给它一点时间。
  // **按次数轮询，不用 Date.now**：`tests/app/fullSession.smoke.test.ts` 的 SM#5 是机器化门禁
  // （`src/**` 除 `platform/clock.ts` 外零 `Date.now(`），首版就是在这里被它拦下的。
  const attempts = Math.max(1, Math.ceil(waitMs / 200));
  let now = await readBuild();
  for (let i = 0; i < attempts; i += 1) {
    if (now === null || before === null || now !== before) break;
    await sleep(200);
    now = await readBuild();
  }

  if (now !== null && before !== null && now !== before) {
    return { status: 'updated', build: now, message: `发现新版本（${now}）。点「立即更新」重新加载页面。` };
  }
  return { status: 'current', build: now ?? before, message: `已是最新（${now ?? before ?? '未知'}）。` };
}

/** 重新加载页面（由玩家点「立即更新」后调用；**绝不自动调用**）。 */
export function reloadPage(): void {
  try {
    location.reload();
  } catch {
    /* 极端环境下 reload 会抛；不因它崩掉设置页 */
  }
}
