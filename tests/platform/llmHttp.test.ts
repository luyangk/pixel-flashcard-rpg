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
import { chat, chatEndpoint, DEFAULT_TIMEOUT_MS } from '../../src/platform/llmHttp';
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

  it('LH#4 **Key 绝不出现在错误文案里**（服务端回显请求头也带不出来）', async () => {
    // 故意让响应体里回显 Key：只为抓"把 response.text() 拼进 reason"的实现
    const echo = fakeFetch({ kind: 'text', status: 400, body: `{"error":"bad key ${KEY}"}` });
    const res = await chat({ config: CONFIG, messages: MESSAGES, fetchImpl: echo.impl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).not.toContain(KEY);
      expect(res.reason).not.toContain('sk-super');
      expect(res.reason).toContain('400');
    }
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
