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

/** 两个领域的夹具（多领域合练用，D50）。 */
function saveWithTwoDecks(a: Card[], b: Card[]): SaveFile {
  const base = makeSave();
  return { ...base, decks: [makeDeck('d1', '唐诗'), makeDeck('d2', '成语')], cards: [...a, ...b] };
}

function setupTwo(a: Card[], b: Card[], deps: Parameters<typeof mountPractice>[2] = {}) {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWithTwoDecks(a, b) }));
  mountPractice(root, ctrl, { now: () => NOW, toastMs: 0, ...deps });
  return { root, ctrl };
}

const deckBtnById = (root: HTMLElement, deckId: string): HTMLButtonElement =>
  ui(root, 'practice-decks').querySelector(`button[data-deck="${deckId}"]`) as HTMLButtonElement;
const deckRemoveBtn = (root: HTMLElement, deckId: string): HTMLButtonElement | null =>
  ui(root, 'practice-decks').querySelector(`button[data-deck-remove="${deckId}"]`) as HTMLButtonElement | null;
const pickBox = (root: HTMLElement, cardId: string): HTMLInputElement =>
  ui(root, 'practice-cards').querySelector(`input[data-pick="${cardId}"]`) as HTMLInputElement;
const togglePick = (root: HTMLElement, cardId: string, on: boolean): void => {
  const box = pickBox(root, cardId);
  box.checked = on;
  box.dispatchEvent(new Event('change'));
};

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

  it('PR#5 超过池上限 ⇒ 按"最紧迫优先"截取，并如实说明还有多少张没进池', () => {
    // **刻意让"列表顺序"与"紧迫程度"相反**（c0 是刚到期、c27 最久没练）：
    // 否则"按列表顺序截"与"按最紧迫截"结果相同，这条用例就没有判别力（变异实测抓到过）。
    const many = Array.from({ length: DRILL_POOL_MAX + 3 }, (_, i) =>
      card(`c${i}`, { srs: srs({ due: NOW - i - 1 }) }),
    );
    const { root } = setup(many);
    openFirstDeck(root);
    expect(picks(root)).toHaveLength(DRILL_POOL_MAX);
    // 该进池的是 c3…c27（最紧迫的 25 张），而出题顺序仍是**列表顺序**
    expect(picks(root)).toEqual(Array.from({ length: DRILL_POOL_MAX }, (_, i) => `c${i + 3}`));
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

/* ------------------------------------------------------------------ D50（现场反馈） */

/**
 * 练功屏的「换领域」与多领域合练（D50，现场反馈）。
 *
 * 判别力：
 * - PR#17 卡列表里有**显式**的换领域入口（只有屏顶那个含混「返回」的实现必红），
 *   且换领域**不清勾选**（清空的实现必红：玩家得重勾一遍）；
 * - PR#18 两个领域的勾选**合起来**交给 `onDrill`，且文案如实报"来自 2 个领域"；
 * - PR#19 「移出本次」只移该领域（连带清掉它自己的勾选），别的领域不受影响；
 * - PR#20 上限是**跨领域合计** 25（每域各算 25 的实现必红），超出部分如实说明；
 * - PR#21 **领域列表上就能开练**（必须先点进某个领域才能开练的实现必红）；
 * - PR#22 「清空勾选」归零，领域行不再标"已加入"；
 * - PR#23 玩家**显式取消**的卡不会被自动补齐重新勾上。
 */
describe('mountPractice —— 换领域与多领域合练（D50）', () => {
  const due = (id: string, deckId: string, order = 1): Card =>
    card(id, { deckId, srs: srs({ due: NOW - order }) });

  it('PR#17 卡列表里有显式「换领域」，点了回领域列表且勾选保留', () => {
    const { root } = setupTwo([due('a1', 'd1')], [due('b1', 'd2')]);
    openFirstDeck(root);
    // 显式入口在（只有屏顶「返回」的实现必红）
    expect(root.querySelector('[data-ui="deck-switch"]'), '卡列表里没有「换领域」入口').not.toBeNull();
    expect(ui(root, 'deck-view-title').textContent).toContain('唐诗');

    const before = picks(root);
    expect(before).toEqual(['a1']);
    click(ui(root, 'deck-switch'));
    // 回到领域列表，且刚才勾的**还在**（换领域不等于清空）
    expect(ui(root, 'practice-decks').hidden).toBe(false);
    expect(ui(root, 'practice-deck-view').hidden).toBe(true);
    expect(ui(root, 'practice-picks').textContent).toContain('已选 1');
    // 再进来：还是勾着的（上一条若只改了文案、其实清空了，这里会红）
    click(deckBtnById(root, 'd1'));
    expect(picks(root)).toEqual(['a1']);
  });

  it('PR#18 两个领域的勾选合起来开练，文案如实报"来自 2 个领域"', () => {
    const seen: string[][] = [];
    const { root } = setupTwo([due('a1', 'd1')], [due('b1', 'd2')], {
      onDrill: (input) => void seen.push([...input.cardIds]),
    });
    click(deckBtnById(root, 'd1'));
    click(ui(root, 'deck-switch'));
    click(deckBtnById(root, 'd2'));
    expect(picks(root).sort()).toEqual(['b1']);
    click(ui(root, 'deck-switch'));
    expect(ui(root, 'practice-picks').textContent).toContain('来自 2 个领域');
    click(ui(root, 'drill-start'));
    expect(seen).toEqual([['a1', 'b1']]);
  });

  it('PR#19 「移出本次」只移该领域，另一域的勾选不受影响', () => {
    const seen: string[][] = [];
    // a3 **未到期**且被玩家显式勾上：移出 d1 必须连带清掉这条"手动记录"，
    // 否则再进来它又自己勾上了（"移出"就等于没生效）。
    const { root } = setupTwo(
      [due('a1', 'd1'), due('a2', 'd1', 2), card('a3', { deckId: 'd1', srs: srs({ due: NOW + 999_999 }) })],
      [due('b1', 'd2')],
      { onDrill: (input) => void seen.push([...input.cardIds]) },
    );
    click(deckBtnById(root, 'd1'));
    togglePick(root, 'a3', true); // 手动加一张没到期的
    expect(picks(root).sort()).toEqual(['a1', 'a2', 'a3']);
    click(ui(root, 'deck-switch'));
    click(deckBtnById(root, 'd2'));
    click(ui(root, 'deck-switch'));
    expect(ui(root, 'practice-picks').textContent).toContain('已选 4');

    const remove = deckRemoveBtn(root, 'd1');
    expect(remove, '已纳入的领域没有「移出本次」').not.toBeNull();
    remove?.click();
    // 移出的是**整个 d1**：它的三张卡都不在本次里，d2 的那张不受影响
    expect(ui(root, 'practice-picks').textContent).toContain('已选 1');
    expect(deckRemoveBtn(root, 'd1'), '移出后还留着「移出本次」').toBeNull();
    expect(deckRemoveBtn(root, 'd2'), '移出 d1 连带把 d2 也移出了').not.toBeNull();
    click(ui(root, 'drill-start'));
    expect(seen).toEqual([['b1']]);

    // 再进 d1：只有"该练的"（a1/a2）回来，手动勾的那张没到期的**不该**自己勾上
    click(deckBtnById(root, 'd1'));
    expect(picks(root).sort()).toEqual(['a1', 'a2']);
  });

  it('PR#20 上限是跨领域合计 25，超出部分如实说明', () => {
    const many = (deckId: string, prefix: string): Card[] =>
      Array.from({ length: 20 }, (_, i) => due(`${prefix}${i}`, deckId, i + 1));
    const { root } = setupTwo(many('d1', 'a'), many('d2', 'b'), { onDrill: () => undefined });
    click(deckBtnById(root, 'd1'));
    click(ui(root, 'deck-switch'));
    expect(ui(root, 'practice-picks').textContent).toContain('已选 20');
    click(deckBtnById(root, 'd2'));
    click(ui(root, 'deck-switch'));
    // 上限是合计 25（每域各算 25 的实现会给出 40）
    expect(ui(root, 'practice-picks').textContent).toContain('已选 25');
    expect(ui(root, 'practice-cap-hint').hidden).toBe(false);
    expect(ui(root, 'practice-cap-hint').textContent).toContain('15');
  });

  it('PR#21 领域列表上就能开练（不必先进某个领域）', () => {
    const seen: string[][] = [];
    const { root } = setupTwo([due('a1', 'd1')], [due('b1', 'd2')], {
      onDrill: (input) => void seen.push([...input.cardIds]),
    });
    // 一个领域都没进 ⇒ 一个都没勾 ⇒ 按钮说明怎么开始
    expect((ui(root, 'drill-start') as HTMLButtonElement).disabled).toBe(true);
    expect(ui(root, 'drill-start').textContent).toContain('先勾');
    click(deckBtnById(root, 'd1'));
    click(ui(root, 'deck-switch'));
    click(deckBtnById(root, 'd2'));
    click(ui(root, 'deck-switch'));
    // **还在领域列表上**就能开练（`click` 对隐藏元素也生效，所以必须显式断言它可见 ——
    // 变异实测：只断言"点了有反应"时，"底部条只在卡列表里显示"的实现照样全绿）
    expect(ui(root, 'practice-decks').hidden).toBe(false);
    expect(ui(root, 'drill-bar').hidden, '领域列表上不显示「开始练功」').toBe(false);
    expect(ui(root, 'drill-bar').textContent).toContain('来自 2 个领域');
    expect((ui(root, 'drill-start') as HTMLButtonElement).disabled).toBe(false);
    click(ui(root, 'drill-start'));
    expect(seen).toEqual([['a1', 'b1']]);
  });

  it('PR#22 「清空勾选」归零，领域行不再标"已加入"', () => {
    const { root } = setupTwo([due('a1', 'd1')], [due('b1', 'd2')]);
    click(deckBtnById(root, 'd1'));
    click(ui(root, 'deck-switch'));
    click(deckBtnById(root, 'd2'));
    click(ui(root, 'deck-switch'));
    expect(ui(root, 'practice-picks').textContent).toContain('已选 2');
    expect(deckRemoveBtn(root, 'd1')).not.toBeNull();

    click(ui(root, 'picks-clear'));
    expect(ui(root, 'practice-picks').textContent).toContain('已选 0');
    expect(deckRemoveBtn(root, 'd1')).toBeNull();
    expect((ui(root, 'drill-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('PR#23 显式取消的卡不会被自动补齐重新勾上', () => {
    const { root } = setupTwo([due('a1', 'd1'), due('a2', 'd1', 2)], [], { onDrill: () => undefined });
    click(deckBtnById(root, 'd1'));
    expect(picks(root).sort()).toEqual(['a1', 'a2']);
    togglePick(root, 'a2', false);
    // 重渲染（任何一次快照订阅都会触发）之后不许把它加回来
    togglePick(root, 'a1', true);
    expect(picks(root)).toEqual(['a1']);
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

/* ------------------------------------------------------------------ D56：重出选项 */

/**
 * 判别力：
 * - PR#C1 缺 `refreshChoices` 口 ⇒ **不显示**按钮（不显示点了没反应的入口）；
 * - PR#C2 点了把 **cardId** 交给写口，成功后如实提示（并说明这算一次额度）；
 * - PR#C3 失败（额度到顶 / 网络）⇒ 原话提示，不谎报成功。
 */
describe('mountPractice —— 重出选项（D56）', () => {
  it('PR#C1 缺口不显示；有口才显示', () => {
    const bare = setup([card('c1')]);
    openFirstDeck(bare.root);
    expect(bare.root.querySelector('[data-ui="card-rechoices"]')).toBeNull();

    const withIt = setup([card('c1')], { refreshChoices: () => Promise.resolve({ ok: true, choices: ['x'] }) });
    openFirstDeck(withIt.root);
    expect(withIt.root.querySelector('[data-ui="card-rechoices"]')).not.toBeNull();
  });

  it('PR#C2 点了把 cardId 交给写口，成功后如实提示', async () => {
    const calls: string[] = [];
    const { root } = setup([card('c1')], {
      refreshChoices: (input) => {
        calls.push(input.cardId);
        return Promise.resolve({ ok: true, choices: ['错一', '错二', '错三'] });
      },
    });
    openFirstDeck(root);
    (root.querySelector('[data-ui="card-rechoices"]') as HTMLElement).click();
    await flushMicrotasks();
    expect(calls).toEqual(['c1']);
    expect(ui(root, 'toast').textContent).toContain('选项');
  });

  it('PR#C3 失败 ⇒ 原话提示，不谎报成功', async () => {
    const { root } = setup([card('c1')], {
      refreshChoices: () => Promise.resolve({ ok: false, reason: '今天的额度用完了，明天再来。' }),
    });
    openFirstDeck(root);
    (root.querySelector('[data-ui="card-rechoices"]') as HTMLElement).click();
    await flushMicrotasks();
    expect(ui(root, 'toast').textContent).toContain('额度用完了');
  });
});

/* ------------------------------------------------------------------ D56 补：把选项露出来 */

/**
 * 判别力：
 * - PR#D1 卡行必须列出**每一条**干扰项（只显示第一条的实现必红）；
 * - PR#D2 没有干扰项的卡要**如实说明**（战斗里会用同领域其他卡补），不留空行；
 * - PR#D3 「重出选项」之后行上显示的是**新**选项（衔接 T1：重出就是为了看一眼对不对）。
 */
describe('mountPractice —— 卡行里的干扰项（D56 补）', () => {
  it('PR#D1 有干扰项 ⇒ 逐条列出', () => {
    const { root } = setup([
      card('c1', { choices: ['错一：它其实是蓝的', '错二：与氧无关', '错三：血里没有铁'] }),
    ]);
    openFirstDeck(root);
    const line = root.querySelector('[data-card-choices="c1"]')?.textContent ?? '';
    for (const c of ['错一：它其实是蓝的', '错二：与氧无关', '错三：血里没有铁']) {
      expect(line, `没列出：${c}`).toContain(c);
    }
  });

  it('PR#D2 没有干扰项 ⇒ 如实说明"战斗里会用同领域其他卡补"，不留空', () => {
    const { root } = setup([card('c1')]);
    openFirstDeck(root);
    const line = root.querySelector('[data-card-choices="c1"]')?.textContent ?? '';
    expect(line).toContain('无');
    expect(line).toContain('同领域');
  });

  it('PR#D3 重出选项之后，行上显示的是**存档里**的新选项（旧的不许留着）', async () => {
    // 这一段要模拟宿主：`refreshChoices` 在**生产里由装配层写盘**（AD#14 钉住），
    // 所以这里也得让存档真的变，再推一次快照 —— 否则测的只是"按钮回了个值"。
    let rig: ReturnType<typeof setup>;
    rig = setup([card('c1', { choices: ['旧干扰项'] })], {
      refreshChoices: () => {
        const snap = rig.ctrl.snapshot();
        const cards = snap.save.cards.map((c) => (c.id === 'c1' ? { ...c, choices: ['新一', '新二'] } : c));
        rig.ctrl.push(makeSnap({ screen: 'menu', save: { ...snap.save, cards } }));
        return Promise.resolve({ ok: true, choices: ['新一', '新二'] });
      },
    });
    openFirstDeck(rig.root);
    expect(rig.root.querySelector('[data-card-choices="c1"]')?.textContent).toContain('旧干扰项');

    (rig.root.querySelector('[data-ui="card-rechoices"]') as HTMLElement).click();
    await flushMicrotasks();
    const line = rig.root.querySelector('[data-card-choices="c1"]')?.textContent ?? '';
    expect(line).toContain('新一');
    expect(line).toContain('新二');
    expect(line).not.toContain('旧干扰项'); // 旧的不许留着（否则玩家以为没生效）
  });
});
