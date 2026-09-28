// @vitest-environment happy-dom
/**
 * tests/platform/llmHttp.test.ts —— Plan 5 · T2：唯一的网络出口（含五种失败与"Key 不外泄"）。
 *
 * 判别力：
 * - LH#2 请求形状：URL 拼接、`Authorization: Bearer`、`stream:false`——地址拼错的实现必红；
 * - LH#3 五种失败各一句人话：把错误吞成 `{}` 或原样抛出的实现红；
 * - LH#4 **Key 绝不出现在错误文案里**：把 `response.text()` 拼进 reason 的实现会在
 *   "服务端回显请求头"的假响应下泄漏 Key ⇒ 本用例的假 fetch 故意回显 Key，专抓这种实现；
 * - LH#5 超时会真的中止（假 fetch 等 signal.abort）。
 */
import { describe, expect, it } from 'vitest';
import {
  chat,
  chatEndpoint,
  DEFAULT_TIMEOUT_MS,
  listModels,
  MODELS_MAX,
  modelsEndpoint,
} from '../../src/platform/llmHttp';
import type { ChatMessage } from '../../src/platform/llmTypes';

const KEY = 'sk-super-secret-value';
const CONFIG = { baseUrl: 'https://api.deepseek.com/', apiKey: KEY, model: 'deepseek-chat' };
const MESSAGES: readonly ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'user' },
];

/** 假 fetch：可指定状态码/响应体/抛错，并记录收到的请求。 */
function fakeFetch(
  behavior:
    | { kind: 'json'; status?: number; body: unknown }
    | { kind: 'text'; status?: number; body: string }
    | { kind: 'throw'; error: unknown }
    | { kind: 'hang' },
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (behavior.kind === 'throw') throw behavior.error;
    if (behavior.kind === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    const status = behavior.status ?? 200;
    const res = new Response(behavior.kind === 'json' ? JSON.stringify(behavior.body) : behavior.body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    return res;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('chatEndpoint', () => {
  it('LH#1 拼端点：容忍结尾斜杠、容忍已带路径、空地址回空串', () => {
    expect(chatEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(chatEndpoint('https://api.deepseek.com///')).toBe('https://api.deepseek.com/chat/completions');
    expect(chatEndpoint('https://x.example/v1')).toBe('https://x.example/v1/chat/completions');
    expect(chatEndpoint('https://x.example/v1/chat/completions')).toBe('https://x.example/v1/chat/completions');
    expect(chatEndpoint('   ')).toBe('');
    expect(chatEndpoint(undefined as unknown as string)).toBe('');
  });
});

describe('chat —— 成功路径与请求形状', () => {
  it('LH#1b 正常返回正文；URL/头/体逐项正确（含 stream:false 与 temperature）', async () => {
    const f = fakeFetch({ kind: 'json', body: { choices: [{ message: { content: '  hello  ' } }] } });
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: f.impl });
    expect(res).toEqual({ ok: true, text: '  hello  ' }); // 正文原样返回（清洗归 core/llmParse）

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(f.calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'deepseek-chat', stream: false, temperature: 0.3 });
    expect(body.messages).toEqual(MESSAGES);
  });

  it('LH#1c 兼容 `choices[0].text`（少数网关的形状）', async () => {
    const f = fakeFetch({ kind: 'json', body: { choices: [{ text: 'legacy' }] } });
    await expect(chat({ config: CONFIG, messages: MESSAGES, fetchImpl: f.impl })).resolves.toEqual({ ok: true, text: 'legacy' });
  });
});

describe('chat —— 配置未填与响应畸形', () => {
  it('LH#2 没地址/没 Key/没模型/没消息：发请求之前就回人话（一次网络调用都不该发生）', async () => {
    const f = fakeFetch({ kind: 'json', body: {} });
    const cases: Array<[string, Parameters<typeof chat>[0]]> = [
      ['地址', { config: { ...CONFIG, baseUrl: '' }, messages: MESSAGES, fetchImpl: f.impl }],
      ['Key', { config: { ...CONFIG, apiKey: '  ' }, messages: MESSAGES, fetchImpl: f.impl }],
      ['模型', { config: { ...CONFIG, model: '' }, messages: MESSAGES, fetchImpl: f.impl }],
      ['内容', { config: CONFIG, messages: [], fetchImpl: f.impl }],
    ];
    for (const [what, deps] of cases) {
      const res = await chat(deps);
      expect(res.ok, what).toBe(false);
      if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
      // 三类配置缺失都要指路设置页；"没内容"是调用方的 bug，不该甩锅给设置
      if (what !== '内容' && !res.ok) expect(res.reason).toContain('设置');
    }
    expect(f.calls).toHaveLength(0); // 配置没填好时一次网络调用都不该发生
  });

  it('LH#2b 响应畸形（空 choices / content 非字符串 / 非 JSON）各给明确原因', async () => {
    const noChoices = fakeFetch({ kind: 'json', body: {} });
    expect(await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: noChoices.impl })).toEqual({
      ok: false,
      reason: '返回里没有 choices 字段。',
    });

    const emptyContent = fakeFetch({ kind: 'json', body: { choices: [{ message: { content: '   ' } }] } });
    const r2 = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: emptyContent.impl });
    expect(r2.ok).toBe(false);

    const notJson = fakeFetch({ kind: 'text', body: '这不是 JSON' });
    const r3 = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: notJson.impl });
    expect(r3).toEqual({ ok: false, reason: '返回的不是合法 JSON。' });
  });
});

