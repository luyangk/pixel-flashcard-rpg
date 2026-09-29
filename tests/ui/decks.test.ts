// @vitest-environment happy-dom
/**
 * tests/ui/decks.test.ts —— Plan 4 · T7：卡组页（分页 / 手写加卡 / 新建领域 / 导入导出）。
 *
 * 判别力：
 * - DK#1 120 张卡首屏**只有 50 行**：「加载更多」再 +50——一次性全挂的实现（120 行）必红，
 *   这也是 Review Focus #5「长列表性能」的可测判据；
 * - DK#5 导出 `ok:false` 但带 text 时**仍然触发下载**（FFW-p3-b）：把 text 丢掉的实现必红；
 * - DK#6 用户在文件选择里取消（null）⇒ 不调导入、不弹 toast（取消不是错误）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Card } from '@core/types';
import type { ExportAndMarkResult, ImportAndSaveResult } from '../../src/app/transfer';
import { backupFileName, mountDecks, PAGE_SIZE } from '../../src/ui/decks';
import { all, click, flushMicrotasks, makeCard, makeCtrl, makeDeck, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

function saveWithCards(n: number) {
  const cards: Card[] = [];
  for (let i = 0; i < n; i++) cards.push(makeCard(`c${i}`, { deckId: 'deck-a', front: `问${i}`, back: `答${i}` }));
  return makeSave({ decks: [makeDeck('deck-a', '生活常识')], cards });
}

describe('mountDecks —— 分页（Review Focus #5）', () => {
  it('DK#1 120 张卡首屏 50 行；加载更多 +50；到底后按钮隐藏', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWithCards(120) }));
    mountDecks(root, ctrl, { onNav: () => undefined });

    expect(ui(root, 'card-count').textContent).toBe('共 120 张 · 已显示 50 张');
    expect(all(root, '[data-card-id]')).toHaveLength(PAGE_SIZE);
    expect(ui(root, 'load-more').hidden).toBe(false);

    click(ui(root, 'load-more'));
    expect(all(root, '[data-card-id]')).toHaveLength(100);
    expect(ui(root, 'card-count').textContent).toBe('共 120 张 · 已显示 100 张');

    click(ui(root, 'load-more'));
    expect(all(root, '[data-card-id]')).toHaveLength(120);
    expect(ui(root, 'load-more').hidden).toBe(true);
  });

  it('DK#1b 少于 50 张时不出现「加载更多」；空库给大白话', () => {
    const root = makeRoot();
    mountDecks(root, makeCtrl(makeSnap({ save: saveWithCards(3) })), {});
    expect(all(root, '[data-card-id]')).toHaveLength(3);
    expect(ui(root, 'load-more').hidden).toBe(true);

    const root2 = makeRoot();
    mountDecks(root2, makeCtrl(makeSnap({ save: makeSave({ cards: [] }) })), {});
    expect(ui(root2, 'card-empty').hidden).toBe(false);
    expect(ui(root2, 'card-count').textContent).toBe('空卡库');
  });

  it('DK#1c 行内带领域名（不是裸 deckId）', () => {
    const root = makeRoot();
    mountDecks(root, makeCtrl(makeSnap({ save: saveWithCards(1) })), {});
    expect(ui(root, 'card-deck').textContent).toBe('生活常识');
  });
});

describe('mountDecks —— 手写加卡', () => {
  it('DK#2 提交一次只调一次写口；成功后清空输入并提示', async () => {
    const root = makeRoot();
    const calls: Array<{ front: string; back: string; deckId: string; id: string }> = [];
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(0) }));
    mountDecks(root, ctrl, {
      newId: () => 'new-id-1',
      toastMs: 0,
      addCard: (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true, value: makeCard(input.id) });
      },
    });

    (ui(root, 'add-front') as HTMLInputElement).value = ' 唐朝开国皇帝是谁？ ';
    (ui(root, 'add-back') as HTMLInputElement).value = '李渊';
    (ui(root, 'add-deck') as HTMLSelectElement).value = 'deck-a';

    click(ui(root, 'add-submit'));
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ front: ' 唐朝开国皇帝是谁？ ', back: '李渊', deckId: 'deck-a', id: 'new-id-1' });
    expect((ui(root, 'add-front') as HTMLInputElement).value).toBe('');
    expect((ui(root, 'add-back') as HTMLInputElement).value).toBe('');
    expect(ui(root, 'toast').textContent).toBe('已加入卡库。');
  });

  it('DK#2b 写口拒绝：提示原因且**不清空输入**（别让玩家重打一遍）', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(0) }));
    mountDecks(root, ctrl, {
      newId: () => 'dup',
      toastMs: 0,
      addCard: () => Promise.resolve({ ok: false, reason: '正面不能是空的——写一句问题或提示吧。' }),
    });

    (ui(root, 'add-front') as HTMLInputElement).value = '';
    (ui(root, 'add-back') as HTMLInputElement).value = '李渊';
    click(ui(root, 'add-submit'));
    await flushMicrotasks();

    expect(ui(root, 'toast').textContent).toContain('正面不能是空的');
    expect((ui(root, 'add-back') as HTMLInputElement).value).toBe('李渊');
  });

  it('DK#2c 未注入写口时表单整块隐藏（不显示点了没反应的入口）', () => {
    const root = makeRoot();
    mountDecks(root, makeCtrl(makeSnap({ save: saveWithCards(1) })), {});
    expect(ui(root, 'add-form').hidden).toBe(true);
    expect(ui(root, 'new-deck-form').hidden).toBe(true);
    expect(ui(root, 'export').hidden).toBe(true);
    expect(ui(root, 'import').hidden).toBe(true);
  });
});

describe('mountDecks —— 新建领域', () => {
  it('DK#3 建领域走写口，成功后提示带领域名', async () => {
    const root = makeRoot();
    const names: string[] = [];
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(1) }));
    mountDecks(root, ctrl, {
      newId: () => 'deck-new',
      toastMs: 0,
      addDeck: (input) => {
        names.push(input.name);
        return Promise.resolve({ ok: true, value: makeDeck(input.id, input.name) });
      },
    });

    (ui(root, 'new-deck-name') as HTMLInputElement).value = '唐诗';
    click(ui(root, 'create-deck'));
    await flushMicrotasks();

    expect(names).toEqual(['唐诗']);
    expect(ui(root, 'toast').textContent).toBe('领域「唐诗」已建好。');
  });

  it('DK#3b 空库时加卡提交禁用（先得有领域可挂）', () => {
    const root = makeRoot();
    mountDecks(root, makeCtrl(makeSnap({ save: makeSave({ decks: [], cards: [] }) })), {
      newId: () => 'x',
      addCard: () => Promise.resolve({ ok: false, reason: 'x' }),
    });
    expect((ui(root, 'add-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('mountDecks —— 备份导入导出', () => {
  it('DK#4 导出成功：文本交给用户一次，文件名按注入时钟与文件名生成', async () => {
    const root = makeRoot();
    const saved: Array<[string, string]> = [];
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(1) }));
    mountDecks(root, ctrl, {
      toastMs: 0,
      // 2023-11-15T00:00:00Z 在 UTC+8 是 2023-11-15 08:00 ⇒ 本地日期 2023-11-15
      now: () => 1_700_006_400_000,
      tzOffsetMin: 480,
      exportBackup: () => Promise.resolve({ ok: true, text: '{"format":"zx-xia"}' }),
      saveTextFile: (text, filename) => saved.push([text, filename]),
    });

    click(ui(root, 'export'));
    await flushMicrotasks();

    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toBe('{"format":"zx-xia"}');
    expect(saved[0][1]).toBe(backupFileName(1_700_006_400_000, 480));
    expect(saved[0][1]).toBe('zx-xia-backup-2023-11-15.json');
    expect(ui(root, 'toast').textContent).toBe('备份已导出。');
  });

  it('DK#5「文件已生成但没记上时刻」：ok:false 也**必须**把文本交出去（FFW-p3-b）', async () => {
    const root = makeRoot();
    const saved: string[] = [];
    const failure: ExportAndMarkResult = {
      ok: false,
      text: '{"format":"zx-xia","save":{}}',
      reason: '导出没能完成：备份文件已生成，但"已备份"记录没能写入存储——请先自己保存好这份文件。',
    };
    mountDecks(root, makeCtrl(makeSnap({ save: saveWithCards(1) })), {
      toastMs: 0,
      exportBackup: () => Promise.resolve(failure),
      saveTextFile: (text) => saved.push(text),
    });

    click(ui(root, 'export'));
    await flushMicrotasks();

    expect(saved).toEqual([failure.text]);
    expect(ui(root, 'toast').textContent).toContain('请先自己保存好这份文件');
  });

  it('DK#6 导入：把文本原样交给编排层；取消（null）则完全不调', async () => {
    const root = makeRoot();
    const seen: string[] = [];
    const okResult: ImportAndSaveResult = { ok: true };
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(1) }));
    mountDecks(root, ctrl, {
      toastMs: 0,
      pickBackupText: () => Promise.resolve('{"format":"zx-xia"}'),
      importBackup: (text) => {
        seen.push(text);
        return Promise.resolve(okResult);
      },
    });

    click(ui(root, 'import'));
    await flushMicrotasks();
    expect(seen).toEqual(['{"format":"zx-xia"}']);
    expect(ui(root, 'toast').textContent).toBe('备份已导入。');

    document.body.replaceChildren();
    const root2 = makeRoot();
    let called = 0;
    mountDecks(root2, makeCtrl(makeSnap({ save: saveWithCards(1) })), {
      toastMs: 0,
      pickBackupText: () => Promise.resolve(null),
      importBackup: () => {
        called += 1;
        return Promise.resolve({ ok: false, reason: '不该走到这里' });
      },
    });
    click(ui(root2, 'import'));
    await flushMicrotasks();
    expect(called).toBe(0);
    expect(root2.querySelector('[data-ui="toast"]')).toBeNull();
  });
});

describe('mountDecks —— 拆除', () => {
  it('DK#7 unmount 摘 DOM 并撤销订阅（拆后推快照不重建）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(60) }));
    const handle = mountDecks(root, ctrl, { onNav: () => undefined });
    expect(all(root, '[data-card-id]')).toHaveLength(50);

    handle.unmount();
    expect(all(root, '[data-card-id]')).toHaveLength(0);
    ctrl.push(makeSnap({ save: saveWithCards(120) }));
    expect(all(root, '[data-card-id]')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ 刷新指纹与防连点（T7 评审修复） */

