// @vitest-environment happy-dom
/**
 * tests/ui/prologue.test.ts —— Plan 4 · T6：序章演出（LORE §5.1 八屏 + 跳过）。
 *
 * 环境：per-file `@vitest-environment happy-dom`（全局 environment 仍是 'node'）。
 *
 * 覆盖面（brief Step 1 + 交付 1/5）：
 * - 逐屏点击推进：8 屏顺序、进度、插画与旁白同步；第 8 屏点完 → onDone **恰一次**；
 * - 右上「跳过」：onDone 恰一次（点击冒泡不得造成第二次），且点后组件已卸载；
 * - 文案权威：prologue.json 的 8 屏旁白与 docs/LORE.md §5.1 **逐字一致**（读原文核对，
 *   不是把 JSON 读回来自己比自己）；插画占位文件存在且是 64×64 灰阶 PNG（T9 原地换正稿）；
 * - 落盘链路（判别力钉）：跳过后经**真实** gameController 的 intent 把
 *   `settings.story.prologueSeen` 写成 true 并落盘 —— T3 的 no-op 实现下此断言必红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '@core/rng';
import { createMemoryStorage } from '@platform/memoryStore';
import prologueJson from '../../assets/narrative/prologue.json';
import { createCoordinator } from '../../src/app/persist';
import { createGameController } from '../../src/app/gameController';
import { needsPrologue } from '../../src/app/storyState';
import { mountPrologue, type PrologueScene } from '../../src/ui/prologue';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENES: readonly PrologueScene[] = prologueJson.scenes;

/** LORE §5.1 的八屏旁白（逐字抄自 docs/LORE.md，评审以此为据；第 8 屏是标题屏）。 */
const LORE_TEXTS = [
  '知识不再入脑，云端即是记忆。',
  '荒原之上，混沌睁开第一只眼。',
  '那日之后，没背进脑子的东西，都没了。',
  '云端靠不住了。',
  '尚有古法：以脑为库，以记为剑。',
  '背下来的，才是你的。',
  '去吧。夺回人间的知识。',
  '知识侠客',
] as const;

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

function ui(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector(`[data-ui="${name}"]`);
  if (!el) throw new Error(`缺少 data-ui=${name}`);
  return el as HTMLElement;
}

afterEach(() => {
  document.body.replaceChildren();
});

/* ------------------------------------------------------------------ 逐屏推进 */

describe('mountPrologue —— 逐屏演出', () => {
  it('P#1 挂载即第 1 屏：旁白/插画/进度/跳过按钮齐备，跳过在右上', () => {
    const root = makeRoot();
    mountPrologue(root, SCENES, () => {});
    expect(ui(root, 'prologue-text').textContent).toBe(SCENES[0].text);
    expect((ui(root, 'prologue-art') as HTMLImageElement).getAttribute('src')).toBe(SCENES[0].art);
    expect(ui(root, 'prologue-progress').textContent).toBe('1 / 8');
    const skip = ui(root, 'prologue-skip');
    expect(skip.textContent).toBe('跳过');
    // "右上"是可判别的 DOM 事实（绝对定位 + top/right 都有值），不是靠 CSS 文件碰运气
    expect(skip.style.position).toBe('absolute');
    expect(skip.style.top).not.toBe('');
    expect(skip.style.right).not.toBe('');
    // 插画不参与命中测试：真机长按/拖动会吞掉包裹层的 click（T6 评审 Minor #2）
    const art = ui(root, 'prologue-art');
    expect(art.getAttribute('draggable')).toBe('false');
    expect(art.style.pointerEvents).toBe('none');
  });

  it('P#2 点击逐屏推进：8 屏顺序不乱；第 8 屏点完 onDone 恰一次且 DOM 清空', () => {
    const root = makeRoot();
    let done = 0;
    mountPrologue(root, SCENES, () => {
      done += 1;
    });
    const screen = ui(root, 'prologue-screen');

    for (let i = 0; i < SCENES.length - 1; i++) {
      expect(ui(root, 'prologue-text').textContent).toBe(SCENES[i].text);
      expect((ui(root, 'prologue-art') as HTMLImageElement).getAttribute('src')).toBe(SCENES[i].art);
      expect(ui(root, 'prologue-progress').textContent).toBe(`${i + 1} / 8`);
      expect(screen.getAttribute('data-scene')).toBe('body'); // 叙事屏
      expect(done).toBe(0); // 未到末屏不得提前收尾
      screen.click();
    }
    // 末屏（标题屏）：hint 换成"开始"话术，data-scene 给 CSS 一个标题屏钩子
    expect(ui(root, 'prologue-text').textContent).toBe(SCENES[7].text);
    expect(ui(root, 'prologue-hint').textContent).toBe('轻触开始');
    expect(screen.getAttribute('data-scene')).toBe('title');
    expect(done).toBe(0);
    screen.click();

    expect(done).toBe(1);
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull(); // 收尾即卸载
    screen.click(); // 卸载后再点也不得重复回调
    expect(done).toBe(1);
  });

  it('P#3 「跳过」：onDone 恰一次（冒泡不得造成第二次），点后组件已卸载', () => {
    const root = makeRoot();
    let done = 0;
    mountPrologue(root, SCENES, () => {
      done += 1;
    });
    ui(root, 'prologue-skip').click();
    expect(done).toBe(1);
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull();
    expect(root.querySelector('[data-ui="prologue-skip"]')).toBeNull();
  });

  it('P#4 空屏列表：立即 onDone（不空转），句柄可安全 unmount', () => {
    const root = makeRoot();
    let done = 0;
    const handle = mountPrologue(root, [], () => {
      done += 1;
    });
    expect(done).toBe(1);
    expect(root.querySelector('[data-ui="prologue-screen"]')).toBeNull();
    handle.unmount(); // 幂等
    expect(done).toBe(1);
  });

  it('P#5 非末屏点击后，hint 仍是"轻触继续"；进度随屏更新', () => {
    const root = makeRoot();
    mountPrologue(root, SCENES, () => {});
    expect(ui(root, 'prologue-hint').textContent).toBe('轻触继续');
    ui(root, 'prologue-screen').click();
    expect(ui(root, 'prologue-hint').textContent).toBe('轻触继续');
    expect(ui(root, 'prologue-progress').textContent).toBe('2 / 8');
  });
});

