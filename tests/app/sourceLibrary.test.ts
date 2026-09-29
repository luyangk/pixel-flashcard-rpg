/**
 * tests/app/sourceLibrary.test.ts —— 内置来源库与合并规则（D53）。
 *
 * 判别力：
 * - SL#1 内置库里每个源都必须**带着实测结论**（`direct` 字段），且两种都真的存在
 *   （全标 true 的实现必红 —— 那些源实测没有 ACAO）；
 * - SL#2 合并：删掉的内置源按墓碑过滤（删了又冒出来 = 玩家会骂人）；
 * - SL#3 玩家源进「我的来源」，同链接去重；
 * - SL#4 删玩家源不进墓碑（它本来就不在内置里），删内置源才进墓碑；
 * - SL#5 「恢复推荐来源」清墓碑但保留玩家自己加的；
 * - SL#6 内置库形状健康：id 唯一、链接都是 http(s)、note 都有一句话。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DOMAINS,
  EMPTY_USER_LIBRARY,
  MY_DOMAIN_ID,
  addSource,
  builtinSourceIds,
  isBuiltinSource,
  mergeLibrary,
  removeSource,
  restoreBuiltins,
} from '../../src/app/sourceLibrary';
import type { SourceDef } from '../../src/core/sourceItem';

const mine: SourceDef = {
  id: 'user:https://my.example/feed',
  name: '我的博客',
  url: 'https://my.example/feed',
  kind: 'rss',
  direct: false,
};

describe('app/sourceLibrary —— 内置库与合并（D53）', () => {
  it('SL#1 内置库同时含"直连可读"与"需读取服务"两类，且 direct 与 docs/SOURCES.md 的实测一致', () => {
    const sources = BUILTIN_DOMAINS.flatMap((d) => d.sources);
    expect(sources.length).toBeGreaterThanOrEqual(12);
    expect(sources.filter((s) => s.direct).length).toBeGreaterThanOrEqual(6);
    // 实测没有 ACAO 的源**必须**标 false（标 true 就是在骗玩家）
    for (const id of ['openai-news', 'hf-blog', 'deepmind', 'arxiv-cs-ai', 'arxiv-cs-lg', 'tds', 'latent-space', 'qbitai']) {
      const s = sources.find((x) => x.id === id);
      expect(s, `内置库缺了实测过的源：${id}`).toBeTruthy();
      expect(s?.direct, `${id} 实测没有 ACAO，direct 必须是 false`).toBe(false);
    }
    // 实测有 ACAO 的源标 true
    for (const id of ['hf-papers', 'gh-vllm', 'hn-front', 'github-blog', 'lilianweng', 'databricks', 'hf-models', 'gh-deepseek']) {
      expect(sources.find((x) => x.id === id)?.direct, `${id} 实测有 ACAO`).toBe(true);
    }
    // Lil'Log 的端点必须是 /index.xml（/feed.xml 实测 404）
    expect(sources.find((x) => x.id === 'lilianweng')?.url).toBe('https://lilianweng.github.io/index.xml');
  });

  it('SL#2 删掉的内置源按墓碑过滤（不许因为刷新又冒出来）', () => {
    const before = mergeLibrary(EMPTY_USER_LIBRARY);
    expect(before[0].sources.some((s) => s.id === 'deeppmind' || s.id === 'deepmind')).toBe(true);

    const after = mergeLibrary({ added: [], removed: ['deepmind', 'arxiv-cs-ai'] });
    expect(after[0].sources.some((s) => s.id === 'deepmind')).toBe(false);
    expect(after[0].sources.some((s) => s.id === 'arxiv-cs-ai')).toBe(false);
    // 别的源不受影响
    expect(after[0].sources.some((s) => s.id === 'hf-papers')).toBe(true);
  });

  it('SL#3 玩家源进「我的来源」；同链接去重（后者覆盖前者）', () => {
    const once = mergeLibrary({ added: [mine], removed: [] });
    expect(once).toHaveLength(2);
    expect(once[1].id).toBe(MY_DOMAIN_ID);
    expect(once[1].sources).toEqual([mine]);

    const twice = mergeLibrary({
      added: [mine, { ...mine, id: 'user:other', name: '改名了' }],
      removed: [],
    });
    expect(twice[1].sources).toHaveLength(1);
    expect(twice[1].sources[0].name).toBe('改名了');
  });

  it('SL#4 删玩家源不进墓碑；删内置源才进墓碑；加回内置源会撤掉墓碑', () => {
    const removedMine = removeSource({ added: [mine], removed: [] }, mine.id);
    expect(removedMine.added).toEqual([]);
    expect(removedMine.removed).toEqual([]);

    const removedBuiltin = removeSource(EMPTY_USER_LIBRARY, 'github-blog');
    expect(removedBuiltin.removed).toEqual(['github-blog']);
    expect(mergeLibrary(removedBuiltin)[0].sources.some((s) => s.id === 'github-blog')).toBe(false);

    const back = addSource(removedBuiltin, {
      id: 'github-blog',
      name: 'GitHub Blog',
      url: 'https://github.blog/feed/',
      kind: 'rss',
      direct: true,
    });
    expect(back.removed).toEqual([]);
    expect(isBuiltinSource('github-blog')).toBe(true);
  });

  it('SL#5 恢复推荐来源：清墓碑、保留自己加的', () => {
    const messy = { added: [mine], removed: ['deepmind', 'tds'] };
    const restored = restoreBuiltins(messy);
    expect(restored.removed).toEqual([]);
    expect(restored.added).toEqual([mine]);
    expect(mergeLibrary(restored)[0].sources.some((s) => s.id === 'deepmind')).toBe(true);
  });

  it('SL#6 内置库形状健康：id 唯一、链接 http(s)、每个源都有一句"能给你什么"', () => {
    const ids = builtinSourceIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of BUILTIN_DOMAINS) {
      expect(d.id.length).toBeGreaterThan(0);
      expect(d.name.length).toBeGreaterThan(0);
      for (const s of d.sources) {
        expect(s.url).toMatch(/^https:\/\//);
        expect((s.note ?? '').length).toBeGreaterThan(4);
      }
    }
  });
});
