/**
 * settings.ts —— Plan 4 · T11：设置屏（Boss 阈值三档 / SM-2 参数 / 默认池子 / 重看序章）。
 *
 * PRD 要求的两处可配（§6.5 D18 阈值三档、§185「SM-2 参数暴露于设置页可调」）与
 * LORE §5.1 的「设置页可重看序章」在此上屏。三条口径：
 *
 * 1. **写口全部注入**（`deps.setTier/setParams/setPoolSize/replayPrologue`，宿主接
 *    app/settingsFlow）——本屏不 import persist、不持有写权限；缺哪个写口就把对应控件
 *    隐藏（不显示点了没反应的入口）。
 * 2. **阈值/池子是"点了就生效"的选择**（aria-pressed 由快照驱动），**SM-2 参数是表单**
 *    （改动要显式点「保存参数」）——因为前者是枚举、后者是四个数字，误触代价不同。
 * 3. **表单值只在快照变化时回填**，输入过程中不覆盖玩家正在敲的内容；保存失败时
 *    **不回填**（让玩家看到自己输的值和错误提示，而不是被无声改回旧值）。
 */
import type { Sm2Params } from '@core/types';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import type { SettingsWriteResult } from '../app/settingsFlow';
import { BOSS_TIERS, POOL_SIZE_MIN, POOL_SIZE_MAX } from '../app/settingsFlow';
import { h, setHidden } from './dom';
import { showToast } from './toast';

export interface SettingsDeps {
  /** 返回主菜单。 */
  readonly onNav?: (target: 'menu') => void;
  readonly setTier?: (tier: 15 | 30 | 50) => Promise<SettingsWriteResult>;
  readonly setParams?: (params: Sm2Params) => Promise<SettingsWriteResult>;
  readonly setPoolSize?: (size: number) => Promise<SettingsWriteResult>;
  readonly replayPrologue?: () => Promise<SettingsWriteResult>;
  /** toast 存活毫秒（测试给 0 免定时器）。 */
  readonly toastMs?: number;
}

export interface SettingsHandle {
  unmount(): void;
}

/** 池子三挡（与备战屏同值域；默认档从存档读，不在这里定产品默认）。 */
const POOL_CHOICES: readonly number[] = [10, 15, 25];

/** SM-2 四个参数的展示元数据（中文名 + 步长；值域检查归 app/settingsFlow）。 */
const PARAM_FIELDS: ReadonlyArray<{ readonly key: keyof Sm2Params; readonly label: string; readonly step: string }> = [
  { key: 'initialEase', label: '起始难度因子', step: '0.1' },
  { key: 'minEase', label: '难度下限', step: '0.1' },
  { key: 'firstInterval', label: '第一次间隔（天）', step: '0.01' },
  { key: 'secondInterval', label: '第二次间隔（天）', step: '0.1' },
];

const TIER_HINT = '阈值越低，卷灵越早现身；引导领域「生活常识」恒为 15 次。';

/**
 * 在 root 里挂设置屏。所有写入都是"点一下/保存一次"的显式动作，屏幕自己不攒状态
 * （唯一例外是 SM-2 输入框里的草稿值，见文件头第 3 条）。
 */
