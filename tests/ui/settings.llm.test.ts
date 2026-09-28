// @vitest-environment happy-dom
/**
 * tests/ui/settings.llm.test.ts —— Plan 5 · T4：设置屏「AI（可选）」分组。
 *
 * 这一组用例守的是本计划**最核心的安全面**：Key 只在本机、绝不回显、绝不被误抹。
 * 判别力（每条都写清"坏实现为何必红"）：
 * - SL#1 缺省注入 ⇒ 整组隐藏（假实现"永远显示一组空控件"必红）；
 * - SL#2 **Key 不回显**：DOM 全树（属性 / 文本 / 输入框 value）任何位置都不得出现明文，
 *   输入框只能是 password + 掩码 placeholder。把 Key 写进 value/placeholder/提示文案的
 *   实现必红——这是"截图/肩窥就能拿走 Key"的那条口子；
 * - SL#3 保存时输入框留空 ⇒ **保留原 Key**。`apiKey: keyInput.value` 这种实现会把 Key
 *   抹成空串 ⇒ 必红（"改个模型名就把 Key 弄丢了"是玩家最不可接受的失败）；
 * - SL#4 预设只填地址与模型、且不落盘；预设顺手抹掉 Key（或用预设里的空 Key 覆盖）必红；
 * - SL#5 「清除 Key」真的让 `load()` 的 Key 变空，地址/模型保留（只清 DOM 不落盘的必红）；
 * - SL#6 「测试连接」成功/失败两条 toast，且测的是**输入框里**的配置（用已存旧值去测的必红）；
 * - SL#7 文案如实说明 Key 的存放与代价（本地 + 不进备份 + 换设备重填）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatResult, LlmConfig } from '../../src/platform/llmTypes';
import { LLM_PRESETS, maskKey } from '../../src/platform/llmConfig';
import { mountSettings, type LlmSettingsDeps } from '../../src/ui/settings';
import { all, click, flushMicrotasks, makeCtrl, makeRoot, makeSnap, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

const STORED_KEY = 'sk-secret-abcdef123456'; // 明文只允许存在于"假存储"里，DOM 里出现即算泄漏
const BASE: LlmConfig = { baseUrl: 'https://api.deepseek.com', apiKey: STORED_KEY, model: 'deepseek-chat' };

/** 假 LLM 配置读写口：内存一份配置 + 记录每次保存/测试的入参。 */
function makeFakeLlm(
  initial: LlmConfig = BASE,
  opts: { readonly testImpl?: (cfg: LlmConfig) => Promise<ChatResult> } = {},
): {
  deps: LlmSettingsDeps;
  saved: LlmConfig[];
  tested: LlmConfig[];
  cfg: () => LlmConfig;
  setTestResult(r: ChatResult): void;
} {
  let cfg: LlmConfig = { ...initial };
  let testResult: ChatResult = { ok: true, text: 'pong' };
  const saved: LlmConfig[] = [];
  const tested: LlmConfig[] = [];
  return {
    saved,
    tested,
    cfg: () => ({ ...cfg }),
    setTestResult: (r) => {
      testResult = r;
    },
    deps: {
      load: () => ({ ...cfg }),
      save: (next) => {
        cfg = { ...next };
        saved.push({ ...next });
      },
      clear: () => {
        cfg = { ...cfg, apiKey: '' };
      },
      test: (c) => {
        tested.push({ ...c });
        return opts.testImpl ? opts.testImpl(c) : Promise.resolve(testResult);
      },
      presets: LLM_PRESETS,
    },
  };
}

/**
 * 全树找明文：属性值 / 叶子文本 / 输入框 value 三处都扫。
 * `innerHTML` 只能看到**属性**（`value` property 不序列化），所以必须三处都查——
 * 只查 innerHTML 的断言会让"直接把 Key 塞进 input.value"的实现漏网（假绿）。
 */
