// @vitest-environment happy-dom
/**
 * tests/ui/result.test.ts —— Plan 4 · T7：结算屏（胜负 / 经验升级 / 战报碎片 / 假记忆演出）。
 *
 * 判别力：
 * - RS#3 碎片**每实例只抽一次**：每次 render 都抽的实现会在 push 快照后跳到下一句 ⇒ 必红；
 * - RS#4 假记忆按 LORE §5.5 的"闪现 → 打叉揭示 → 下一张"两拍推进（注入手动调度器逐拍断言）：
 *   直接一上来就显示 ✕ 的实现、或永不推进的实现，都会在某一拍上红；
 * - RS#5「跳过演出」推到终态且**不留待触发的定时器**（否则拆屏后回调会打到已摘的 DOM）；
 * - RS#6 资产表（assets/narrative/fake-words.json）与规则引擎联测：篡改后**不得等于真答案**
 *   （LORE §5.5 硬契约），也不得把答案掏空成空串。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mulberry32 } from '@core/rng';
import type { FakeCard } from '../../src/app/fakeMemory';
import { pickFakes } from '../../src/app/fakeMemory';
import type { RunSummary } from '../../src/app/controllerTypes';
import { mountResult } from '../../src/ui/result';
import fakeWordsJson from '../../assets/narrative/fake-words.json';
import { all, click, makeCard, makeCtrl, makeRoot, makeSave, makeScheduler, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    won: true,
    expGained: 12,
    levelBefore: 1,
    levelAfter: 1,
    leveledUp: false,
    misses: 2,
    poolLen: 15,
    ...over,
  };
}

function fake(id: string, front: string, tamperedBack: string): FakeCard {
  return { id: `${id}#word-swap`, realCardId: id, front, tamperedBack, rule: 'word-swap' };
}

function snapWith(res: RunSummary | null, beatIndex = 0) {
  const base = makeSave();
  const save = { ...base, settings: { ...base.settings, story: { prologueSeen: true, beatIndex } } };
  return makeSnap({ screen: 'result', save, lastResult: res });
}

describe('mountResult —— 胜负与成长', () => {
  it('RS#1 胜局：图标/经验/等级/战况齐备，且不显示假记忆区', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, {});

    expect(ui(root, 'outcome').textContent).toBe('胜');
    expect(ui(root, 'outcome').getAttribute('data-won')).toBe('true');
    expect(ui(root, 'exp').textContent).toBe('经验 +12');
    expect(ui(root, 'level').textContent).toBe('等级 1');
    expect(ui(root, 'stats').textContent).toBe('出战 15 张 · 空转 2 次');
    expect(ui(root, 'fake-memory').hidden).toBe(true);
    expect(ui(root, 'no-result').hidden).toBe(true);
  });

  it('RS#2 升级局标出"升级！"（成败/升级三态不混）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary({ leveledUp: true, levelBefore: 2, levelAfter: 3 })));
    mountResult(root, ctrl, {});
    expect(ui(root, 'level').textContent).toBe('等级 2 → 3（升级！）');
  });

  it('RS#7 败局经验为 0 也照常上屏；lastResult 为 null 时给大白话与回菜单', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary({ won: false, expGained: 0 })));
    mountResult(root, ctrl, {});
    expect(ui(root, 'outcome').textContent).toBe('败');
    expect(ui(root, 'exp').textContent).toBe('经验 +0');

    const root2 = makeRoot();
    const ctrl2 = makeCtrl(snapWith(null));
    mountResult(root2, ctrl2, {});
    expect(ui(root2, 'no-result').hidden).toBe(false);
    expect(ui(root2, 'summary').hidden).toBe(true);
    click(ui(root2, 'to-menu'));
    expect(ctrl2.intents).toEqual([{ type: 'finish' }]);
  });
});

describe('mountResult —— 战报碎片', () => {
  it('RS#3 每实例只抽一次：快照更新不再抽下一句（每次 render 都抽的实现必红）', () => {
    const root = makeRoot();
    // 两句的池：轮内不重复（beats.test.ts B#1）⇒ 第二句必与第一句不同，
    // 于是"快照重放会不会重抽"这件事在屏幕文本上是可判别的（重抽必然换句）。
    const beats = ['甲句', '乙句'];
    const drawn: number[] = [];
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, { beats, onBeatDrawn: (c) => drawn.push(c) });

    const first = ui(root, 'beat').textContent;
    expect(first).not.toBe('');
    expect(drawn).toEqual([1]); // 游标 0 → next 1

    ctrl.push(snapWith(summary(), 1)); // 宿主把游标写回后推的新快照
    expect(ui(root, 'beat').textContent).toBe(first); // 不重抽 ⇒ 文本不变
    expect(drawn).toEqual([1]); // 也不重复回传游标
  });

  it('RS#3b 空池不抽、不显示碎片（也不回传游标）', () => {
    const root = makeRoot();
    const drawn: number[] = [];
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, { beats: [], onBeatDrawn: (c) => drawn.push(c) });
    expect(ui(root, 'beat').hidden).toBe(true);
    expect(drawn).toEqual([]);
  });
});

describe('mountResult —— 假记忆战败演出（LORE §5.5）', () => {
  const twoFakes = [fake('c1', '唐朝开国皇帝是谁？', '宋朝'), fake('c2', '光的速度约多少？', '每秒 30 万公里')];

  it('RS#4 两拍推进：闪现 → 打叉揭示 → 下一张 → 终态', () => {
    const root = makeRoot();
    const sched = makeScheduler();
    const ctrl = makeCtrl(snapWith(summary({ won: false, expGained: 0 })));
    mountResult(root, ctrl, { fakes: twoFakes, ...sched });

    // 第一拍：只显示被篡改的答案，✕ 尚未出现
    expect(ui(root, 'fake-memory').hidden).toBe(false);
    expect(ui(root, 'fake-front').textContent).toBe('唐朝开国皇帝是谁？');
    expect(ui(root, 'fake-back').textContent).toBe('宋朝');
    expect(ui(root, 'fake-card').getAttribute('data-fake-rule')).toBe('word-swap');
    expect(ui(root, 'fake-card').getAttribute('data-revealed')).toBe('false');
    expect(ui(root, 'fake-cross').hidden).toBe(true);
    expect(ui(root, 'fake-progress').textContent).toBe('1 / 2');
    expect(sched.pending()).toBe(1);

    sched.fire(); // 揭示
    expect(ui(root, 'fake-cross').hidden).toBe(false);
    expect(ui(root, 'fake-reveal-text').textContent).toBe('假的。幸好你没记住它。');
    expect(ui(root, 'fake-card').getAttribute('data-revealed')).toBe('true');

    sched.fire(); // 下一张：答案收回、✕ 收回
    expect(ui(root, 'fake-progress').textContent).toBe('2 / 2');
    expect(ui(root, 'fake-card').getAttribute('data-revealed')).toBe('false');
    expect(ui(root, 'fake-cross').hidden).toBe(true);

    sched.fire(); // 最后一张揭示即终态
    expect(ui(root, 'fake-cross').hidden).toBe(false);
    expect(ui(root, 'fake-skip').hidden).toBe(true);
    expect(sched.pending()).toBe(0);
  });

  it('RS#5「跳过演出」直接到终态，并清掉待触发的定时器', () => {
    const root = makeRoot();
    const sched = makeScheduler();
    const ctrl = makeCtrl(snapWith(summary({ won: false, expGained: 0 })));
    mountResult(root, ctrl, { fakes: twoFakes, ...sched });

    click(ui(root, 'fake-skip'));
    expect(ui(root, 'fake-cross').hidden).toBe(false);
    expect(ui(root, 'fake-progress').textContent).toBe('2 / 2');
    expect(sched.pending()).toBe(0);
    expect(ui(root, 'fake-skip').hidden).toBe(true);
  });

  it('RS#4b 胜局即使有素材也不演出（素材是败局专属）', () => {
    const root = makeRoot();
    const sched = makeScheduler();
    const ctrl = makeCtrl(snapWith(summary({ won: true })));
    mountResult(root, ctrl, { fakes: twoFakes, ...sched });
    expect(ui(root, 'fake-memory').hidden).toBe(true);
    expect(sched.pending()).toBe(0);
  });

  it('RS#6 词表资产 × 规则引擎：篡改后 ≠ 真答案、front 保真、答案不被掏空', () => {
    const table = new Map(Object.entries(fakeWordsJson.pairs as Record<string, string>));
    expect(table.size).toBeGreaterThanOrEqual(8);
    for (const [from, to] of table) {
      expect(from.length).toBeGreaterThan(0);
      expect(to.length).toBeGreaterThan(0);
      expect(to).not.toBe(from);
    }

    const pool = [
      makeCard('c1', { front: '唐朝的开国皇帝是谁？', back: '李渊，唐朝开国皇帝。' }),
      makeCard('c2', { front: '光合作用的产物？', back: '有机物与氧气，发生在光合作用中。' }),
      makeCard('c3', { front: '质量的定义？', back: '质量是物质的量。' }),
    ];
    const fakes = pickFakes(pool, 3, { rng: mulberry32(11), wordTable: table });
    expect(fakes.length).toBeGreaterThan(0);
    for (const f of fakes) {
      const real = pool.find((c) => c.id === f.realCardId)!;
      expect(f.tamperedBack).not.toBe(real.back);
      expect(f.tamperedBack.length).toBeGreaterThan(0);
      expect(f.front).toBe(real.front);
    }
  });

  it('RS#6b 拆除时清表：unmount 后手动调度器无待触发任务', () => {
    const root = makeRoot();
    const sched = makeScheduler();
    const ctrl = makeCtrl(snapWith(summary({ won: false, expGained: 0 })));
    const handle = mountResult(root, ctrl, { fakes: twoFakes, ...sched });
    expect(sched.pending()).toBe(1);
    handle.unmount();
    expect(sched.pending()).toBe(0);
    expect(all(root, '[data-ui="fake-card"]')).toHaveLength(0);
  });
});

describe('mountResult —— 再来一场', () => {
  it('RS#8 有 onReplay 才显示按钮；点击调一次并被禁用到重开（防双开）', () => {
    const root = makeRoot();
    let replay = 0;
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, { onReplay: () => (replay += 1) });

    const btn = ui(root, 'replay') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    click(btn);
    expect(replay).toBe(1);
    expect(btn.disabled).toBe(true);
  });

  it('RS#8b 无 onReplay 时按钮隐藏（不显示点了没反应的入口）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, {});
    expect(ui(root, 'replay').hidden).toBe(true);
  });
});
