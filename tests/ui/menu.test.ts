// @vitest-environment happy-dom
/**
 * tests/ui/menu.test.ts —— Plan 4 · T7：主菜单（四入口 / 本地榜 Top10 / 备份提醒横幅）。
 *
 * 判别力：
 * - MN#2 12 条记录只上 10 行且**最高分在首行**：忘了 limit 或忘了排序的实现必红；
 * - MN#4 提醒横幅跟 `reminderDue` 走，"知道了"只压本次实例：
 *   把 dismiss 写成落盘/全局的实现会让"重新进菜单仍然弹"这条断言（MN#4b）红；
 * - MN#5 订阅刷新：不订阅的实现拿不到"存档变了榜就变"这条链。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '@core/leaderboard';
import { levelFromExp, playerStatsFor } from '../../src/app/growth';
import { mountMenu, type MenuTarget } from '../../src/ui/menu';
import { all, click, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, makeSrs, ui } from './support';

/** 本文件自己的时间锚（与其它 UI 用例同款：注入时钟，测试里不读真表）。 */
const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);

afterEach(() => {
  document.body.replaceChildren();
});

function run(id: string, score: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    at: 1_700_000_000_000 + score,
    result: 'won',
    kind: 'encounter',
    domain: '生活常识',
    cards: 15,
    misses: 0,
    level: 1,
    score,
    ...over,
  };
}

function saveWithLeaderboard(count: number) {
  const board: RunRecord[] = [];
  for (let i = 0; i < count; i++) board.push(run(`r${i}`, (i + 1) * 10));
  return makeSave({ settings: { ...makeSave().settings, leaderboard: board } });
}

describe('mountMenu —— 四入口', () => {
  it('MN#1 五个入口各自的导航目标正确（缺一个或对不上都算红）', () => {
    const root = makeRoot();
    const nav: MenuTarget[] = [];
    const ctrl = makeCtrl(makeSnap());
    mountMenu(root, ctrl, { onNav: (t) => nav.push(t) });

    expect(ui(root, 'menu-title').textContent).toBe('知识侠客');
    const entries = all(root, '[data-nav]');
    expect(entries.map((e) => e.getAttribute('data-nav'))).toEqual([
      'prepare',
      'decks',
      'practice',
      'codex',
      'settings',
    ]);
    // 「练功」是 D44 登记的唯一术语例外（用户指定的词），其余四个继续走大白话（LORE §8）
    expect(entries.map((e) => e.textContent)).toEqual(['开始复习', '卡组', '练功', '藏书阁', '设置']);
    for (const e of entries) click(e);
    expect(nav).toEqual(['prepare', 'decks', 'practice', 'codex', 'settings']);
  });
});

