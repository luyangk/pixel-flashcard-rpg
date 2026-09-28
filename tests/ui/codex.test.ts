// @vitest-environment happy-dom
/**
 * tests/ui/codex.test.ts —— Plan 4 · T8：藏书阁（净化条目 / 彩蛋 / 练习关 / 行记三幕）。
 *
 * 判别力：
 * - CX#1 条目**新者前**：按存档顺序渲染的实现（老的在前）必红；
 * - CX#2 自建领域无彩蛋时显示「已净化」而不是编一段假冷知识（编造内容比留白更糟）；
 * - CX#4 行记按 `settings.story.arcSeen` 分锁定/解锁两态：忽略解锁位的实现会把三幕全画出来 ⇒ 必红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, Deck } from '@core/types';
import type { ArcAct } from '../../src/ui/codex';
import { nextBeat } from '../../src/ui/beats';
import { mountCodex, purifiedEntries } from '../../src/ui/codex';
import { all, click, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

const ACTS: readonly ArcAct[] = [
  { act: 1, title: '一 · 源头', art: 'assets/sprites/arc-1.png', lines: ['所有卷灵的残片，指向同一个方向。'] },
  { act: 2, title: '二 · 真相', art: 'assets/sprites/arc-2.png', lines: ['混沌不是入侵者。'] },
  { act: 3, title: '三 · 留白', art: 'assets/sprites/arc-3.png', lines: ['侠客立于本体门前。'] },
];

function saveWith(decks: Deck[], cards: Card[], arcSeen = 0) {
  const base = makeSave();
  return {
    ...base,
    decks,
    cards,
    settings: { ...base.settings, progress: { exp: 0 }, story: { prologueSeen: true, beatIndex: 0, arcSeen } },
  };
}

describe('purifiedEntries —— 条目选取与排序', () => {
  it('CX#1 只取已净化领域，且新者前（按存档顺序的实现在此必红）', () => {
    const decks = [
      makeDeck('d-old', '老领域', { purifiedAt: 100 }),
      makeDeck('d-new', '新领域', { purifiedAt: 900 }),
      makeDeck('d-raw', '没净化'),
    ];
    expect(purifiedEntries(saveWith(decks, [])).map((e) => e.deck.id)).toEqual(['d-new', 'd-old']);
  });
});

describe('mountCodex —— 条目区', () => {
  it('CX#1b 条目含称号（默认模板回落）、卡数与净化日期（按注入时区）', () => {
    const root = makeRoot();
    const decks = [
      makeDeck('d1', '唐诗', { purifiedAt: Date.UTC(2026, 9, 26, 20, 0, 0), bossName: '诗酒卷灵' }),
      makeDeck('d2', '英语词根', { purifiedAt: Date.UTC(2026, 9, 20, 1, 0, 0) }),
    ];
    const cards = [makeCard('c1', { deckId: 'd1' }), makeCard('c2', { deckId: 'd1' })];
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWith(decks, cards) }));
    mountCodex(root, ctrl, { acts: ACTS, tzOffsetMin: 480 });

    const rows = all(root, '[data-codex-entry]');
    expect(rows.map((r) => r.getAttribute('data-codex-entry'))).toEqual(['d1', 'd2']);
    expect(ui(rows[0], 'entry-name').textContent).toBe('诗酒卷灵');
    // 2026-10-26T20:00Z 在 UTC+8 是 10-27 04:00 ⇒ 本地日期 2026-10-27
    expect(ui(rows[0], 'entry-meta').textContent).toBe('2 张卡 · 净化于 2026-10-27');
    expect(ui(rows[1], 'entry-name').textContent).toBe('英语词根·卷灵'); // 无 bossName → 默认模板
    expect(ui(root, 'codex-count').textContent).toBe('已净化 2 个领域');
    expect(ui(root, 'codex-empty').hidden).toBe(true);
  });

  it('CX#2 彩蛋来自注入表；没有条目的领域显示「已净化」而不是编内容', () => {
    const root = makeRoot();
    const decks = [makeDeck('preset-life', '生活常识', { purifiedAt: 5 }), makeDeck('mine', '我的领域', { purifiedAt: 4 })];
    const ctrl = makeCtrl(makeSnap({ save: saveWith(decks, []) }));
    mountCodex(root, ctrl, { eggs: { 'preset-life': '闪电与雷声本是同一件事。' }, acts: ACTS });

    const rows = all(root, '[data-codex-entry]');
    expect(ui(rows[0], 'entry-egg').textContent).toBe('闪电与雷声本是同一件事。');
    expect(ui(rows[1], 'entry-egg').textContent).toBe('已净化');
  });

  it('CX#3 练习关入口调 onPractice(deckId)；没有宿主写口时按钮禁用', () => {
    const root = makeRoot();
    const seen: string[] = [];
    const decks = [makeDeck('d1', '唐诗', { purifiedAt: 5 })];
    const ctrl = makeCtrl(makeSnap({ save: saveWith(decks, []) }));
    mountCodex(root, ctrl, { acts: ACTS, onPractice: (id) => seen.push(id) });

    click(ui(root, 'codex-list').querySelector('[data-practice]') as HTMLElement);
    expect(seen).toEqual(['d1']);

    const root2 = makeRoot();
    mountCodex(root2, makeCtrl(makeSnap({ save: saveWith(decks, []) })), { acts: ACTS });
    expect((root2.querySelector('[data-practice]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('CX#5 空态：没有净化过任何领域时给大白话，不显示空列表', () => {
    const root = makeRoot();
    mountCodex(root, makeCtrl(makeSnap({ save: saveWith([makeDeck('d1', '唐诗')], []) })), { acts: ACTS });
    expect(ui(root, 'codex-empty').hidden).toBe(false);
    expect(ui(root, 'codex-count').textContent).toBe('空卷');
    expect(all(root, '[data-codex-entry]')).toHaveLength(0);
  });
});

describe('mountCodex —— 行记（三幕）', () => {
  it('CX#4 arcSeen 决定锁定态：已解锁显示标题/插画/文案，未解锁显示「尚未显现」', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWith([], [], 1) }));
    mountCodex(root, ctrl, { acts: ACTS });

    const rows = all(root, '[data-act]');
    expect(rows.map((r) => r.getAttribute('data-unlocked'))).toEqual(['true', 'false', 'false']);
    expect(ui(rows[0], 'act-title').textContent).toBe('一 · 源头');
    expect((rows[0].querySelector('[data-ui="act-art"]') as HTMLImageElement).getAttribute('src')).toBe(
      'assets/sprites/arc-1.png',
    );
    expect(all(rows[0], '[data-ui="act-line"]')).toHaveLength(1);
    expect(ui(rows[1], 'act-title').textContent).toBe('尚未显现');

    // 净化数推进 ⇒ 第二幕解锁（同一实例经订阅刷新）
    ctrl.push(makeSnap({ save: saveWith([], [], 2) }));
    expect(all(root, '[data-act]').map((r) => r.getAttribute('data-unlocked'))).toEqual(['true', 'true', 'false']);
  });

  it('CX#4b 三幕齐（arcSeen=3）时全部可回看', () => {
    const root = makeRoot();
    mountCodex(root, makeCtrl(makeSnap({ save: saveWith([], [], 3) })), { acts: ACTS });
    expect(all(root, '[data-act]').map((r) => r.getAttribute('data-unlocked'))).toEqual(['true', 'true', 'true']);
    // 夹具三幕各 1 句 ⇒ 3 句全在屏上（真数据 assets/narrative/arc.json 是 2/3/2 句）
    expect(all(root, '[data-ui="act-line"]').length).toBe(3);
  });
});

describe('mountCodex —— 历史战报（T8 评审 I-1 的补齐）', () => {
  it('CX#7 按 beatIndex 确定性回放已抽过的句子（回放 ≠ 再抽：不推进游标、不耗随机源）', () => {
    const root = makeRoot();
    const pool = ['甲句', '乙句', '丙句'];
    // 手算前 3 抽的期望（与 beats.test 同源：nextBeat 对同一 (池, 游标) 恒得同一句）
    const expected = [0, 1, 2].map((i) => nextBeat(pool, i).text);
    const ctrl = makeCtrl(makeSnap({ save: saveWith([], [], 0) }));
    // saveWith 的 story.beatIndex 固定为 0，这里手工改成 3（已抽过 3 句）
    const base = saveWith([], [], 0);
    const save = { ...base, settings: { ...base.settings, story: { ...base.settings.story, beatIndex: 3 } } };
    ctrl.push(makeSnap({ save }));
    mountCodex(root, ctrl, { acts: ACTS, beats: pool });

    expect(all(root, '[data-beat]').map((li) => li.textContent)).toEqual(expected);
    expect(ui(root, 'beat-history').hidden).toBe(false);
    expect(ui(root, 'beat-history-empty').hidden).toBe(true);
  });

  it('CX#7b 还没抽过（beatIndex=0）或没有池 ⇒ 空态提示，不显示空列表', () => {
    const root = makeRoot();
    mountCodex(root, makeCtrl(makeSnap({ save: saveWith([], [], 0) })), { acts: ACTS, beats: ['甲句'] });
    expect(ui(root, 'beat-history').hidden).toBe(true);
    expect(ui(root, 'beat-history-empty').hidden).toBe(false);
    expect(all(root, '[data-beat]')).toHaveLength(0);

    const root2 = makeRoot();
    const base = saveWith([], [], 0);
    const save = { ...base, settings: { ...base.settings, story: { ...base.settings.story, beatIndex: 5 } } };
    mountCodex(root2, makeCtrl(makeSnap({ save })), { acts: ACTS, beats: [] });
    expect(all(root2, '[data-beat]')).toHaveLength(0);
    expect(ui(root2, 'beat-history-empty').hidden).toBe(false);
  });

  it('CX#7c 只保留最近 N 条（越早的被截掉，顺序仍是旧→新）', () => {
    const root = makeRoot();
    const pool = Array.from({ length: 10 }, (_, i) => `句${i}`);
    const base = saveWith([], [], 0);
    const save = { ...base, settings: { ...base.settings, story: { ...base.settings.story, beatIndex: 6 } } };
    mountCodex(root, makeCtrl(makeSnap({ save })), { acts: ACTS, beats: pool, beatHistoryLimit: 2 });

    const expected = [4, 5].map((i) => nextBeat(pool, i).text);
    expect(all(root, '[data-beat]').map((li) => li.textContent)).toEqual(expected);
  });

  it('CX#7d 快照推进（又抽了一句）⇒ 历史跟着长一条', () => {
    const root = makeRoot();
    const pool = ['甲句', '乙句', '丙句'];
    const base = saveWith([], [], 0);
    const withCursor = (n: number) => ({
      ...base,
      settings: { ...base.settings, story: { ...base.settings.story, beatIndex: n } },
    });
    const ctrl = makeCtrl(makeSnap({ save: withCursor(1) }));
    mountCodex(root, ctrl, { acts: ACTS, beats: pool });
    expect(all(root, '[data-beat]')).toHaveLength(1);

    ctrl.push(makeSnap({ save: withCursor(2) }));
    expect(all(root, '[data-beat]').map((li) => li.textContent)).toEqual([0, 1].map((i) => nextBeat(pool, i).text));
  });
});

describe('mountCodex —— 拆除与导航', () => {
  it('CX#6 返回按钮调 onNav；unmount 摘 DOM 并撤销订阅', () => {
    const root = makeRoot();
    const nav: string[] = [];
    const decks = [makeDeck('d1', '唐诗', { purifiedAt: 5 })];
    const ctrl = makeCtrl(makeSnap({ save: saveWith(decks, []) }));
    const handle = mountCodex(root, ctrl, { acts: ACTS, onNav: (t) => nav.push(t) });
    click(ui(root, 'back'));
    expect(nav).toEqual(['menu']);

    handle.unmount();
    expect(all(root, '[data-codex-entry]')).toHaveLength(0);
    ctrl.push(makeSnap({ save: saveWith([makeDeck('d2', '乙', { purifiedAt: 9 })], []) }));
    expect(all(root, '[data-codex-entry]')).toHaveLength(0);
  });
});
