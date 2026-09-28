// @vitest-environment happy-dom
/**
 * tests/platform/assets.test.ts —— Plan 4 · T11：图片加载（精灵兜底）。
 *
 * 判别力：
 * - AS#2 加载失败/超时都**不 reject**，回一张带透明 data URL 的兜底图——把错误往上抛的
 *   实现会让"素材缺一张"变成"整个游戏起不来"（战斗屏挂载前就 await 了四张图）；
 * - AS#3 四张图并发等齐（loadSprites 的 hero/mob/boss/bg 各自来自对应路径：路径错位是
 *   最容易发生的低级错误，用"每张图收到的 src"直接钉死）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadImage, loadSprites, SPRITE_PATHS, TRANSPARENT_PNG } from '../../src/platform/assets';

afterEach(() => {
  document.body.replaceChildren();
});

/** 可控的假 Image：记录 src、可手动触发 load/error。 */
function fakeImageFactory(): { create: () => HTMLImageElement; images: HTMLImageElement[]; fireAll: (type: 'load' | 'error') => void } {
  const images: HTMLImageElement[] = [];
  const create = (): HTMLImageElement => {
    const img = document.createElement('img');
    images.push(img);
    return img;
  };
  return {
    create,
    images,
    fireAll: (type) => {
      for (const img of images) img.dispatchEvent(new Event(type));
    },
  };
}

describe('loadImage', () => {
  it('AS#1 成功路径：拿到的是同一张图（不是兜底）', async () => {
    const factory = fakeImageFactory();
    const p = loadImage('assets/sprites/hero.png', { createImage: factory.create, timeoutMs: 0 });
    factory.fireAll('load');
    const img = await p;
    expect(img.getAttribute('src')).toBe('assets/sprites/hero.png');
    expect(img).toBe(factory.images[0]);
  });

  it('AS#2 失败与超时都回兜底图（透明 1×1），永不 reject', async () => {
    const bad = fakeImageFactory();
    const failed = loadImage('assets/sprites/missing.png', { createImage: bad.create, timeoutMs: 0 });
    bad.fireAll('error');
    const fb = await failed;
    expect(fb.getAttribute('src')).toBe(TRANSPARENT_PNG);
    expect(fb).not.toBe(bad.images[0]);

    // 超时路径：不触发任何事件，靠注入的定时器到点放行
    const slow = fakeImageFactory();
    const pending = loadImage('assets/sprites/slow.png', { createImage: slow.create, timeoutMs: 10 });
    // 手动把注入的 setTimer 立刻触发
    const fast = loadImage('assets/sprites/slow.png', {
      createImage: slow.create,
      timeoutMs: 10,
      setTimer: (cb) => {
        cb();
        return 1;
      },
      clearTimer: () => undefined,
    });
    const slowFb = await pending.then(
      () => 'unexpected',
      () => 'rejected',
    ).then(() => fast).then((img) => img);
    expect(slowFb.getAttribute('src')).toBe(TRANSPARENT_PNG);
  });
});

describe('loadSprites', () => {
  it('AS#3 四张图各来自正确路径，并发等齐后一起返回', async () => {
    const factory = fakeImageFactory();
    const p = loadSprites(SPRITE_PATHS, { createImage: factory.create, timeoutMs: 0 });
    expect(factory.images).toHaveLength(4);
    expect(factory.images.map((i) => i.getAttribute('src'))).toEqual([
      SPRITE_PATHS.hero,
      SPRITE_PATHS.mob,
      SPRITE_PATHS.boss,
      SPRITE_PATHS.bg,
    ]);
    factory.fireAll('load');
    const sprites = await p;
    expect(Object.keys(sprites).sort()).toEqual(['bg', 'boss', 'hero', 'mob']);
    // StageImage 是 HTMLImageElement | ImageBitmap 的联合：本测试注入的是前者
    const src = (x: unknown): string | null => (x as HTMLImageElement).getAttribute('src');
  });

  it('AS#3b 缺图（error）时战斗素材仍是四件可用对象（hero 兜底、其余照常）', async () => {
    const factory = fakeImageFactory();
    const p = loadSprites(SPRITE_PATHS, { createImage: factory.create, timeoutMs: 0 });
    factory.images.forEach((img, i) => img.dispatchEvent(new Event(i === 0 ? 'error' : 'load')));
    const sprites = await p;
    const src = (x: unknown): string | null => (x as HTMLImageElement).getAttribute('src');
    expect(src(sprites.hero)).toBe(TRANSPARENT_PNG);
    expect(src(sprites.bg)).toBe(SPRITE_PATHS.bg);
  });
});