describe('chat —— 五种失败与安全', () => {
  it('LH#3 401/403/402/404/429/5xx/网络层各一句人话', async () => {
    const cases: Array<[number | null, string]> = [
      [401, 'Key 不对或没有权限'],
      [403, 'Key 不对或没有权限'],
      [402, '余额不足'],
      [404, '接口地址不对'],
      [429, '限流'],
      [503, '服务商那边出故障'],
      [418, '请求被拒绝'],
    ];
    for (const [status, expectText] of cases) {
      const f = fakeFetch({ kind: 'json', status: status as number, body: {} });
      const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: f.impl });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain(expectText);
        expect(res.reason).toContain(String(status));
      }
    }

    const netErr = fakeFetch({ kind: 'throw', error: new TypeError('Failed to fetch') });
    const r = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: netErr.impl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('连不上这个地址');
  });

  it('LH#4 错误文案**带服务商原话但抹掉 Key**：400 要说清多半是模型名/参数问题', async () => {
    // 响应体里同时含"有用的诊断"与"回显的 Key"——两者必须一留一抹
    const echo = fakeFetch({
      kind: 'text',
      status: 400,
      body: `{"error":{"message":"Model Not Exist: deepseek-chat (key ${KEY})"}}`,
    });
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: echo.impl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('400');
      expect(res.reason).toContain('模型名'); // 可操作的方向
      expect(res.reason).toContain('Model Not Exist'); // 服务商原话（用户自查的唯一线索）
      expect(res.reason).not.toContain(KEY); // 但 Key 必须被抹掉
      expect(res.reason).not.toContain('sk-super');
      expect(res.reason).toContain('***'); // 抹除的痕迹（说明走的是脱敏路径）
    }
  });

  it('LH#4b 详情脱敏的边界：`sk-` 形状一律抹除、压成单行、超长截断', async () => {
    const long = 'x'.repeat(400);
    const weird = fakeFetch({
      kind: 'text',
      status: 500,
      body: `{"error":{"message":"upstream sk-OTHERKEY123456 failed\n${long}"}}`,
    });
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: weird.impl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).not.toContain('sk-OTHERKEY123456');
      expect(res.reason).not.toContain('\n'); // 单行
      expect(res.reason.length).toBeLessThan(400); // 截断
    }
  });

  it('LH#4c 读不出详情（非 JSON 且无 message）时仍给人话，不抛', async () => {
    const broken = fakeFetch({ kind: 'text', status: 400, body: 'not json at all' });
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: broken.impl });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('模型名'); // 状态码映射仍然生效
  });

  it('LH#5 超时会真的中止请求（假 fetch 一直挂着，只有 abort 才能结束它）', async () => {
    const hang = fakeFetch({ kind: 'hang' });
    const started = Date.now();
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: hang.impl, timeoutMs: 30 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('超时');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  }, 10_000);

  it('LH#5b 外部 signal 中止 ⇒ 给"被取消"而不是超时；且永不整段抛出', async () => {
    const hang = fakeFetch({ kind: 'hang' });
    const ac = new AbortController();
    const p = chat({ config: CONFIG, messages: MESSAGES, fetchImpl: hang.impl, timeoutMs: 0, signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('取消');
  });

  it('LH#5c fetch 抛任意怪东西也不逃逸（永不 reject）', async () => {
    const weird = fakeFetch({ kind: 'throw', error: '字符串错误' });
    await expect(chat({ config: CONFIG, messages: MESSAGES, fetchImpl: weird.impl })).resolves.toMatchObject({ ok: false });
    const nontype = fakeFetch({ kind: 'throw', error: new Error('boom') });
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: nontype.impl });
    if (!res.ok) expect(res.reason).toContain('boom');
  });
});

