/**
 * tests/tooling/llmSafety.test.ts —— Plan 5 · T6：AI 面的**四条机器不变量**。
 *
 * 为什么用"扫源码 + 剥注释"而不是只靠评审：Key 泄漏与数据外流都属于**一次疏忽就长期存在**
 * 的问题，而它们都能被几条结构性事实挡死。这四条是本计划的安全承诺的机器化形态
 * （PRD D38）：
 *
 * 1. **Key 不进存档**：`src/core/**`（存档形状的定义处）与 `src/app/**`（写存档的层）
 *    里不得出现 `apiKey`——它一旦出现在这两层，就迟早会被写进 `SaveFile` 并被导出。
 * 2. **网络只在 platform**：`core/app/ui` 都不得出现 `fetch(` / `XMLHttpRequest`。
 *    （UI 直连外部服务会让"Key 只在一处进请求头"这条承诺失效，也让测试无法离线跑。）
 * 3. **Key 只经 llmConfig 读写**：`localStorage` 只出现在 `src/platform/**`。
 * 4. **UI 不回显 Key**：设置屏必须用 `type: 'password'` 且用 `maskKey()` 展示已存值。
 *
 * 每条都配了"有牙"的自检：把一个真实违规样例喂给同一套判据，必须命中。
 * 判据只读**代码**（剥掉注释与字符串字面量），否则文件头里"我不 import persist"这种话
 * 会造成假红——本仓已有先例（`check-core-purity` 的注释剥离器）。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../scripts/check-core-purity';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function collectTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collectTs(p, acc);
    else if (e.endsWith('.ts') || e.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

/**
 * 读一组**路径**下全部 .ts 的代码形态（剥注释与字符串）。
 *
 * 路径既可以是目录（递归），也可以是单个文件——**根文件必须能单独点名**
 * （安全评审判 I-4：首版只枚举 `src/core|app|ui|stage|platform` 这些子目录，
 * 于是 `src/main.ts`（入口装配）根本不在任何一条判据里；在那里顺手加一个 fetch
 * 或 localStorage 都不会被发现）。
 */
function codeOf(rels: readonly string[]): Array<{ file: string; code: string; raw: string }> {
  const out: Array<{ file: string; code: string; raw: string }> = [];
  for (const rel of rels) {
    const p = join(ROOT, rel);
    const files = statSync(p).isDirectory() ? collectTs(p) : [p];
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf8');
      out.push({ file: relative(ROOT, abs), code: stripComments(raw), raw });
    }
  }
  return out;
}

/** 命中检查（返回违规文件清单；空 = 干净）。 */
function hits(files: Array<{ file: string; code: string }>, needle: string): string[] {
  return files.filter((f) => f.code.includes(needle)).map((f) => f.file);
}

/** 按正则命中（用于"标识符级"判据，例如 fetch 这个**词**而不是 `fetch(` 这个写法）。 */
function regexHits(files: Array<{ file: string; code: string }>, re: RegExp): string[] {
  return files.filter((f) => re.test(f.code)).map((f) => f.file);
}

