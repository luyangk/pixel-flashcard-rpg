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
import type { ChatResult, LlmConfig } from '../platform/llmTypes';
// maskKey 是 Key 展示形态的**唯一权威**（永不回显明文）：设置屏只消费它，不自己拼掩码。
// 平台 LLM 配置模块的其余读写口仍由宿主装配（见 hostAdapters），本文件只取这一个纯函数。
import { maskKey } from '../platform/llmConfig';
import { h, setHidden } from './dom';
import { showToast } from './toast';

/**
 * AI（可选）分组的注入面（Plan 5 · T4）。
 *
 * 全部经宿主装配：`load/save/clear` 接 `platform/llmConfig`（Key 的唯一存放点），
 * `test` 接 `platform/llmHttp.chat` 的一次最小请求，`presets` 接 `LLM_PRESETS`。
 * 本屏**不认识 localStorage、不认识网络**——因此它在测试里可以直接用假实现穷举
 * "保存时留空是否保留原 Key""失败 toast 说了什么"。
 */
export interface LlmSettingsDeps {
  /** 读当前配置（Key 明文只在内存里过一手，绝不进 DOM）。 */
  readonly load: () => LlmConfig;
  /**
   * 写配置（宿主接 `platform/llmConfig.saveLlmConfig`）。
   * **返回是否真的写入**：浏览器隐私模式/配额满会写失败，设置屏要如实说"没能保存"
   * 而不是报"已保存"（安全评审判 m-2）。
   */
  readonly save: (cfg: LlmConfig) => boolean;
  /** 清 Key（保留地址/模型）。 */
  readonly clear: () => void;
  /** 「测试连接」：发一次最小请求，reason 已是人话。 */
  readonly test: (cfg: LlmConfig) => Promise<ChatResult>;
  /** 预设（DeepSeek / 通义 / 自定义；**恒不含 Key**）。 */
  readonly presets: ReadonlyArray<{ readonly id: string; readonly label: string; readonly config: LlmConfig }>;
  /**
   * 「拉取模型列表」（宿主接 `platform/llmHttp.listModels`）：直接问服务商要它当前可用的
   * 模型名，省得玩家去翻文档、也避免"预设里的名字过时"这类坑（用户实测撞过一次）。
   */
  readonly listModels?: (cfg: LlmConfig) => Promise<
    { readonly ok: true; readonly models: readonly string[] } | { readonly ok: false; readonly reason: string }
  >;
}

