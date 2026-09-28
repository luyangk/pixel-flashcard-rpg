/**
 * assets.ts —— Plan 4 · T11：精灵与背景的图片加载（浏览器侧）。
 *
 * 三个刻意的设计：
 * 1. **路径是字符串、不是 ESM 导入**：`assets/sprites/*.png` 由 vite.config 的复制插件
 *    原样带进产物；这样 JSON 里的 art 路径与代码里的精灵路径口径一致（一处真理）。
 * 2. **加载失败不抛、给透明兜底**：手机上可能因为文件缺失/解码失败（T9 素材尚未产出、
 *    缓存半截）拿不到图。此时若把 null 交给 `drawImage` 会抛 InvalidStateError，
 *    整场战斗黑屏——兜底成 1×1 透明 PNG 至少让战斗逻辑照常跑完。
 * 3. **全部并发等齐再返回**：战斗屏挂载前就把 4 张图准备好，避免首帧画到未解码的图。
 */
import type { StageSprites } from '../stage/renderer';

/** 运行时素材路径（与 assets/ 目录结构一一对应；T9 的正式素材原地替换，路径不变）。 */
export const SPRITE_PATHS = {
  hero: 'assets/sprites/hero.png',
  mob: 'assets/sprites/mob-1.png',
  boss: 'assets/sprites/boss-1.png',
  bg: 'assets/sprites/bg-arena.png',
} as const;

/** 1×1 全透明 PNG（兜底图；内联 data URL，避免为兜底再造一个文件）。 */
export const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface ImageLoaderDeps {
  /** 图片工厂覆盖位（测试注入假 Image）。 */
  readonly createImage?: () => HTMLImageElement;
  /** 超时毫秒（缺省 4000）：加载悬挂时也要放行，不能让启动卡死。 */
  readonly timeoutMs?: number;
  /** 定时器覆盖位（测试用）。 */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  readonly clearTimer?: (h: number) => void;
}

/**
 * 加载一张图。无论成功/失败/超时都 resolve（失败给透明兜底），**永不 reject**：
 * 素材是"锦上添花"，不该有能力让游戏起不来。
 */
export function loadImage(src: string, deps: ImageLoaderDeps = {}): Promise<HTMLImageElement> {
  const create = deps.createImage ?? (() => new Image());
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs >= 0 ? deps.timeoutMs : 4000;
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = deps.clearTimer ?? ((h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));

  return new Promise<HTMLImageElement>((resolve) => {
    let img: HTMLImageElement;
    try {
      img = create();
    } catch {
      resolve(fallbackImage(create));
      return;
    }
    let settled = false;
    let handle: number | null = null;
    const finish = (useFallback: boolean): void => {
      if (settled) return;
      settled = true;
      if (handle !== null) clearTimer(handle);
      if (useFallback) resolve(fallbackImage(create));
      else resolve(img);
    };

    img.addEventListener?.('load', () => finish(false));
    img.addEventListener?.('error', () => finish(true));
    img.src = src;
    if (timeoutMs > 0) handle = setTimer(() => finish(true), timeoutMs);
  });
}

/** 造一张兜底图（设置 src 前就 resolve，故调用方拿到的是"已可画"的占位）。 */
function fallbackImage(create: () => HTMLImageElement): HTMLImageElement {
  const img = create();
  img.src = TRANSPARENT_PNG;
  return img;
}

/** 舞台四件套（hero/mob/boss/bg），路径可覆盖以便将来接不同关卡素材。 */
export async function loadSprites(
  paths: { hero: string; mob: string; boss: string; bg: string } = SPRITE_PATHS,
  deps: ImageLoaderDeps = {},
): Promise<StageSprites> {
  const [hero, mob, boss, bg] = await Promise.all([
    loadImage(paths.hero, deps),
    loadImage(paths.mob, deps),
    loadImage(paths.boss, deps),
    loadImage(paths.bg, deps),
  ]);
  return { hero, mob, boss, bg };
}
