// @vitest-environment happy-dom
/**
 * tests/ui/settings.reset.test.ts —— Plan 5 追加：设置屏「存档」分组（重置 + 先导出备份）。
 *
 * 用户提的是"需要一个重置存档的方法，我不知道如何从头体验"——所以这一组的重点是
 * **不可逆动作的摩擦与诚实披露**，不是"按钮能不能点"。
 * 判别力（每条都写清"坏实现为何必红"）：
 * - SR#1 缺 `resetSave` 注入 ⇒ 整组隐藏（假实现"永远显示一个点了没反应的按钮"必红）；
 * - SR#2 **两步确认**：第一次点击只展开代价说明，`resetSave` 一次都不许被调用
 *   （直接绑 `resetSave` 到按钮上的实现必红——那是"误触即清档"）；
 * - SR#3 第二次（确认按钮）才真调，成功 toast 报出"回来多少领域/多少卡"，并收起确认态；
 * - SR#4 失败如实上屏（`ok:false` 的 reason 原样显示），确认态**保留**（玩家可重试或改主意）；
 * - SR#5 写口 reject 也不许逃逸（只读闩锁会真 reject）——收成一句 toast；
 * - SR#6 「先导出备份」调 `exportBackupNow`，且**导出失败也如实说**；缺该口则按钮不显示；
 * - SR#7 代价清单逐项都在（卡库 / 进度 / 等级 / 榜单 / 序章 / 设置），且明说 Key 不受影响
 *   （说漏"卡库会没"就是误导：玩家以为只是清进度）；
 * - SR#8 在途期间按钮禁用（连点两次 = 连清两遍，必须被挡住）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSettings } from '../../src/ui/settings';
import { all, click, flushMicrotasks, makeCtrl, makeRoot, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

/** 装一次设置屏，回传常用查询与 spy。 */
function mount(opts: { readonly resetSave?: unknown; readonly exportBackupNow?: unknown } = {}) {
  const root = makeRoot();
  const ctrl = makeCtrl();
  const deps = {
    onNav: () => undefined,
    toastMs: 0,
    ...(opts.resetSave === undefined ? {} : { resetSave: opts.resetSave }),
    ...(opts.exportBackupNow === undefined ? {} : { exportBackupNow: opts.exportBackupNow }),
  };
  const handle = mountSettings(root, ctrl, deps as never);
  return { root, ctrl, handle };
}

const OK_RESET = () => Promise.resolve({ ok: true as const, cards: 30, decks: 4 });

