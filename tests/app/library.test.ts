/**
 * tests/app/library.test.ts —— Plan 4 · T7：卡库写口（手写加卡 / 新建领域）。
 *
 * 这一层是 UI 与 coordinator 之间的**唯一加卡入口**（R-T7-p4-a），所以本文件用**真**
 * coordinator + memoryStore 取证，而不是假的 mutate 桩：
 * - LB#1 走完整落库链：mutate 写进存档 → flush → store.load 读回来仍是合法档（validateSave 通过），
 *   且新卡的 SRS 是 `createInitialSRS` 的口径（stability='new'、due=nowMs）；
 * - LB#2 全部拒绝面**不触存储**：cards 长度不变、写次数为 0（用写计数 spy 取证）；
 * - LB#3 只读态（坏档接管）下写口**回大白话拒绝**（不是抛异常）且零写入；第二道闩锁
 *   （mutate 抛 SaveReadOnlyError）由 LB#3b 用"readOnly() 说谎"的协调器单独取证。
 * - LB#5 时间域与 tags 域也在 mutate **之前**守住：NaN 时刻或非字符串标签若放进去，
 *   落盘自检会整包拒 ⇒ dirty 永久为真、此后任何改动都写不进（T7 评审判 I-2）。
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
      // Plan 6 · T5：作答模式与每日额度进档（迁移器为缺席档补同款缺省；
      // 夹具代表"当前形状的完整档"，缺席会让形状断言把归一化误读成丢字段——
      // 与上面 leaderboard 在 T7 时的理由逐字相同）。
      answerMode: 'choice',
      llmQuota: { day: '', cards: 0, judges: 0 },
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

  /**
   * Plan 5 · T4：`sourceType` 的溯源落库。
   * 判别力：把来源写死成 `'manual'` 的实现在 `'llm'` 那条上必红；而**不消毒**、把
   * 运行时脏值（`'preset'`/`'x'`）原样塞进 `source.type` 的实现会让落盘自检整包拒
   * （SOURCE_TYPES 不含它们）——`flush()` 与 `validateSave` 两条断言因此都必要。
   */
  it('LB#1c sourceType=llm 落 {type:"llm"}；脏值/缺省一律回落 manual 且仍能落盘', async () => {
    const { coord, store } = await makeCoord(seed());
    const llm = await addCard(coord, { front: 'f1', back: 'b1', deckId: 'deck-a', id: 'c-llm', nowMs: NOW, sourceType: 'llm' });
    expect(llm.ok).toBe(true);
    if (llm.ok) expect(llm.value.source).toEqual({ type: 'llm', createdAt: NOW });

    const manual = await addCard(coord, { front: 'f2', back: 'b2', deckId: 'deck-a', id: 'c-manual', nowMs: NOW });
    expect(manual.ok).toBe(true);
    if (manual.ok) expect(manual.value.source).toEqual({ type: 'manual', createdAt: NOW });

    const dirty = await addCard(coord, {
      front: 'f3',
      back: 'b3',
      deckId: 'deck-a',
      id: 'c-dirty',
      nowMs: NOW,
      sourceType: 'preset' as never,
    });
    expect(dirty.ok).toBe(true);
    if (dirty.ok) expect(dirty.value.source).toEqual({ type: 'manual', createdAt: NOW });

    expect(await coord.flush()).toBe(true);
    const persisted = await store.load();
    expect(persisted?.cards.map((c) => c.source?.type)).toEqual(['llm', 'manual', 'manual']);
    expect(() => validateSave(persisted)).not.toThrow();
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

  it('LB#5 脏时刻（NaN/Infinity/超界）→ ok:false 且零写入（否则整档永久写不进）', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
      const { coord, writes } = await makeCoord(seed());
      const res = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-a', id: 'x', nowMs: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain('时间');
      expect(writes()).toBe(0);
      // 关键取证：档还没被毒化——补一张合法卡仍能落盘
      const good = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-a', id: 'ok', nowMs: NOW });
      expect(good.ok).toBe(true);
      expect(await coord.flush()).toBe(true);
    }
  });

  it('LB#5b 非字符串标签 → ok:false 零写入；缺省则是空数组', async () => {
    const { coord, writes } = await makeCoord(seed());
    const bad = await addCard(coord, {
      front: 'f',
      back: 'b',
      deckId: 'deck-a',
      id: 'x',
      nowMs: NOW,
      // 类型层拦不住运行期脏值（JSON 反序列化/绕过类型），写口必须自己守
      tags: ['历史', 123] as unknown as string[],
    });
    expect(bad.ok).toBe(false);
    expect(writes()).toBe(0);

    const res = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-a', id: 'y', nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.tags).toEqual([]);
  });

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

