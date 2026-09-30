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
    mode: 'fight',
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
  const save = { ...base, settings: { ...base.settings, story: { prologueSeen: true, beatIndex, arcSeen: 0 } } };
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

  it('RS#10 败局给"下一步"引导（终审 J-1/J-2：两处必败此前毫无解释），胜局不给', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary({ won: false, expGained: 0 })));
    mountResult(root, ctrl, {});
    const hint = ui(root, 'lose-hint');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('三成涨到十成'); // 讲清机制：稳定度决定伤害（数值须与 damageMultiplier 同步：new=0.3）

    ctrl.push(snapWith(summary({ won: true })));
    expect((root.querySelector('[data-ui="lose-hint"]') as HTMLElement).hidden).toBe(true);
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

  it('RS#3c 败局**不**抽碎片（LORE §5.2 / PRD §9 都是"每胜一场"；败局的叙事面是假记忆）', () => {
    const root = makeRoot();
    const drawn: number[] = [];
    const ctrl = makeCtrl(snapWith(summary({ won: false, expGained: 0 })));
    mountResult(root, ctrl, { beats: ['甲句', '乙句'], onBeatDrawn: (c) => drawn.push(c) });
    expect(ui(root, 'beat').hidden).toBe(true);
    expect(drawn).toEqual([]);

    // 同一实例里胜负不会"补抽"：再推一个胜局快照才允许抽（且只抽一次）
    ctrl.push(snapWith(summary({ won: true })));
    expect(ui(root, 'beat').hidden).toBe(false);
    expect(drawn).toEqual([1]);
    ctrl.push(snapWith(summary({ won: true }), 1));
    expect(drawn).toEqual([1]);
  });

  it('RS#3d 显式 null 游标仍被 nextBeat 拒（`?? 0` 会把它当成"从第 0 句重来"）', () => {
    const root = makeRoot();
    const base = makeSave();
    const save = {
      ...base,
      settings: { ...base.settings, story: { prologueSeen: true, beatIndex: null as unknown as number, arcSeen: 0 } },
    };
    const drawn: number[] = [];
    const ctrl = makeCtrl(makeSnap({ screen: 'result', save, lastResult: summary() }));
    mountResult(root, ctrl, { beats: ['甲句', '乙句'], onBeatDrawn: (c) => drawn.push(c) });

    expect(ui(root, 'beat').hidden).toBe(true); // 脏游标 ⇒ 不出句
    expect(drawn).toEqual([]); // 也不推进游标
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

  it('RS#4c 先挂屏后推败局快照也能起演出（挂载时判一次的实现在此必红）', () => {
    const root = makeRoot();
    const sched = makeScheduler();
    const ctrl = makeCtrl(snapWith(null)); // 挂载时还没有结果
    mountResult(root, ctrl, { fakes: twoFakes, ...sched });
    expect(sched.pending()).toBe(0);

    ctrl.push(snapWith(summary({ won: false, expGained: 0 })));
    expect(sched.pending()).toBe(1); // 已起"闪现"拍
    expect(ui(root, 'fake-card').getAttribute('data-revealed')).toBe('false');

    sched.fire();
    expect(ui(root, 'fake-cross').hidden).toBe(false); // 揭示拍也照常推进
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

  it('RS#8c 点过之后若有新快照（会话动了）按钮解禁——不留死在禁用态', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, { onReplay: () => undefined });
    const btn = ui(root, 'replay') as HTMLButtonElement;
    click(btn);
    expect(btn.disabled).toBe(true);

    ctrl.push(snapWith(summary())); // 重开成功 / 换屏都会带来新快照
    expect((ui(root, 'replay') as HTMLButtonElement).disabled).toBe(false);
  });

  it('RS#8b 无 onReplay 时按钮隐藏（不显示点了没反应的入口）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(snapWith(summary()));
    mountResult(root, ctrl, {});
    expect(ui(root, 'replay').hidden).toBe(true);
  });
});

/* ------------------------------------------------------------------ Plan 7 · T5 */

