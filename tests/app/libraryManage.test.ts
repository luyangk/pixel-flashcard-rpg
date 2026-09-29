/**
 * tests/app/libraryManage.test.ts —— Plan 5 追加：领域改名 / 删除领域 / 删除单卡。
 *
 * 用户实测反馈："新建领域后不知道如何删除或修改"——这一波补的三个写口。
 *
 * 判别力：
 * - LM#2 删领域必须**连同它的卡一起删**：只删领域的实现会让下一步落盘自检整包失败
 *   （断言"flush 后 validateSave 通过 + 存储里卡也没了"，只删领域必红）；
 * - LM#3 改名要挡重名与超长：不挡的实现会写出两个同名领域（屏上再也分不清）；
 * - LM#4 三个写口的拒绝面都不触存储（写计数为 0），只读态给可上屏 reason。
 */
import { describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { validateSave } from '@core/saveMigrate';
import { DECK_NAME_MAX, addCard, removeCard, removeDeck, renameDeck, updateCard } from '../../src/app/library';
import { createCoordinator, type Coordinator } from '../../src/app/persist';

const NOW = Date.UTC(2026, 9, 28, 6, 0, 0);

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

function card(id: string, deckId: string) {
  return {
    id,
    deckId,
    front: `q-${id}`,
    back: `a-${id}`,
    srs: { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, stability: 'new' as const, effectiveReviewDays: [] },
    tags: [],
  };
}

function seed(): SaveFile {
  return {
    schemaVersion: 1,
    decks: [
      { id: 'd1', name: '唐诗', isPreset: false },
      { id: 'd2', name: '词根', isPreset: false },
    ],
    cards: [card('c1', 'd1'), card('c2', 'd1'), card('c3', 'd2')],
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
  };
}

async function makeCoord(seedSave: SaveFile = seed()): Promise<{ coord: Coordinator; writes: () => number; store: GameStorage }> {
  const inner = createMemoryStorage();
  await inner.save(seedSave);
  const wrapped = wrapStore(inner);
  const coord = await createCoordinator(wrapped.store, { now: () => NOW, debounceMs: 0 });
  return { coord, writes: wrapped.writes, store: wrapped.store };
}

describe('renameDeck —— 改领域名', () => {
  it('LM#1 改名成功；同值不重写（写放大纪律）', async () => {
    const { coord, writes } = await makeCoord();
    const res = await renameDeck(coord, { deckId: 'd1', name: '  唐诗精选  ' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.name).toBe('唐诗精选'); // trim 过
    expect(coord.snapshot().decks[0].name).toBe('唐诗精选');

    const before = writes();
    const same = await renameDeck(coord, { deckId: 'd1', name: '唐诗精选' });
    expect(same.ok).toBe(true);
    expect(writes()).toBe(before); // 同值一次都没写
  });

  it('LM#2 空名/超长/重名/不存在的领域都被拒，且零写入', async () => {
    const { coord, writes } = await makeCoord();
    const before = writes();
    const cases: Array<[string, { deckId: string; name: string }]> = [
      ['空名', { deckId: 'd1', name: '   ' }],
      ['超长', { deckId: 'd1', name: '字'.repeat(DECK_NAME_MAX + 1) }],
      ['与别的领域重名', { deckId: 'd1', name: '词根' }],
      ['领域不存在', { deckId: 'ghost', name: '新名' }],
      ['没指定领域', { deckId: '', name: '新名' }],
    ];
    for (const [why, input] of cases) {
      const res = await renameDeck(coord, input);
      expect(res.ok, why).toBe(false);
      if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
    }
    expect(writes()).toBe(before);
    expect(coord.snapshot().decks.map((d) => d.name)).toEqual(['唐诗', '词根']);
  });

  it('LM#2b 恰好 30 个字合法（边界不误杀）', async () => {
    const { coord } = await makeCoord();
    const res = await renameDeck(coord, { deckId: 'd1', name: '字'.repeat(DECK_NAME_MAX) });
    expect(res.ok).toBe(true);
  });
});

describe('removeDeck —— 删领域（连同卡）', () => {
  it('LM#3 删领域连同它的卡一起删，落盘自检仍通过（只删领域的实现必红）', async () => {
    const { coord, store } = await makeCoord();
    const res = await removeDeck(coord, { deckId: 'd1' });
    expect(res).toEqual({ ok: true, value: { cards: 2 } }); // 如实回被删的卡数

    const save = coord.snapshot();
    expect(save.decks.map((d) => d.id)).toEqual(['d2']);
    expect(save.cards.map((c) => c.id)).toEqual(['c3']); // d1 的两张卡没了
    expect(save.cards.every((c) => c.deckId !== 'd1')).toBe(true); // 引用闭合

    expect(await coord.flush()).toBe(true); // 只删领域 ⇒ 悬空 deckId ⇒ 这里会 false
    const persisted = await store.load();
    expect(() => validateSave(persisted)).not.toThrow();
  });

  it('LM#3b 领域不存在 / 没指定 ⇒ 拒绝且零写入', async () => {
    const { coord, writes } = await makeCoord();
    const before = writes();
    expect((await removeDeck(coord, { deckId: 'ghost' })).ok).toBe(false);
    expect((await removeDeck(coord, { deckId: '' })).ok).toBe(false);
    expect(writes()).toBe(before);
    expect(coord.snapshot().decks).toHaveLength(2);
  });

  it('LM#4 只读态：三个写口都给可上屏 reason（不抛、不写）', async () => {
    const bad = { schemaVersion: 2 } as unknown as SaveFile;
    const { coord, writes } = await makeCoord(bad);
    expect(coord.readOnly()).toBe(true);

    for (const res of [
      await renameDeck(coord, { deckId: 'd1', name: 'x' }),
      await removeDeck(coord, { deckId: 'd1' }),
      await removeCard(coord, { cardId: 'c1' }),
    ]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain('只读保护');
    }
    expect(writes()).toBe(0);
  });
});

describe('removeCard —— 删单张卡', () => {
  it('LM#5 删一张卡：只动它，其它卡与领域不受影响；不存在则拒', async () => {
    const { coord } = await makeCoord();
    const res = await removeCard(coord, { cardId: 'c1' });
    expect(res).toEqual({ ok: true, value: { id: 'c1' } });
    expect(coord.snapshot().cards.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(coord.snapshot().decks).toHaveLength(2);

    expect((await removeCard(coord, { cardId: 'c1' })).ok).toBe(false); // 已经删过了
    expect((await removeCard(coord, { cardId: '' })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ Plan 8 · T7 */

/**
 * updateCard —— 就地改正背面（Plan 8 · T7）。
 *
 * 为什么需要：`addCard` 只能加、`removeCard` 只能删，"看到错字只能删了重加"是这个功能
 * 最别扭的地方（用户实测反馈里也点到过"不知道如何修改"）。
 *
 * 判别力：
 * - UM#1 改完真的落盘、`flush` 后过 `validateSave`；
 * - UM#2 同值不重写（写放大纪律）；
 * - UM#3 空正面/空背面拒绝、卡不存在拒绝、只读态拒绝（与 addCard 同款闸门）；
 * - UM#4 **新背面撞上某条干扰项 ⇒ 把那条剔掉**（否则选择题会出现"干扰项就是正确答案"）；
 * - UM#5 改内容不动 SRS / 不动来源（改的是文案，不是学习进度）。
 */
describe('updateCard —— 就地改正背面（Plan 8 · T7）', () => {
  async function makeOne() {
    const { coord, writes, store } = await makeCoord();
    const res = await addCard(coord, {
      front: '唐朝开国皇帝是谁？',
      back: '李渊',
      deckId: 'd1',
      id: 'u1',
      nowMs: NOW,
      choices: ['李世民', '杨坚', '赵匡胤'],
    });
    expect(res.ok).toBe(true);
    return { coord, writes, store };
  }

  it('UM#1 改内容成功并落盘（过 validateSave）', async () => {
    const { coord, store } = await makeOne();
    const res = await updateCard(coord, { cardId: 'u1', front: '唐朝第一个皇帝是谁？', back: '李渊（唐高祖）' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.front).toBe('唐朝第一个皇帝是谁？');
    expect(res.value.back).toBe('李渊（唐高祖）');
    await coord.flush();
    const disk = await store.load();
    const card = disk?.cards.find((c) => c.id === 'u1');
    expect(card?.back).toBe('李渊（唐高祖）');
    expect(validateSave(disk).ok).toBe(true);
  });

  it('UM#2 同值不重写（不点亮 dirty）', async () => {
    const { coord } = await makeOne();
    await coord.flush();
    const res = await updateCard(coord, { cardId: 'u1', front: '唐朝开国皇帝是谁？', back: '李渊' });
    expect(res.ok).toBe(true);
    expect(coord.dirty()).toBe(false);
  });

  it('UM#3 空值 / 卡不存在 / 只读态都拒绝且不写盘', async () => {
    const { coord, store } = await makeOne();
    await coord.flush();
    const before = JSON.stringify(await store.load());

    for (const bad of [
      { cardId: 'u1', front: '   ', back: 'x' },
      { cardId: 'u1', front: 'x', back: '' },
      { cardId: 'nope', front: 'x', back: 'y' },
      { cardId: '', front: 'x', back: 'y' },
    ]) {
      const res = await updateCard(coord, bad);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(await store.load())).toBe(before);

    // 只读态：坏档 ⇒ 闩锁
    const roStore = createMemoryStorage();
    await roStore.save({ schemaVersion: 99 } as unknown as SaveFile);
    const ro = await createCoordinator(roStore, { now: () => NOW, debounceMs: 0 });
    const roRes = await updateCard(ro, { cardId: 'u1', front: 'x', back: 'y' });
    expect(roRes.ok).toBe(false);
    if (!roRes.ok) expect(roRes.reason.length).toBeGreaterThan(0);
  });

  it('UM#4 新背面撞上某条干扰项 ⇒ 那条被剔掉，其余保留', async () => {
    const { coord } = await makeOne();
    const res = await updateCard(coord, { cardId: 'u1', front: '唐朝开国皇帝是谁？', back: '李世民' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // "李世民"原本是干扰项之一，现在成了正确答案 ⇒ 它不能继续当干扰项
    expect(res.value.choices).toEqual(['杨坚', '赵匡胤']);
  });

  it('UM#5 改内容不动 SRS 与来源', async () => {
    const { coord } = await makeOne();
    const before = coord.snapshot().cards.find((c) => c.id === 'u1');
    await updateCard(coord, { cardId: 'u1', front: '新正面', back: '新背面' });
    const after = coord.snapshot().cards.find((c) => c.id === 'u1');
    expect(after?.srs).toEqual(before?.srs);
    expect(after?.source).toEqual(before?.source);
  });
});