function domLeaks(root: HTMLElement, needle: string): string[] {
  const out: string[] = [];
  const walk = (el: Element): void => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes(needle)) out.push(`${el.tagName}[${attr.name}]`);
    }
    const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
    if (typeof value === 'string' && value.includes(needle)) out.push(`${el.tagName}.value`);
    if (el.children.length === 0 && (el.textContent ?? '').includes(needle)) out.push(`${el.tagName}.text`);
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);
  return out;
}

function mountWith(fake: ReturnType<typeof makeFakeLlm>, llm?: LlmSettingsDeps | undefined): HTMLElement {
  const root = makeRoot();
  mountSettings(root, makeCtrl(makeSnap()), { toastMs: 0, ...(llm === undefined ? { llm: fake.deps } : { llm }) });
  return root;
}

describe('mountSettings —— AI 分组：注入面', () => {
  it('SL#1 缺省注入 ⇒ 整组隐藏（不显示点了没反应的入口）', () => {
    const root = makeRoot();
    mountSettings(root, makeCtrl(makeSnap()), {});
    expect(ui(root, 'llm-group').hidden).toBe(true);
  });

  it('SL#2 Key 绝不回显：DOM 全树无明文，输入框是 password + 掩码 placeholder', () => {
    const fake = makeFakeLlm();
    const root = mountWith(fake);

    expect(ui(root, 'llm-group').hidden).toBe(false);
    const keyInput = ui(root, 'llm-key') as HTMLInputElement;
    expect(keyInput.getAttribute('type')).toBe('password');
    expect(keyInput.value).toBe(''); // 已存 Key 绝不回填输入框
    expect(keyInput.placeholder).toBe(maskKey(STORED_KEY)); // 只能是"前 3 后 4"的指纹

    expect(domLeaks(root, STORED_KEY)).toEqual([]);
    // 反向自检：掩码本身确实在屏上（否则"不含明文"这条是空转的）
    expect(keyInput.placeholder).toContain('sk-');
    expect(keyInput.placeholder).not.toBe(STORED_KEY);
    expect(domLeaks(root, 'sk-')).toContain('INPUT[placeholder]');
  });

  it('SL#3 保存时输入框留空 ⇒ 保留原 Key；填了新 Key ⇒ 替换且保存后输入框清空', () => {
    const fake = makeFakeLlm();
    const root = mountWith(fake);

    (ui(root, 'llm-base') as HTMLInputElement).value = 'https://gateway.example/v1';
    (ui(root, 'llm-model') as HTMLInputElement).value = 'qwen-plus';
    click(ui(root, 'llm-save'));

    expect(fake.saved).toEqual([
      { baseUrl: 'https://gateway.example/v1', apiKey: STORED_KEY, model: 'qwen-plus' },
    ]);
    expect(fake.cfg().apiKey).toBe(STORED_KEY); // 留空 ≠ 抹掉
    expect(ui(root, 'toast').textContent).toBe('AI 设置已保存。');

    const keyInput = ui(root, 'llm-key') as HTMLInputElement;
    keyInput.value = 'sk-brand-new-key-9876';
    click(ui(root, 'llm-save'));
    expect(fake.cfg().apiKey).toBe('sk-brand-new-key-9876');
    // 保存后输入框清空、placeholder 换成新掩码 ⇒ DOM 里连刚敲进去的明文也不留
    expect(keyInput.value).toBe('');
    expect(keyInput.placeholder).toBe(maskKey('sk-brand-new-key-9876'));
    expect(domLeaks(root, 'sk-brand-new-key-9876')).toEqual([]);
  });

  it('SL#4 预设只填地址与模型：不落盘、不碰已敲的 Key；「自定义」清空两者', () => {
    const fake = makeFakeLlm();
    const root = mountWith(fake);
    const keyInput = ui(root, 'llm-key') as HTMLInputElement;
    keyInput.value = 'typed-not-saved-yet';

    click(root.querySelector('[data-llm-preset="dashscope"]') as HTMLElement);
    expect((ui(root, 'llm-base') as HTMLInputElement).value).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect((ui(root, 'llm-model') as HTMLInputElement).value).toBe('qwen-plus');
    expect(keyInput.value).toBe('typed-not-saved-yet'); // 换服务商不该抹掉玩家敲了一半的 Key
    expect(fake.saved).toEqual([]); // 预设只是填充，不写存储

    click(root.querySelector('[data-llm-preset="custom"]') as HTMLElement);
    expect((ui(root, 'llm-base') as HTMLInputElement).value).toBe('');
    expect((ui(root, 'llm-model') as HTMLInputElement).value).toBe('');
    expect(keyInput.value).toBe('typed-not-saved-yet'); // 自定义同样不动 Key
  });

  it('SL#5「清除 Key」：load() 的 Key 变空、地址与模型保留、placeholder 回「（未设置）」', () => {
    const fake = makeFakeLlm();
    const root = mountWith(fake);

    click(ui(root, 'llm-clear'));
    expect(fake.cfg()).toEqual({ baseUrl: BASE.baseUrl, apiKey: '', model: BASE.model });
    expect((ui(root, 'llm-key') as HTMLInputElement).placeholder).toBe('（未设置）');
    expect(ui(root, 'toast').textContent).toBe('已清除。');
    expect(domLeaks(root, STORED_KEY)).toEqual([]); // 清完更不该有明文
  });

  it('SL#6「测试连接」：成功「连接正常。」/ 失败原样上屏 reason；测的是输入框里的配置', async () => {
    const fake = makeFakeLlm();
    const root = mountWith(fake);
    (ui(root, 'llm-base') as HTMLInputElement).value = 'https://gateway.example/v1';
    (ui(root, 'llm-key') as HTMLInputElement).value = 'sk-typed-in-box';
    (ui(root, 'llm-model') as HTMLInputElement).value = 'my-model';

    click(ui(root, 'llm-test'));
    await flushMicrotasks();
    expect(fake.tested).toEqual([{ baseUrl: 'https://gateway.example/v1', apiKey: 'sk-typed-in-box', model: 'my-model' }]);
    expect(ui(root, 'toast').textContent).toBe('连接正常。');

    fake.setTestResult({ ok: false, reason: 'Key 不对或没有权限（401/403）——去设置页检查一下。' });
    click(ui(root, 'llm-test'));
    await flushMicrotasks();
    expect(ui(root, 'toast').textContent).toBe('Key 不对或没有权限（401/403）——去设置页检查一下。');
  });

  it('SL#6b 测试在途时按钮禁用：连点两次只发一次请求（防重试风暴）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = makeFakeLlm(BASE, { testImpl: () => gate.then(() => ({ ok: true as const, text: 'pong' })) });
    const root = mountWith(fake);

    click(ui(root, 'llm-test'));
    expect((ui(root, 'llm-test') as HTMLButtonElement).disabled).toBe(true);
    click(ui(root, 'llm-test'));
    await flushMicrotasks();
    expect(fake.tested).toHaveLength(1);

    (release as unknown as () => void)();
    await flushMicrotasks();
    expect((ui(root, 'llm-test') as HTMLButtonElement).disabled).toBe(false);
    expect(ui(root, 'toast').textContent).toBe('连接正常。');
  });

  it('SL#7 文案如实：本地浏览器、不进备份、换设备要重填（LS#6 的屏上兑现）', () => {
    const fake = makeFakeLlm();
    const root = mountWith(fake);
    const text = ui(root, 'llm-group').textContent ?? '';
    expect(text).toContain('不进备份');
    expect(text).toContain('换设备');
    expect(text).toContain('这台设备');
    // 也要说清"留空保存 = 不改 Key"，否则玩家会以为空框就是删 Key
    expect(text).toContain('留空');
    expect(all(root, '[data-ui="llm-clear"]')).toHaveLength(1);
  });
});
