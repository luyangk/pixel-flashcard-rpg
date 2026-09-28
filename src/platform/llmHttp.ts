/**
 * llmHttp.ts —— Plan 5 · T2：全仓**唯一的 LLM 网络出口**。
 *
 * ## 为什么集中在一处
 * 网络 + 密钥 + 外部服务这三件事叠在一起是最容易出安全问题的地方（Key 泄漏进日志/错误文本、
 * 超时没人管、错误码变成一坨 `[object Object]`）。集中成一个函数之后：
 * - **Key 只在这里进请求头**，且所有错误文案都从状态码/异常类型生成，**绝不回显请求内容**；
 * - 超时、跨域、限流、鉴权各给一句人话（UI 直接把 reason 上屏）；
 * - `fetchImpl` 可注入 ⇒ 五种失败路径都能在测试里逐条钉住，不需要真的联网。
 *
 * ## 与 DeepSeek / 通义 / 自定义的关系
 * 三家都提供 OpenAI 兼容的 `POST {base}/chat/completions`（`stream:false`）。
 * DeepSeek 与 DashScope 的 CORS 都允许浏览器直连（2026-09 实测），OpenAI 官方域名的预检
 * 未通过，故不列预设——玩家若知道某个允许跨域的兼容网关，用「自定义」即可。
 *
 * ## 流式与重试
 * 都**刻意不做**：本作只要短 JSON（最多 20 张卡），流式带来的复杂度远超收益；
 * 自动重试会在限流时雪上加霜，改由玩家自己再点一次。
 */
import type { ChatMessage, ChatResult, FetchLike, LlmConfig } from './llmTypes';

/** 默认超时：手机网络下 30s 足够；到点就中止，绝不无限转圈。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ChatDeps {
  readonly config: LlmConfig;
  readonly messages: readonly ChatMessage[];
  /** 注入位（测试用假 fetch；生产不传）。 */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** 外部中止信号（例如玩家离开页面）；与内部超时合并。 */
  readonly signal?: AbortSignal;
}

/** 把 baseUrl 规范化成 chat/completions 端点（容忍结尾斜杠与已带路径的写法）。 */
export function chatEndpoint(baseUrl: string): string {
  const base = (typeof baseUrl === 'string' ? baseUrl : '').trim().replace(/\/+$/, '');
  if (base.length === 0) return '';
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/**
 * 错误文案（**不含 Key、不含请求体**）。分层：状态码 → 语义；异常类型 → 网络层。
 * 402/404 也各自给一句：这两类在"填错地址/余额不足"时很常见，笼统说"请求失败"没法排查。
 */
function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return 'Key 不对或没有权限（401/403）——去设置页检查一下。';
  if (status === 402) return '这个账号余额不足或未开通（402）。';
  if (status === 404) return '接口地址不对（404）——检查 Base URL 是不是多了或少了路径。';
  if (status === 429) return '被服务商限流了（429）——等一会儿再试。';
  // 400/422 在实测里最常见的成因就是**模型名不被该服务商接受**（用户实测就撞到这个）：
  // 与其笼统说"请求被拒绝"，不如把最可能的原因说出来，并附上服务商的原话（见 readErrorDetail）。
  if (status === 400 || status === 422) {
    return `请求被拒绝（${status}）——多半是**模型名**与这个服务商的目录不一致，或者它不接受某个参数。`;
  }
  if (status >= 500) return `服务商那边出故障了（${status}）——稍后再试。`;
  return `请求被拒绝（${status}）。`;
}

/** 错误详情长度上限（人话优先，别把一屏都占了）。 */
const ERROR_DETAIL_MAX = 200;

/**
 * 读取服务商返回的错误详情，并**脱敏**后交给上屏。
 *
 * 为什么值得冒"把响应体带进文案"的风险（安全评审判 I-1 时期的顾虑）：
 * 用户实测的 400 里，服务商原话（`model not found: xxx` 之类）是**唯一能自查的线索**；
 * 一句笼统的"请求被拒绝"会让人无从下手。风险用三道闸口控制住：
 * 1. 先按配置里的 Key 精确抹除；
 * 2. 再按 `sk-`/`Bearer` 形状抹除（防止服务商回显的是别的键）；
 * 3. 压成单行、截断到 200 字。
 * 任何一步失败（非 JSON、读不出）都回空串——宁可不显示，也不原样吐出来。
 */
async function readErrorDetail(res: Response, apiKey: string): Promise<string> {
  try {
    let raw = '';
    try {
      const json = (await res.json()) as { error?: { message?: unknown }; message?: unknown };
      const msg = json?.error?.message ?? json?.message;
      raw = typeof msg === 'string' ? msg : JSON.stringify(json);
    } catch {
      raw = await res.text();
    }
    if (typeof raw !== 'string' || raw.trim().length === 0) return '';
    let text = raw;
    const key = (apiKey ?? '').trim();
    if (key.length >= 8) text = text.split(key).join('***');
    text = text.replace(/\b(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***');
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > ERROR_DETAIL_MAX ? `${text.slice(0, ERROR_DETAIL_MAX)}…` : text;
  } catch {
    return '';
  }
}

function reasonForError(e: unknown, timedOut: boolean): string {
  if (timedOut) return '请求超时了——网络慢或服务商太慢，稍后再试。';
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError') return '请求被取消了。';
  // fetch 在网络层失败时抛 TypeError（跨域被拦、DNS、断网都走这里）
  if (e instanceof TypeError) {
    return '连不上这个地址（可能是网络问题，也可能是该服务不允许浏览器直连／跨域被拦）。';
  }
  return `请求失败：${e instanceof Error ? e.message : String(e)}`;
}

/** 从 OpenAI 兼容响应里取正文；形状不符时给明确原因（不猜、不吞）。 */
function textFromResponse(json: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (json === null || typeof json !== 'object') return { ok: false, reason: '返回内容不是 JSON 对象。' };
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false, reason: '返回里没有 choices 字段。' };
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | null;
  const content = first?.message?.content ?? first?.text;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '返回里没有正文内容。' };
  }
  return { ok: true, text: content };
}

