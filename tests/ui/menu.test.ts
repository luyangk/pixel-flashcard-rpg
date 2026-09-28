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
import { mountMenu, type MenuTarget } from '../../src/ui/menu';
import { all, click, makeCtrl, makeRoot, makeSave, makeSnap, ui } from './support';

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
  it('MN#1 四个入口各自的导航目标正确（缺一个或对不上都算红）', () => {
    const root = makeRoot();
    const nav: MenuTarget[] = [];
    const ctrl = makeCtrl(makeSnap());
    mountMenu(root, ctrl, { onNav: (t) => nav.push(t) });

    expect(ui(root, 'menu-title').textContent).toBe('知识侠客');
    const entries = all(root, '[data-nav]');
    expect(entries.map((e) => e.getAttribute('data-nav'))).toEqual(['prepare', 'decks', 'codex', 'settings']);
    for (const e of entries) click(e);
    expect(nav).toEqual(['prepare', 'decks', 'codex', 'settings']);
  });
});

describe('mountMenu —— 本地榜 Top10', () => {
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
    expect(all(root, '[data-nav]')).toHaveLength(4);

    handle.unmount();
    expect(all(root, '[data-nav]')).toHaveLength(0);
    ctrl.push(makeSnap({ save: saveWithLeaderboard(9) }));
    expect(all(root, '[data-ui="rank-row"]')).toHaveLength(0);
  });
});
