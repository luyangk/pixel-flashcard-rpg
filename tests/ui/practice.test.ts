// @vitest-environment happy-dom
/**
 * tests/ui/practice.test.ts —— Plan 7 · T6：练功屏（看旧卡 + 勾选 + 练这一域）。
 *
 * 判别力（每条都写清"坏实现为何必红"）：
 * - PR#1 额度行来自注入口（宿主现算，不在这里造数字）；
 * - PR#2 领域行的三个计数要对（卡数 / 待复习=到期 / 已掌握）——把它们都算成"卡数"的实现必红；
 * - PR#3 搜索同时匹配正面与背面（只搜正面的实现必红）；
 * - PR#4 默认勾选**恰是**"到期 + 新卡"（全勾的实现必红：练功会变成把整个领域刷一遍）；
 * - PR#5 勾选超过上限时截取并**如实说明**还有多少张没进池（静默截断的实现必红）；
 * - PR#6 一张都没勾 ⇒ 按钮禁用（否则会开一场空仗）；
 * - PR#7 「练这一域」只交**勾选的那些**、且顺序稳定；
 * - PR#8 本屏零写口（DOM 里不该出现卡组页的删除/保存控件）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, SaveFile, SRSState } from '@core/types';
import { mountPractice, DRILL_POOL_MAX, sourceLabel } from '../../src/ui/practice';
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

const NOW = Date.UTC(2026, 10, 1, 4, 0, 0);

function srs(over: Partial<SRSState> = {}): SRSState {
  return { ease: 2.5, interval: 10, reps: 3, lapses: 0, due: NOW + 86_400_000, stability: 'review', effectiveReviewDays: [], ...over };
}
function card(id: string, over: Partial<Card> = {}): Card {
  return { id, deckId: 'd1', front: `正面-${id}`, back: `背面-${id}`, tags: [], srs: srs(), ...over };
}

function saveWith(cards: Card[]): SaveFile {
  const base = makeSave();
  return { ...base, decks: [makeDeck('d1', '唐诗')], cards };
}

function setup(cards: Card[], deps: Parameters<typeof mountPractice>[2] = {}) {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWith(cards) }));
  mountPractice(root, ctrl, { now: () => NOW, toastMs: 0, ...deps });
  return { root, ctrl };
}
const deckBtn = (root: HTMLElement): HTMLButtonElement => ui(root, 'practice-decks').querySelector('button[data-deck]') as HTMLButtonElement;
const picks = (root: HTMLElement): string[] =>
  all(root, 'input[data-pick]').filter((el) => (el as HTMLInputElement).checked).map((el) => el.getAttribute('data-pick') as string);
const openFirstDeck = (root: HTMLElement): void => click(deckBtn(root));

describe('mountPractice —— 看旧卡（Plan 7 · T6）', () => {
  it('PR#1 额度行来自注入口；缺省则不显示', () => {
    const shown = setup([card('c1')], { quotaText: () => '今日：生成剩 137 / 200' });
    expect(ui(shown.root, 'practice-quota').hidden).toBe(false);
    expect(ui(shown.root, 'practice-quota').textContent).toContain('137');

    const bare = setup([card('c1')]);
    expect(ui(bare.root, 'practice-quota').hidden).toBe(true);
  });

  it('PR#2 领域行三个计数正确（卡数 / 待复习 / 已掌握）', () => {
    const { root } = setup([
      card('c1', { srs: srs({ due: NOW - 1000 }) }), // 到期
      card('c2', { srs: srs({ due: NOW + 1000 }) }), // 未到期
      card('c3', { srs: srs({ stability: 'mastered', due: NOW + 1000 }) }),
    ]);
    const text = deckBtn(root).textContent ?? '';
    expect(text).toContain('3 张');
    expect(text).toContain('待复习 1');
    expect(text).toContain('已掌握 1');
  });

  it('PR#3 搜索同时匹配正面与背面（大小写不敏感）', () => {
    const { root } = setup([
      card('c1', { front: '李白是哪个朝代的', back: '唐朝' }),
      card('c2', { front: '杜甫是谁', back: '诗人' }),
    ]);
    openFirstDeck(root);
    expect(all(root, '[data-card-row]')).toHaveLength(2);

    const input = ui(root, 'practice-search') as HTMLInputElement;
    input.value = '唐朝'; // 只在背面
    input.dispatchEvent(new Event('input'));
    expect(all(root, '[data-card-row]').map((r) => r.getAttribute('data-card-row'))).toEqual(['c1']);

    input.value = '杜甫'; // 只在正面
    input.dispatchEvent(new Event('input'));
    expect(all(root, '[data-card-row]').map((r) => r.getAttribute('data-card-row'))).toEqual(['c2']);
  });

  it('PR#4 默认勾选恰是"到期 + 新卡"，不是全勾', () => {
    const { root } = setup([
      card('c1', { srs: srs({ due: NOW - 1 }) }), // 到期 ⇒ 勾
      card('c2', { srs: srs({ stability: 'new', due: 0 }) }), // 新卡 ⇒ 勾
      card('c3', { srs: srs({ due: NOW + 86_400_000 }) }), // 未到期 ⇒ 不勾
      card('c4', { srs: srs({ stability: 'mastered', due: NOW + 86_400_000 }) }), // 已掌握且未到期 ⇒ 不勾
    ]);
    openFirstDeck(root);
    expect(picks(root).sort()).toEqual(['c1', 'c2']);
  });

  it('PR#5 超过池上限 ⇒ 截取并如实说明还有多少张没进池', () => {
    const many = Array.from({ length: DRILL_POOL_MAX + 3 }, (_, i) =>
      card(`c${i}`, { srs: srs({ due: NOW - i - 1 }) }),
    );
    const { root } = setup(many);
    openFirstDeck(root);
    expect(picks(root)).toHaveLength(DRILL_POOL_MAX);
    expect(ui(root, 'practice-cap-hint').hidden).toBe(false);
    expect(ui(root, 'practice-cap-hint').textContent).toContain('3');
  });

  it('PR#6 取消到 0 张 ⇒ 按钮禁用并提示先勾', () => {
    // 必须注入 onDrill：否则禁用可能只是因为"没有写口"，测不出"空勾选"这一条
    // （变异实测：M4 首版因此没牙）
    const { root } = setup([card('c1', { srs: srs({ stability: 'new', due: 0 }) })], { onDrill: () => undefined });
    openFirstDeck(root);
    const box = ui(root, 'practice-cards').querySelector('input[data-pick]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect((ui(root, 'drill-start') as HTMLButtonElement).disabled).toBe(true);
    expect(ui(root, 'drill-start').textContent).toContain('先勾');
  });

  it('PR#7 「练这一域」只交勾选的那些，顺序稳定（按列表顺序）', () => {
    const seen: string[][] = [];
    const { root } = setup(
      [
        card('c1', { srs: srs({ due: NOW - 1 }) }),
        card('c2', { srs: srs({ due: NOW - 2 }) }),
        card('c3', { srs: srs({ due: NOW + 999 }) }),
        // c4 **始终不勾**：没有它的话"整域都交"与"只交勾选的"结果一样
        // （变异实测：M5 首版因此没牙）
        card('c4', { srs: srs({ stability: 'mastered', due: NOW + 999_999 }) }),
      ],
      { onDrill: (input) => void seen.push([...input.cardIds]) },
    );
    openFirstDeck(root);
    // 默认勾的是 c1/c2；再手动勾上 c3（演示"想加练哪张就自己勾"）
    const c3 = ui(root, 'practice-cards').querySelector('input[data-pick="c3"]') as HTMLInputElement;
    c3.checked = true;
    c3.dispatchEvent(new Event('change'));
    click(ui(root, 'drill-start'));
    expect(seen).toEqual([['c1', 'c2', 'c3']]);
    expect(seen[0]).not.toContain('c4'); // 没勾的不许带走
  });

  it('PR#8 卡行给出稳定度、来源与到期；本屏零写口', () => {
    const { root } = setup([
      card('c1', {
        source: { type: 'llm', createdAt: NOW },
        srs: srs({ stability: 'new', due: 0 }),
      }),
    ]);
    openFirstDeck(root);
    const meta = ui(root, 'practice-cards').querySelector('.practice-meta')?.textContent ?? '';
    expect(meta).toContain('初识');
    expect(meta).toContain('AI 辅建');
    expect(meta).toContain('现在'); // due=0 ⇒ 现在
    // 零写口：卡组页的编辑/删除控件不该出现在这里
    expect(all(root, '[data-card-delete]')).toHaveLength(0);
    expect(all(root, '[data-deck-delete]')).toHaveLength(0);
    expect(all(root, '[data-ui="save-params"]')).toHaveLength(0);
  });

  it('PR#9 空卡库 ⇒ 一句引导，不是空白', () => {
    const { root } = setup([]);
    expect(ui(root, 'practice-empty').hidden).toBe(false);
    expect(ui(root, 'practice-empty').textContent).toContain('卡组页');
  });

  it('PR#10 来源标签：五种来源各一句人话，未知也不空', () => {
    expect(sourceLabel({ type: 'preset', createdAt: 0 })).toBe('预置');
    expect(sourceLabel({ type: 'manual', createdAt: 0 })).toBe('手写');
    expect(sourceLabel({ type: 'llm', createdAt: 0 })).toBe('AI 辅建');
    expect(sourceLabel({ type: 'hotspot', createdAt: 0 })).toBe('采集');
    expect(sourceLabel({ type: 'domain', createdAt: 0 })).toBe('领域');
    expect(sourceLabel(undefined).length).toBeGreaterThan(0);
  });

  it('PR#11 两段式返回：卡列表里先回领域列表，再回菜单', () => {
    const navs: string[] = [];
    const { root } = setup([card('c1')], { onNav: (t) => void navs.push(t) });
    openFirstDeck(root);
    click(ui(root, 'back'));
    expect(navs).toEqual([]); // 先回领域列表（没离开这一屏）
    // 显隐落在**分区容器**上（practice-cards 是它内部的列表容器，恒在）
    expect(ui(root, 'practice-deck-view').hidden).toBe(true);
    expect(ui(root, 'practice-decks').hidden).toBe(false);
    click(ui(root, 'back'));
    expect(navs).toEqual(['menu']);
  });
});

/* ------------------------------------------------------------------ Plan 8 · T6 */

