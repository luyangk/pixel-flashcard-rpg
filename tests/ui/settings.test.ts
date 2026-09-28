// @vitest-environment happy-dom
/**
 * tests/ui/settings.test.ts —— Plan 4 · T11：设置屏（阈值 / 池子 / SM-2 参数 / 重看序章）。
 *
 * 判别力：
 * - SE#1 阈值与池子按钮的选中态来自**快照**（aria-pressed），点击把值交给注入写口；
 *   把选中态写成"点谁谁亮"的本地状态，就无法在"写失败/被拒"时回到真值 ⇒ 必红；
 * - SE#3 表单只在 params 引用变化时回填：输入过程中被覆盖的实现在这条上必红；
 * - SE#4 非法输入（空框 → NaN）不自己兜默认值，而是**原样交给写口**（域检查在 app 层）：
 *   在屏上悄悄填默认值的实现会显示"已保存"⇒ 必红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Sm2Params } from '@core/types';
import type { SettingsWriteResult } from '../../src/app/settingsFlow';
import { mountSettings } from '../../src/ui/settings';
import { all, click, flushMicrotasks, makeCtrl, makeRoot, makeSave, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

const PARAMS: Sm2Params = { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 };

function saveWith(over: { tier?: 15 | 30 | 50; pool?: number; params?: Sm2Params; prologueSeen?: boolean } = {}) {
  const base = makeSave();
  return {
    ...base,
    settings: {
      ...base.settings,
      bossThresholdTier: over.tier ?? 30,
      sm2Params: over.params ?? PARAMS,
      battle: { defaultPoolSize: over.pool ?? 15 },
      story: { prologueSeen: over.prologueSeen ?? true, beatIndex: 0, arcSeen: 0 },
    },
  };
}

describe('mountSettings —— 阈值与池子', () => {
  it('SE#1 选中态来自快照；点击把值交给写口（本地高亮实现在写失败时必红）', async () => {
    const root = makeRoot();
    const tiers: number[] = [];
    const pools: number[] = [];
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: saveWith({ tier: 30, pool: 10 }) }));
    mountSettings(root, ctrl, {
      toastMs: 0,
      setTier: (t) => {
        tiers.push(t);
        return Promise.resolve<SettingsWriteResult>({ ok: true });
      },
      setPoolSize: (n) => {
        pools.push(n);
        return Promise.resolve<SettingsWriteResult>({ ok: true });
      },
    });

    const tierBtn = (t: number): HTMLElement => root.querySelector(`[data-tier="${t}"]`) as HTMLElement;
    expect(tierBtn(30).getAttribute('aria-pressed')).toBe('true');
    expect(tierBtn(15).getAttribute('aria-pressed')).toBe('false');
    expect((root.querySelector('[data-pool="10"]') as HTMLElement).getAttribute('aria-pressed')).toBe('true');

    click(tierBtn(15));
    await flushMicrotasks();
    expect(tiers).toEqual([15]);
    // 写口成功但快照未变（测试的假控制器不推新快照）⇒ 选中态仍停在真值 30
    expect(tierBtn(30).getAttribute('aria-pressed')).toBe('true');
    expect(ui(root, 'toast').textContent).toBe('阈值已设为 15 次。');

    click(root.querySelector('[data-pool="25"]') as HTMLElement);
    await flushMicrotasks();
    expect(pools).toEqual([25]);
  });

  it('SE#1b 写口回 ok:false 时提示原因，不假装成功', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWith() }));
    mountSettings(root, ctrl, {
      toastMs: 0,
      setTier: () => Promise.resolve({ ok: false, reason: '阈值只能选 15 / 30 / 50 三档。' }),
    });
    click(root.querySelector('[data-tier="15"]') as HTMLElement);
    await flushMicrotasks();
    expect(ui(root, 'toast').textContent).toBe('阈值只能选 15 / 30 / 50 三档。');
  });

  it('SE#1c 未注入写口时按钮禁用（不显示点了没反应的入口）', () => {
    const root = makeRoot();
    mountSettings(root, makeCtrl(makeSnap({ save: saveWith() })), {});
    expect((root.querySelector('[data-tier="15"]') as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector('[data-pool="10"]') as HTMLButtonElement).disabled).toBe(true);
    expect((ui(root, 'save-params') as HTMLButtonElement).disabled).toBe(true);
    expect((ui(root, 'replay-prologue') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('mountSettings —— SM-2 参数表单', () => {
  it('SE#2 初值来自存档；保存把四个数字原样交给写口', async () => {
    const root = makeRoot();
    const sent: Sm2Params[] = [];
    const ctrl = makeCtrl(makeSnap({ save: saveWith() }));
    mountSettings(root, ctrl, {
      toastMs: 0,
      setParams: (p) => {
        sent.push(p);
        return Promise.resolve<SettingsWriteResult>({ ok: true });
      },
    });

    const input = (key: string): HTMLInputElement => root.querySelector(`[data-param="${key}"]`) as HTMLInputElement;
    expect(input('initialEase').value).toBe('2.5');
    expect(input('secondInterval').value).toBe('6');

    input('initialEase').value = '2.8';
    input('minEase').value = '1.5';
    input('firstInterval').value = '0.2';
    input('secondInterval').value = '7';
    click(ui(root, 'save-params'));
    await flushMicrotasks();

    expect(sent).toEqual([{ initialEase: 2.8, minEase: 1.5, firstInterval: 0.2, secondInterval: 7 }]);
    expect(ui(root, 'toast').textContent).toBe('参数已保存。');
  });

  it('SE#3 输入过程中不被快照覆盖（只按 params 引用变化回填）', () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWith() }));
    mountSettings(root, ctrl, { setParams: () => Promise.resolve({ ok: true }) });

    const initial = root.querySelector('[data-param="initialEase"]') as HTMLInputElement;
    initial.value = '3.3';
    ctrl.push(makeSnap({ save: saveWith() })); // 同一份 save 引用（params 未变）
    expect((root.querySelector('[data-param="initialEase"]') as HTMLInputElement).value).toBe('3.3');

    // params 真的换了才回填
    ctrl.push(makeSnap({ save: saveWith({ params: { initialEase: 1.9, minEase: 1.2, firstInterval: 1, secondInterval: 4 } }) }));
    expect((root.querySelector('[data-param="initialEase"]') as HTMLInputElement).value).toBe('1.9');
  });

  it('SE#4 空框 → NaN 原样交给写口（屏上不许自己兜默认值）', async () => {
    const root = makeRoot();
    const sent: Sm2Params[] = [];
    const ctrl = makeCtrl(makeSnap({ save: saveWith() }));
    mountSettings(root, ctrl, {
      toastMs: 0,
      setParams: (p) => {
        sent.push(p);
        return Promise.resolve({ ok: false, reason: '参数没保存：initialEase 必须是数字。' });
      },
    });

    (root.querySelector('[data-param="initialEase"]') as HTMLInputElement).value = '';
    click(ui(root, 'save-params'));
    await flushMicrotasks();

    expect(sent).toHaveLength(1);
    expect(Number.isNaN(sent[0].initialEase)).toBe(true);
    expect(ui(root, 'toast').textContent).toContain('必须是数字');
    // 失败不回填：玩家看到的是自己输的空框与错误原因
    expect((root.querySelector('[data-param="initialEase"]') as HTMLInputElement).value).toBe('');
  });
});

describe('mountSettings —— 重看序章与拆除', () => {
  it('SE#5 调注入的 replayPrologue；返回按钮回菜单', async () => {
    const root = makeRoot();
    let replayed = 0;
    const nav: string[] = [];
    const ctrl = makeCtrl(makeSnap({ save: saveWith() }));
    mountSettings(root, ctrl, {
      toastMs: 0,
      onNav: (t) => nav.push(t),
      replayPrologue: () => {
        replayed += 1;
        return Promise.resolve({ ok: true });
      },
    });

    click(ui(root, 'replay-prologue'));
    await flushMicrotasks();
    expect(replayed).toBe(1);
    expect(ui(root, 'toast').textContent).toBe('再看一次序章吧。');

    click(ui(root, 'back'));
    expect(nav).toEqual(['menu']);
  });

  it('SE#6 写口抛错（只读闩锁）→ 变 toast，不逃逸；unmount 摘 DOM 并撤销订阅', async () => {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ save: saveWith() }));
    const handle = mountSettings(root, ctrl, {
      toastMs: 0,
      setTier: () => Promise.reject(new Error('存档无法读取（已进入只读保护）')),
    });
    click(root.querySelector('[data-tier="15"]') as HTMLElement);
    await flushMicrotasks();
    expect(ui(root, 'toast').textContent).toContain('只读保护');

    handle.unmount();
    expect(all(root, '[data-tier]')).toHaveLength(0);
    ctrl.push(makeSnap({ save: saveWith({ tier: 15 }) }));
    expect(all(root, '[data-tier]')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ Plan 6 · T8 */

