// @vitest-environment happy-dom
/**
 * tests/platform/llmConfig.test.ts —— Plan 5 · T2：Key 的存放（localStorage，不进存档）。
 *
 * 判别力：
 * - LC#1 坏内容/坏字段一律回落默认：把 `JSON.parse` 结果直接当配置用的实现会在这里红；
 * - LC#2 `maskKey` 永不回显明文：直接返回原串的实现红（这正是"截图泄漏 Key"的场景）；
 * - LC#4 **配置里没有存档**：本模块不 import persist/saveMigrate，也不产生任何 SaveFile 形状
 *   —— 这条与 `tests/tooling/llmSafety.test.ts` 的机器判据互为呼应。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLlmConfig,
  DEFAULT_LLM_CONFIG,
  isLlmReady,
  LLM_PRESETS,
  LLM_STORAGE_KEY,
  loadLlmConfig,
  maskKey,
  saveLlmConfig,
} from '../../src/platform/llmConfig';

/** 极简假 localStorage（happy-dom 也有真货，但假的可控且能模拟抛错）。 */
function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & {
  dump: () => Record<string, string>;
  breakIt: () => void;
} {
  const map = new Map(Object.entries(initial));
  let broken = false;
  return {
    getItem: (k) => {
      if (broken) throw new Error('storage broken');
      return map.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (broken) throw new Error('quota');
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
    breakIt: () => {
      broken = true;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('loadLlmConfig —— 坏值一律回落', () => {
  it('LC#1 空存储/坏 JSON/非对象/字段类型错：全部回默认；坏 localStorage 也不抛', () => {
    expect(loadLlmConfig(fakeStorage())).toEqual(DEFAULT_LLM_CONFIG);

    for (const bad of ['{', 'null', '42', '"str"', '[1,2]', '{"baseUrl":1,"model":[],"apiKey":{}}']) {
      const got = loadLlmConfig(fakeStorage({ [LLM_STORAGE_KEY]: bad }));
      expect(got, bad).toEqual(DEFAULT_LLM_CONFIG);
    }

    const broken = fakeStorage();
    broken.breakIt();
    expect(loadLlmConfig(broken)).toEqual(DEFAULT_LLM_CONFIG); // 抛不出来
  });

  it('LC#1b 合法值逐字读回；**空 Key 是合法状态**（"未设置"不等于坏值）', () => {
    const store = fakeStorage({
      [LLM_STORAGE_KEY]: JSON.stringify({
        baseUrl: ' https://api.deepseek.com/ ',
        apiKey: '',
        model: ' deepseek-chat ',
      }),
    });
    // 配置层只 trim 空白，**不做 URL 规范化**（结尾斜杠归 chatEndpoint 处理）——
    // 两处都"顺手规范化"会让人分不清最终发给服务商的是哪个地址
    expect(loadLlmConfig(store)).toEqual({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: '',
      model: 'deepseek-chat',
    });
    expect(isLlmReady(loadLlmConfig(store))).toBe(false); // 没 Key 不算就绪
  });
});

describe('默认配置与预设 —— 必须与官方目录一致', () => {
  it('LC#5 默认模型是 deepseek-flash（旧的 deepseek-chat 已停用，会导致 400——用户实测）', () => {
    expect(DEFAULT_LLM_CONFIG.model).toBe('deepseek-flash');
    const deepseek = LLM_PRESETS.find((p) => p.id === 'deepseek');
    expect(deepseek?.config.model).toBe('deepseek-flash');
    // 预设里不得再出现已停用的名字
    for (const p of LLM_PRESETS) expect(p.config.model).not.toBe('deepseek-chat');
  });
});

describe('saveLlmConfig / clearLlmConfig', () => {
  it('LC#2 写进 localStorage 的键固定、可读回；清除只清 Key 保留地址与模型', () => {
    const store = fakeStorage();
    saveLlmConfig({ baseUrl: 'https://x.example/v1', apiKey: 'sk-secret', model: 'm1' }, store);
    expect(Object.keys(store.dump())).toEqual([LLM_STORAGE_KEY]);
    expect(loadLlmConfig(store)).toEqual({ baseUrl: 'https://x.example/v1', apiKey: 'sk-secret', model: 'm1' });

    // clear 需要能读旧值，故这里用真 localStorage 走一遍（假 store 只实现 setItem）
    localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify({ baseUrl: 'https://x.example/v1', apiKey: 'sk-secret', model: 'm1' }));
    clearLlmConfig(localStorage);
    expect(loadLlmConfig(localStorage)).toEqual({ baseUrl: 'https://x.example/v1', apiKey: '', model: 'm1' });
    expect(localStorage.getItem(LLM_STORAGE_KEY)).not.toContain('sk-secret'); // Key 真的没了
  });

  it('LC#2b 写失败（配额/隐私模式）静默：不让设置页炸掉', () => {
    const broken = fakeStorage();
    broken.breakIt();
    expect(() => saveLlmConfig({ baseUrl: 'x', apiKey: 'y', model: 'z' }, broken)).not.toThrow();
  });

  it('LC#3 预设三家：地址/模型齐备，且**都不带 Key**', () => {
    expect(LLM_PRESETS.map((p) => p.id)).toEqual(['deepseek', 'dashscope', 'custom']);
    for (const p of LLM_PRESETS) {
      expect(p.config.apiKey).toBe('');
      expect(p.label.length).toBeGreaterThan(0);
      if (p.id !== 'custom') {
        expect(p.config.baseUrl).toMatch(/^https:\/\//);
        expect(p.config.model.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('maskKey —— 永不回显明文', () => {
  it('LC#4 短 Key / 长 Key / 空 Key 三种形态都不泄漏完整值', () => {
    expect(maskKey('')).toBe('（未设置）');
    expect(maskKey('   ')).toBe('（未设置）');
    const short = maskKey('sk-abcd');
    expect(short).toBe('sk…cd');
    expect(short).not.toContain('abcd');

    const long = maskKey('sk-1234567890abcdef');
    expect(long).toBe('sk-…cdef');
    expect(long).not.toContain('1234567890ab');
    expect(long.length).toBeLessThan('sk-1234567890abcdef'.length);
  });
});
