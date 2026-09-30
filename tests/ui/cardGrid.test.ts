// @vitest-environment happy-dom
/**
 * tests/ui/cardGrid.test.ts —— **网格卡行的结构性契约**（D65）
 *
 * ## 为什么要这条测试
 * 现场 bug（小米外屏竖屏）：练功·看旧卡里正文变成"一字一行"、被挤到右侧一条缝。
 * 根因是**加新元素时漏了一行 CSS**：`.practice-card` 是 `auto 1fr` 两栏网格，
 * 新加的「还差什么」那行没写 `grid-column: 2`，于是它掉进第 1 列（auto 列按内容撑到最宽），
 * 第 2 列被压成一条缝，所有正文随即一字一行。
 *
 * **这个 bug 单元测试抓不到** —— happy-dom 不计算布局，DOM 断言全绿，只有真机上才看得见。
 * 所以我们退一步守**结构**：网格容器里凡是"文本会长短不定"的直接子元素，
 * 必须有显式 `grid-column`（或明确属于第 1 列的复选框），容器本身必须用 `minmax(0, 1fr)`。
 * 这样"再加一行忘了写 grid-column"会在 CI 里当场红，而不是等你换手机才发现。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card } from '@core/types';
import { mountPractice } from '../../src/ui/practice';
import { click, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, makeSrs, ui } from './support';

const CSS = readFileSync('src/ui/styles.css', 'utf8');

/** 正则转义（只用到这几个字符，不引库）。 */
function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 该 class 在 CSS 里有没有显式的 grid-column 声明。 */
function hasGridColumn(cls: string): boolean {
  const re = new RegExp(`${esc(`.${cls}`)}\\s*\\{[^}]*grid-column\\s*:`, 's');
  return re.test(CSS);
}

/** 容器规则里是否用了 minmax(0, 1fr)（长文本不顶开第 2 列的防线）。 */
function usesMinmax(selector: string): boolean {
  const re = new RegExp(
    `${esc(selector)}\\s*\\{[^}]*grid-template-columns\\s*:[^;]*minmax\\(0,\\s*1fr\\)`,
    's',
  );
  return re.test(CSS);
}

function directChildClasses(container: Element): string[] {
  const out: string[] = [];
  for (const child of Array.from(container.children)) {
    for (const cls of Array.from(child.classList)) out.push(cls);
  }
  return out;
}

describe('D65 网格卡行的结构性契约', () => {
  it('CG#1 练功·看旧卡：卡行里每个文本子元素都有 grid-column（漏一个就会一字一行）', () => {
    const root = makeRoot();
    // 夹具刻意**又长又全**：正文长、有选项、状态说明也长 —— 这正是塌陷发生的条件
    const long = '打雷时为什么先看到闪电、后听到雷声？这是一句刻意很长的正面文字，用来把网格的列顶开。';
    const card: Card = makeCard('c1', {
      deckId: 'd1', // 卡必须落在夹具的领域里，否则点进去是空的（探针踩过）
      front: long,
      back: '光的速度约每秒 30 万公里，声音约每秒 340 米'.repeat(3),
      srs: makeSrs({ stability: 'review', interval: 3, effectiveReviewDays: ['2026-10-28', '2026-10-29'] }),
    });
    const save = makeSave({ decks: [makeDeck('d1', '唐诗')], cards: [card] });
    mountPractice(root, makeCtrl(makeSnap({ screen: 'menu', save })), { now: () => 0, tzOffsetMin: 480 });
    // 卡行在"点进某领域"之后才渲染（与 practice.test.ts 的 openFirstDeck 同款）
    click(ui(root, 'practice-decks').querySelector('button[data-deck]') as HTMLElement);

    const cardEl = root.querySelector('.practice-card');
    expect(cardEl, '没渲染出卡行').not.toBeNull();
    const classes = directChildClasses(cardEl as Element);
    expect(classes.length).toBeGreaterThan(3);

    // 复选框明确属于第 1 列（只有它豁免）；**其余每个子元素都必须显式落列** ——
    // 自动排布在两列网格里会让"奇数位"的元素掉进第 1 列，把布局撑塌
    const exempt = new Set(['practice-pick']);
    for (const cls of classes) {
      if (exempt.has(cls)) continue;
      expect(hasGridColumn(cls), `.${cls} 缺少 grid-column —— 它会掉进第 1 列并把第 2 列挤成一条缝`).toBe(true);
    }
    expect(usesMinmax('.practice-card'), '.practice-card 第 2 列要用 minmax(0, 1fr)（长文本不顶开）').toBe(true);
  });

  it('CG#2 采新卡候选行同款契约', () => {
    const container = CSS.match(/\.candidate\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(container, '.candidate 规则不见了').not.toBe('');
    expect(usesMinmax('.candidate'), '.candidate 第 2 列要用 minmax(0, 1fr)').toBe(true);
    // 候选行里唯一的"会长"的文本子元素是选项行，它必须跨列
    const choicesRule = CSS.match(/\.candidate-choices\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(choicesRule).toContain('grid-column');
  });
});
