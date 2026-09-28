/**
 * tests/app/resetFlow.test.ts —— Plan 5 追加：「重置存档」（用户实测反馈"不知道怎么从头体验"）。
 *
 * 这一组用例守的是**四步顺序**（`clear` → `reload` → `installPresetContent` → `flush`）。
 * 判别力（每条都写清"坏实现为何必红"）：
 * - RS#1 重置后真的是"新装状态"：预置 4 领域 30 张卡回来了，等级/战绩/序章记录/设置全部归零。
 *   只清不灌（玩家看到空卡库）或只灌不清（自己的卡还在）都会红；
 * - RS#2 **先 reload 再灌**：RS#2 先当场演出"只清存储、不 reload 就灌"的后果（installPresetContent
 *   拒），再证明正路灌得进去 ⇒ 把 resetFlow 里的 reload 删掉必红；
 * - RS#3 `clear` 失败 ⇒ `ok:false` 且**存储原样保留**（不许半清）；
 * - RS#4 `reload` 失败 ⇒ `ok:false`，且如实说明"已清空、但没载回来"（不能谎报成功）；
 * - RS#5 时间读数异常 ⇒ 一步都不动（`clear` 都没调用）；内容非法 ⇒ 清空后如实报"没灌入"；
 * - RS#6 **重置后真的落盘**：从 store 直接 load 出来的就是新档（不 flush 的实现必红——
 *   内存里是新档、存储里还是旧档，刷新页面就"复活"）；
 * - RS#7 重置**不碰** LLM Key：本模块源码里不得出现 `localStorage`/`llmConfig`
 *   （Key 不在存档里，重置也不该顺手清掉它）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { createCoordinator, type Coordinator } from '../../src/app/persist';
import { installPresetContent } from '../../src/app/presetContent';
import { resetSave } from '../../src/app/resetFlow';
import presetJson from '../../assets/content/preset.json';

const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);

/** 种子档里写死的 SM-2 默认值（与 persist 的 DEFAULT_SETTINGS 同值；不 import 是因为它是私有的）。 */
const DEFAULT_PARAMS = { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 };

function srs(): SaveFile['cards'][number]['srs'] {
  return { ease: 2.5, interval: 10, reps: 3, lapses: 0, due: 0, stability: 'review', effectiveReviewDays: [] };
}

/** 一份"玩了一阵子"的档：两个领域、两张卡、有等级/战绩/序章记录、设置被改过。 */
function playedSave(): SaveFile {
  return {
    schemaVersion: 1,
    decks: [
      { id: 'deck-a', name: '生活常识', isPreset: true },
      { id: 'deck-mine', name: '我自己加的', isPreset: false },
    ],
    cards: [
      { id: 'c1', deckId: 'deck-a', front: 'q1', back: 'a1', tags: [], srs: srs() },
      { id: 'c2', deckId: 'deck-mine', front: 'q2', back: 'a2', tags: [], srs: srs() },
    ],
    settings: {
      bossThresholdTier: 15,
      sm2Params: { ...DEFAULT_PARAMS, initialEase: 2.0 },
      battle: { defaultPoolSize: 25 },
      progress: { exp: 420 },
      story: { prologueSeen: true, beatIndex: 3, arcSeen: 2 },
      leaderboard: [
        { id: 'r1', at: NOW, result: 'won', kind: 'encounter', domain: '生活常识', cards: 15, misses: 2, level: 4, score: 150 },
      ],
    },
    meta: { savedAt: NOW, plays: 7 },
  };
}

interface Rig {
  readonly coord: Coordinator;
  readonly store: GameStorage;
  /** 直接读存储（绕开内存档）——"真的落盘了吗"只信这个。 */
  readonly onDisk: () => Promise<SaveFile | null>;
}

async function makeRig(seed?: SaveFile): Promise<Rig> {
  const store = createMemoryStorage();
  if (seed !== undefined) await store.save(seed);
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
  return { coord, store, onDisk: () => store.load() };
}

/** 一个"clear 之后 reload 读不到档"的存储：验证 RS#4 的失败面。 */
function makeReloadRefusingStore(seed: SaveFile): GameStorage {
  let cleared = false;
  return {
    kind: 'memory',
    load: () => (cleared ? Promise.reject(new Error('读不出来（模拟）')) : Promise.resolve(seed)),
    save: () => Promise.resolve(),
    clear: () => {
      cleared = true;
      return Promise.resolve();
    },
  };
}

