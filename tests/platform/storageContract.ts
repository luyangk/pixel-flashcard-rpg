/**
 * GameStorage 共享契约测试套件 —— memoryStore 与 idbStore 跑同一套。
 *
 * 契约（brief Step 1）：
 * 1. save → load roundtrip 保真；未写入时 load 得 null。
 * 2. clear → load 得 null。
 * 3. 并发双 save，load 得到「后发起」的那次（以 meta.savedAt 判别）。
 * 4. save 内部深拷贝：外部 mutate 入参不影响已存值。
 *
 * makeFactory 每次调用必须返回一个全新、彼此隔离的存储实例
 * （idb 侧对应独立 dbName，避免跨用例串档）。
 */

import { describe, expect, it } from 'vitest';
import type { Card, Deck, SaveFile, Settings, SRSState } from '@core/types';
import type { GameStorage } from '@platform/storage';

/** 构造一条合法存档；savedAt 兼作"哪一次写入更晚"的判别标记。 */
export function makeSave(savedAt: number, marker = 'base'): SaveFile {
  const srs: SRSState = {
    ease: 2.5,
    interval: 1,
    reps: 0,
    lapses: 0,
    due: 1761955200000,
    stability: 'new',
    effectiveReviewDays: [],
  };
  const card: Card = {
    id: `card-${marker}`,
    deckId: 'd1',
    front: '「卷灵」栖息在哪里？',
    back: '未净化的知识领域卡组中',
    source: { type: 'preset', createdAt: 1761955200000 },
    srs,
    tags: ['lore'],
  };
  const deck: Deck = { id: 'd1', name: '前端基础', isPreset: true, bossName: '文档荒废之灵' };
  const settings: Settings = {
    bossThresholdTier: 30,
    sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
  };
  return { schemaVersion: 1, decks: [deck], cards: [card], settings, meta: { savedAt, plays: 0 } };
}

export function runStorageContractSuite(
  label: string,
  makeFactory: () => Promise<() => Promise<GameStorage>>,
): void {
  describe(`GameStorage contract: ${label}`, () => {
    it('load 未写入时返回 null；save→load roundtrip 保真', async () => {
      const factory = await makeFactory();
      const store = await factory();
      expect(store.kind).toMatch(/^(idb|memory)$/);
      await expect(store.load()).resolves.toBeNull();

      const input = makeSave(1761955200000);
      await store.save(input);
      await expect(store.load()).resolves.toEqual(input);
    });

    it('clear 之后 load 返回 null，且可再次 save', async () => {
      const factory = await makeFactory();
      const store = await factory();
      await store.save(makeSave(1761955200000));
      await store.clear();
      await expect(store.load()).resolves.toBeNull();

      await store.save(makeSave(1762041600000, 'again'));
      const restored = await store.load();
      expect(restored).not.toBeNull();
      expect(restored!.meta.savedAt).toBe(1762041600000);
    });

    it('并发双 save 后 load 得到后发起的那次', async () => {
      const factory = await makeFactory();
      const store = await factory();
      const first = makeSave(1761955200000, 'first');
      const second = makeSave(1762041600000, 'second'); // 更晚发起，语义上应胜出
      await Promise.all([store.save(first), store.save(second)]);

      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.meta.savedAt).toBe(second.meta.savedAt);
      expect(loaded!.cards[0].id).toBe('card-second');
    });

    it('save 内部深拷贝：外部 mutate 入参不影响已存值', async () => {
      const factory = await makeFactory();
      const store = await factory();
      const input = makeSave(1761955200000);
      await store.save(input);

      // 模拟调用方在 save 完成后继续改动同一个对象（含嵌套引用）
      input.cards[0].front = '被篡改的问题';
      input.cards[0].srs.ease = 99;
      input.cards.push({ ...input.cards[0], id: 'injected' });
      input.decks.length = 0;
      input.meta.plays = 12345;

      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.cards).toHaveLength(1);
      expect(loaded!.cards[0].front).toBe('「卷灵」栖息在哪里？');
      expect(loaded!.cards[0].srs.ease).toBe(2.5);
      expect(loaded!.decks).toHaveLength(1);
      expect(loaded!.meta.plays).toBe(0);
    });

    it('两个实例互不可见（隔离性）', async () => {
      const factory = await makeFactory();
      const a = await factory();
      const b = await factory();
      await a.save(makeSave(1761955200000));
      await expect(b.load()).resolves.toBeNull();
    });
  });
}