describe('mountDecks —— 刷新指纹带内容（评审判 I-3）', () => {
  it('DK#8 同条数、同领域的另一批卡（导入备份的真实路径）→ 列表必须刷新', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(3) }));
    mountDecks(root, ctrl, {});
    expect(all(root, '[data-card-id]').map((r) => r.querySelector('.card-front')?.textContent)).toEqual([
      '问0',
      '问1',
      '问2',
    ]);

    // 换汤不换药：条数一样、领域一样、id 相同，只有内容变了
    const swapped = saveWithCards(3);
    swapped.cards = swapped.cards.map((c, i) => ({ ...c, front: `新问${i}`, back: `新答${i}` }));
    ctrl.push(makeSnap({ save: swapped }));
    expect(all(root, '[data-card-id]').map((r) => r.querySelector('.card-front')?.textContent)).toEqual([
      '新问0',
      '新问1',
      '新问2',
    ]);
  });

  it('DK#8b 加卡后下拉里的领域计数跟着刷新（只按领域指纹早退的实现必红）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(3) }));
    mountDecks(root, ctrl, {});
    const optionText = (): string => (ui(root, 'add-deck').children[0] as HTMLOptionElement).textContent ?? '';
    expect(optionText()).toBe('生活常识（3）');

    ctrl.push(makeSnap({ save: saveWithCards(4) }));
    expect(optionText()).toBe('生活常识（4）');
  });
});