describe('resetFlow（重置存档）', () => {
  it('RS#1 重置后回到新装状态：预置卡回来、进度与记录归零', async () => {
    const rig = await makeRig(playedSave());
    const res = await resetSave({ coord: rig.coord, store: rig.store, content: presetJson, nowMs: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 预置内容：4 领域 / 30 张（数值对着内容文件写死：内容被改小/改空时这里也要红）
    expect(res.decks).toBe(4);
    expect(res.cards).toBe(30);

    const save = rig.coord.snapshot();
    expect(save.cards.length).toBe(30);
    expect(save.decks.length).toBe(4);
    expect(save.cards.some((c) => c.id === 'c1')).toBe(false); // 玩家自己加的卡没了
    expect(save.decks.some((d) => d.id === 'deck-mine')).toBe(false);
    expect(save.meta.plays).toBe(0);
    expect(save.settings.progress.exp).toBe(0);
    expect(save.settings.story).toEqual({ prologueSeen: false, beatIndex: 0, arcSeen: 0 });
    expect(save.settings.leaderboard).toEqual([]);
    // 设置也回到默认——重置的是**整份存档**，所以 UI 的代价清单里必须写上"设置"
    expect(save.settings.sm2Params).toEqual(DEFAULT_PARAMS);
    expect(save.settings.battle.defaultPoolSize).toBe(15);
    // 预置内容自带卷灵称号（LORE §4.2 的官方名），说明灌进去的是真内容而不是空壳
    expect(save.decks.every((d) => typeof d.bossName === 'string' && d.bossName.length > 0)).toBe(true);
  });

  it('RS#2 先 reload 再灌：漏掉 reload 就灌不进去（当场演出那个后果）', async () => {
    // 反证：只 clear 存储、不 reload ⇒ 内存档还是"玩过的那份" ⇒ installPresetContent 拒
    const wrong = await makeRig(playedSave());
    await wrong.store.clear();
    const refused = await installPresetContent(wrong.coord, presetJson, NOW);
    expect(refused.installed).toBe(false);

    // 正路：resetSave 自己会 reload，同一份内容灌得进去
    const rig = await makeRig(playedSave());
    const res = await resetSave({ coord: rig.coord, store: rig.store, content: presetJson, nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cards).toBe(30);
  });

  it('RS#6 重置后的档真的落盘（只改内存不 flush 的实现必红）', async () => {
    const rig = await makeRig(playedSave());
    await resetSave({ coord: rig.coord, store: rig.store, content: presetJson, nowMs: NOW });
    const disk = await rig.onDisk();
    expect(disk).not.toBeNull();
    expect(disk?.cards.length).toBe(30);
    expect(disk?.meta.plays).toBe(0);
    expect(disk?.settings.progress.exp).toBe(0);
    // 只读闩锁也要解掉：重置正是坏档玩家唯一的自救路径之一
    expect(rig.coord.readOnly()).toBe(false);
  });

  it('RS#3 clear 失败：不谎报成功，且存储与内存都原样保留', async () => {
    const inner = createMemoryStorage();
    await inner.save(playedSave());
    let clearCalls = 0;
    const store: GameStorage = {
      kind: 'memory',
      load: () => inner.load(),
      save: (f) => inner.save(f),
      clear: () => {
        clearCalls += 1;
        return Promise.reject(new Error('配额满了'));
      },
    };
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    const res = await resetSave({ coord, store, content: presetJson, nowMs: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('清空存储失败');
    expect(clearCalls).toBe(1);
    const disk = await inner.load();
    expect(disk?.meta.plays).toBe(7); // 原档一动没动
    expect(coord.snapshot().meta.plays).toBe(7);
    expect(coord.snapshot().cards.length).toBe(2);
  });

  it('RS#4 reload 失败：如实说"已清空但没载回来"（不许报成功）', async () => {
    const store = makeReloadRefusingStore(playedSave());
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    const res = await resetSave({ coord, store, content: presetJson, nowMs: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('已清空');
    expect(res.reason).toContain('重新载入失败');
  });

  it('RS#5 时间读数异常：一步都不动（clear 都没调用）', async () => {
    const inner = createMemoryStorage();
    await inner.save(playedSave());
    let touched = 0;
    const store: GameStorage = {
      kind: 'memory',
      load: () => inner.load(),
      save: (f) => {
        touched += 1;
        return inner.save(f);
      },
      clear: () => {
        touched += 1;
        return inner.clear();
      },
    };
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    const before = touched;
    const res = await resetSave({ coord, store, content: presetJson, nowMs: Number.NaN });
    expect(res.ok).toBe(false);
    expect(touched).toBe(before);
    expect(coord.snapshot().meta.plays).toBe(7);
  });

  it('RS#5b 内容非法（不是预置形状）：清空后如实报"预置没能灌入"，并说明现在是空库', async () => {
    const rig = await makeRig(playedSave());
    const res = await resetSave({ coord: rig.coord, store: rig.store, content: { decks: 'nope' }, nowMs: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('预置内容没能灌入');
    expect(res.reason).toContain('空卡库'); // 玩家据此知道还能手写卡开局
    expect(rig.coord.snapshot().cards.length).toBe(0);
  });

  it('RS#7 本模块不碰 LLM Key：代码里没有 localStorage / llmConfig 的痕迹', () => {
    // 注释里**故意**写着"Key 存在 localStorage、不在存档里"（那句话正是本条的依据），
    // 所以先剥注释再断言：断言的对象是"实现有没有碰它"，不是"文档有没有提它"。
    const src = readFileSync(new URL('../../src/app/resetFlow.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    expect(src).not.toContain('localStorage');
    expect(src).not.toContain('llmConfig');
    expect(src).not.toContain('LLM_STORAGE_KEY');
  });
});