/**
 * 设置页「作答方式」（Plan 6 · T8 / D41 + D42）。
 *
 * 判别力：
 * - SA#1 选中态来自**快照**（与阈值同款纪律：写失败时不能停在"点谁谁亮"的假状态）；
 * - SA#2 点击把值交给注入写口；
 * - SA#3 **D42 的例外必须上屏**：文案要出现"答案"与"服务商"——把答案发给模型是本应用
 *   唯一一处打破"不发送答案"承诺的地方，藏着不说就是欺骗；
 * - SA#4 没配 AI ⇒ 问答按钮禁用并说明（不让玩家选一个点了没反应的模式）；
 * - SA#5 今日额度来自注入口（额度是给玩家的承诺，屏上要看得见）。
 */
describe('mountSettings —— 作答方式（Plan 6 · T8）', () => {
  function mountAnswer(over: {
    mode?: 'choice' | 'qa';
    quotaText?: string;
    withLlm?: boolean;
    setAnswerMode?: (m: 'choice' | 'qa') => Promise<SettingsWriteResult>;
  } = {}) {
    const root = makeRoot();
    const base = makeSave();
    const save = {
      ...base,
      settings: { ...base.settings, answerMode: over.mode ?? 'choice' },
    };
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save }));
    mountSettings(root, ctrl, {
      toastMs: 0,
      setAnswerMode: over.setAnswerMode ?? (() => Promise.resolve<SettingsWriteResult>({ ok: true })),
      llmQuotaText: () => over.quotaText ?? '今日：生成剩 200 / 200 · 判定剩 300 / 300',
      ...(over.withLlm === true
        ? {
            llm: {
              load: () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-flash' }),
              save: () => true,
              clear: () => undefined,
              test: () => Promise.resolve({ ok: true as const, text: 'pong' }),
              presets: [],
            },
          }
        : {}),
    });
    return root;
  }
  const modeBtn = (root: HTMLElement, mode: string): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>(`[data-answer-mode="${mode}"]`) as HTMLButtonElement;

  it('SA#1 两个按钮的选中态来自快照', () => {
    const choice = mountAnswer({ mode: 'choice' });
    expect(modeBtn(choice, 'choice').getAttribute('aria-pressed')).toBe('true');
    expect(modeBtn(choice, 'qa').getAttribute('aria-pressed')).toBe('false');

    const qa = mountAnswer({ mode: 'qa' });
    expect(modeBtn(qa, 'qa').getAttribute('aria-pressed')).toBe('true');
    expect(modeBtn(qa, 'choice').getAttribute('aria-pressed')).toBe('false');
  });

  it('SA#2 点击把值交给写口（切到问答模式）', async () => {
    const seen: string[] = [];
    // 切到问答模式要求 AI 就绪（没配 AI 时按钮是禁用的，见 SA#4）
    const root = mountAnswer({
      withLlm: true,
      setAnswerMode: (m) => {
        seen.push(m);
        return Promise.resolve<SettingsWriteResult>({ ok: true });
      },
    });
    click(modeBtn(root, 'qa'));
    await flushMicrotasks();
    expect(seen).toEqual(['qa']);
  });

  it('SA#3 D42 的例外上屏：文案含「答案」与「服务商」', () => {
    const root = mountAnswer();
    const group = ui(root, 'answer-mode-group');
    const hint = group.textContent ?? '';
    expect(hint).toContain('答案');
    expect(hint).toContain('服务商');
    expect(hint).toMatch(/AI|大模型/);
  });

  it('SA#4 没配 AI ⇒ 问答按钮禁用并说明原因（不让玩家选一个点了没反应的模式）', () => {
    const noAi = mountAnswer({ withLlm: false });
    expect(modeBtn(noAi, 'qa').disabled).toBe(true);
    expect(ui(noAi, 'answer-mode-qa-blocked').hidden).toBe(false);

    const withAi = mountAnswer({ withLlm: true });
    expect(modeBtn(withAi, 'qa').disabled).toBe(false);
    expect(ui(withAi, 'answer-mode-qa-blocked').hidden).toBe(true);
  });

  it('SA#5 今日额度行来自注入口', () => {
    const root = mountAnswer({ quotaText: '今日：生成剩 137 / 200 · 判定剩 288 / 300' });
    expect(ui(root, 'llm-quota-text').textContent).toContain('137');
    expect(ui(root, 'llm-quota-text').textContent).toContain('288');
  });
});