export function mountSettings(root: HTMLElement, ctrl: GameController, deps: SettingsDeps = {}): SettingsHandle {
  if (!root || !ctrl) throw new Error('mount-settings: root/controller required');

  let destroyed = false;
  let busy = false;
  let toastOff: (() => void) | null = null;
  /** 上次回填输入框所依据的 params 引用（同引用不覆盖玩家草稿）。 */
  let filledFrom: Sm2Params | null = null;

  const backBtn = h('button', { 'data-ui': 'back', class: 'back-btn', type: 'button' }, '返回') as HTMLButtonElement;
  const headerEl = h('header', { class: 'settings-header' }, [
    backBtn,
    h('h2', { class: 'screen-title' }, '设置'),
  ]);

  /* ------------------------------------------------------------ 阈值三档 */
  const tierButtons = BOSS_TIERS.map((tier) => {
    const b = h('button', { 'data-tier': String(tier), class: 'tier-btn', type: 'button' }, `${tier} 次`) as HTMLButtonElement;
    b.addEventListener('click', () => void write(() => deps.setTier?.(tier), `阈值已设为 ${tier} 次。`));
    return b;
  });
  const tierEl = h('section', { 'data-ui': 'tier-group', class: 'settings-group' }, [
    h('h3', { class: 'field-title' }, '卷灵阈值'),
    h('p', { class: 'field-hint' }, TIER_HINT),
    h('div', { class: 'tier-row' }, tierButtons),
  ]);

  /* ------------------------------------------------------------ 默认池子 */
  const poolButtons = POOL_CHOICES.map((size) => {
    const b = h('button', { 'data-pool': String(size), class: 'pool-btn', type: 'button' }, `${size} 张`) as HTMLButtonElement;
    b.addEventListener('click', () => void write(() => deps.setPoolSize?.(size), `默认池子已设为 ${size} 张。`));
    return b;
  });
  const poolEl = h('section', { 'data-ui': 'pool-group', class: 'settings-group' }, [
    h('h3', { class: 'field-title' }, '默认池子大小'),
    h('p', { class: 'field-hint' }, `备战屏的初始选择（合法域 ${POOL_SIZE_MIN}–${POOL_SIZE_MAX}）。`),
    h('div', { class: 'pool-row' }, poolButtons),
  ]);

  /* ------------------------------------------------------------ SM-2 参数 */
  const paramInputs = new Map<keyof Sm2Params, HTMLInputElement>();
  const paramRows = PARAM_FIELDS.map((field) => {
    const input = h('input', {
      'data-param': field.key,
      class: 'param-input',
      type: 'number',
      step: field.step,
      min: '0',
      inputmode: 'decimal',
    }) as HTMLInputElement;
    paramInputs.set(field.key, input);
    return h('label', { class: 'param-row' }, [h('span', { class: 'param-label' }, field.label), input]);
  });
  const saveParamsBtn = h('button', { 'data-ui': 'save-params', class: 'save-btn', type: 'button' }, '保存参数') as HTMLButtonElement;
  const paramEl = h('section', { 'data-ui': 'param-group', class: 'settings-group' }, [
    h('h3', { class: 'field-title' }, '复习参数（SM-2）'),
    h('p', { class: 'field-hint' }, '数值越大，间隔涨得越慢；改完要点保存。'),
    ...paramRows,
    saveParamsBtn,
  ]);

  /* ------------------------------------------------------------ 重看序章 */
  const replayBtn = h('button', { 'data-ui': 'replay-prologue', class: 'replay-btn', type: 'button' }, '重看序章') as HTMLButtonElement;
  const storyEl = h('section', { 'data-ui': 'story-group', class: 'settings-group' }, [
    h('h3', { class: 'field-title' }, '序章'),
    h('p', { class: 'field-hint' }, '下次回到菜单时会重新演出一次（可跳过）。'),
    replayBtn,
  ]);

  const screen = h('div', { 'data-ui': 'settings-screen', class: 'settings-screen' }, [
    headerEl,
    tierEl,
    poolEl,
    paramEl,
    storyEl,
  ]);
  root.appendChild(screen);

  /* ------------------------------------------------------------ 渲染与写入 */
  function toast(text: string): void {
    toastOff?.();
    toastOff = showToast(screen, text, { ms: deps.toastMs });
  }

  /** 统一的写入包装：禁用 → 调写口 → 提示 → 解禁。写口缺省时直接不动作。 */
  async function write(action: (() => Promise<SettingsWriteResult> | undefined) | null, okText: string): Promise<void> {
    if (destroyed || busy || action === null) return;
    const run = action();
    if (!run) return;
    busy = true;
    render(ctrl.snapshot());
    try {
      const res = await run;
      toast(res.ok ? okText : res.reason);
    } catch (e) {
      // 只读闩锁下写口会真 reject——收成一句提示，不让 rejection 逃逸
      toast(`没保存：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  function render(snap: ControllerSnapshot): void {
    const settings = snap.save?.settings;
    for (const [i, tier] of BOSS_TIERS.entries()) {
      tierButtons[i].setAttribute('aria-pressed', String(settings?.bossThresholdTier === tier));
      tierButtons[i].disabled = busy || typeof deps.setTier !== 'function';
    }
    for (const [i, size] of POOL_CHOICES.entries()) {
      poolButtons[i].setAttribute('aria-pressed', String(settings?.battle?.defaultPoolSize === size));
      poolButtons[i].disabled = busy || typeof deps.setPoolSize !== 'function';
    }

    // 表单回填：只在 params 引用变化时（同引用不动玩家草稿）
    const params = settings?.sm2Params;
    if (params && params !== filledFrom) {
      filledFrom = params;
      for (const [key, input] of paramInputs) {
        const v = params[key];
        input.value = typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
      }
    }
    saveParamsBtn.disabled = busy || typeof deps.setParams !== 'function';
    replayBtn.disabled = busy || typeof deps.replayPrologue !== 'function';
    setHidden(backBtn, typeof deps.onNav !== 'function');
  }

  function readParams(): Sm2Params {
    const out = {} as Sm2Params;
    for (const [key, input] of paramInputs) {
      // 空串 → NaN，交给 settingsFlow 的域检查拒绝（不在这里悄悄填默认值）
      out[key] = input.value.trim() === '' ? Number.NaN : Number(input.value);
    }
    return out;
  }

  backBtn.addEventListener('click', () => deps.onNav?.('menu'));
  saveParamsBtn.addEventListener('click', () => void write(() => deps.setParams?.(readParams()), '参数已保存。'));
  replayBtn.addEventListener('click', () => void write(() => deps.replayPrologue?.(), '再看一次序章吧。'));

  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    render(snap);
  });
  render(ctrl.snapshot());

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    if (toastOff) {
      toastOff();
      toastOff = null;
    }
    screen.remove();
  }

  return { unmount: destroy };
}
