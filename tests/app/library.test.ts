/**
 * tests/app/library.test.ts —— Plan 4 · T7：卡库写口（手写加卡 / 新建领域）。
 *
 * 这一层是 UI 与 coordinator 之间的**唯一加卡入口**（R-T7-p4-a），所以本文件用**真**
 * coordinator + memoryStore 取证，而不是假的 mutate 桩：
 * - LB#1 走完整落库链：mutate 写进存档 → flush → store.load 读回来仍是合法档（validateSave 通过），
 *   且新卡的 SRS 是 `createInitialSRS` 的口径（stability='new'、due=nowMs）；
 * - LB#2 全部拒绝面**不触存储**：cards 长度不变、写次数为 0（用写计数 spy 取证）；
 * - LB#3 只读态（坏档接管）下写口抛 SaveReadOnlyError，绝不静默失败。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { validateSave } from '@core/saveMigrate';
import { addCard, addDeck } from '../../src/app/library';
import { SaveReadOnlyError, createCoordinator, type Coordinator } from '../../src/app/persist';

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);

/** 写计数 spy：拒绝面必须由"存储一次都没写"取证，而不是靠读回来的值猜。 */
function wrapStore(inner: GameStorage): { store: GameStorage; writes: () => number } {
  let writes = 0;
  return {
    store: {
      kind: inner.kind,
      load: () => inner.load(),
      clear: () => inner.clear(),
      save: (f: SaveFile) => {
        writes += 1;
        return inner.save(f);
      },
    },
    writes: () => writes,
  };
}

async function makeCoord(seed?: unknown): Promise<{ coord: Coordinator; writes: () => number; store: GameStorage }> {
  const inner = createMemoryStorage();
  if (seed !== undefined) await inner.save(seed as SaveFile);
  const wrapped = wrapStore(inner);
  const coord = await createCoordinator(wrapped.store, { now: () => NOW, debounceMs: 0 });
  return { coord, writes: wrapped.writes, store: wrapped.store };
}

