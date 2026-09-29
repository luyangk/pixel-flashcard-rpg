// @vitest-environment happy-dom
/**
 * tests/ui/settings.update.test.ts —— 设置页「关于」分组（D54）。
 *
 * 判别力：
 * - SU#1 口齐 ⇒ 显示当前版本 + 「检查更新」；缺口 ⇒ **整组收起**（不显示点了没反应的入口）；
 * - SU#2 检查发现新版 ⇒ 显示新版本号并露出「立即更新」；点它才调 `apply`（**绝不自动刷新**）；
 * - SU#3 已是最新 ⇒ 说"已是最新"，**不露**「立即更新」（露了就等于给一个会白刷的按钮）；
 * - SU#4 检查期间按钮禁用（防连点），结束后恢复。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mountSettings } from '../../src/ui/settings';
import { click, flushMicrotasks, makeCtrl, makeSave, makeSnap, makeRoot, ui } from './support';

afterEach(() => {
  document.body.replaceChildren();
});

type PwaDeps = NonNullable<NonNullable<Parameters<typeof mountSettings>[2]>['pwa']>;

function setup(
  pwa: PwaDeps | undefined,
  over: { check?: () => Promise<{ status: 'updated' | 'current' | 'unsupported'; build: string | null; message: string }> } = {},
) {
  const root = makeRoot();
  const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave() }));
  const applied: number[] = [];
  mountSettings(root, ctrl, {
    toastMs: 0,
    ...(pwa === undefined
      ? {}
      : {
          pwa: {
            version: pwa.version,
            check: over.check ?? pwa.check,
            apply: () => void applied.push(1),
          },
        }),
  });
  return { root, applied };
}

describe('mountSettings —— 关于（版本与更新，D54）', () => {
  it('SU#1 口齐 ⇒ 显示当前版本；缺 pwa 口 ⇒ 整组收起', () => {
    const shown = setup({
      version: () => '1790651470233',
      check: () => Promise.resolve({ status: 'current', build: '1790651470233', message: '已是最新。' }),
      apply: () => undefined,
    });
    expect(ui(shown.root, 'pwa-group').hidden).toBe(false);
    expect(ui(shown.root, 'pwa-version').textContent).toContain('1790651470233');
    // 没查过之前不该有「立即更新」（否则它会白刷一次）
    expect(ui(shown.root, 'pwa-apply').hidden).toBe(true);

    const bare = setup(undefined);
    expect(ui(bare.root, 'pwa-group').hidden).toBe(true);
  });

  it('SU#2 发现新版 ⇒ 显示新版本号 + 露出「立即更新」；点了才 apply', async () => {
    const { root, applied } = setup(
      {
        version: () => '111',
        check: () => Promise.resolve({ status: 'current', build: '111', message: '已是最新。' }),
        apply: () => undefined,
      },
      { check: () => Promise.resolve({ status: 'updated', build: '222', message: '发现新版本（222）。' }) },
    );
    click(ui(root, 'pwa-check'));
    expect((ui(root, 'pwa-check') as HTMLButtonElement).disabled).toBe(true); // 在途禁用
    await flushMicrotasks();

    expect(ui(root, 'pwa-status').textContent).toContain('222');
    expect(ui(root, 'pwa-apply').hidden).toBe(false);
    expect(applied).toEqual([]); // **自动刷新是禁止的**：打一半的一局不能被刷掉

    click(ui(root, 'pwa-apply'));
    expect(applied).toEqual([1]);
  });

  it('SU#3 已是最新 ⇒ 说清楚，且不露「立即更新」', async () => {
    const { root } = setup({
      version: () => '111',
      check: () => Promise.resolve({ status: 'current', build: '111', message: '已是最新（111）。' }),
      apply: () => undefined,
    });
    click(ui(root, 'pwa-check'));
    await flushMicrotasks();
    expect(ui(root, 'pwa-status').textContent).toContain('已是最新');
    expect(ui(root, 'pwa-apply').hidden).toBe(true);
    expect((ui(root, 'pwa-check') as HTMLButtonElement).disabled).toBe(false);
  });

  it('SU#4 环境不支持 SW ⇒ 如实说，且「立即更新」不露', async () => {
    const { root } = setup({
      version: () => 'dev',
      check: () => Promise.resolve({ status: 'unsupported', build: null, message: '这个环境没有离线缓存，不用更新。' }),
      apply: () => undefined,
    });
    click(ui(root, 'pwa-check'));
    await flushMicrotasks();
    expect(ui(root, 'pwa-status').textContent).toContain('没有离线缓存');
    expect(ui(root, 'pwa-apply').hidden).toBe(true);
  });
});

/* ------------------------------------------------------------------ D57：玩家身份 */

/**
 * 判别力：
 * - SU#P1 有 profile 口才显示「玩家」组；缺口整组收起；
 * - SU#P2 改昵称 ⇒ 写口收到新昵称**且 ID 原样带着**（写丢了 ID 就没法对比了）；
 * - SU#P3 ID 只读展示（屏上不给可改入口）。
 */
describe('mountSettings —— 玩家身份（D57）', () => {
  function rig(profile: { nickname: string; userId: string } | null) {
    const root = makeRoot();
    const ctrl = makeCtrl(makeSnap({ screen: 'menu', save: makeSave() }));
    const saves: Array<{ nickname: string; userId: string }> = [];
    mountSettings(root, ctrl, {
      toastMs: 0,
      ...(profile === null
        ? {}
        : {
            profile: {
              load: () => ({ ...profile }),
              save: (next: { nickname: string; userId: string }) => {
                saves.push({ ...next });
                return true;
              },
            },
          }),
    });
    return { root, saves };
  }

  it('SU#P1 有口 ⇒ 显示当前昵称与 ID；缺口 ⇒ 整组收起', () => {
    const shown = rig({ nickname: '阿竹', userId: 'u-deadbeef' });
    expect(ui(shown.root, 'profile-group').hidden).toBe(false);
    expect((ui(shown.root, 'profile-nickname') as HTMLInputElement).value).toBe('阿竹');
    expect(ui(shown.root, 'profile-id').textContent).toContain('u-deadbeef');

    const bare = rig(null);
    expect(ui(bare.root, 'profile-group').hidden).toBe(true);
  });

  it('SU#P2 改昵称：写口收到新昵称，且 ID 原样带着', () => {
    const { root, saves } = rig({ nickname: '阿竹', userId: 'u-deadbeef' });
    (ui(root, 'profile-nickname') as HTMLInputElement).value = '竹影';
    click(ui(root, 'profile-save'));
    expect(saves).toEqual([{ nickname: '竹影', userId: 'u-deadbeef' }]);
    expect(ui(root, 'toast').textContent).toContain('昵称');
  });

  it('SU#P3 ID 只读：屏上没有第二块输入框改它', () => {
    const { root } = rig({ nickname: '阿竹', userId: 'u-deadbeef' });
    // 全屏只有一个 input 带 profile-nickname；ID 只以文本出现
    expect(root.querySelectorAll('[data-ui="profile-nickname"]')).toHaveLength(1);
    expect(root.querySelector('[data-ui="profile-id"]')?.tagName.toLowerCase()).toBe('p');
  });
});