describe('mountMenu —— 本地榜 Top10', () => {
  it('MN#7 六维面板（终审 I-3）：等级与攻/防/体力/精神/气血全部可见，且与 app 层派生同源', () => {
    const root = makeRoot();
    // 造一份"练过"的档：2 张 mastered 卡 + 1 张自建 review 卡 + 若干经验
    const base = makeSave();
    const cards = [
      makeCard('c1', { srs: makeSrs({ stability: 'mastered', interval: 30, reps: 6 }) }),
      makeCard('c2', { srs: makeSrs({ stability: 'mastered', interval: 30, reps: 6 }) }),
      makeCard('c3', {
        srs: makeSrs({ stability: 'review' }),
        source: { type: 'manual', createdAt: 0 },
      }),
    ];
    const save = {
      ...base,
      cards,
      decks: [makeDeck('deck-a', '生活常识')],
      settings: { ...base.settings, progress: { exp: 1234 } },
    };
    const expected = playerStatsFor(save);
    const ctrl = makeCtrl(makeSnap({ save }));
    mountMenu(root, ctrl, { onNav: () => undefined });

    const stat = (k: string): string => (root.querySelector(`[data-stat="${k}"]`) as HTMLElement).textContent ?? '';
    expect(stat('level')).toBe(String(levelFromExp(1234)));
    expect(stat('atk')).toBe(String(expected.atk));
    expect(stat('def')).toBe(String(expected.def));
    expect(stat('vit')).toBe(String(expected.vit));
    expect(stat('spi')).toBe(String(expected.spi));
    expect(stat('maxHp')).toBe(String(expected.maxHp));
    expect(expected.vit).toBe(3); // 口径自检：stability ≥ review 的卡都计入体力（2 mastered + 1 review）
    expect(expected.spi).toBe(1); // 一张合格自建卡（manual + review + lapses≤2）计入精神

    // 快照一变（又练熟一张）面板跟着变——写死一次的实现在这条上红
    const more = { ...save, cards: [...cards, makeCard('c4', { srs: makeSrs({ stability: 'mastered', interval: 30, reps: 6 }) })] };
    ctrl.push(makeSnap({ save: more }));
    expect(stat('atk')).toBe(String(playerStatsFor(more).atk));
    expect(stat('vit')).toBe('4'); // 再加一张 mastered ⇒ 体力 +1
  });

  it('MN#2 12 条记录只上 10 行，且最高分在首行', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithLeaderboard(12) }));
    mountMenu(root, ctrl, { onNav: () => undefined });

    const rows = all(root, '[data-ui="rank-row"]');
    expect(rows).toHaveLength(10);
    expect(rows[0].textContent).toContain('120 分');
    expect(rows[0].textContent!.startsWith('1. ')).toBe(true);
    expect(rows[9].textContent).toContain('30 分');
    expect(ui(root, 'rank-empty').hidden).toBe(true);
  });

  it('MN#2b 行文案含领域与胜负（卷灵局额外标注）', () => {
    const root = makeRoot();
    const boss = run('b1', 200, { kind: 'boss', domain: '唐诗' });
    const lost = run('l1', 0, { result: 'lost', domain: '英语词根' });
    const save = makeSave({
      settings: { ...makeSave().settings, leaderboard: [boss, lost] },
    });
    const ctrl = makeCtrl(makeSnap({ save }));
    mountMenu(root, ctrl, { onNav: () => undefined });

    const rows = all(root, '[data-ui="rank-row"]').map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('唐诗');
    expect(rows[0]).toContain('卷灵');
    expect(rows[1]).toContain('英语词根');
    expect(rows[1]).toContain('败');
  });

  it('MN#3 空榜（含字段缺席）→ 显示"还没有战绩"而不是空列表', () => {
    const root = makeRoot();
    const noBoard = makeSave({ settings: { ...makeSave().settings, leaderboard: undefined } });
    const ctrl = makeCtrl(makeSnap({ save: noBoard }));
    mountMenu(root, ctrl, { onNav: () => undefined });

    expect(all(root, '[data-ui="rank-row"]')).toHaveLength(0);
    expect(ui(root, 'rank-empty').hidden).toBe(false);
  });

  it('MN#5 存档变化（新榜）→ 行数随之更新（订阅生效）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithLeaderboard(2) }));
    mountMenu(root, ctrl, { onNav: () => undefined });
    expect(all(root, '[data-ui="rank-row"]')).toHaveLength(2);

    ctrl.push(makeSnap({ save: saveWithLeaderboard(5) }));
    expect(all(root, '[data-ui="rank-row"]')).toHaveLength(5);
  });
});

describe('mountMenu —— 备份提醒横幅', () => {
  it('MN#4 reminderDue 为真才有横幅；「去备份」进卡组页', () => {
    const root = makeRoot();
    const nav: MenuTarget[] = [];
    const ctrl = makeCtrl(makeSnap({ reminderDue: true }));
    mountMenu(root, ctrl, { onNav: (t) => nav.push(t) });

    const banner = ui(root, 'backup-reminder');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('7 天没备份');

    click(ui(root, 'backup-go'));
    expect(nav).toEqual(['decks']);
  });

  it('MN#4b 闸门为假则不显示；「知道了」只压本实例（重进菜单照样弹）', () => {
    const root = makeRoot();
    const quiet = makeCtrl(makeSnap({ reminderDue: false }));
    mountMenu(root, quiet, { onNav: () => undefined });
    expect(ui(root, 'backup-reminder').hidden).toBe(true);

    const root2 = makeRoot();
    const ctrl = makeCtrl(makeSnap({ reminderDue: true }));
    mountMenu(root2, ctrl, { onNav: () => undefined });
    click(ui(root2, 'backup-dismiss'));
    expect(ui(root2, 'backup-reminder').hidden).toBe(true);

    // 重新进菜单 = 新实例 ⇒ 闸门仍是唯一判据（dismiss 不该落盘/全局）
    const root3 = makeRoot();
    mountMenu(root3, makeCtrl(makeSnap({ reminderDue: true })), { onNav: () => undefined });
    expect(ui(root3, 'backup-reminder').hidden).toBe(false);
  });
});