/**
 * 练功屏的分区切换（Plan 8 · T6）：看旧卡 / 采新卡。
 *
 * 判别力：注入 `collect` 才显示分区条（缺省 = 不显示点了没反应的入口）；
 * 切到采新卡时**旧卡区整块收起**（两个分区不能同时占屏，否则玩家以为要两边都做）。
 */
describe('mountPractice —— 分区切换（Plan 8 · T6）', () => {
  const collectDeps = {
    collectCards: () =>
      Promise.resolve({
        ok: true as const,
        candidates: [],
        quota: { day: '2026-11-01', cards: 0, judges: 0 },
        requests: 0,
        truncated: false,
      }),
  };

  it('PR#12 注入采新卡 ⇒ 显示分区条并可切换；缺省则不显示', () => {
    const withCollect = setup([card('c1')], { collect: collectDeps });
    const tabs = ui(withCollect.root, 'practice-tabs');
    expect(tabs.hidden).toBe(false);
    expect(ui(withCollect.root, 'tab-browse').getAttribute('aria-pressed')).toBe('true');

    click(ui(withCollect.root, 'tab-collect'));
    expect(ui(withCollect.root, 'tab-collect').getAttribute('aria-pressed')).toBe('true');
    expect(ui(withCollect.root, 'practice-deck-view').hidden).toBe(true); // 旧卡区收起
    expect(ui(withCollect.root, 'practice-decks').hidden).toBe(true);
    expect(ui(withCollect.root, 'collect-host').hidden).toBe(false);
    // 用 querySelector 判"在不在"：`ui()` 在缺元素时会**抛**，拿它做"不存在"的断言必然自相矛盾
    expect(withCollect.root.querySelector('[data-ui="practice-collect"]')).not.toBeNull(); // 子分区真的挂上了

    click(ui(withCollect.root, 'tab-browse'));
    expect(ui(withCollect.root, 'collect-host').hidden).toBe(true);
    expect(ui(withCollect.root, 'practice-decks').hidden).toBe(false);
    expect(withCollect.root.querySelector('[data-ui="practice-collect"]')).toBeNull(); // 离开即拆

    const bare = setup([card('c1')]);
    expect(ui(bare.root, 'practice-tabs').hidden).toBe(true);
  });
});