/** 一份带领域与一张卡的合法档（写死在测试里，不 import persist 的种子档）。 */
function seed(over: Partial<SaveFile> = {}): SaveFile {
  return {
    schemaVersion: 1,
    decks: [{ id: 'deck-a', name: '生活常识', isPreset: true }],
    cards: [],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW - 1000, plays: 0 },
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('addCard —— 成功路径（真落库）', () => {
  it('LB#1 卡进档、SRS 是初始态、flush 后从存储读回来仍是合法档', async () => {
    const { coord, store } = await makeCoord(seed());
    const res = await addCard(coord, {
      front: '唐朝开国皇帝是谁？',
      back: '李渊',
      deckId: 'deck-a',
      id: 'card-1',
      nowMs: NOW,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      id: 'card-1',
      deckId: 'deck-a',
      front: '唐朝开国皇帝是谁？',
      back: '李渊',
      source: { type: 'manual', createdAt: NOW },
      srs: {
        ease: 2.5,
        interval: 0,
        reps: 0,
        lapses: 0,
        due: NOW,
        stability: 'new',
        effectiveReviewDays: [],
      },
      tags: [],
    });

    expect(await coord.flush()).toBe(true);
    const persisted = await store.load();
    expect(persisted?.cards.map((c) => c.id)).toEqual(['card-1']);
    expect(() => validateSave(persisted)).not.toThrow(); // 落盘自检面（引用闭合也算）
  });

  it('LB#1b tags 缺省为空数组，且传入的 tags 被复制（不共享引用）', async () => {
    const { coord } = await makeCoord(seed());
    const tags = ['历史'];
    const res = await addCard(coord, {
      front: 'f',
      back: 'b',
      deckId: 'deck-a',
      id: 'card-2',
      nowMs: NOW,
      tags,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    tags.push('污染');
    expect(res.value.tags).toEqual(['历史']);
  });
});

describe('addCard —— 拒绝面（不触存储）', () => {
  const cases: ReadonlyArray<{ why: string; input: Parameters<typeof addCard>[1] }> = [
    { why: '正面空白', input: { front: '   ', back: 'b', deckId: 'deck-a', id: 'x1', nowMs: NOW } },
    { why: '背面为空串', input: { front: 'f', back: '', deckId: 'deck-a', id: 'x2', nowMs: NOW } },
    { why: '领域不存在', input: { front: 'f', back: 'b', deckId: 'deck-ghost', id: 'x3', nowMs: NOW } },
    { why: 'id 空白', input: { front: 'f', back: 'b', deckId: 'deck-a', id: '  ', nowMs: NOW } },
  ];

  for (const c of cases) {
    it(`LB#2 ${c.why} ⇒ ok:false 且零写入`, async () => {
      const { coord, writes } = await makeCoord(seed());
      const res = await addCard(coord, c.input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason.length).toBeGreaterThan(0);
      expect(coord.snapshot().cards).toHaveLength(0);
      expect(writes()).toBe(0);
    });
  }

  it('LB#2b 重复 id 拒绝（重复 id 会让落盘自检整包拒，必须在这里挡住）', async () => {
    const { coord, writes } = await makeCoord(seed());
    const ok = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-a', id: 'dup', nowMs: NOW });
    expect(ok.ok).toBe(true);
    const before = writes();
    const again = await addCard(coord, { front: 'f2', back: 'b2', deckId: 'deck-a', id: 'dup', nowMs: NOW });
    expect(again.ok).toBe(false);
    expect(coord.snapshot().cards).toHaveLength(1);
    expect(writes()).toBe(before); // 第二次一次都没写
  });
});

describe('addCard —— 只读态', () => {
  it('LB#3 坏档接管后写口回大白话拒绝且零写入（闩锁仍在 mutate 内兜底）', async () => {
    const bad = { schemaVersion: 2, decks: [], cards: [], settings: {}, meta: { savedAt: 0, plays: 0 } };
    const { coord, writes } = await makeCoord(bad);
    expect(coord.readOnly()).toBe(true);

    const res = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-a', id: 'c', nowMs: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('只读保护');
    expect(coord.snapshot().cards).toHaveLength(0);
    expect(writes()).toBe(0);

    const deck = await addDeck(coord, { name: '唐诗', id: 'deck-t' });
    expect(deck.ok).toBe(false);
    expect(writes()).toBe(0);
  });

  it('LB#3b 绕过预判也拦得住：闩锁抛 SaveReadOnlyError，写口不吞异常', async () => {
    // 直接构造一个"readOnly() 说谎"的协调器，证明第二道闩锁真的在（而不是只靠第一道判断）
    const base = await makeCoord(seed());
    const lying: Coordinator = {
      ...base.coord,
      readOnly: () => false,
      mutate: () => Promise.reject(new SaveReadOnlyError('addCard')),
    };
    await expect(
      addCard(lying, { front: 'f', back: 'b', deckId: 'deck-a', id: 'c', nowMs: NOW }),
    ).rejects.toBeInstanceOf(SaveReadOnlyError);
  });
});

describe('addDeck', () => {
  it('LB#4 建领域成功；空名/同名/同 id 拒绝且零写入', async () => {
    const { coord, writes } = await makeCoord(seed());
    const ok = await addDeck(coord, { name: '唐诗', id: 'deck-tang' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toEqual({ id: 'deck-tang', name: '唐诗', isPreset: false });
    expect(coord.snapshot().decks.map((d) => d.id)).toEqual(['deck-a', 'deck-tang']);

    const before = writes();
    for (const input of [
      { name: '   ', id: 'deck-x' },
      { name: '唐诗', id: 'deck-y' },
      { name: '别的名字', id: 'deck-tang' },
    ]) {
      const res = await addDeck(coord, input);
      expect(res.ok).toBe(false);
    }
    expect(coord.snapshot().decks).toHaveLength(2);
    expect(writes()).toBe(before);
  });

  it('LB#4b 空库先建领域再加卡 ⇒ 引用闭合，落盘自检通过', async () => {
    const empty: SaveFile = { ...seed(), decks: [], cards: [] };
    const { coord, store } = await makeCoord(empty);
    const deck = await addDeck(coord, { name: '我的领域', id: 'deck-me' });
    expect(deck.ok).toBe(true);
    const card = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-me', id: 'c1', nowMs: NOW });
    expect(card.ok).toBe(true);

    expect(await coord.flush()).toBe(true);
    const persisted = await store.load();
    expect(() => validateSave(persisted)).not.toThrow();
  });
});