/**
 * 发一次对话请求。**永不抛**：一切失败都收敛成 `{ok:false, reason}`。
 * 无 Key / 无地址等"配置没填好"的情况在发请求之前就返回，省一次白跑。
 */
export async function chat(deps: ChatDeps): Promise<ChatResult> {
  const config = deps?.config;
  const endpoint = chatEndpoint(config?.baseUrl ?? '');
  if (endpoint.length === 0) return { ok: false, reason: '还没填接口地址（设置 → AI）。' };
  if (typeof config?.apiKey !== 'string' || config.apiKey.trim().length === 0) {
    return { ok: false, reason: '还没填 API Key（设置 → AI）。' };
  }
  if (typeof config.model !== 'string' || config.model.trim().length === 0) {
    return { ok: false, reason: '还没填模型名（设置 → AI）。' };
  }
  const messages = Array.isArray(deps.messages) ? deps.messages : [];
  if (messages.length === 0) return { ok: false, reason: '没有要发送的内容。' };

  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: '这个环境不支持网络请求。' };

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(0, deps.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  // 外部信号也要能中止
  const onExternalAbort = (): void => controller?.abort();
  deps.signal?.addEventListener?.('abort', onExternalAbort);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Key 只出现在这一行；任何错误路径都不会把它带进文案
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model.trim(),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.3,
        stream: false,
      }),
      signal: controller?.signal,
    });
    if (!res || typeof res.ok !== 'boolean') return { ok: false, reason: '返回异常：拿不到响应状态。' };
    if (!res.ok) {
      const detail = await readErrorDetail(res, config.apiKey);
      return { ok: false, reason: detail.length > 0 ? `${reasonForStatus(res.status)}服务商说：${detail}` : reasonForStatus(res.status) };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: '返回的不是合法 JSON。' };
    }
    return textFromResponse(json);
  } catch (e) {
    return { ok: false, reason: reasonForError(e, timedOut) };
  } finally {
    if (timer !== null) clearTimeout(timer);
    deps.signal?.removeEventListener?.('abort', onExternalAbort);
  }
}

/* --------------------------------------------------------------------------
 * 模型列表（Plan 5 追加，用户实测驱动）
 *
 * 起因：预设里的模型名过时（deepseek-chat 已停用）⇒ 用户得到 400 却无从下手。
 * OpenAI 兼容的服务商都提供 `GET {base}/models`，于是"模型名"这件事可以**问服务商本人**，
 * 而不是靠文档或记忆。接口与 chat 同源（同一 base、同一 Bearer 头、同一超时与错误映射）。
 * -------------------------------------------------------------------------- */

/** 模型列表结果面（`reason` 可直接上屏；永不抛）。 */
export type ListModelsResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** 模型列表上限（有些网关返回上百个，屏上只给前 N 个够挑就行）。 */
export const MODELS_MAX = 60;

/** 由 baseUrl 推出 `/models` 端点（容忍结尾斜杠）。 */
export function modelsEndpoint(baseUrl: string): string {
  const base = (typeof baseUrl === 'string' ? baseUrl : '').trim().replace(/\/+$/, '');
  if (base.length === 0) return '';
  return base.endsWith('/models') ? base : `${base}/models`;
}

/**
 * 拉取服务商当前可用的模型名。**永不抛**，失败一律给人话。
 * 返回值经过去重、去空、排序与封顶——脏/超长列表不该把屏幕压垮。
 */
export async function listModels(deps: {
  readonly config: LlmConfig;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}): Promise<ListModelsResult> {
  const endpoint = modelsEndpoint(deps?.config?.baseUrl ?? '');
  if (endpoint.length === 0) return { ok: false, reason: '还没填接口地址（设置 → AI）。' };
  const key = typeof deps.config.apiKey === 'string' ? deps.config.apiKey.trim() : '';
  if (key.length === 0) return { ok: false, reason: '还没填 API Key（设置 → AI）。' };

  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: '这个环境不支持网络请求。' };

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(0, deps.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    const res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: controller?.signal,
    });
    if (!res || typeof res.ok !== 'boolean') return { ok: false, reason: '返回异常：拿不到响应状态。' };
    if (!res.ok) {
      const detail = await readErrorDetail(res, key);
      return {
        ok: false,
        reason: detail.length > 0 ? `${reasonForStatus(res.status)}服务商说：${detail}` : reasonForStatus(res.status),
      };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: '模型列表返回的不是合法 JSON。' };
    }
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return { ok: false, reason: '这个服务商没有按 OpenAI 兼容格式返回模型列表。' };
    const ids: string[] = [];
    for (const item of data) {
      const id = typeof item === 'string' ? item : (item as { id?: unknown })?.id;
      if (typeof id === 'string' && id.trim().length > 0 && !ids.includes(id.trim())) ids.push(id.trim());
    }
    if (ids.length === 0) return { ok: false, reason: '服务商返回的模型列表是空的。' };
    ids.sort();
    return { ok: true, models: ids.slice(0, MODELS_MAX) };
  } catch (e) {
    return { ok: false, reason: reasonForError(e, timedOut) };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