/**
 * 结算屏的木桩形态（Plan 7 · T5）。
 *
 * 判别力：
 * - RS#D1 drill **不是"败"**：练功不判胜负 ⇒ 既不能显示「败」，也不能给"下一步"引导
 *   （那句是劝败者回去背卡的，对练功是噪音），更不能演假记忆；
 * - RS#D2 drill **不抽战报碎片**（碎片是"每胜一场"的叙事面，练功不是胜场）；
 * - RS#D3 drill 照常显示练了多少张与经验（1/20 也要看得见，否则玩家以为白练了）。
 */
describe('mountResult —— 木桩练完（Plan 7 · T5）', () => {
  const drillSummary = (over: Partial<RunSummary> = {}): RunSummary => ({
    won: false,
    mode: 'drill',
    expGained: 1,
    levelBefore: 1,
    levelAfter: 2,
    leveledUp: true,
    misses: 2,
    poolLen: 3,
    ...over,
  });

  it('RS#D1 显示"练功完成"，且不显示「败」/「下一步」/假记忆', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'result', lastResult: drillSummary() }));
    mountResult(root, ctrl, {
      beats: ['混沌又退了一尺。'],
      fakes: [pickFakes([makeCard('c1')], 1, { rng: mulberry32(1), wordTable: new Map([['唐朝', '宋朝']]) })[0]],
    });
    expect(ui(root, 'outcome').textContent).toContain('练功');
    expect(ui(root, 'outcome').textContent).not.toBe('败');
    expect(ui(root, 'lose-hint').hidden).toBe(true);
    expect(ui(root, 'fake-memory').hidden).toBe(true);
  });

  it('RS#D2 不抽战报碎片（碎片是胜场的叙事面）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'result', lastResult: drillSummary() }));
    const drawn: number[] = [];
    mountResult(root, ctrl, { beats: ['混沌又退了一尺。'], onBeatDrawn: (c) => drawn.push(c) });
    expect(ui(root, 'beat').hidden).toBe(true);
    expect(drawn).toEqual([]);
  });

  it('RS#D3 照常显示练了多少张与经验（+1 也要看得见）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'result', lastResult: drillSummary() }));
    mountResult(root, ctrl, {});
    expect(ui(root, 'exp').textContent).toContain('+1');
    expect(ui(root, 'stats').textContent).toContain('3');
    expect(ui(root, 'drill-summary').hidden).toBe(false);
    expect(ui(root, 'drill-summary').textContent).toContain('练功完成');
  });
});

/* ------------------------------------------------------------------ D58：这一局叫什么 */

/**
 * 判别力：
 * - RS#N1 记录里有名字 ⇒ 结果屏显示它（`雅号 · 组合`）；
 * - RS#N2 只在**第一次**渲染时请一次宿主命名（重渲染反复请求 = 反复花钱）；
 * - RS#N3 缺 `onNameRequest` ⇒ 只显示兜底名，不崩；木桩练功没有 recordId ⇒ 不显示也不请求。
 */