describe('设置屏「存档」分组', () => {
  it('SR#1 没接 resetSave ⇒ 整组隐藏', () => {
    const { root } = mount();
    expect(ui(root, 'save-group').hidden).toBe(true);
    // 「重置存档」按钮不该以"可见但没反应"的形态留在屏上
    expect(ui(root, 'save-reset').hidden).toBe(false); // 按钮本身在 DOM 里，但父分组藏着
    expect(isVisible(ui(root, 'save-reset'))).toBe(false);
  });

  it('SR#2 第一次点击只展开代价说明，绝不调 resetSave', async () => {
    const resetSave = vi.fn(OK_RESET);
    const { root } = mount({ resetSave });
    expect(ui(root, 'save-reset-actions').hidden).toBe(true);

    click(ui(root, 'save-reset'));
    await flushMicrotasks();

    expect(resetSave).not.toHaveBeenCalled();
    expect(ui(root, 'save-reset-actions').hidden).toBe(false);
    expect(ui(root, 'save-reset-warning').textContent).toContain('不能撤销');
    // 触发按钮在确认态被禁用：不给"再点一下也当确认"的歧义
    expect((ui(root, 'save-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('SR#3 确认后才真重置，成功 toast 报出回来的领域/卡数并收起确认态', async () => {
    const resetSave = vi.fn(OK_RESET);
    const { root } = mount({ resetSave });
    click(ui(root, 'save-reset'));
    await flushMicrotasks();
    click(ui(root, 'save-reset-confirm'));
    await flushMicrotasks();

    expect(resetSave).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('4 个领域');
    expect(root.textContent).toContain('30 张卡');
    expect(ui(root, 'save-reset-actions').hidden).toBe(true);
    expect((ui(root, 'save-reset') as HTMLButtonElement).disabled).toBe(false);
  });

  it('SR#4 失败如实上屏，且确认态保留（可重试）', async () => {
    const resetSave = vi.fn(() => Promise.resolve({ ok: false as const, reason: '清空存储失败：配额满了（存档没有被改动）。' }));
    const { root } = mount({ resetSave });
    click(ui(root, 'save-reset'));
    await flushMicrotasks();
    click(ui(root, 'save-reset-confirm'));
    await flushMicrotasks();

    expect(root.textContent).toContain('配额满了');
    expect(ui(root, 'save-reset-actions').hidden).toBe(false);
  });

  it('SR#5 写口 reject 不许逃逸（只读闩锁会真 reject）', async () => {
    const resetSave = vi.fn(() => Promise.reject(new Error('存档无法读取（已进入只读保护）')));
    const { root } = mount({ resetSave });
    click(ui(root, 'save-reset'));
    await flushMicrotasks();
    click(ui(root, 'save-reset-confirm'));
    await flushMicrotasks();

    expect(root.textContent).toContain('重置没能完成');
    expect(root.textContent).toContain('只读保护');
  });

  it('SR#6 「先导出备份」调 exportBackupNow；失败也如实说；没这个口就不显示', async () => {
    const exportOk = vi.fn(() => Promise.resolve({ ok: true }));
    const a = mount({ resetSave: OK_RESET, exportBackupNow: exportOk });
    click(ui(a.root, 'save-reset'));
    await flushMicrotasks();
    click(ui(a.root, 'save-export-first'));
    await flushMicrotasks();
    expect(exportOk).toHaveBeenCalledTimes(1);
    expect(a.root.textContent).toContain('备份已导出');

    const exportFail = vi.fn(() => Promise.resolve({ ok: false, reason: '改动还没能全部写进存储，这次没有生成备份文件（稍后再试）。' }));
    const b = mount({ resetSave: OK_RESET, exportBackupNow: exportFail });
    click(ui(b.root, 'save-reset'));
    await flushMicrotasks();
    click(ui(b.root, 'save-export-first'));
    await flushMicrotasks();
    expect(b.root.textContent).toContain('没有生成备份文件');

    // 没接导出就整个按钮不显示（不是"点了没反应"）
    const c = mount({ resetSave: OK_RESET });
    click(ui(c.root, 'save-reset'));
    await flushMicrotasks();
    expect(isVisible(ui(c.root, 'save-export-first'))).toBe(false);
    expect(all(c.root, '[data-ui="save-export-first"]').length).toBe(1);
  });

  it('SR#7 代价清单逐项在，且明说 Key 不受影响', async () => {
    const { root } = mount({ resetSave: OK_RESET });
    click(ui(root, 'save-reset'));
    await flushMicrotasks();
    const warning = ui(root, 'save-reset-warning').textContent ?? '';
    for (const item of ['卡库', '复习进度', '等级', '战绩榜', '序章记录', '设置']) {
      expect(warning).toContain(item);
    }
    expect(warning).toContain('不能撤销');
    expect(warning).toContain('Key'); // "重置会不会把我的 Key 也清掉"是必然的疑问
    expect(warning).toContain('不用重填');
  });

  it('SR#8 在途期间按钮禁用：连点两次只清一遍', async () => {
    // 初值给一个空操作而不是 null：TS 的控制流分析看不到"executor 稍后才赋值"，
    // 声明成 `| null` 会在调用点被收窄成 never（`release?.()` 直接类型报错）。
    let release: () => void = () => undefined;
    const resetSave = vi.fn(
      () =>
        new Promise<{ ok: true; cards: number; decks: number }>((resolve) => {
          release = () => resolve({ ok: true, cards: 30, decks: 4 });
        }),
    );
    const { root } = mount({ resetSave });
    click(ui(root, 'save-reset'));
    await flushMicrotasks();

    click(ui(root, 'save-reset-confirm'));
    click(ui(root, 'save-reset-confirm')); // 第二次点击必须被挡（disabled）
    await flushMicrotasks();
    expect(resetSave).toHaveBeenCalledTimes(1);
    expect((ui(root, 'save-reset-confirm') as HTMLButtonElement).disabled).toBe(true);

    release();
    await flushMicrotasks();
    expect((ui(root, 'save-reset-confirm') as HTMLButtonElement).disabled).toBe(false);
  });
});

/** 元素是否真的可见（自己与所有祖先都没有 hidden）——只查自身 hidden 会漏掉藏在分组里的按钮。 */
function isVisible(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.hidden) return false;
    cur = cur.parentElement;
  }
  return true;
}