export interface SettingsDeps {
  /** 返回主菜单。 */
  readonly onNav?: (target: 'menu') => void;
  readonly setTier?: (tier: 15 | 30 | 50) => Promise<SettingsWriteResult>;
  readonly setParams?: (params: Sm2Params) => Promise<SettingsWriteResult>;
  readonly setPoolSize?: (size: number) => Promise<SettingsWriteResult>;
  readonly replayPrologue?: () => Promise<SettingsWriteResult>;
  /** AI（可选）分组；缺省则整组隐藏（不显示点了没反应的入口）。 */
  readonly llm?: LlmSettingsDeps;
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
 * AI 分组的文案（LS#6 要求如实两条：Key 只在本机、不进备份；换设备要重填）。
 * 也顺带说清"留空保存 = 不改动已存的 Key"与"清除要用按钮"——否则玩家会以为
 * 输入框空着就是把 Key 删了（或以为页面在偷偷留着他的 Key 却不显示）。
 */
const LLM_KEY_HINT = 'Key 只存在这台设备的浏览器里（本地明文），不进备份文件；换设备要重新填一次。';
const LLM_INPUT_HINT = '保存时 Key 留空 = 不改动已存的 Key；想清掉请点「清除 Key」。';
/**
 * 模型名的提示。用户实测的 400 就是模型名与网关目录不一致导致的——把口径写在输入框旁边，
 * 并明确"不是我们写死的、以你的服务商目录为准"，否则玩家会以为是本应用坏了。
 */
const LLM_MODEL_HINT =
  '模型名必须与你在服务商那里开通的一致：DeepSeek 现在是 deepseek-flash 或 deepseek-v4-pro' +
  '（旧的 deepseek-chat 已停用，填它会得到 400）；通义是 qwen-plus / qwen-max 等；' +
  '中转/自建网关请照它自己的目录填。拿不准就点「拉取模型列表」，它会问你自己的账号要。';

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
  /** AI 分组的写口（缺省 = 整组隐藏；见 SettingsDeps.llm）。 */
  const llmDeps = deps.llm;
  const canLlm = !!llmDeps && typeof llmDeps.load === 'function' && typeof llmDeps.save === 'function';
  /** 「测试连接」在途标记（与 busy 分开：一次网络请求不该把阈值/池子按钮一起冻住）。 */
  let llmBusy = false;
  /** 模型列表请求在途（与 llmBusy 分开：它不影响保存/测试的可用性） */
  let modelsBusy = false;
  /** 当前**已存**的配置（Key 只在这份内存副本里过手，绝不写进任何 DOM 属性/文本）。 */
  let storedLlm: LlmConfig = { baseUrl: '', apiKey: '', model: '' };

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
    h('p', { class: 'field-hint' }, '点了会**马上**重演一次（可跳过）。'),
    replayBtn,
  ]);

  /* ------------------------------------------------------------ AI（可选，Plan 5 · T4） */
  const llmBaseInput = h('input', {
    'data-ui': 'llm-base',
    class: 'llm-input',
    type: 'text',
    placeholder: 'https://api.deepseek.com',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const llmModelInput = h('input', {
    'data-ui': 'llm-model',
    class: 'llm-input',
    type: 'text',
    placeholder: 'deepseek-chat',
    autocomplete: 'off',
  }) as HTMLInputElement;
  // Key 输入框：type=password + 只显示掩码 placeholder。**任何路径都不写 value=明文**
  // （保存成功即清空输入框，改回掩码 placeholder）。
  const llmKeyInput = h('input', {
    'data-ui': 'llm-key',
    class: 'llm-input',
    type: 'password',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const llmSaveBtn = h('button', { 'data-ui': 'llm-save', class: 'llm-btn', type: 'button' }, '保存') as HTMLButtonElement;
  const llmTestBtn = h(
    'button',
    { 'data-ui': 'llm-test', class: 'llm-btn', type: 'button' },
    '测试连接',
  ) as HTMLButtonElement;
  const llmClearBtn = h(
    'button',
    { 'data-ui': 'llm-clear', class: 'llm-btn', type: 'button' },
    '清除 Key',
  ) as HTMLButtonElement;

  const llmPresetButtons = (llmDeps?.presets ?? []).map((preset) => {
    const b = h(
      'button',
      { 'data-llm-preset': preset.id, class: 'llm-preset', type: 'button' },
      preset.label,
    ) as HTMLButtonElement;
    b.addEventListener('click', () => onPickPreset(preset.id));
    return b;
  });

  const llmPresetsEl = h('div', { 'data-ui': 'llm-presets', class: 'llm-presets' }, llmPresetButtons);
  const llmModelsListEl = h('div', { 'data-ui': 'llm-models-list', class: 'llm-models-list' });
  const llmModelsStatusEl = h('p', { 'data-ui': 'llm-models-status', class: 'field-hint', hidden: true });
  const llmModelsBtn = h(
    'button',
    { 'data-ui': 'llm-models-fetch', class: 'llm-models-fetch', type: 'button' },
    '拉取模型列表',
  ) as HTMLButtonElement;
  const llmEl = h('section', { 'data-ui': 'llm-group', class: 'settings-group', hidden: !canLlm }, [
    h('h3', { class: 'field-title' }, 'AI（可选）'),
    h('p', { class: 'field-hint' }, LLM_KEY_HINT),
    h('p', { class: 'field-hint' }, LLM_INPUT_HINT),
    llmPresetsEl,
    h('label', { class: 'llm-row' }, [h('span', { class: 'llm-label' }, 'Base URL'), llmBaseInput]),
    h('label', { class: 'llm-row' }, [h('span', { class: 'llm-label' }, '模型'), llmModelInput]),
    h('p', { 'data-ui': 'llm-model-hint', class: 'field-hint' }, LLM_MODEL_HINT),
    h('div', { class: 'llm-models' }, [llmModelsBtn]),
    llmModelsStatusEl,
    llmModelsListEl,
    h('label', { class: 'llm-row' }, [h('span', { class: 'llm-label' }, 'API Key'), llmKeyInput]),
    h('div', { class: 'llm-actions' }, [llmSaveBtn, llmTestBtn, llmClearBtn]),
  ]);

  const screen = h('div', { 'data-ui': 'settings-screen', class: 'settings-screen' }, [
    headerEl,
    tierEl,
    poolEl,
    paramEl,
    storyEl,
    llmEl,
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

  /* ------------------------------------------------------------ AI 分组的读写 */
  /** 读一次"已存配置"（加载口异常也不让设置屏炸掉：回落空配置）。 */
  function readStoredLlm(): LlmConfig {
    try {
      const cfg = llmDeps?.load();
      if (!cfg || typeof cfg !== 'object') return { baseUrl: '', apiKey: '', model: '' };
      return {
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
        apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
        model: typeof cfg.model === 'string' ? cfg.model : '',
      };
    } catch {
      return { baseUrl: '', apiKey: '', model: '' };
    }
  }

  /** 把"已存配置"映到输入框：地址/模型照抄，**Key 只以掩码出现在 placeholder**。 */
  function applyStoredLlm(): void {
    llmBaseInput.value = storedLlm.baseUrl;
    llmModelInput.value = storedLlm.model;
    llmKeyInput.value = '';
    llmKeyInput.placeholder = maskKey(storedLlm.apiKey);
  }

  /** 当前输入框里的配置：Key 留空 ⇒ **沿用已存值**（留空不等于清空，清空要点「清除 Key」）。 */
  /**
   * 组装"当前输入框 + 已存值"的配置。**每次现读一次磁盘**（安全评审判 m-6）：
   * 多标签页下另一个标签点了「清除 Key」时，本标签内存里的副本已过期；
   * 不重读就会把已清除的 Key 复活。重读只在 Key 输入框为空时影响结果，代价可以忽略。
   */
  function inputLlmConfig(): LlmConfig {
    const typed = llmKeyInput.value.trim();
    // Key 留空 ⇒ 沿用"磁盘上当前那份"（现读，不用内存副本：见函数注释的 m-6 理由）
    const onDisk = typed.length > 0 ? null : readStoredLlm();
    return {
      baseUrl: llmBaseInput.value,
      apiKey: typed.length > 0 ? typed : (onDisk?.apiKey ?? storedLlm.apiKey),
      model: llmModelInput.value,
    };
  }

  /**
   * 预设**只填地址与模型**（预设里恒无 Key）；「自定义」的两个字段是空串，于是清空让玩家自己填。
   * Key 输入框与已存 Key 都不动——换一家服务商不该顺手把玩家的 Key 抹掉。
   */
  function onPickPreset(id: string): void {
    if (destroyed || llmBusy) return;
    const preset = (llmDeps?.presets ?? []).find((p) => p.id === id);
    if (!preset) return;
    llmBaseInput.value = preset.config.baseUrl;
    llmModelInput.value = preset.config.model;
  }

  function onSaveLlm(): void {
    if (destroyed || llmBusy || !llmDeps) return;
    let written = false;
    try {
      written = llmDeps.save(inputLlmConfig()) === true;
    } catch (e) {
      toast(`没保存：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (written) {
      // 回读**真正存下的**那份（platform 侧会 trim 并对空地址/空模型回落默认值），
      // 于是"屏幕上显示的 = 生效的"；Key 输入框同时清空，DOM 里不残留明文。
      storedLlm = readStoredLlm();
      applyStoredLlm();
      toast('AI 设置已保存。');
      return;
    }
    // 写失败（隐私模式/配额满）：**不回读、不清空输入框、不改掩码**——玩家刚敲的 Key 必须留在框里
    // （清掉他会以为已保存，下次打开发现要重填）；并如实说"没能保存"（安全评审判 m-2）。
    toast('没能保存（浏览器可能禁用了本地存储）——请检查一下。');
  }

  async function onTestLlm(): Promise<void> {
    if (destroyed || llmBusy || !llmDeps || typeof llmDeps.test !== 'function') return;
    llmBusy = true;
    render(ctrl.snapshot());
    try {
      const res = await llmDeps.test(inputLlmConfig());
      if (res && res.ok === true) toast('连接正常。');
      else toast(res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '连接失败。');
    } catch (e) {
      toast(`连接失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      llmBusy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  async function onFetchModels(): Promise<void> {
    if (destroyed || modelsBusy || !llmDeps || typeof llmDeps.listModels !== 'function') return;
    modelsBusy = true;
    llmModelsListEl.replaceChildren();
    llmModelsStatusEl.textContent = '正在问服务商要模型列表…';
    setHidden(llmModelsStatusEl, false);
    render(ctrl.snapshot());
    try {
      const res = await llmDeps.listModels(inputLlmConfig());
      if (destroyed) return;
      if (!res || res.ok !== true) {
        llmModelsStatusEl.textContent =
          res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '没能取到模型列表。';
        return;
      }
      if (res.models.length === 0) {
        llmModelsStatusEl.textContent = '服务商没有返回任何模型。';
        return;
      }
      llmModelsStatusEl.textContent = `这个账号可用 ${res.models.length} 个模型，点一个填入：`;
      for (const id of res.models) {
        const b = h('button', { 'data-llm-model-option': id, class: 'llm-model-option', type: 'button' }, id) as HTMLButtonElement;
        b.addEventListener('click', () => {
          // 只填输入框，不落盘：与"预设"同口径（要不要用还得玩家自己点保存）
          llmModelInput.value = id;
          render(ctrl.snapshot());
        });
        llmModelsListEl.appendChild(b);
      }
    } catch (e) {
      if (!destroyed) llmModelsStatusEl.textContent = `没能取到模型列表：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      modelsBusy = false;
      if (!destroyed) render(ctrl.snapshot());
    }
  }

  function onClearLlm(): void {
    if (destroyed || llmBusy || !llmDeps || typeof llmDeps.clear !== 'function') return;
    try {
      llmDeps.clear();
    } catch (e) {
      toast(`没清掉：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    storedLlm = readStoredLlm();
    applyStoredLlm();
    toast('已清除。');
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
    // 「拉取模型列表」只在宿主提供该口时显示；在途时禁用（防连点）
    setHidden(llmModelsBtn, typeof llmDeps?.listModels !== 'function');
    llmModelsBtn.disabled = modelsBusy;

    // AI 分组：可写口在场的按钮才显示；「测试连接」在途时整组按钮禁用（防连点）。
    llmSaveBtn.disabled = llmBusy;
    llmTestBtn.disabled = llmBusy || typeof llmDeps?.test !== 'function';
    llmClearBtn.disabled = llmBusy || typeof llmDeps?.clear !== 'function';
    setHidden(llmTestBtn, !canLlm || typeof llmDeps?.test !== 'function');
    setHidden(llmClearBtn, !canLlm || typeof llmDeps?.clear !== 'function');
    setHidden(llmPresetsEl, llmPresetButtons.length === 0);
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
  llmSaveBtn.addEventListener('click', onSaveLlm);
  llmModelsBtn.addEventListener('click', () => void onFetchModels());
  llmTestBtn.addEventListener('click', () => void onTestLlm());
  llmClearBtn.addEventListener('click', onClearLlm);

  // 初次回填：地址/模型照抄已存值，Key 只以掩码形态出现在 placeholder（明文绝不进 DOM）。
  if (canLlm) {
    storedLlm = readStoredLlm();
    applyStoredLlm();
  }

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