describe('mountDecks —— 防连点（RF#3 的卡组页面）', () => {
  it('DK#9 写口未回来前再点「加入卡库」不会重复调用（删掉 busy 守卫的实现必红）', async () => {
    const root = makeRoot();
    let addCalls = 0;
    let release: () => void = () => undefined;
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(0) }));
    mountDecks(root, ctrl, {
      newId: () => 'new-id',
      toastMs: 0,
      addCard: () => {
        addCalls += 1; // 只数**写口**被调了几次——"点了几次"不是重点
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, value: makeCard('x') });
        });
      },
    });

    click(ui(root, 'add-submit'));
    await flushMicrotasks();
    expect(addCalls).toBe(1);
    expect((ui(root, 'add-submit') as HTMLButtonElement).disabled).toBe(true);
    click(ui(root, 'add-submit')); // 第二次点击必须被 busy 吃掉
    await flushMicrotasks();
    expect(addCalls).toBe(1);
    release();
    await flushMicrotasks();
    expect((ui(root, 'add-submit') as HTMLButtonElement).disabled).toBe(false); // 回执后解禁
  });

  it('DK#9b 文件选择未回来前再点「导入备份」只开一个选择器（busy 在 await 之前置位）', async () => {
    const root = makeRoot();
    let picks = 0;
    let release: (v: string | null) => void = () => undefined;
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(1) }));
    mountDecks(root, ctrl, {
      toastMs: 0,
      pickBackupText: () => {
        picks += 1;
        return new Promise<string | null>((resolve) => {
          release = resolve;
        });
      },
      importBackup: () => Promise.resolve({ ok: true }),
    });

    click(ui(root, 'import'));
    await flushMicrotasks();
    click(ui(root, 'import'));
    await flushMicrotasks();
    expect(picks).toBe(1);

    release(null);
    await flushMicrotasks();
    expect((ui(root, 'import') as HTMLButtonElement).disabled).toBe(false);
  });

  it('DK#9c 写口 reject（只读闩锁）→ 变成 toast，不逃逸成未处理 rejection', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWithCards(0) }));
    mountDecks(root, ctrl, {
      newId: () => 'x',
      toastMs: 0,
      addCard: () => Promise.reject(new Error('存档无法读取（已进入只读保护）')),
    });

    click(ui(root, 'add-submit'));
    await flushMicrotasks();
    expect(ui(root, 'toast').textContent).toContain('只读保护');
  });
});