/* ------------------------------------------------------------------ Plan 6 · T5 */

/**
 * `Card.choices` 随卡入库（Plan 6 · D41）：生成卡时由模型产出的干扰项要真的落进存档，
 * 否则选择题永远只能退回到"同领域其他卡的背面"这一级来源。
 */
describe('addCard —— 干扰项 choices（Plan 6 · T5）', () => {
  it('LB#C1 带 choices ⇒ 落盘保留（顺序不变）；flush 后仍是合法档', async () => {
    const { coord, store } = await makeCoord(seed());
    const res = await addCard(coord, {
      front: '唐朝开国皇帝是谁？',
      back: '李渊',
      deckId: 'deck-a',
      id: 'card-1',
      nowMs: NOW,
      choices: ['李世民', '杨坚', '赵匡胤'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.choices).toEqual(['李世民', '杨坚', '赵匡胤']);
    await coord.flush();
    const disk = await store.load();
    expect(disk?.cards[0].choices).toEqual(['李世民', '杨坚', '赵匡胤']);
    expect(validateSave(disk).ok).toBe(true);
  });

  it('LB#C2 缺席 / 空数组 / 全是脏项 ⇒ **不写该字段**（缺席 = 没有干扰项，不是空数组）', async () => {
    const { coord } = await makeCoord(seed());
    const a = await addCard(coord, { front: 'f', back: 'b', deckId: 'deck-a', id: 'c1', nowMs: NOW });
    expect(a.ok).toBe(true);
    if (a.ok) expect('choices' in a.value).toBe(false);

    const b = await addCard(coord, {
      front: 'f2', back: 'b2', deckId: 'deck-a', id: 'c2', nowMs: NOW, choices: [],
    });
    expect(b.ok).toBe(true);
    if (b.ok) expect('choices' in b.value).toBe(false);

    // 与答案相同 / 空串 / 非字符串 ⇒ 逐项剔除后为空 ⇒ 同样不写字段
    const c = await addCard(coord, {
      front: 'f3', back: '答案', deckId: 'deck-a', id: 'c3', nowMs: NOW,
      choices: ['答案', '   ', 7 as never],
    });
    expect(c.ok).toBe(true);
    if (c.ok) expect('choices' in c.value).toBe(false);
  });

  it('LB#C3 干扰项超上限 / 重复 ⇒ 按 core 口径净化（去重后取前 5 条）', async () => {
    const { coord } = await makeCoord(seed());
    const res = await addCard(coord, {
      front: 'f', back: 'b', deckId: 'deck-a', id: 'c1', nowMs: NOW,
      choices: [' 错1 ', '错1', '错2', '错3', '错4', '错5', '错6'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.choices).toEqual(['错1', '错2', '错3', '错4', '错5']); // 去重 + 截到 5
    expect(validateSave(coord.snapshot()).ok).toBe(true);
  });

  it('LB#C4 干扰项超长 ⇒ 按码点截到 200（不是整条丢掉）', async () => {
    const { coord } = await makeCoord(seed());
    const long = '乙'.repeat(300);
    const res = await addCard(coord, {
      front: 'f', back: 'b', deckId: 'deck-a', id: 'c1', nowMs: NOW, choices: [long],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const got = res.value.choices?.[0] ?? '';
    expect(Array.from(got).length).toBe(200);
    expect(validateSave(coord.snapshot()).ok).toBe(true);
  });
});