describe('mountMenu —— 拆除', () => {
  it('MN#6 unmount 摘 DOM 且撤销订阅', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithLeaderboard(3) }));
    const handle = mountMenu(root, ctrl, { onNav: () => undefined });
    expect(all(root, '[data-nav]')).toHaveLength(5);

    handle.unmount();
    expect(all(root, '[data-nav]')).toHaveLength(0);
    ctrl.push(makeSnap({ save: saveWithLeaderboard(9) }));
    expect(all(root, '[data-ui="rank-row"]')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ D57：个人纪录 */

/**
 * 判别力：
 * - MN#R1 四个维度都渲染出来（把纪录做成一个数字的实现必红）；
 * - MN#R2 口径正确：等级/经验来自存档、已掌握与自建卡按来源分类、复习天数取并集；
 * - MN#R3 昵称在注入口里时写进说明；没复习过时如实说"从今天开始"；
 * - MN#R4 本地榜**不动**（玩家要求两个都留）。
 */
describe('mountMenu —— 个人纪录（D57）', () => {
  const rec = (root: HTMLElement, key: string): string =>
    root.querySelector(`[data-record="${key}"]`)?.textContent ?? '';

  it('MN#R1/R2 四个维度都渲染，且口径正确', () => {
    const root = makeRoot();
    const save = makeSave({
      cards: [
        { ...makeCard('a'), srs: { ...makeCard('a').srs, stability: 'mastered', effectiveReviewDays: ['2026-10-26', '2026-10-27'] } },
        { ...makeCard('b'), srs: { ...makeCard('b').srs, stability: 'mastered', effectiveReviewDays: ['2026-10-25'] } },
        { ...makeCard('c'), source: { type: 'llm', createdAt: NOW } },
      ],
    });
    save.settings.progress = { exp: 120 };
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save }));
    mountMenu(root, ctrl, {
      onNav: () => undefined,
      now: () => Date.UTC(2026, 9, 27, 4, 0, 0), // 本地（+480）= 2026-10-27 12:00
      tzOffsetMin: 480,
    });

    expect(rec(root, 'level')).toContain('120 经验');
    expect(rec(root, 'mastered')).toContain('2 张');
    expect(rec(root, 'selfMade')).toContain('1 张'); // 只有 llm 那张算自建
    expect(rec(root, 'days')).toContain('3 天'); // 25/26/27 的并集
    expect(rec(root, 'days')).toContain('连续 3 天'); // 25/26/27 三天连着（并集之后就是连续三天）
  });

  it('MN#R3 昵称进说明；从没复习过时如实说"从今天开始"', () => {
    const withName = makeRoot();
    mountMenu(withName, makeCtrl(makeSnap({ screen: 'menu', save: makeSave() })), {
      onNav: () => undefined,
      now: () => Date.UTC(2026, 9, 27, 4, 0, 0),
      tzOffsetMin: 480,
      profile: { load: () => ({ nickname: '阿竹', userId: 'u-deadbeef' }) },
    });
    const hint = withName.querySelector('[data-ui="records-hint"]')?.textContent ?? '';
    expect(hint).toContain('阿竹');
    expect(hint).toContain('从 1 开始'); // 空账本的文案
  });

  it('MN#R4 本地榜仍在（两个都留）', () => {
    const root = makeRoot();
    const save = makeSave();
    save.settings.leaderboard = [
      { id: 'r1', at: NOW, result: 'won', kind: 'encounter', domain: '生活常识', cards: 3, misses: 0, level: 1, score: 80 },
    ];
    mountMenu(root, makeCtrl(makeSnap({ screen: 'menu', save })), {
      onNav: () => undefined,
      now: () => Date.UTC(2026, 9, 27, 4, 0, 0),
      tzOffsetMin: 480,
    });
    expect(root.querySelector('[data-ui="leaderboard"]')?.children.length).toBe(1);
    expect(root.querySelector('[data-ui="records-section"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ D58：战绩行显示名字 */

/**
 * 判别力：
 * - MN#T1 有 title 的记录显示名字（把多领域的一局写成"只有第一个领域"的实现必红）；
 * - MN#T2 老记录（没有 title）回落到领域名，不空着。
 */
describe('mountMenu —— 战绩行的名字（D58）', () => {
  const row = (i = 0): string => (all(document.body, '[data-ui="rank-row"]')[i]?.textContent ?? '');

  it('MN#T1 有名字就显示名字；MN#T2 老记录回落领域名', () => {
    const root = makeRoot();
    const save = makeSave();
    save.settings.leaderboard = [
      { id: 'r1', at: 2, result: 'won', kind: 'encounter', domain: '生活常识', cards: 3, misses: 0, level: 1, score: 80, title: '长安夜雨 · 唐诗 × 成语典故' },
      { id: 'r2', at: 1, result: 'lost', kind: 'encounter', domain: '生活常识', cards: 2, misses: 2, level: 1, score: 0 },
    ];
    mountMenu(root, makeCtrl(makeSnap({ screen: 'menu', save })), { onNav: () => undefined });
    expect(row(0)).toContain('长安夜雨 · 唐诗 × 成语典故');
    expect(row(0)).not.toContain('生活常识');
    expect(row(1)).toContain('生活常识'); // 老记录回流领域名
  });
});