/* ------------------------------------------------------------------ Plan 8 · T12 */

/**
 * 卡组页的「采新卡」入口（D49：用户反馈"都是建卡嘛"）。
 *
 * 判别力：
 * - DC#E1 注入 `onCollect` ⇒ 入口可见且点击调它（缺省 ⇒ **隐藏**：不显示点了没反应的入口）；
 * - DC#E2 它挂在「AI 辅建卡」附近（同一件事的两种来源，入口不该分居两屏）。
 */
describe('mountDecks —— 采新卡入口（Plan 8 · T12 / D49）', () => {
  function mountWith(over: Record<string, unknown> = {}) {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: makeSave({ decks: [makeDeck('d1', '唐诗')], cards: [makeCard('c1')] }) }));
    mountDecks(root, ctrl, over as never);
    return root;
  }

  it('DC#E1 注入 onCollect ⇒ 入口可见、点了调它；缺省 ⇒ 隐藏', () => {
    const calls: number[] = [];
    const shown = mountWith({ onCollect: () => void calls.push(1) });
    expect(ui(shown, 'collect-entry').hidden).toBe(false);
    expect(ui(shown, 'collect-open').hidden).toBe(false);
    click(ui(shown, 'collect-open'));
    expect(calls).toEqual([1]);

    const bare = mountWith();
    expect(ui(bare, 'collect-entry').hidden).toBe(true);
  });

  it('DC#E2 入口就在「AI 辅建卡」附近（同一件事的两种来源）', () => {
    const root = mountWith({
      onCollect: () => undefined,
      // 辅建卡需要 addCard + llmCards 两个口才显示（与既有纪律一致）
      addCard: () => Promise.resolve({ ok: true, value: makeCard('x') }),
      llmCards: () => Promise.resolve({ ok: true, value: [], truncated: false }),
    });
    const author = root.querySelector('[data-ui="llm-author-section"]') as HTMLElement | null;
    const entry = root.querySelector('[data-ui="collect-entry"]') as HTMLElement | null;
    expect(author).not.toBeNull();
    expect(entry).not.toBeNull();
    // 两者相邻：入口紧跟在辅建卡 section 之后
    expect(author?.nextElementSibling).toBe(entry);
  });
});
