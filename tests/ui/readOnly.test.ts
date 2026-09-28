// @vitest-environment happy-dom
/**
 * tests/ui/readOnly.test.ts —— Plan 4 · T8：只读保护条（D29 三件套的 UI 两件）。
 *
 * 判别力：
 * - RO#2 文件名必须是 `zx-xia-corrupt-<本地日期>.json`（D29 verbatim），且用**注入**的
 *   时钟/时区算——写死日期或读宿主时钟的实现必红；
 * - RO#3 rawDump 给 null（连读都读不出来）时**不得**假装导出成功：不调 saveTextFile、如实报"读不出"
 *   ——给用户一份假的"你的存档"比什么都不给更危险；
 * - RO#4 rawDump 抛错要变成一句 toast，不能让异常逃到事件处理器（D29 的"全捕获可见"）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { corruptFileName, mountReadOnlyBar, READ_ONLY_TEXT } from '../../src/ui/readOnly';
import { click, flushMicrotasks, makeCtrl, makeRoot, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

describe('corruptFileName', () => {
  it('RO#1 文件名按本地日期（UTC+8 跨日边界走对）', () => {
    expect(corruptFileName(Date.UTC(2026, 9, 26, 20, 0, 0), 480)).toBe('zx-xia-corrupt-2026-10-27.json');
    expect(corruptFileName(Date.UTC(2026, 9, 26, 20, 0, 0), 0)).toBe('zx-xia-corrupt-2026-10-26.json');
  });
});

describe('mountReadOnlyBar —— 显隐', () => {
  it('RO#2 只读位为假时隐藏、为真时显示（文案 D29 verbatim），并随快照切换', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ readOnly: false }));
    mountReadOnlyBar(root, ctrl, {});
    expect(ui(root, 'readonly-bar').hidden).toBe(true);

    ctrl.push(makeSnap({ readOnly: true }));
    expect(ui(root, 'readonly-bar').hidden).toBe(false);
    expect(ui(root, 'readonly-text').textContent).toBe('存档无法读取，本次进度不会保存');
    expect(READ_ONLY_TEXT).toBe('存档无法读取，本次进度不会保存');

    ctrl.push(makeSnap({ readOnly: false }));
    expect(ui(root, 'readonly-bar').hidden).toBe(true);
  });

  it('RO#2b 没注入 rawDump/saveTextFile 时导出按钮隐藏', () => {
    const root = makeRoot();
    mountReadOnlyBar(root, makeCtrl(makeSnap({ readOnly: true })), {});
    expect(ui(root, 'readonly-dump').hidden).toBe(true);
  });

  it('RO#2c **只缺时钟**时也隐藏（否则会静默产出 1970 的文件名；评审判 m-2）', () => {
    const root = makeRoot();
    mountReadOnlyBar(root, makeCtrl(makeSnap({ readOnly: true })), {
      rawDump: () => Promise.resolve('{}'),
      saveTextFile: () => undefined,
      // 刻意不给 now
    });
    expect(ui(root, 'readonly-dump').hidden).toBe(true);

    // 补上时钟就出现（证明隐藏的原因确实是缺时钟，而不是别的）
    const root2 = makeRoot();
    mountReadOnlyBar(root2, makeCtrl(makeSnap({ readOnly: true })), {
      rawDump: () => Promise.resolve('{}'),
      saveTextFile: () => undefined,
      now: () => 0,
      toastMs: 0,
    });
    expect(ui(root2, 'readonly-dump').hidden).toBe(false);
  });
});

describe('mountReadOnlyBar —— 坏档原文导出', () => {
  it('RO#3 有原文：交出去恰一次，文件名按注入时钟/时区', async () => {
    const root = makeRoot();
    const saved: Array<[string, string]> = [];
    let dumps = 0;
    const ctrl = makeCtrl(makeSnap({ readOnly: true }));
    mountReadOnlyBar(root, ctrl, {
      toastMs: 0,
      now: () => Date.UTC(2026, 9, 26, 20, 0, 0),
      tzOffsetMin: 480,
      rawDump: () => {
        dumps += 1;
        return Promise.resolve('{"schemaVersion":2}');
      },
      saveTextFile: (text, filename) => saved.push([text, filename]),
    });

    click(ui(root, 'readonly-dump'));
    await flushMicrotasks();

    expect(dumps).toBe(1);
    expect(saved).toEqual([['{"schemaVersion":2}', 'zx-xia-corrupt-2026-10-27.json']]);
    expect((ui(root, 'readonly-dump') as HTMLButtonElement).disabled).toBe(false); // 结束后解禁（可再导一次）
    expect(document.querySelector('[data-ui="toast"]')?.textContent).toContain('请自己留好');
  });

  it('RO#3b 读不出原文（null/空串）：不生成文件，如实说读不出', async () => {
    const root = makeRoot();
    const saved: string[] = [];
    mountReadOnlyBar(root, makeCtrl(makeSnap({ readOnly: true })), {
      toastMs: 0,
      rawDump: () => Promise.resolve(null),
      saveTextFile: (text) => saved.push(text),
    });

    click(ui(root, 'readonly-dump'));
    await flushMicrotasks();
    expect(saved).toEqual([]);
    expect(document.querySelector('[data-ui="toast"]')?.textContent).toContain('读不出存储里的原文');

    document.body.replaceChildren();
    const root2 = makeRoot();
    const saved2: string[] = [];
    mountReadOnlyBar(root2, makeCtrl(makeSnap({ readOnly: true })), {
      toastMs: 0,
      rawDump: () => Promise.resolve(''),
      saveTextFile: (text) => saved2.push(text),
    });
    click(ui(root2, 'readonly-dump'));
    await flushMicrotasks();
    expect(saved2).toEqual([]);
  });

  it('RO#4 rawDump 抛错 → 变成 toast，不逃逸（D29「全捕获可见」）', async () => {
    const root = makeRoot();
    mountReadOnlyBar(root, makeCtrl(makeSnap({ readOnly: true })), {
      toastMs: 0,
      rawDump: () => Promise.reject(new Error('IndexedDB 炸了')),
      saveTextFile: () => undefined,
    });

    click(ui(root, 'readonly-dump'));
    await flushMicrotasks();
    expect(document.querySelector('[data-ui="toast"]')?.textContent).toContain('导出没能完成');
    expect(document.querySelector('[data-ui="toast"]')?.textContent).toContain('IndexedDB 炸了');
  });
});

describe('mountReadOnlyBar —— 拆除', () => {
  it('RO#5 unmount 摘 DOM 并撤销订阅（拆后推快照不重建）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ readOnly: true }));
    const handle = mountReadOnlyBar(root, ctrl, { rawDump: () => Promise.resolve('x'), saveTextFile: () => undefined });
    expect(document.querySelector('[data-ui="readonly-bar"]')).not.toBeNull();

    handle.unmount();
    expect(document.querySelector('[data-ui="readonly-bar"]')).toBeNull();
    ctrl.push(makeSnap({ readOnly: true }));
    expect(document.querySelector('[data-ui="readonly-bar"]')).toBeNull();
  });
});
