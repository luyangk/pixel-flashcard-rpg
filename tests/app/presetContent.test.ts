/**
 * tests/app/presetContent.test.ts —— Plan 4 · T11：预置内容种子（4 领域 / 30 张手写卡）。
 *
 * 判别力：
 * - PC#1 内容校验**逐项**都要有牙：空 id / 重复 id / 悬空领域 / 空正面 / 非字符串 tags
 *   各自必须让 `validateContent` 拒（把判据删掉任一条，本组就会红）；
 * - PC#3 真实 `assets/content/preset.json` 必须**整份过校验**（内容文件是手写的，
 *   一个笔误就会让新玩家拿不到新手套装——这条是内容与代码之间的契约）；
 * - PC#4 非空库一律不灌（老玩家不能被塞 30 张陌生卡），且**零写入**（写计数 spy 取证）；
 * - PC#5 只读态不灌**也不抛**（启动路径上抛异常 = 白屏）。
 */
import { describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { validateSave } from '@core/saveMigrate';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import {
  buildPresetEntities,
  contentCardCount,
  installPresetContent,
  isFreshLibrary,
  validateContent,
} from '../../src/app/presetContent';
import presetJson from '../../assets/content/preset.json';

const NOW = Date.UTC(2026, 9, 27, 8, 0, 0);

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

/** 合法的最小内容（两个领域各一卡）——用于逐项变体。 */
function content(): unknown {
  return {
    decks: [
      { id: 'd1', name: '甲', bossName: '甲·卷灵', cards: [{ id: 'c1', front: 'q', back: 'a', tags: ['x'] }] },
      { id: 'd2', name: '乙', cards: [{ id: 'c2', front: 'q2', back: 'a2' }] },
    ],
  };
}

function emptySave(): SaveFile {
  return {
    schemaVersion: 1,
    decks: [],
    cards: [],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: NOW - 1, plays: 0 },
  };
}

describe('validateContent —— 逐项有牙', () => {
  it('PC#1 合法内容通过；六类畸形各自被拒', () => {
    expect(validateContent(content()).ok).toBe(true);

    const cases: ReadonlyArray<[string, unknown]> = [
      ['不是对象', 42],
      ['没有领域', { decks: [] }],
      ['领域 id 为空', { decks: [{ id: '', name: '甲', cards: [] }] }],
      ['领域没有名字', { decks: [{ id: 'd1', name: '  ', cards: [] }] }],
      ['领域 id 重复', { decks: [{ id: 'd1', name: '甲', cards: [] }, { id: 'd1', name: '乙', cards: [] }] }],
      ['卡 id 重复', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b' }] }, { id: 'd2', name: '乙', cards: [{ id: 'c', front: 'f', back: 'b' }] }] }],
      ['卡正面为空', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: ' ', back: 'b' }] }] }],
      ['卡背面为空', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: '' }] }] }],
      ['tags 非字符串数组', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b', tags: [1] }] }] }],
      ['cards 不是数组', { decks: [{ id: 'd1', name: '甲', cards: 'x' }] }],
    ];
    for (const [why, bad] of cases) {
      const res = validateContent(bad);
      expect(res.ok, `应当拒绝：${why}`).toBe(false);
      if (!res.ok) expect(res.reason).toContain('预置内容有问题');
    }
  });

  it('PC#2 buildPresetEntities：卡 id 保真、溯源写 preset、SRS 是初始态、不共享引用', () => {
    const checked = validateContent(content());
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const built = buildPresetEntities(checked.content, NOW);

    expect(built.decks).toEqual([
      { id: 'd1', name: '甲', isPreset: true, bossName: '甲·卷灵' },
      { id: 'd2', name: '乙', isPreset: true },
    ]);
    expect(built.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(built.cards[0]).toMatchObject({
      id: 'c1',
      deckId: 'd1',
      front: 'q',
      back: 'a',
      source: { type: 'preset', createdAt: NOW },
      srs: { stability: 'new', due: NOW },
      tags: ['x'],
    });
    expect(contentCardCount(checked.content)).toBe(2);
  });
});

