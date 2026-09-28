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
  setAnswerMode,
  setBossThresholdTier,
  setDefaultPoolSize,
  setLlmQuota,
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
      // Plan 6 · T5：作答模式与每日额度进档（迁移器为缺席档补同款缺省；
      // 夹具代表"当前形状的完整档"，缺席会让形状断言把归一化误读成丢字段——
      // 与上面 leaderboard 在 T7 时的理由逐字相同）。
      answerMode: 'choice',
      llmQuota: { day: '', cards: 0, judges: 0 },
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

/* ------------------------------------------------------------------ Plan 6 · T5 */

describe('setAnswerMode / setLlmQuota（Plan 6 · T5）', () => {
  it('SF#A1 切换作答模式成功并**真的落盘**（过 validateSave 自检）', async () => {
    const { coord, store } = await makeCoord();
    const res = await setAnswerMode(coord, 'qa');
    expect(res.ok).toBe(true);
    expect(coord.snapshot().settings.answerMode).toBe('qa');
    await coord.flush();
    const disk = await store.load();
    expect(disk?.settings.answerMode).toBe('qa');
    expect(validateSave(disk).ok).toBe(true);
    expect(await setAnswerMode(coord, 'choice')).toEqual({ ok: true });
    expect(coord.snapshot().settings.answerMode).toBe('choice');
  });

  it('SF#A2 域外值拒绝且**零写入**；同值不重写（写放大纪律）', async () => {
    const { coord, store } = await makeCoord();
    for (const bad of ['x', true, 1, null, undefined, {}]) {
      const res = await setAnswerMode(coord, bad);
      expect(res.ok, String(bad)).toBe(false);
      if (!res.ok) expect(res.reason).toContain('作答');
    }
    await coord.flush();
    expect((await store.load())?.settings.answerMode ?? 'choice').toBe('choice');

    // 同值：写入计数取证（markDirty 不该被触发 ⇒ 存储保持 clean）
    await setAnswerMode(coord, 'choice');
    expect(coord.dirty()).toBe(false);
  });

  it('SF#Q1 写额度：脏值拒绝（负数/小数/NaN/空 day），合法值落盘', async () => {
    const { coord, store } = await makeCoord();
    for (const bad of [
      { day: 7, cards: 0, judges: 0 },
      { day: '2026-10-01', cards: -1, judges: 0 },
      { day: '2026-10-01', cards: 0, judges: 1.5 },
      null,
      'nope',
    ]) {
      const res = await setLlmQuota(coord, bad as never);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (!res.ok) expect(res.reason).toContain('额度');
    }
    // 空串 day 合法（= 未记录，与缺省值同形）
    expect(await setLlmQuota(coord, { day: '', cards: 0, judges: 0 })).toEqual({ ok: true });
    const good = { day: '2026-10-01', cards: 7, judges: 9 };
    expect(await setLlmQuota(coord, good)).toEqual({ ok: true });
    expect(coord.snapshot().settings.llmQuota).toEqual(good);
    await coord.flush();
    expect((await store.load())?.settings.llmQuota).toEqual(good);
    expect(validateSave(await store.load()).ok).toBe(true);
  });

  it('SF#Q2 额度在只读态下如实失败（不谎报成功）', async () => {
    // 坏档 ⇒ 只读闩锁
    const store = createMemoryStorage();
    await store.save({ schemaVersion: 99 } as unknown as SaveFile);
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    expect(coord.readOnly()).toBe(true);
    await expect(setLlmQuota(coord, { day: '2026-10-01', cards: 1, judges: 1 })).rejects.toBeInstanceOf(Error);
    await expect(setAnswerMode(coord, 'qa')).rejects.toBeInstanceOf(Error);
  });
});
