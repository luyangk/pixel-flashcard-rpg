// @vitest-environment happy-dom
/**
 * tests/platform/presetOfferStore.test.ts —— "送过哪些预置领域"的本机记录（D66）。
 *
 * 判别力：
 * - PO#1 空记录 ⇒ 空数组；写入读取一致；
 * - PO#2 坏 JSON / 坏形状 / 脏 id 一律净化，**永不抛**（最坏是重送一次，不是启动崩）；
 * - PO#3 `addOffers` 是**并集**（不会把旧记录冲掉 —— 冲掉就等于把玩家删过的域又送一次）;
 * - PO#4 存储不可用 ⇒ 读回空、写不抛；
 * - PO#5 这个模块**只存领域 id**，绝不碰玩家内容与 Key。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRESET_OFFER_KEY,
  addOffers,
  clearOffers,
  loadOffers,
  sanitizeOffers,
} from '../../src/platform/presetOfferStore';

afterEach(() => {
  localStorage.removeItem(PRESET_OFFER_KEY);
  vi.restoreAllMocks();
});

describe('platform/presetOfferStore —— 已送过的预置领域（D66）', () => {
  it('PO#1 空 ⇒ 空；写入读回一致', () => {
    expect(loadOffers()).toEqual([]);
    expect(addOffers(['preset-ai-foundation'])).toEqual(['preset-ai-foundation']);
    expect(loadOffers()).toEqual(['preset-ai-foundation']);
  });

  it('PO#2 坏 JSON / 坏形状 / 脏 id 净化，不抛', () => {
    localStorage.setItem(PRESET_OFFER_KEY, '{oops');
    expect(loadOffers()).toEqual([]);
    localStorage.setItem(PRESET_OFFER_KEY, JSON.stringify([42, '', '  ', 'UPPER CASE', 'preset-x']));
    expect(loadOffers()).toEqual(['preset-x']);
    expect(sanitizeOffers('nope')).toEqual([]);
  });

  it('PO#3 addOffers 取并集（不冲掉旧记录）', () => {
    addOffers(['preset-ai-foundation']);
    addOffers(['preset-next']);
    expect(loadOffers().sort()).toEqual(['preset-ai-foundation', 'preset-next']);
    // 重复写入不产生重复项
    addOffers(['preset-next']);
    expect(loadOffers()).toHaveLength(2);
  });

  it('PO#4 存储不可用 ⇒ 读回空、写不抛', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('隐私模式');
      },
    });
    try {
      expect(() => loadOffers()).not.toThrow();
      expect(loadOffers()).toEqual([]);
      expect(() => addOffers(['preset-x'])).not.toThrow();
      expect(() => clearOffers()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('PO#5 只存领域 id（不碰内容与 Key）', async () => {
    addOffers(['preset-ai-foundation']);
    const raw = localStorage.getItem(PRESET_OFFER_KEY) ?? '';
    expect(raw).toContain('preset-ai-foundation');
    expect(raw.length).toBeLessThan(200);
    const src = (await import('node:fs')).readFileSync('src/platform/presetOfferStore.ts', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['apiKey', 'Authorization', 'Bearer', 'front', 'back']) {
      expect(code, `不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});