describe('mountResult —— 这一局的名字（D58）', () => {
  it('RS#N1/N2 显示名字，且只请一次宿主去升级', () => {
    const root = makeRoot();
    const reqs: Array<{ recordId: string; combo: string }> = [];
    const snap = makeSnap({
      screen: 'result',
      save: {
        ...makeSave(),
        settings: {
          ...makeSave().settings,
          leaderboard: [
            { id: 'r1', at: 1, result: 'won', kind: 'encounter', domain: '唐诗', cards: 3, misses: 0, level: 1, score: 80, title: '长安夜雨 · 唐诗 × 成语典故' },
          ],
        },
      },
      lastResult: { won: true, mode: 'fight', expGained: 10, levelBefore: 1, levelAfter: 1, leveledUp: false, misses: 0, poolLen: 3, recordId: 'r1' },
    });
    const ctrl = makeCtrl(snap);
    mountResult(root, ctrl, {
      flashMs: 0,
      holdMs: 0,
      onNameRequest: (input) => void reqs.push({ recordId: input.recordId, combo: input.combo }),
    });

    expect(ui(root, 'fight-title').hidden).toBe(false);
    expect(ui(root, 'fight-title').textContent).toBe('长安夜雨 · 唐诗 × 成语典故');
    expect(reqs).toEqual([{ recordId: 'r1', combo: '唐诗 × 成语典故' }]);

    // 再推一次快照（模拟别处变化）⇒ 不再请一次
    ctrl.push({ ...snap });
    expect(reqs).toHaveLength(1);
  });

  it('RS#N4 被挤出前 50 条（榜上查不到）⇒ 结算屏**仍要显示**本局名字（I2）', () => {
    // 现场路径：已有 ≥50 条高分记录时，本局（败局 0 分）当场被挤出榜 ⇒ 按 recordId 查榜查不到。
    // 名字是本地即时生成的兜底名，本来就在手里，不该在最需要它的那次结算丢掉。
    const root = makeRoot();
    mountResult(
      root,
      makeCtrl(
        makeSnap({
          screen: 'result',
          save: makeSave(), // 榜是空的：模拟"本局被挤出榜"
          lastResult: {
            won: false,
            mode: 'fight',
            expGained: 0,
            levelBefore: 1,
            levelAfter: 1,
            leveledUp: false,
            misses: 3,
            poolLen: 5,
            recordId: 'r-gone',
            fightTitle: '松间清露 · 唐诗 × 成语典故',
          },
        }),
      ),
      { flashMs: 0, holdMs: 0 },
    );
    expect(ui(root, 'fight-title').hidden).toBe(false);
    expect(ui(root, 'fight-title').textContent).toBe('松间清露 · 唐诗 × 成语典故');
  });

  it('RS#N5 榜上有（且被升级）⇒ 用榜上的新名字（升级要能刷新结算屏）', () => {
    const root = makeRoot();
    mountResult(
      root,
      makeCtrl(
        makeSnap({
          screen: 'result',
          save: {
            ...makeSave(),
            settings: {
              ...makeSave().settings,
              leaderboard: [
                { id: 'r1', at: 1, result: 'won', kind: 'encounter', domain: '唐诗', cards: 3, misses: 0, level: 1, score: 80, title: '长安夜雨 · 唐诗 × 成语典故' },
              ],
            },
          },
          lastResult: {
            won: true, mode: 'fight', expGained: 10, levelBefore: 1, levelAfter: 1, leveledUp: false,
            misses: 0, poolLen: 3, recordId: 'r1', fightTitle: '孤灯残卷 · 唐诗 × 成语典故',
          },
        }),
      ),
      { flashMs: 0, holdMs: 0 },
    );
    expect(ui(root, 'fight-title').textContent).toBe('长安夜雨 · 唐诗 × 成语典故');
  });

  it('RS#N3 缺命名口 ⇒ 只显示兜底名；木桩练功没有 recordId ⇒ 名字不显示也不请求', () => {
    const root = makeRoot();
    const snap = makeSnap({
      screen: 'result',
      save: {
        ...makeSave(),
        settings: {
          ...makeSave().settings,
          leaderboard: [
            { id: 'r1', at: 1, result: 'won', kind: 'encounter', domain: '唐诗', cards: 3, misses: 0, level: 1, score: 80, title: '松间清露 · 唐诗' },
          ],
        },
      },
      lastResult: { won: true, mode: 'fight', expGained: 10, levelBefore: 1, levelAfter: 1, leveledUp: false, misses: 0, poolLen: 3, recordId: 'r1' },
    });
    mountResult(root, makeCtrl(snap), { flashMs: 0, holdMs: 0 });
    expect(ui(root, 'fight-title').textContent).toBe('松间清露 · 唐诗');

    const drill = makeRoot();
    mountResult(
      drill,
      makeCtrl(makeSnap({
        screen: 'result',
        save: makeSave(),
        lastResult: { won: false, mode: 'drill', expGained: 3, levelBefore: 1, levelAfter: 1, leveledUp: false, misses: 0, poolLen: 5 },
      })),
      { flashMs: 0, holdMs: 0, onNameRequest: () => { throw new Error('练功不该请求命名'); } },
    );
    expect(ui(drill, 'fight-title').hidden).toBe(true);
  });
});