describe('真实内容文件（assets/content/preset.json）', () => {
  it('PC#3 整份过校验：4 个领域 / 30 张卡 / 引导领域 id 在场 / 全字段合法', () => {
    const checked = validateContent(presetJson);
    expect(checked.ok, checked.ok ? '' : (checked as { reason: string }).reason).toBe(true);
    if (!checked.ok) return;
    expect(checked.content.decks).toHaveLength(4);
    expect(contentCardCount(checked.content)).toBe(30);
    expect(checked.content.decks.map((d) => d.id)).toEqual(['preset-life', 'preset-tang', 'preset-root', 'preset-idiom']);
    // 引导领域（阈值特调 15）必须有足够卡数才可能在 3 天内达标
    const guide = checked.content.decks.find((d) => d.id === 'preset-life');
    expect(guide?.cards.length).toBeGreaterThanOrEqual(8);
  });

  it('PC#3b 引导域至少有 3 张卡含 ASCII 数字（假记忆演出的素材来源；终审 I-1）', () => {
    const checked = validateContent(presetJson);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const guide = checked.content.decks.find((d) => d.id === 'preset-life');
    const withDigit = (guide?.cards ?? []).filter((c) => /\d/.test(c.back));
    // fakeMemory.tamperNumber 只认 ASCII 数字：一张都没有 ⇒ 玩家最可能的首败看不到演出
    expect(withDigit.length, '引导域没有可数字篡改的答案').toBeGreaterThanOrEqual(3);
  });
});

describe('installPresetContent —— 只在空库灌', () => {
  it('PC#4 空库 → 灌入并被落盘自检接受；再次调用不再灌', async () => {
    const { coord, store } = await makeCoord(emptySave());
    expect(isFreshLibrary(coord.snapshot())).toBe(true);

    const first = await installPresetContent(coord, presetJson, NOW);
    expect(first).toEqual({ installed: true, decks: 4, cards: 30 });
    expect(coord.snapshot().cards).toHaveLength(30);

    expect(await coord.flush()).toBe(true);
    const persisted = await store.load();
    expect(() => validateSave(persisted)).not.toThrow();

    // 幂等：第二次因"非空库"直接跳过，存储写次数不再增加
    const second = await installPresetContent(coord, presetJson, NOW + 1000);
    expect(second.installed).toBe(false);
  });

  it('PC#4b 已有内容的档一律不灌、零写入（老玩家不被塞陌生卡）', async () => {
    const seed = emptySave();
    seed.decks = [{ id: 'mine', name: '我的领域', isPreset: false }];
    seed.cards = [
      {
        id: 'mine-1',
        deckId: 'mine',
        front: 'f',
        back: 'b',
        srs: { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, stability: 'new', effectiveReviewDays: [] },
        tags: [],
      },
    ];
    const { coord, writes } = await makeCoord(seed);
    const res = await installPresetContent(coord, presetJson, NOW);
    expect(res.installed).toBe(false);
    expect(coord.snapshot().cards).toHaveLength(1);
    expect(writes()).toBe(0);
  });

  it('PC#4c 内容坏了/时刻脏了 → 不灌、零写入（宁可不给新手套装，不给写不进的档）', async () => {
    const broken = { decks: [{ id: '', name: '甲', cards: [] }] };
    const a = await makeCoord(emptySave());
    expect((await installPresetContent(a.coord, broken, NOW)).installed).toBe(false);
    expect(a.writes()).toBe(0);

    const b = await makeCoord(emptySave());
    expect((await installPresetContent(b.coord, presetJson, Number.NaN)).installed).toBe(false);
    expect(b.writes()).toBe(0);
    expect(b.coord.snapshot().cards).toHaveLength(0);
  });

  it('PC#4d isFreshLibrary 是**合取**：只有领域无卡、或只有卡无领域，都不算空库（评审判 m-3）', async () => {
    // 只有领域（玩家建了领域还没加卡）：不该被塞 30 张陌生卡
    const decksOnly = emptySave();
    decksOnly.decks = [{ id: 'mine', name: '我的领域', isPreset: false }];
    expect(isFreshLibrary(decksOnly)).toBe(false);
    const a = await makeCoord(decksOnly);
    expect((await installPresetContent(a.coord, presetJson, NOW)).installed).toBe(false);
    expect(a.writes()).toBe(0);

    // 只有卡（历史档：cards 有内容但 decks 被清过）：同样不灌
    const cardsOnly = emptySave();
    cardsOnly.cards = [
      {
        id: 'c1',
        deckId: 'ghost',
        front: 'f',
        back: 'b',
        srs: { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, stability: 'new', effectiveReviewDays: [] },
        tags: [],
      },
    ];
    expect(isFreshLibrary(cardsOnly)).toBe(false);

    // 两者皆空才算空库（唯一会灌的形态）
    expect(isFreshLibrary(emptySave())).toBe(true);
  });

  it('PC#5 只读态（坏档接管）不灌也不抛——启动路径不能因为存档坏了而白屏', async () => {
    const { coord } = await makeCoord({ schemaVersion: 2, decks: [], cards: [], settings: {}, meta: {} });
    expect(coord.readOnly()).toBe(true);
    const res = await installPresetContent(coord, presetJson, NOW);
    expect(res.installed).toBe(false);
    if (!res.installed) expect(res.reason).toContain('只读');
  });
});