/* ------------------------------------------------------------------ Plan 8 · T7 */

/**
 * 看旧卡就地编辑（Plan 8 · T7）。
 *
 * 判别力：
 * - PR#13 注入写口才有「改」入口（缺省不显示点了没反应的按钮）；
 * - PR#14 保存把**输入框里的值**交给写口，成功后回到只读态并刷新；
 * - PR#15 保存失败**保留输入**并如实提示（清空/丢掉玩家刚敲的字是最恼人的失败）；
 * - PR#16 取消不改动任何东西。
 */
describe('mountPractice —— 就地编辑（Plan 8 · T7）', () => {
  it('PR#13 缺省不显示「改」；注入写口后显示', () => {
    const bare = setup([card('c1')]);
    openFirstDeck(bare.root);
    expect(bare.root.querySelector('[data-ui="card-edit"]')).toBeNull();

    const withEdit = setup([card('c1')], { updateCard: () => Promise.resolve({ ok: true }) });
    openFirstDeck(withEdit.root);
    expect(withEdit.root.querySelector('[data-ui="card-edit"]')).not.toBeNull();
  });

  it('PR#14 保存把输入框里的值交给写口，成功后回到只读态', async () => {
    const calls: Array<{ cardId: string; front: string; back: string }> = [];
    const { root } = setup([card('c1')], {
      updateCard: (input) => {
        calls.push({ ...input });
        return Promise.resolve({ ok: true });
      },
    });
    openFirstDeck(root);
    click(root.querySelector('[data-ui="card-edit"]') as HTMLElement);
    const front = root.querySelector('[data-card-edit-front]') as HTMLInputElement;
    const back = root.querySelector('[data-card-edit-back]') as HTMLInputElement;
    front.value = '改过的正面';
    back.value = '改过的背面';
    click(root.querySelector('[data-card-edit-save]') as HTMLElement);
    await flushMicrotasks();

    expect(calls).toEqual([{ cardId: 'c1', front: '改过的正面', back: '改过的背面' }]);
    expect(root.querySelector('[data-card-edit-front]')).toBeNull(); // 回到只读态
    expect(ui(root, 'toast').textContent).toContain('改好了');
  });

  it('PR#15 保存失败保留输入并如实提示', async () => {
    const { root } = setup([card('c1')], {
      updateCard: () => Promise.resolve({ ok: false, reason: '存档无法读取（只读保护）。' }),
    });
    openFirstDeck(root);
    click(root.querySelector('[data-ui="card-edit"]') as HTMLElement);
    const front = root.querySelector('[data-card-edit-front]') as HTMLInputElement;
    front.value = '我敲的字';
    click(root.querySelector('[data-card-edit-save]') as HTMLElement);
    await flushMicrotasks();

    expect(ui(root, 'toast').textContent).toContain('只读');
    const stillThere = root.querySelector('[data-card-edit-front]') as HTMLInputElement | null;
    expect(stillThere, '失败后必须留在编辑态（否则玩家刚敲的字就没了）').not.toBeNull();
    expect(stillThere?.value).toBe('我敲的字');
  });

  it('PR#16 取消回到只读态，且不调写口', async () => {
    let called = 0;
    const { root } = setup([card('c1')], {
      updateCard: () => {
        called += 1;
        return Promise.resolve({ ok: true });
      },
    });
    openFirstDeck(root);
    click(root.querySelector('[data-ui="card-edit"]') as HTMLElement);
    click(root.querySelector('[data-card-edit-cancel]') as HTMLElement);
    expect(root.querySelector('[data-card-edit-front]')).toBeNull();
    expect(called).toBe(0);
  });
});
