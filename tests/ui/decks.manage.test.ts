// @vitest-environment happy-dom
/**
 * tests/ui/decks.manage.test.ts —— Plan 5 追加：卡组页的「领域管理」（改名 / 删除）与删卡。
 *
 * 用户实测："新建领域后不知道如何删除或修改。"
 *
 * 判别力：
 * - DM#2 删除**必须两步**：第一次点击只进确认态、绝不调写口（一步就删的实现必红）；
 * - DM#3 改名走注入写口、成功后退出编辑态；失败时**留在编辑态**并把原因上屏
 *   （退出编辑态的实现会让玩家的输入凭空消失）；
 * - DM#4 取消改名/取消删除 ⇒ 零写入。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, Deck } from '@core/types';
import { mountDecks, type DecksDeps } from '../../src/ui/decks';
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

interface Rig {
  readonly root: HTMLElement;
  readonly renamed: Array<{ deckId: string; name: string }>;
  readonly removedDecks: string[];
  readonly removedCards: string[];
  renameResult: (input: { deckId: string; name: string }) => { ok: boolean; reason?: string; name?: string };
  removeDeckResult: (id: string) => { ok: boolean; reason?: string; cards?: number };
}

function saveWith(): ReturnType<typeof makeSave> {
  const decks: Deck[] = [makeDeck('d1', '唐诗'), makeDeck('d2', '词根')];
  const cards: Card[] = [makeCard('c1', { deckId: 'd1' }), makeCard('c2', { deckId: 'd1' }), makeCard('c3', { deckId: 'd2' })];
  return makeSave({ decks, cards });
}

function makeRig(opts: { deps?: Partial<DecksDeps> } = {}): Rig {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWith() }));
  const rig: Rig = {
    root,
    renamed: [],
    removedDecks: [],
    removedCards: [],
    renameResult: (input) => ({ ok: true, name: input.name }),
    removeDeckResult: () => ({ ok: true, cards: 2 }),
  };
  mountDecks(root, ctrl, {
    toastMs: 0,
    newId: () => 'id-1',
    renameDeck: (input) => {
      rig.renamed.push(input);
      const r = rig.renameResult(input);
      return Promise.resolve(
        r.ok
          ? { ok: true as const, value: makeDeck(input.deckId, r.name ?? input.name) }
          : { ok: false as const, reason: r.reason ?? '改名失败' },
      );
    },
    removeDeck: (input) => {
      rig.removedDecks.push(input.deckId);
      const r = rig.removeDeckResult(input.deckId);
      return Promise.resolve(
        r.ok ? { ok: true as const, value: { cards: r.cards ?? 0 } } : { ok: false as const, reason: r.reason ?? '删除失败' },
      );
    },
    removeCard: (input) => {
      rig.removedCards.push(input.cardId);
      return Promise.resolve({ ok: true as const, value: { id: input.cardId } });
    },
    ...opts.deps,
  });
  return rig;
}

describe('mountDecks —— 领域管理（改名/删除）', () => {
  it('DM#1 每个领域一行，显示名字与卡数；入口齐备', () => {
    const rig = makeRig();
    const rows = all(rig.root, '[data-deck-manage]');
    expect(rows.map((r) => r.getAttribute('data-deck-manage'))).toEqual(['d1', 'd2']);
    expect((rows[0].querySelector('[data-deck-name="d1"]') as HTMLElement).textContent).toContain('唐诗');
    expect(rows[0].querySelector('[data-deck-rename="d1"]')).not.toBeNull();
    expect(rows[0].querySelector('[data-deck-delete="d1"]')).not.toBeNull();
    // 卡数如实（d1 有两张）
    expect((rows[0].querySelector('[data-deck-name="d1"]') as HTMLElement).textContent).toBe('唐诗（2 张）');
  });

  it('DM#2 删除**两步**：第一次点击只进确认态、写口零调用；第二次才真删', async () => {
    const rig = makeRig();
    click(rig.root.querySelector('[data-deck-delete="d1"]') as HTMLElement);
    expect(rig.removedDecks).toEqual([]); // 一步就删的实现必红
    expect((rig.root.querySelector('[data-deck-delete="d1"]') as HTMLElement).textContent).toContain('确认删除');
    expect((rig.root.querySelector('[data-deck-delete="d1"]') as HTMLElement).textContent).toContain('2 张卡'); // 告知代价

    click(rig.root.querySelector('[data-deck-delete="d1"]') as HTMLElement);
    await flushMicrotasks();
    expect(rig.removedDecks).toEqual(['d1']);
    expect(ui(rig.root, 'toast').textContent).toContain('连同 2 张卡');
  });

  it('DM#2b 删除失败（只读态等）⇒ 原因上屏，且不假装成功', async () => {
    const rig = makeRig();
    rig.removeDeckResult = () => ({ ok: false, reason: '存档没法读取（只读保护中）。' });
    click(rig.root.querySelector('[data-deck-delete="d1"]') as HTMLElement);
    click(rig.root.querySelector('[data-deck-delete="d1"]') as HTMLElement);
    await flushMicrotasks();
    expect(ui(rig.root, 'toast').textContent).toContain('只读保护');
  });

  it('DM#3 改名：进编辑态 → 保存调写口一次；成功后退出编辑态并提示', async () => {
    const rig = makeRig();
    click(rig.root.querySelector('[data-deck-rename="d1"]') as HTMLElement);
    const input = rig.root.querySelector('[data-deck-rename-input="d1"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('唐诗'); // 预填旧名，方便微调
    input.value = '唐诗精选';

    click(rig.root.querySelector('[data-deck-rename-confirm="d1"]') as HTMLElement);
    await flushMicrotasks();
    expect(rig.renamed).toEqual([{ deckId: 'd1', name: '唐诗精选' }]);
    expect(ui(rig.root, 'toast').textContent).toContain('唐诗精选');
    expect(rig.root.querySelector('[data-deck-rename-input="d1"]')).toBeNull(); // 退出编辑态
  });

  it('DM#3b 改名失败 ⇒ 原因上屏且**留在编辑态**（输入不凭空消失）', async () => {
    const rig = makeRig();
    rig.renameResult = () => ({ ok: false, reason: '已经有同名领域了——换个名字吧。' });
    click(rig.root.querySelector('[data-deck-rename="d1"]') as HTMLElement);
    (rig.root.querySelector('[data-deck-rename-input="d1"]') as HTMLInputElement).value = '词根';
    click(rig.root.querySelector('[data-deck-rename-confirm="d1"]') as HTMLElement);
    await flushMicrotasks();

    expect(ui(rig.root, 'toast').textContent).toContain('同名领域');
    const input = rig.root.querySelector('[data-deck-rename-input="d1"]') as HTMLInputElement;
    expect(input).not.toBeNull(); // 还在编辑态
    expect(input.value).toBe('词根'); // 输入保留
  });

  it('DM#4 取消改名 / 取消删除 ⇒ 零写入，且回到非确认态', async () => {
    const rig = makeRig();
    click(rig.root.querySelector('[data-deck-rename="d1"]') as HTMLElement);
    click(rig.root.querySelector('[data-deck-rename-cancel="d1"]') as HTMLElement);
    expect(rig.renamed).toEqual([]);
    expect(rig.root.querySelector('[data-deck-rename-input="d1"]')).toBeNull();

    click(rig.root.querySelector('[data-deck-delete="d2"]') as HTMLElement);
    expect((rig.root.querySelector('[data-deck-delete="d2"]') as HTMLElement).textContent).toContain('确认删除');
    // 切到别的行（例如去改名）⇒ 确认态被清掉，不会误删
    click(rig.root.querySelector('[data-deck-rename="d2"]') as HTMLElement);
    expect((rig.root.querySelector('[data-deck-delete="d2"]') as HTMLElement)?.textContent ?? '删除').toBe('删除');
    expect(rig.removedDecks).toEqual([]);
  });

  it('DM#5 删单卡也是两步；取消零写入', async () => {
    const rig = makeRig();
    const del = () => rig.root.querySelector('[data-card-delete="c1"]') as HTMLElement;
    click(del());
    expect(rig.removedCards).toEqual([]); // 一步就删的实现必红
    expect(del().textContent).toBe('确认删除');
    click(del());
    await flushMicrotasks();
    expect(rig.removedCards).toEqual(['c1']);
    expect(ui(rig.root, 'toast').textContent).toContain('已删除');
  });

  it('DM#6 未注入管理写口 ⇒ 整块不出现（不显示点了没反应的入口）', () => {
    const rig = makeRig({ deps: { renameDeck: undefined, removeDeck: undefined, removeCard: undefined } });
    expect(rig.root.querySelector('[data-deck-manage-section]')).toBeNull();
    expect(rig.root.querySelector('[data-card-delete]')).toBeNull();
  });
});