describe('listModels —— 问服务商要模型名（用户实测驱动的功能）', () => {
  it('LM#1 正常：GET {base}/models + Bearer 头；去重排序并封顶', async () => {
    const f = fakeFetch({ kind: 'json', body: { data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }, { id: 'deepseek-flash' }, { id: '  ' }, { nope: 1 }] } });
    const res = await listModels({ config: CONFIG, fetchImpl: f.impl });
    expect(res).toEqual({ ok: true, models: ['deepseek-flash', 'deepseek-v4-pro'] });
    expect(f.calls[0].url).toBe('https://api.deepseek.com/models');
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('LM#2 未填地址/Key ⇒ 不发请求；401/429/网络各给人话且不含 Key', async () => {
    const f = fakeFetch({ kind: 'json', body: {} });
    expect((await listModels({ config: { ...CONFIG, baseUrl: '' }, fetchImpl: f.impl })).ok).toBe(false);
    expect((await listModels({ config: { ...CONFIG, apiKey: ' ' }, fetchImpl: f.impl })).ok).toBe(false);
    expect(f.calls).toHaveLength(0);

    const unauthorized = fakeFetch({ kind: 'text', status: 401, body: `{"error":{"message":"bad key ${KEY}"}}` });
    const r = await listModels({ config: CONFIG, fetchImpl: unauthorized.impl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('Key 不对');
      expect(r.reason).not.toContain(KEY); // 脱敏
    }
  });

  it('LM#3 形状不符（没有 data 数组 / 空列表 / 非 JSON）各给明确原因', async () => {
    const shape = fakeFetch({ kind: 'json', body: { models: [] } });
    expect(await listModels({ config: CONFIG, fetchImpl: shape.impl })).toEqual({
      ok: false,
      reason: '这个服务商没有按 OpenAI 兼容格式返回模型列表。',
    });
    const empty = fakeFetch({ kind: 'json', body: { data: [] } });
    expect((await listModels({ config: CONFIG, fetchImpl: empty.impl })).ok).toBe(false);
    const notJson = fakeFetch({ kind: 'text', body: 'nope' });
    expect((await listModels({ config: CONFIG, fetchImpl: notJson.impl })).ok).toBe(false);
  });

  it('LM#4 modelsEndpoint：容忍结尾斜杠与已带 /models；封顶 MODELS_MAX', async () => {
    expect(modelsEndpoint('https://api.deepseek.com/')).toBe('https://api.deepseek.com/models');
    expect(modelsEndpoint('https://x.example/v1')).toBe('https://x.example/v1/models');
    expect(modelsEndpoint('https://x.example/v1/models')).toBe('https://x.example/v1/models');
    expect(modelsEndpoint('')).toBe('');

    const many = Array.from({ length: MODELS_MAX + 20 }, (_, i) => ({ id: `m${String(i).padStart(3, '0')}` }));
    const f = fakeFetch({ kind: 'json', body: { data: many } });
    const res = await listModels({ config: CONFIG, fetchImpl: f.impl });
    if (res.ok) expect(res.models).toHaveLength(MODELS_MAX);
  });
});
