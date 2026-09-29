/**
 * llmConfig.ts —— Plan 5 · T2：LLM 配置的**唯一存放点**（`localStorage`）。
 *
 * ## 为什么绝不放进 `SaveFile`
 * PRD §4.4 要求 Key"仅存本地"。存档是**会被导出的**（备份文件、换机迁移、发给朋友帮忙看），
 * 把 Key 放进存档等于让它跟着备份文件到处跑。所以这里单独用一个 localStorage 键：
 * 它不进 `settings`、不进备份、不参与 `validateSave`——代价是"换设备要重新填一次"，
 * 这个代价必须付。`tests/tooling/llmSafety.test.ts` 会机器化守住这条。
 *
 * ## 明文存储的诚实说明
 * 浏览器里没有可信的密钥保管处：任何"前端加密"都只能把解密密钥也放在同一处，属于自欺。
 * 因此本模块**明文**存 Key，并把这件事如实写进设置页文案（本地明文 + 告知，PRD 的既定口径）。
 *
 * ## 坏值一律回落
 * localStorage 里的内容可能被用户手改、被旧版本写坏、被隐私插件清空。读取时逐字段消毒：
 * 不是对象 → 默认值；字段非字符串 → 默认值；**只有 Key 是空串时保留空串**（"未设置"是合法状态）。
 */
import type { LlmConfig } from './llmTypes';

/** localStorage 的键（带版本后缀：将来形状变了可以并存而不是互相踩）。 */
export const LLM_STORAGE_KEY = 'zx-xia.llm.v1';

/** 默认配置：DeepSeek（国内直连可达、CORS 允许浏览器调用，2026-09 实测）。 */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  readerUrl: '',
  readerKey: '',
  // 【2026-09 实测修正】官方目录现在只有 `deepseek-flash`（= DeepSeek-V4.1-Flash）与
  // `deepseek-v4-pro`；旧名 `deepseek-chat` 已不被接受（会得到 400）。
  // 用户实测就是这个坑，因此这里必须跟官方目录对齐——并在设置页提供「拉取模型列表」，
  // 免得下次改名又要靠猜。
  model: 'deepseek-flash',
};

/**
 * 三家预设。**只填 baseUrl 与 model，绝不预置任何 Key**（也不预置"某个好心人的 Key"）。
 * 通义走 DashScope 的 OpenAI 兼容模式；自定义留给"OpenAI 兼容网关"这类场景。
 */
export const LLM_PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly config: LlmConfig }> = [
  { id: 'deepseek', label: 'DeepSeek', config: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash' } },
  {
    id: 'dashscope',
    label: '通义千问',
    config: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-plus' },
  },
  { id: 'custom', label: '自定义', config: { baseUrl: '', apiKey: '', model: '' } },
];

/** 消毒单个字段：非字符串 → 回落值；字符串则 trim（不做 URL/格式校验，交给调用时的错误映射）。 */
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** 读配置（永不抛：localStorage 不可用/内容坏了都回默认）。 */
export function loadLlmConfig(storage?: Pick<Storage, 'getItem'>): LlmConfig {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return { ...DEFAULT_LLM_CONFIG };
    const raw = store.getItem(LLM_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_LLM_CONFIG };
    const o = parsed as Record<string, unknown>;
    return {
      // 注意：baseUrl/model 为空串是**非法配置**（预设里的"自定义"就是空），此时回落默认值，
      // 免得玩家点"自定义"却忘了填就得到一个 statusCode 404 的费解错误。
      baseUrl: str(o.baseUrl, DEFAULT_LLM_CONFIG.baseUrl) || DEFAULT_LLM_CONFIG.baseUrl,
      apiKey: str(o.apiKey, ''), // 空串是合法状态（未设置）
      model: str(o.model, DEFAULT_LLM_CONFIG.model) || DEFAULT_LLM_CONFIG.model,
      // 读取服务（可选）：**空串 = 不启用**，故不做"空串回落默认"（那会让玩家关不掉它）
      readerUrl: str(o.readerUrl, ''),
      readerKey: str(o.readerKey, ''),
    };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

/**
 * 写配置。返回**是否真的写进去了**：隐私模式/配额满时返回 false，
 * 让设置屏能如实说"没能保存"而不是报"已保存"（安全评审判 m-2：首版静默吞掉写失败，
 * 屏幕上却出现"已保存"，反馈自相矛盾）。永不抛。
 */
export function saveLlmConfig(cfg: LlmConfig, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return false;
    store.setItem(
      LLM_STORAGE_KEY,
      JSON.stringify({
        baseUrl: str(cfg?.baseUrl, DEFAULT_LLM_CONFIG.baseUrl) || DEFAULT_LLM_CONFIG.baseUrl,
        apiKey: str(cfg?.apiKey, ''),
        model: str(cfg?.model, DEFAULT_LLM_CONFIG.model) || DEFAULT_LLM_CONFIG.model,
        readerUrl: str(cfg?.readerUrl, ''),
        readerKey: str(cfg?.readerKey, ''),
      }),
    );
    return true;
  } catch {
    /* 存不下：调用方据此提示；本模块的产物只影响"下次要重填"，不影响游戏本身 */
    return false;
  }
}

/** 清除（设置页的「清除 Key」；只清 Key，保留 baseUrl/model 省得重填）。 */
export function clearLlmConfig(storage?: Pick<Storage, 'setItem'>): void {
  saveLlmConfig({ ...loadLlmConfig(), apiKey: '' }, storage);
}

/**
 * Key 的展示形态：**永不回显明文**。只给"前 3 后 4"的指纹，够玩家确认"填的是哪一把"，
 * 又不足以让别人从屏幕/截图里拿走。
 */
export function maskKey(key: string): string {
  const k = typeof key === 'string' ? key.trim() : '';
  if (k.length === 0) return '（未设置）';
  if (k.length <= 8) return `${k.slice(0, 2)}…${k.slice(-2)}`;
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/** 是否已配置到"可以试着调用"的程度（不校验 Key 有效性——那要靠一次真实请求）。 */
export function isLlmReady(cfg: LlmConfig): boolean {
  return str(cfg?.baseUrl, '').length > 0 && str(cfg?.model, '').length > 0 && str(cfg?.apiKey, '').length > 0;
}
