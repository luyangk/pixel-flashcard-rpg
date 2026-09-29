// @vitest-environment happy-dom
/**
 * tests/platform/profileStore.test.ts —— 玩家身份（D57）。
 *
 * 判别力：
 * - PF#1 没写过 ⇒ 空身份；写进去读回来一致（昵称按码点截断到 12）；
 * - PF#2 坏 JSON / 坏形状 / 坏 ID 形状一律净化，**永不抛**；
 * - PF#3 `ensureProfile` **只生成一次** ID 并落盘（每次刷新换 ID ⇒ 将来对比无从谈起）；
 * - PF#4 存储不可用 ⇒ 读回默认、写回 false；
 * - PF#5 绝不碰 Key（第四个白名单归属要有自己的守卫）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NICKNAME,
  NICKNAME_MAX,
  PROFILE_STORAGE_KEY,
  clearProfile,
  ensureProfile,
  loadProfile,
  sanitizeProfile,
  saveProfile,
} from '../../src/platform/profileStore';

afterEach(() => {
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe('platform/profileStore —— 玩家身份（D57）', () => {
  it('PF#1 空身份；写入读回一致；昵称按码点截断', () => {
    expect(loadProfile()).toEqual({ nickname: '', userId: '' });
    expect(saveProfile({ nickname: '阿竹', userId: 'u-deadbeef' })).toBe(true);
    expect(loadProfile()).toEqual({ nickname: '阿竹', userId: 'u-deadbeef' });

    expect(sanitizeProfile({ nickname: '字'.repeat(40), userId: 'u-12345678' }).nickname).toHaveLength(NICKNAME_MAX);
  });

  it('PF#2 坏 JSON / 坏形状 / 坏 ID ⇒ 净化，不抛', () => {
    localStorage.setItem(PROFILE_STORAGE_KEY, '{oops');
    expect(loadProfile()).toEqual({ nickname: '', userId: '' });
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(['x']));
    expect(loadProfile()).toEqual({ nickname: '', userId: '' });
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ nickname: 42, userId: 'evil' }));
    expect(loadProfile()).toEqual({ nickname: '', userId: '' }); // ID 形状不对 ⇒ 当作没有
  });

  it('PF#3 ensureProfile 只生成一次 ID 并落盘', () => {
    let seq = 0;
    const newId = (): string => `u-${String(++seq).padStart(8, '0')}`;
    const first = ensureProfile(newId);
    expect(first.userId).toBe('u-00000001');
    const second = ensureProfile(newId);
    expect(second.userId).toBe('u-00000001'); // 不再生成
    expect(seq).toBe(1);
    // 起过昵称之后再 ensure，昵称要保住
    saveProfile({ nickname: '阿竹', userId: first.userId });
    expect(ensureProfile(newId).nickname).toBe('阿竹');
  });

  it('PF#4 存储不可用（隐私模式 / 配额满）⇒ 默认与 false，都不抛', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('隐私模式');
      },
    });
    try {
      expect(() => loadProfile()).not.toThrow();
      expect(loadProfile()).toEqual({ nickname: '', userId: '' });
      expect(saveProfile({ nickname: 'x', userId: 'u-00000000' })).toBe(false);
      expect(() => clearProfile()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }

    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(saveProfile({ nickname: 'x', userId: 'u-00000000' })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('PF#5 存储键是登记的第四个归属；这个模块绝不碰 Key', async () => {
    expect(PROFILE_STORAGE_KEY).toBe('zx-xia.profile.v1');
    expect(DEFAULT_NICKNAME).toBe('无名侠客');
    const raw = (await import('node:fs')).readFileSync('src/platform/profileStore.ts', 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['apiKey', 'Authorization', 'Bearer', 'LLM_STORAGE_KEY']) {
      expect(code, `profileStore 不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});
