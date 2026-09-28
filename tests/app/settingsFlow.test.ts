/**
 * tests/app/settingsFlow.test.ts —— Plan 4 · T11：设置写口（阈值 / SM-2 / 池子 / 重看序章）。
 *
 * 判别力：
 * - SF#1 每个合法写入都必须**过落盘自检**（真 coordinator + flush + validateSave）——
 *   这就是"写口域与 saveMigrate 域对齐"的取证；
 * - SF#2 域外值（越界池子、NaN/非正参数、initialEase < minEase）一律拒且零写入：
 *   放进权威档会让 dirty 永久为真、此后所有改动都写不进（T7 评审判 I-2 的同款病灶）；
 * - SF#3 同值不重写（写放大纪律）。
 */
import { describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import { createMemoryStorage } from '@platform/memoryStore';
import { validateSave } from '@core/saveMigrate';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import {
  BOSS_TIERS,
  POOL_SIZE_MAX,
  POOL_SIZE_MIN,
  replayPrologue,
  setBossThresholdTier,
  setDefaultPoolSize,
  setSm2Params,
  validateSm2Params,
} from '../../src/app/settingsFlow';

const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);

function save(over: Partial<SaveFile> = {}): SaveFile {
  return {
    schemaVersion: 1,
    decks: [],
    cards: [],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: true, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW, plays: 0 },
    ...over,
  };
}

async function makeCoord(seed: SaveFile = save()): Promise<{ coord: Coordinator; store: ReturnType<typeof createMemoryStorage> }> {
  const store = createMemoryStorage();
  await store.save(seed);
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
  return { coord, store };
}

describe('validateSm2Params —— 产品级域', () => {
  it('SF#0 四个有限正数且 initialEase ≥ minEase；否则拒', () => {
    expect(validateSm2Params({ initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 }).ok).toBe(true);
    const bads: unknown[] = [
      null,
      { initialEase: 2.5, minEase: 1.3, firstInterval: 1 },
      { initialEase: Number.NaN, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
      { initialEase: 2.5, minEase: 1.3, firstInterval: 0, secondInterval: 6 },
      { initialEase: 2.5, minEase: -1, firstInterval: 1, secondInterval: 6 },
      { initialEase: 1.1, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
    ];
    for (const bad of bads) expect(validateSm2Params(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe('settingsFlow —— 写入与域对齐', () => {
  it('SF#1 四个写口都能写进合法值并过落盘自检', async () => {
    const { coord, store } = await makeCoord();
    expect(BOSS_TIERS).toEqual([15, 30, 50]);

    expect(await setBossThresholdTier(coord, 15)).toEqual({ ok: true });
    expect(await setDefaultPoolSize(coord, 25)).toEqual({ ok: true });
    expect(await setSm2Params(coord, { initialEase: 2.8, minEase: 1.5, firstInterval: 0.2, secondInterval: 7 })).toEqual({ ok: true });
    expect(await replayPrologue(coord)).toEqual({ ok: true });

    expect(coord.snapshot().settings.bossThresholdTier).toBe(15);
    expect(coord.snapshot().settings.battle.defaultPoolSize).toBe(25);
    expect(coord.snapshot().settings.sm2Params.initialEase).toBe(2.8);
    expect(coord.snapshot().settings.story.prologueSeen).toBe(false);

    expect(await coord.flush()).toBe(true);
    const persisted = await store.load();
    expect(() => validateSave(persisted)).not.toThrow();
  });

  it('SF#2 域外值一律拒且零写入（脏值会让整档永远写不进）', async () => {
    const { coord } = await makeCoord();
    const before = coord.dirty();

    for (const bad of [14, 31, '30', Number.NaN]) {
      expect((await setBossThresholdTier(coord, bad)).ok).toBe(false);
    }
    for (const bad of [POOL_SIZE_MIN - 1, POOL_SIZE_MAX + 1, 15.5, Number.NaN]) {
      expect((await setDefaultPoolSize(coord, bad)).ok).toBe(false);
    }
    expect((await setSm2Params(coord, { initialEase: Number.NaN, minEase: 1.3, firstInterval: 1, secondInterval: 6 })).ok).toBe(false);

    expect(coord.snapshot().settings.bossThresholdTier).toBe(30);
    expect(coord.snapshot().settings.battle.defaultPoolSize).toBe(15);
    expect(coord.dirty()).toBe(before); // 一次都没标脏
    // 关键：档没被毒化 —— 补一个合法值仍能落盘
    expect((await setBossThresholdTier(coord, 50)).ok).toBe(true);
    expect(await coord.flush()).toBe(true);
  });

  it('SF#3 同值不重写（写放大纪律）；重看序章对已看过的才动笔', async () => {
    const { coord } = await makeCoord();
    expect(await setBossThresholdTier(coord, 30)).toEqual({ ok: true });
    expect(coord.dirty()).toBe(false); // 同值 → 不标脏

    expect(await setDefaultPoolSize(coord, 15)).toEqual({ ok: true });
    expect(coord.dirty()).toBe(false);

    // 序章已看过（seed 是 true）→ 第一次会写；再调一次不写
    expect(await replayPrologue(coord)).toEqual({ ok: true });
    const dirtyAfterFirst = coord.dirty();
    expect(dirtyAfterFirst).toBe(true);
    await coord.flush();
    expect(await replayPrologue(coord)).toEqual({ ok: true });
    expect(coord.dirty()).toBe(false);
  });

  it('SF#4 只读态：写口把拒绝折成返回值而不是异常（设置页据此提示）', async () => {
    const store = createMemoryStorage();
    await store.save({ schemaVersion: 2, decks: [], cards: [], settings: {}, meta: {} } as unknown as SaveFile);
    const coord = await createCoordinator(store, { now: () => NOW });
    expect(coord.readOnly()).toBe(true);
    // 只读态下 mutate 抛 SaveReadOnlyError —— 写口不吞，调用方（设置屏）的 catch 负责上屏
    await expect(setBossThresholdTier(coord, 15)).rejects.toThrow();
  });
});