describe('LLM 安全不变量', () => {
  it('LS#1 Key 不进存档：core（存档形状）与 app（写存档层）里没有 apiKey 的代码引用', () => {
    const files = codeOf(['src/core', 'src/app', 'src/main.ts']);
    expect(files.length).toBeGreaterThan(10);
    expect(hits(files, 'apiKey')).toEqual([]);
    // 也不该出现"把 Key 塞进 settings/save"这类旁路命名的痕迹
    expect(hits(files, 'llmKey')).toEqual([]);
    expect(hits(files, 'api_key')).toEqual([]);
  });

  it('LS#2 网络只在 platform：core/app/ui 里没有 fetch / XMLHttpRequest 这类网络标识符', () => {
    const files = codeOf(['src/core', 'src/app', 'src/ui', 'src/stage', 'src/main.ts']);
    expect(files.length).toBeGreaterThan(20);
    // 按**标识符**判（`fetch(` 这种字面写法挡不住 `typeof fetch` / `fetchImpl` 之外的别名）
    expect(regexHits(files, /\bfetch\b/)).toEqual([]);
    expect(hits(files, 'XMLHttpRequest')).toEqual([]);
    expect(hits(files, 'sendBeacon')).toEqual([]);
    expect(hits(files, 'WebSocket')).toEqual([]);

    // platform 里确实有（否则这条判据是空转的：网络总得有个出口）
    expect(regexHits(codeOf(['src/platform']), /\bfetch\b/).length).toBeGreaterThan(0);
  });

  it('LS#3 Key 只经 llmConfig：localStorage 只出现在 platform（且只在两个已登记模块里）', () => {
    const files = codeOf(['src/core', 'src/app', 'src/ui', 'src/stage', 'src/main.ts']);
    expect(hits(files, 'localStorage')).toEqual([]);
    expect(hits(files, 'sessionStorage')).toEqual([]);

    // `localStorage` 的归属要**逐字列出**（多一个必须显式登记）：
    // ① llmConfig.ts = 玩家的 LLM Key；② inboxStore.ts = 待读清单（链接/标题/粘来的正文）；
    // ③ sourceStore.ts = 采新卡的来源库（玩家自己加/删的源；D53 —— 同样是"本机工具配置"，
    //    不进存档、不进备份、不存 Key）；
    // ④ profileStore.ts = 玩家身份（昵称 + 短 ID；D57 —— 它不是游戏进度，且该活过"重置存档"，
    //    与 AI Key 同款口径）。
    const platformHits = hits(codeOf(['src/platform']), 'localStorage');
    expect(platformHits).toEqual([
      'src/platform/inboxStore.ts',
      'src/platform/llmConfig.ts',
      'src/platform/profileStore.ts',
      'src/platform/sourceStore.ts',
    ]);
  });

  it('LS#3b 待读清单里绝不放 Key：inboxStore 不碰 apiKey / Authorization / LLM 存储键', () => {
    const code = stripComments(readFileSync(join(ROOT, 'src/platform/inboxStore.ts'), 'utf8'));
    for (const forbidden of ['apiKey', 'Authorization', 'Bearer', 'zx-xia.llm', 'LLM_STORAGE_KEY']) {
      expect(code, `inboxStore 不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('LS#4 UI 不回显 Key：设置屏用 password 输入框 + maskKey 展示已存值，且**不自己读写 Key**', () => {
    const settings = readFileSync(join(ROOT, 'src/ui/settings.ts'), 'utf8');
    expect(settings).toContain('maskKey('); // 已存值只能以掩码形态出现
    expect(/type:\s*'password'/.test(settings)).toBe(true);
    // Key 输入框必须挂在这个 data-ui 上（测试与不变量都依赖它作为唯一入口）
    expect(settings).toContain("'llm-key'");
    // 明文 Key 不得被写进展示路径
    const code = stripComments(settings);
    expect(code).not.toMatch(/textContent\s*=\s*[A-Za-z_$][\w$]*\.apiKey/);

    // 【口径裁定 R-P5-llm-a】设置屏**可以** import 纯格式化函数 `maskKey`（无副作用、不碰 Key），
    // 但**不得**自己 import 读/写/清除 Key 的函数，也不得直接发网络请求——key 的读写只能经注入的
    // `deps.llm.{load,save,clear,test}`（宿主接 platform）。这条比"UI 不许 import 平台 LLM 模块"
    // 更精确：前者会把无害的纯函数也禁掉，后者才是真正要守的边界。
    for (const forbidden of ['loadLlmConfig', 'saveLlmConfig', 'clearLlmConfig', 'LLM_STORAGE_KEY', 'llmHttp', 'chat(']) {
      expect(code, `settings.ts 不该直接使用 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('LS#4b Service Worker 不碰 Key：sw.js 里没有 apiKey/localStorage（它允许 fetch，那是它的职责）', () => {
    const sw = readFileSync(join(ROOT, 'src/sw.js'), 'utf8');
    const code = stripComments(sw);
    expect(code).not.toContain('apiKey');
    expect(code).not.toContain('localStorage');
    expect(code).not.toContain('Authorization');
    // 显式登记豁免：SW 必须用 fetch 才能做离线缓存——所以"网络只在 platform"这条不适用于它，
    // 但"不碰密钥"这条适用于所有文件。写成断言而不是注释，免得下次有人以为漏扫了。
    expect(/\bfetch\b/.test(code)).toBe(true);
  });

  it('LS#5 判据有牙：真实违规样例会被同一套判据命中（不是空转的断言）', () => {
    const evil = [
      { file: 'src/app/evil.ts', code: stripComments("export const k = save.settings.apiKey;") },
      { file: 'src/ui/evil.ts', code: stripComments("const r = await fetch('https://api.example.com');") },
    ];
    expect(hits(evil, 'apiKey')).toEqual(['src/app/evil.ts']);
    expect(regexHits(evil, /\bfetch\b/)).toEqual(['src/ui/evil.ts']);
    // 反之：注释与字符串里的字样不该命中（这就是必须剥注释的原因）
    const innocent = [{ file: 'x.ts', code: stripComments("// apiKey 不该出现在代码里\nconst s = 'fetch( 只是文案';") }];
    expect(hits(innocent, 'apiKey')).toEqual([]);
    expect(regexHits(innocent, /\bfetch\b/)).toEqual([]);
  });

  it('LS#7 人审闸门（结构判据）：写口只出现在"确认"函数体里，生成函数体里不许出现写口', () => {
    /**
     * 安全评审判 M-3：首版此处只是 `toContain('加入卡库')` 这类**字符串存在性**检查——
     * 把"生成后自动落库"真的做出来它照样绿（评审实测 M7b 全绿）。现在改为**函数边界**判据：
     * 抽出生成函数体与确认函数体，断言写口只出现在后者。
     * 真正的人审保证仍由行为用例守（DA#2/DA#4/PL#2/CX#LLM2…），这条只防结构性回归。
     */
    const bodyOf = (src: string, fnName: string): string => {
      const start = src.indexOf(`function ${fnName}(`);
      expect(start, `${fnName} 不存在`).toBeGreaterThanOrEqual(0);
      const rest = src.slice(start + 1);
      const nextIdx = rest.search(/\n  (?:async )?function /);
      const body = nextIdx < 0 ? rest : rest.slice(0, nextIdx);
      // 必须剥注释：下一个函数的 JSDoc 会提到写口名字（例如"`deps.setEgg` → …"），
      // 不剥就会把注释命中当真（首版就是这么假红了一次）
      return stripComments(body);
    };

    // 判据两层：①生成体里不出现写口；②生成体里也不去**调用确认流程**
    // （只查 ① 会漏掉"生成完自动点确认"这种实现——评审 M7b 的形态，我实测过一次）
    const decks = readFileSync(join(ROOT, 'src/ui/decks.ts'), 'utf8');
    const authorRun = bodyOf(decks, 'onAuthorRun');
    expect(authorRun).not.toContain('deps.addCard');
    expect(authorRun).not.toContain('onAuthorConfirm');
    expect(bodyOf(decks, 'onAuthorConfirm')).toContain('deps.addCard');

    const prepare = readFileSync(join(ROOT, 'src/ui/prepare.ts'), 'utf8');
    const askNames = bodyOf(prepare, 'onAskNames');
    expect(askNames).not.toContain('deps.setBossName');
    expect(askNames).not.toContain('confirmBossName');
    expect(bodyOf(prepare, 'confirmBossName')).toContain('deps.setBossName');

    const codex = readFileSync(join(ROOT, 'src/ui/codex.ts'), 'utf8');
    const writeEgg = bodyOf(codex, 'onWriteEgg');
    expect(writeEgg).not.toContain('deps.setEgg');
    expect(writeEgg).not.toContain('onAcceptEgg');
    expect(bodyOf(codex, 'onAcceptEgg')).toContain('deps.setEgg');
  });

  it('LS#6 计划文档与 UI 文案都如实说明 Key 的存放与代价（本地明文 + 不进备份）', () => {
    const plan = readFileSync(join(ROOT, 'docs/superpowers/plans/2026-09-28-plan5-llm.md'), 'utf8');
    expect(plan).toContain('localStorage');
    expect(plan).toContain('绝不进');
    const settings = readFileSync(join(ROOT, 'src/ui/settings.ts'), 'utf8');
    expect(settings).toContain('不进备份');
    expect(settings).toContain('换设备');
  });
});
