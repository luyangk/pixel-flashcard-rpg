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
import type { Card, SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { validateSave } from '@core/saveMigrate';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import {
  backfillPresetChoices,
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
      // Plan 6 · T5：作答模式与每日额度进档（迁移器为缺席档补同款缺省；
      // 夹具代表"当前形状的完整档"，缺席会让形状断言把归一化误读成丢字段——
      // 与上面 leaderboard 在 T7 时的理由逐字相同）。
      answerMode: 'choice',
      llmQuota: { day: '', cards: 0, judges: 0 },
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
      // D56：干扰项的形状也要拦（内容文件是手写的 —— 空白项/非字符串/超条数/超长都该当场红）
      ['choices 不是数组', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b', choices: 'x' }] }] }],
      ['choices 有空白项', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b', choices: ['  '] }] }] }],
      ['choices 有非字符串', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b', choices: [1] }] }] }],
      ['choices 超过上限', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b', choices: Array(9).fill('x') }] }] }],
      ['choices 超长', { decks: [{ id: 'd1', name: '甲', cards: [{ id: 'c', front: 'f', back: 'b', choices: ['字'.repeat(201)] }] }] }],
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

  it('PC#3c **每张预置卡都自带 3 条干扰项**（同领域、不重复、不等于答案、长度可控）', () => {
    // 为什么这条是硬契约：预置卡没有自带 choices 时，战斗只能吃池子 ——
    // 多领域合练就会串味（现场："生活常识的题里出现 AI 的选项"）。这条守着"开局就有选项"。
    const cards = presetJson.decks.flatMap((d) => d.cards);
    expect(cards).toHaveLength(30);
    for (const c of cards) {
      const choices = c.choices ?? [];
      expect(choices.length, `${c.id} 的干扰项不是 3 条`).toBe(3);
      expect(new Set(choices).size, `${c.id} 的干扰项内部重复`).toBe(3);
      for (const ch of choices) {
        expect(ch.trim().length, `${c.id} 有空白干扰项`).toBeGreaterThan(0);
        expect(ch, `${c.id} 的干扰项与答案相同`).not.toBe(c.back);
        expect(Array.from(ch).length, `${c.id} 的干扰项过长：${ch}`).toBeLessThanOrEqual(30);
      }
    }
  });

  it('PC#3d 预置干扰项会被**带进卡里**（加载器漏传 = 玩家看到的还是池子凑的选项）', async () => {
    const checked = validateContent(presetJson);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const { cards } = buildPresetEntities(checked.content, NOW);
    const life01 = cards.find((c) => c.id === 'life-01');
    expect(life01?.choices).toHaveLength(3);
    expect(life01?.choices).toContain('云层太高，雷声被云挡住了');
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

/* ------------------------------------------------------------------ D56：老档回填干扰项 */

/**
 * 判别力：
 * - PC#6 老档（预置卡没有选项）⇒ 一次回填后每张预置卡都有 3 条，且**一次落盘**；
 * - PC#7 **只补缺**：玩家重出过的选项、手写卡、已删的卡一律不动；
 * - PC#8 幂等：第二遍 `filled === 0` 且**零写入**（否则每次启动都会刷 savedAt）。
 */
describe('backfillPresetChoices —— 给已有存档补干扰项（D56）', () => {
  /** 一张最小的卡（本文件没有共享夹具，就地写一份最省的）。 */
  const cardOf = (id: string, sourceType: 'preset' | 'manual', choices?: string[]): Card => ({
    id,
    deckId: 'preset-life',
    front: `q-${id}`,
    back: `a-${id}`,
    tags: [],
    source: { type: sourceType, createdAt: NOW },
    ...(choices === undefined ? {} : { choices }),
    srs: { stability: 'new', due: NOW, ease: 2.5, interval: 0, reps: 0, lapses: 0, effectiveReviewDays: [] },
  });

  /** 老档：预置卡（无选项）+ 一张手写卡。 */
  function legacySave(): SaveFile {
    return {
      ...emptySave(),
      decks: [{ id: 'preset-life', name: '生活常识', isPreset: true }],
      cards: [cardOf('life-01', 'preset'), cardOf('life-02', 'preset'), cardOf('mine', 'manual')],
    };
  }

  it('PC#6 老档一次回填：每个预置卡补上 3 条，手写卡不动，一次落盘', async () => {
    const inner = createMemoryStorage();
    await inner.save(legacySave());
    const wrapped = wrapStore(inner);
    const coord = await createCoordinator(wrapped.store, { now: () => NOW, debounceMs: 0 });

    const res = await backfillPresetChoices(coord, presetJson);
    expect(res.filled).toBe(2);
    await coord.flush();

    const after = coord.snapshot().cards;
    expect(after.find((c) => c.id === 'life-01')?.choices).toHaveLength(3);
    expect(after.find((c) => c.id === 'life-02')?.choices).toHaveLength(3);
    expect(after.find((c) => c.id === 'mine')?.choices).toBeUndefined();
    expect(wrapped.writes()).toBe(1); // 一次批量写，不是两张卡两次
  });

  it('PC#7 只补缺：玩家重出过的选项原样保留', async () => {
    const seed = legacySave();
    seed.cards[0].choices = ['我自己重出的'];
    const inner = createMemoryStorage();
    await inner.save(seed);
    const coord = await createCoordinator(inner, { now: () => NOW, debounceMs: 0 });

    const res = await backfillPresetChoices(coord, presetJson);
    expect(res.filled).toBe(1); // 只有 life-02 缺
    expect(coord.snapshot().cards.find((c) => c.id === 'life-01')?.choices).toEqual(['我自己重出的']);
  });

  it('PC#7b 同 id 但不是预置卡（例如从别人的备份导进来）⇒ 绝不动它', async () => {
    const seed = legacySave();
    // id 撞上预置卡，但来源是手写 ⇒ 回填必须按**来源**判断，不能只看 id
    seed.cards[1] = { ...seed.cards[1], source: { type: 'manual', createdAt: NOW } };
    const inner = createMemoryStorage();
    await inner.save(seed);
    const coord = await createCoordinator(inner, { now: () => NOW, debounceMs: 0 });

    const res = await backfillPresetChoices(coord, presetJson);
    expect(res.filled).toBe(1); // 只有 life-01
    expect(coord.snapshot().cards.find((c) => c.id === 'life-02')?.choices).toBeUndefined();
  });

  it('PC#8 幂等：第二遍零改动、零写入', async () => {
    const inner = createMemoryStorage();
    await inner.save(legacySave());
    const wrapped = wrapStore(inner);
    const coord = await createCoordinator(wrapped.store, { now: () => NOW, debounceMs: 0 });

    await backfillPresetChoices(coord, presetJson);
    await coord.flush();
    const writesAfterFirst = wrapped.writes();
    const second = await backfillPresetChoices(coord, presetJson);
    await coord.flush();
    expect(second.filled).toBe(0);
    expect(wrapped.writes()).toBe(writesAfterFirst);
  });
});
