// @vitest-environment happy-dom
/**
 * tests/ui/hostAdapters.test.ts —— Plan 4 · T11 修复波：**装配层**（`src/ui/hostAdapters.ts`）。
 *
 * 为什么值得单独一套（T11 评审判 I-5）：抽出来之前，装配逻辑长在 `src/main.ts` 里——带副作用、
 * 测试无法 import，于是"导入前 flush / 导入后 reload"这两条接缝修复**零覆盖**：把它们删掉，
 * 73 条相关用例全绿。本文件直接测装配函数，把这两条钉住。
 *
 * 判别力：
 * - AD#1 导入前必须 flush：造一个 debounce>0、内存档已脏的场景，导入另一份档到 store，
 *   若装配层不先 flush，那次陈旧的窗写会把导入结果**覆盖**掉（导入档 plays=5 → 变回 1）⇒ 必红；
 * - AD#2 导入成功但 reload 失败 ⇒ 返回值必须 ok:false 且 reason 说清"写进去了但读不出来"
 *   （原实现照样回 ok:true，玩家会看到"备份已导入"与只读横幅同时出现）；
 * - AD#4 「再来一场」必须复用上一局的 startFight 参数（含 boss 档），否则重开会偷偷换成随机遭遇战。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import { createMemoryStorage } from '@platform/memoryStore';
import { exportBackup } from '../../src/app/backup';
import { createCoordinator } from '../../src/app/persist';
import { createGameController } from '../../src/app/gameController';
import type { GameController, GameIntent } from '../../src/app/controllerTypes';
import { assembleHost } from '../../src/ui/hostAdapters';
import type { LlmConfig } from '../../src/platform/llmTypes';
import arcJson from '../../assets/narrative/arc.json';
import beatsJson from '../../assets/narrative/beats.json';
import eggsJson from '../../assets/narrative/eggs.json';
import presetJson from '../../assets/content/preset.json';
import prologueJson from '../../assets/narrative/prologue.json';
import { makeCard, makeDeck, makeSave } from './support';

const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);

function img(): HTMLImageElement {
  return document.createElement('img');
}

interface Rig {
  readonly assembly: ReturnType<typeof assembleHost>;
  readonly coord: Awaited<ReturnType<typeof createCoordinator>>;
  readonly store: ReturnType<typeof createMemoryStorage>;
  readonly notices: string[];
  readonly downloads: Array<[string, string]>;
  setPicked(text: string | null): void;
  replayCalls: () => number;
}

async function makeRig(opts: { seed?: SaveFile; debounceMs?: number } = {}): Promise<Rig> {
  const store = createMemoryStorage();
  if (opts.seed) await store.save(opts.seed);
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: opts.debounceMs ?? 0 });
  const rawCtrl = await createGameController({ coord, rng: () => 0.5, now: () => NOW, tzOffsetMin: 480 });

  const notices: string[] = [];
  const downloads: Array<[string, string]> = [];
  let picked: string | null = null;
  let replay = 0;

  const assembly = assembleHost({
    ctrl: rawCtrl,
    coord,
    store,
    now: () => NOW,
    tzOffsetMin: 480,
    rng: () => 0.5,
    sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
    prologueScenes: prologueJson.scenes as never,
    beats: beatsJson.beats as never,
    acts: arcJson.acts as never,
    eggs: eggsJson.eggs as never,
    wordTable: new Map([['唐朝', '宋朝']]),
    onNotice: (t) => notices.push(t),
    hostRef: () => ({ replayPrologue: () => void (replay += 1) }),
    toastMs: 0,
    pickBackupText: () => Promise.resolve(picked),
    saveTextFile: (text, filename) => downloads.push([text, filename]),
  });

  return {
    assembly,
    coord,
    store,
    notices,
    downloads,
    setPicked: (t) => {
      picked = t;
    },
    replayCalls: () => replay,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('assembleHost —— 导入链（R-T11-p4-b / R-T11-p4-c）', () => {
  it('AD#1 导入前先 flush（顺序契约）：在途改动先落净，导入才写 store（删掉 flush 必红）', async () => {
    const incoming = makeSave({ decks: [makeDeck('deck-a', '甲')] });
    incoming.meta.plays = 5;

    // 事件日志：谁先谁后由它取证（与其赌一个真实的竞态窗口，不如把**顺序契约**钉死）
    const events: string[] = [];
    const inner = createMemoryStorage();
    const store: typeof inner = {
      kind: 'memory',
      clear: () => inner.clear(),
      load: () => inner.load(),
      save: (f) => {
        events.push(`save:plays=${f.meta.plays}`);
        return inner.save(f);
      },
    };
    const real = await createCoordinator(store, { now: () => NOW, debounceMs: 30 });
    const coord: typeof real = {
      ...real,
      flush: () => {
        events.push('flush');
        return real.flush();
      },
    };
    const assembly = assembleHost({
      ctrl: await createGameController({ coord, rng: () => 0.5, now: () => NOW, tzOffsetMin: 480 }),
      coord,
      store,
      now: () => NOW,
      tzOffsetMin: 480,
      rng: () => 0.5,
      sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
      prologueScenes: prologueJson.scenes as never,
      beats: beatsJson.beats as never,
      acts: arcJson.acts as never,
      eggs: eggsJson.eggs as never,
      wordTable: new Map(),
      toastMs: 0,
      pickBackupText: () => Promise.resolve(null),
      saveTextFile: () => undefined,
    });

    // 内存档脏（30ms 后才落盘）：这正是"导入被陈旧窗写覆盖"的时间窗
    await coord.mutate((s) => {
      s.meta.plays = 1;
    });
    await assembly.adapters.importBackup?.(exportBackup(incoming, NOW));

    // ① flush 必须排在最前（删掉那行 ⇒ 第一条就是导入的 save，本断言红）
    expect(events[0], `事件序列：${events.join(' → ')}`).toBe('flush');
    // ② 在途那份脏档先落盘、导入档随后覆盖它（顺序不能倒：倒了就是把导入内容写没了）
    const staleAt = events.indexOf('save:plays=1');
    const importedAt = events.indexOf('save:plays=5');
    expect(staleAt, `事件序列：${events.join(' → ')}`).toBeGreaterThanOrEqual(0);
    expect(importedAt).toBeGreaterThan(staleAt);
    // ③ 等过 debounce 窗，确认没有"事后覆盖"（这条才真正判"最终存储里是谁"）
    await new Promise((r) => setTimeout(r, 80));
    expect((await store.load())?.meta.plays).toBe(5);
    expect(coord.snapshot().meta.plays).toBe(5);
  });

  it('AD#2 导入写进去了但 reload 读不回来 ⇒ ok:false + 说清情况，并给一句 notice', async () => {
    // 构造"写得进、读不出"的存储：reload 走 store.load，import 走 store.save——
    // 这正是"导入成功但游戏用不上"的真实形态（例如配额/权限突变后读侧坏了）
    const inner = createMemoryStorage();
    const readBroken: typeof inner = {
      kind: 'memory',
      save: (f) => inner.save(f),
      clear: () => inner.clear(),
      load: () => Promise.reject(new Error('磁盘读不出来')),
    };
    const coord = await createCoordinator(readBroken, { now: () => NOW, debounceMs: 0 });
    const notices: string[] = [];
    const assembly = assembleHost({
      ctrl: await createGameController({ coord, rng: () => 0.5, now: () => NOW, tzOffsetMin: 480 }),
      coord,
      store: readBroken,
      now: () => NOW,
      tzOffsetMin: 480,
      rng: () => 0.5,
      sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
      prologueScenes: prologueJson.scenes as never,
      beats: beatsJson.beats as never,
      acts: arcJson.acts as never,
      eggs: eggsJson.eggs as never,
      wordTable: new Map(),
      onNotice: (t) => notices.push(t),
      toastMs: 0,
      pickBackupText: () => Promise.resolve(null),
      saveTextFile: () => undefined,
    });

    const res = await assembly.adapters.importBackup?.(exportBackup(makeSave(), NOW));
    expect(res?.ok).toBe(false);
    expect(res?.reason ?? '').toContain('重新载入');
    expect(res?.reason ?? '').toContain('刷新页面');
    expect(notices.join('|')).toContain('重新载入'); // 屏上也要说一句（不是只改返回值）
  });
});

describe('assembleHost —— LLM 接线（Key 与配置）', () => {
  it('AD#7 宿主**每次调用现读配置**：改完 Key 后下一次请求就带新 Key（绑定一次的实现必红）', async () => {
    const calls: Array<Record<string, string>> = [];
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // 内存版配置口：与生产同一条路径（assembleHost 的 llmConfigIo 注入位）
    let current: LlmConfig = { baseUrl: 'https://a.example', apiKey: 'sk-FIRST', model: 'm1' };
    const rig = await makeRig();
    const assembly = assembleHost({
      ctrl: rig.assembly.ctrl,
      coord: rig.coord,
      store: rig.store,
      now: () => NOW,
      tzOffsetMin: 480,
      rng: () => 0.5,
      sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
      prologueScenes: prologueJson.scenes as never,
      beats: beatsJson.beats as never,
      acts: arcJson.acts as never,
      eggs: eggsJson.eggs as never,
      wordTable: new Map(),
      toastMs: 0,
      pickBackupText: () => Promise.resolve(null),
      saveTextFile: () => undefined,
      llmFetchImpl: fakeFetch,
      llmConfigIo: {
        load: () => ({ ...current }),
        save: (cfg) => {
          current = { ...cfg };
          return true;
        },
        clear: () => {
          current = { ...current, apiKey: '' };
        },
      },
    });

    await assembly.adapters.llmCards?.({ text: '资料', deckName: '唐诗' });
    current = { baseUrl: 'https://b.example', apiKey: 'sk-SECOND', model: 'm2' };
    await assembly.adapters.llmCards?.({ text: '资料', deckName: '唐诗' });

    expect(calls).toHaveLength(2);
    expect(calls[0].Authorization).toBe('Bearer sk-FIRST');
    // 把 boundChat 里的 loadLlmConfig() 提到闭包外（绑定一次）⇒ 这里会是 FIRST，用例红
    expect(calls[1].Authorization).toBe('Bearer sk-SECOND');
    // 顺带钉"现读"对设置屏也成立（同一份 llmIo）
    expect(assembly.adapters.llm?.load().apiKey).toBe('sk-SECOND');
  });
});

describe('assembleHost —— 会话记忆与练习关', () => {
  it('AD#3 练习关走 bossFightParams：单领域 + size=min(卡数,25) + difficulty=boss', async () => {
    const cards = [];
    for (let i = 0; i < 30; i++) cards.push(makeCard(`c${i}`, { deckId: 'd1' }));
    const rig = await makeRig({ seed: makeSave({ decks: [makeDeck('d1', '甲')], cards }) });
    const intents: GameIntent[] = [];
    const spyCtrl: GameController = {
      snapshot: () => rig.assembly.ctrl.snapshot(),
      subscribe: (cb) => rig.assembly.ctrl.subscribe(cb),
      intent: (i) => {
        intents.push(i);
        return Promise.resolve();
      },
    };
    // 用 spy 控制器重装一次（只为看 intent 形状；bossFightParams 是同一处口径）
    const coord2 = rig.coord;
    const assembly = assembleHost({
      ctrl: spyCtrl,
      coord: coord2,
      store: rig.store,
      now: () => NOW,
      tzOffsetMin: 480,
      rng: () => 0.5,
      sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
      prologueScenes: prologueJson.scenes as never,
      beats: beatsJson.beats as never,
      acts: arcJson.acts as never,
      eggs: eggsJson.eggs as never,
      wordTable: new Map(),
      toastMs: 0,
      pickBackupText: () => Promise.resolve(null),
      saveTextFile: () => undefined,
    });
    assembly.adapters.onPractice?.('d1');
    expect(intents).toEqual([{ type: 'startFight', size: 25, deckIds: ['d1'], difficulty: 'boss' }]);
  });

  it('AD#4「再来一场」复用上一局参数（含 boss 档）', async () => {
    const rig = await makeRig();
    const intents: GameIntent[] = [];
    const spyCtrl: GameController = {
      snapshot: () => rig.assembly.ctrl.snapshot(),
      subscribe: (cb) => rig.assembly.ctrl.subscribe(cb),
      intent: (i) => {
        intents.push(i);
        return Promise.resolve();
      },
    };
    const assembly = assembleHost({
      ctrl: spyCtrl,
      coord: rig.coord,
      store: rig.store,
      now: () => NOW,
      tzOffsetMin: 480,
      rng: () => 0.5,
      sprites: { hero: img(), mob: img(), boss: img(), bg: img() },
      prologueScenes: prologueJson.scenes as never,
      beats: beatsJson.beats as never,
      acts: arcJson.acts as never,
      eggs: eggsJson.eggs as never,
      wordTable: new Map(),
      toastMs: 0,
      pickBackupText: () => Promise.resolve(null),
      saveTextFile: () => undefined,
    });

    await assembly.ctrl.intent({ type: 'startFight', size: 25, deckIds: ['d1'], difficulty: 'boss' });
    assembly.adapters.onReplay?.();
    expect(intents).toEqual([
      { type: 'startFight', size: 25, deckIds: ['d1'], difficulty: 'boss' },
      { type: 'startFight', size: 25, deckIds: ['d1'], difficulty: 'boss' },
    ]);
  });

  it('AD#5「重看序章」：写口成功后当场把序章挂回来（settingsFlow 只写存档 ⇒ 那句 UI 文案是假的）', async () => {
    const rig = await makeRig({ seed: makeSave() });
    expect(rig.replayCalls()).toBe(0);
    const res = await rig.assembly.adapters.replayPrologue?.();
    expect(res).toEqual({ ok: true });
    expect(rig.replayCalls()).toBe(1);
    expect(rig.coord.snapshot().settings.story.prologueSeen).toBe(false);
  });
});

describe('assembleHost —— 导出与抢救口', () => {
  it('AD#6 导出走 exportAndMark（信封 + 记时），rawDump 直通 coordinator', async () => {
    const rig = await makeRig({ seed: makeSave() });
    const res = await rig.assembly.adapters.exportBackup?.();
    expect(res?.ok).toBe(true);
    if (res?.ok) expect(JSON.parse(res.text as string).format).toBeTruthy();
    expect(rig.coord.snapshot().meta.lastExportedAt).toBe(NOW);

    const dump = await rig.assembly.adapters.rawDump?.();
    expect(typeof dump).toBe('string');
    expect(JSON.parse(dump as string).schemaVersion).toBe(1);
  });

  it('AD#6b 预置内容与写口：addCard 带上注入时钟、setBossName/setTier 走 app 层', async () => {
    // 夹具必须引用闭合（默认卡挂在 deck-a 上）：不闭合法档会让 coordinator 直接进只读态，
    // 那测的就不是写口而是闩锁了
    const rig = await makeRig({ seed: makeSave({ decks: [makeDeck('deck-a', '甲')] }) });
    const added = await rig.assembly.adapters.addCard?.({
      front: 'f',
      back: 'b',
      deckId: 'deck-a',
      id: 'new-1',
    });
    expect(added?.ok).toBe(true);
    if (added?.ok) expect(added.value.source?.createdAt).toBe(NOW);

    // 新卡吃玩家调过的 SM-2 参数（终审 Minor）：改设置后再加一张，ease 必须跟着变
    expect(await rig.assembly.adapters.setParams?.({ initialEase: 2.9, minEase: 1.4, firstInterval: 1, secondInterval: 5 })).toEqual({ ok: true });
    const second = await rig.assembly.adapters.addCard?.({ front: 'f2', back: 'b2', deckId: 'deck-a', id: 'new-2' });
    expect(second?.ok).toBe(true);
    if (second?.ok) expect(second.value.srs.ease).toBe(2.9);

    expect(await rig.assembly.adapters.setTier?.(15)).toEqual({ ok: true });
    expect(rig.coord.snapshot().settings.bossThresholdTier).toBe(15);
    const named = await rig.assembly.adapters.setBossName?.('deck-a', '荒原卷灵');
    expect(named?.ok).toBe(true);
    expect(rig.coord.snapshot().decks[0].bossName).toBe('荒原卷灵');
  });
});