/* ------------------------------------------------------------------ 文案权威（LORE §5.1） */

describe('assets/narrative/prologue.json —— 与 LORE §5.1 逐字一致', () => {
  it('PJ#1 恰 8 屏、每屏有非空 {text, art}、art 互不重复', () => {
    expect(SCENES).toHaveLength(8);
    for (const s of SCENES) {
      expect(typeof s.text).toBe('string');
      expect(s.text.length).toBeGreaterThan(0);
      expect(typeof s.art).toBe('string');
      expect(s.art.length).toBeGreaterThan(0);
    }
    expect(new Set(SCENES.map((s) => s.art)).size).toBe(8);
  });

  it('PJ#2 八屏旁白逐字等于 LORE §5.1 的八句', () => {
    expect(SCENES.map((s) => s.text)).toEqual([...LORE_TEXTS]);
  });

  it('PJ#3 旁白确在 docs/LORE.md 原文里（含引号形式）：改 LORE 或改 JSON 单边都会红', () => {
    const lore = readFileSync(join(REPO_ROOT, 'docs/LORE.md'), 'utf8');
    for (const text of LORE_TEXTS.slice(0, 7)) {
      expect(lore, `LORE 缺旁白引文：${text}`).toContain(`*"${text}"*`);
    }
    expect(lore).toContain('《知识侠客》'); // 第 8 屏：标题屏
  });

  it('PJ#4 插画占位是存在的 64×64 灰阶 PNG（T9 原地换正稿）', () => {
    for (const s of SCENES) {
      const file = join(REPO_ROOT, s.art);
      expect(existsSync(file), `缺占位插画：${s.art}`).toBe(true);
      const buf = readFileSync(file);
      expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG 签名
      expect(buf.readUInt32BE(16)).toBe(64);
      expect(buf.readUInt32BE(20)).toBe(64);
      expect(buf[25]).toBe(0); // color type 0 = 灰度
    }
  });
});

/* ------------------------------------------------------------------ 落盘链路（真实控制器） */

describe('序章落盘 —— 经 ctrl intent 记 prologueSeen（判别力钉）', () => {
  async function makeSession() {
    const store = createMemoryStorage();
    const coord = await createCoordinator(store, { now: () => 0 });
    const ctrl = await createGameController({
      coord,
      rng: mulberry32(3),
      now: () => 0,
      tzOffsetMin: 480,
    });
    return { store, coord, ctrl };
  }

  it('PL#1 跳过 → seenPrologue intent → story.prologueSeen 落盘为 true、屏回 menu', async () => {
    const { store, coord, ctrl } = await makeSession();
    expect(needsPrologue(coord.snapshot())).toBe(true); // 新档：序章没看过

    const root = makeRoot();
    let dispatched: Promise<void> | null = null;
    mountPrologue(root, SCENES, () => {
      dispatched = ctrl.intent({ type: 'seenPrologue' }); // 宿主契约：onDone 即派发 intent
    });
    ui(root, 'prologue-skip').click();
    await dispatched; // intent 的 await 链跑完（mutate 串行队列落定）才能断言落盘

    expect(ctrl.snapshot().screen).toBe('menu');
    expect(ctrl.snapshot().save.settings.story.prologueSeen).toBe(true); // T3 no-op 实现下必红
    expect(needsPrologue(ctrl.snapshot().save)).toBe(false);

    await coord.flush();
    const loaded = await store.load();
    expect(loaded?.settings.story).toEqual({ prologueSeen: true, beatIndex: 0 });
  });

  it('PL#2 八屏看完 → 同样落盘 prologueSeen=true（跳看与看完同待遇）', async () => {
    const { store, coord, ctrl } = await makeSession();
    const root = makeRoot();
    let dispatched: Promise<void> | null = null;
    mountPrologue(root, SCENES, () => {
      dispatched = ctrl.intent({ type: 'skipPrologue' });
    });
    for (let i = 0; i < SCENES.length; i++) ui(root, 'prologue-screen').click();
    await dispatched;

    await coord.flush();
    const loaded = await store.load();
    expect(loaded?.settings.story.prologueSeen).toBe(true);
    expect(ctrl.snapshot().screen).toBe('menu');
  });
});
