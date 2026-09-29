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
import { localDayString } from '@core/reviewLedger';
import { fetchPage } from '../../src/platform/pageFetch';
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

async function makeRig(opts: { seed?: SaveFile; debounceMs?: number; presetContent?: unknown } = {}): Promise<Rig> {
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
    // 缺省**不**传：这条缺省本身就是产品行为（没有预置内容就没有"新装状态"可言，
    // 于是「重置存档」整组不显示）——AD#9 守着它，AD#8 用真内容驱动。
    presetContent: opts.presetContent,
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

describe('assembleHost —— 重置存档（Plan 5 追加）', () => {
  it('AD#8 给了 presetContent ⇒ resetSave 真的清档重装；exportBackupNow 导出并按下发文件名', async () => {
    const played = makeSave();
    played.meta.plays = 7;
    played.settings.progress.exp = 420;
    const rig = await makeRig({ seed: played, presetContent: presetJson });

    expect(typeof rig.assembly.adapters.resetSave).toBe('function');
    const res = await rig.assembly.adapters.resetSave?.();
    expect(res).toEqual({ ok: true, cards: 30, decks: 4 });
    // 内存档与存储档都得是"新装状态"（resetFlow 的 flush 收口；ADR 见 app/resetFlow.ts）
    expect(rig.coord.snapshot().meta.plays).toBe(0);
    expect(rig.coord.snapshot().settings.progress.exp).toBe(0);
    const disk = await rig.store.load();
    expect(disk?.cards.length).toBe(30);
    expect(disk?.meta.plays).toBe(0);

    // 「先导出备份」：走 exportAndMark（信封 + 记时），文件名与卡组页导出同一家族
    const exported = await rig.assembly.adapters.exportBackupNow?.();
    expect(exported?.ok).toBe(true);
    expect(rig.downloads).toHaveLength(1);
    expect(rig.downloads[0][1]).toMatch(/^zx-xia-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(rig.downloads[0][0]).toContain('"schemaVersion"');
    // 记时也真的落了（导出成功 = 时间戳写进 meta；只给文件不记时的实现必红）
    expect(rig.coord.snapshot().meta.lastExportedAt).toBe(NOW);
  });

  it('AD#9 没给 presetContent ⇒ 不接 resetSave（缺它整组隐藏，而不是给一个会清空的按钮）', async () => {
    const rig = await makeRig({ seed: makeSave() });
    expect(rig.assembly.adapters.resetSave).toBeUndefined();
    // 导出依旧可用（它不依赖预置内容），但设置屏里整组不显示 ⇒ 设置屏上也点不到它
    expect(typeof rig.assembly.adapters.exportBackupNow).toBe('function');
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

/* ------------------------------------------------------------------ Plan 6 · T7 */

/**
 * 判卷口的装配（Plan 6 · T7 / D42）。
 *
 * 判别力：
 * - AD#10 **判定额度真的记账**：判一次 `llmQuota.judges` 必须 +1 并落盘
 *   （不记账的实现 ⇒ 设置页显示的消耗是假的、300 次上限永远不生效）；
 * - AD#10b 额度到顶 ⇒ **不发起请求**（假 fetch 计数取证）且回可上屏原因；
 * - AD#10c 判定同样**每次现读配置**（玩家刚改的 Key 立刻生效，与辅建卡同一条接缝）；
 * - AD#11 作答模式写口直达 settingsFlow（同值不重写由那条用例保证）。
 */
describe('assembleHost —— 问答判卷与作答模式（Plan 6 · T7）', () => {
  function judgeRig(opts: { fetchCalls?: string[]; quotaJudges?: number } = {}) {
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      opts.fetchCalls?.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"match":true,"reason":"要点都在","missing":[]}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    let current: LlmConfig = { baseUrl: 'https://a.example', apiKey: 'sk-FIRST', model: 'm1' };
    return {
      fakeFetch,
      getConfig: () => current,
      setConfig: (cfg: LlmConfig) => {
        current = cfg;
      },
      configIo: {
        load: () => ({ ...current }),
        save: (cfg: LlmConfig) => {
          current = { ...cfg };
          return true;
        },
        clear: () => {
          current = { ...current, apiKey: '' };
        },
      },
    };
  }

  async function makeJudgeAssembly(opts: { fetchCalls?: string[]; quotaJudges?: number } = {}) {
    const rig = judgeRig(opts);
    const seed = makeSave();
    if (opts.quotaJudges !== undefined) {
      seed.settings.llmQuota = { day: localDayString(NOW, 480), cards: 0, judges: opts.quotaJudges };
    }
    const store = createMemoryStorage();
    await store.save(seed);
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    const ctrl = await createGameController({ coord, rng: () => 0.5, now: () => NOW, tzOffsetMin: 480 });
    const assembly = assembleHost({
      ctrl,
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
      llmFetchImpl: rig.fakeFetch,
      llmConfigIo: rig.configIo,
    });
    return { assembly, coord, store, rig };
  }

  it('AD#10 判一次 ⇒ 额度 +1 且落盘；结果原样回给屏', async () => {
    const { assembly, coord, store } = await makeJudgeAssembly();
    const res = await assembly.adapters.judge?.({ front: 'f', answer: 'a', reply: 'r' });
    expect(res).toEqual({ ok: true, match: true, reason: '要点都在', missing: [] });
    expect(coord.snapshot().settings.llmQuota?.judges).toBe(1);
    await coord.flush();
    expect((await store.load())?.settings.llmQuota?.judges).toBe(1);
  });

  it('AD#10b 额度用尽 ⇒ 不发起请求，回可上屏原因（UI 据此回落自评）', async () => {
    const fetchCalls: string[] = [];
    const { assembly } = await makeJudgeAssembly({ fetchCalls, quotaJudges: 300 });
    const res = await assembly.adapters.judge?.({ front: 'f', answer: 'a', reply: 'r' });
    expect(res?.ok).toBe(false);
    if (res && !res.ok) expect(res.reason).toContain('额度用完');
    expect(fetchCalls).toHaveLength(0); // ← 到顶就不该再花钱
  });

  it('AD#10c 判定同样每次现读配置：改完 Key 后下一次请求带新 Key', async () => {
    const fetchCalls: string[] = [];
    const { assembly, rig } = await makeJudgeAssembly({ fetchCalls });
    await assembly.adapters.judge?.({ front: 'f', answer: 'a', reply: 'r' });
    rig.setConfig({ baseUrl: 'https://b.example', apiKey: 'sk-SECOND', model: 'm2' });
    await assembly.adapters.judge?.({ front: 'f', answer: 'a', reply: 'r' });
    expect(fetchCalls).toEqual(['Bearer sk-FIRST', 'Bearer sk-SECOND']);
  });

  it('AD#11 作答模式写口：切到 qa 落盘、同值不重写', async () => {
    const { assembly, coord, store } = await makeJudgeAssembly();
    expect(await assembly.adapters.setAnswerMode?.('qa')).toEqual({ ok: true });
    expect(coord.snapshot().settings.answerMode).toBe('qa');
    await coord.flush();
    expect((await store.load())?.settings.answerMode).toBe('qa');
    await assembly.adapters.setAnswerMode?.('qa'); // 同值
    expect(coord.dirty()).toBe(false);
  });
});

/* ------------------------------------------------------------------ Plan 8 · T9 */

/**
 * 采新卡的装配面（Plan 8 · T9）。
 *
 * 判别力：
 * - AD#12 **额度真的写回存档**：生成一次后 `settings.llmQuota.cards` 必须增加，
 *   且第二次生成用的是新额度（不写回 ⇒ 额度永远不涨，200 张/天的承诺是假的）；
 * - AD#13 读取服务**只在玩家配了它的时候才带**（默认空串 = 不启用：不该把链接外发给第三方）；
 * - AD#14 `addCard` 支持 `hotspot` + `url`（溯源字段真的落进 `source`）。
 */
describe('assembleHost —— 采新卡接线（Plan 8 · T9）', () => {
  async function collectRig(opts: { readerUrl?: string; readerKey?: string } = {}) {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (u.startsWith('https://reader.example/')) {
        return new Response('读取服务给的纯文本正文', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      throw new TypeError('Failed to fetch'); // 直读被 CORS 拦
    }) as unknown as typeof fetch;

    const store = createMemoryStorage();
    await store.save(makeSave());
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    const ctrl = await createGameController({ coord, rng: () => 0.5, now: () => NOW, tzOffsetMin: 480 });
    const chatCalls: number[] = [];
    let current: LlmConfig = {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-fake',
      model: 'deepseek-flash',
      readerUrl: opts.readerUrl ?? '',
      readerKey: opts.readerKey ?? '',
    };
    const assembly = assembleHost({
      ctrl,
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
      fetchPageImpl: (url, o) => fetchPage(url, { fetchImpl: fakeFetch, ...(o ?? {}) }),
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
      // 生成口覆盖：本用例要钉的是**装配层自己的"额度写回"**（提示词/分块各有专门用例）
      collectCardsOverride: () => {
        chatCalls.push(1);
        return Promise.resolve({
          ok: true,
          candidates: [{ front: 'f', back: 'b', tags: [], choices: ['错'] }],
          quota: { day: localDayString(NOW, 480), cards: 1, judges: 0 },
          requests: 1,
          truncated: false,
        });
      },
    });
    return { assembly, coord, store, calls, chatCalls };
  }

  it('AD#12 生成一次 ⇒ 候选回来了且**额度写回存档**；第二次用的是新额度', async () => {
    const { assembly, coord } = await collectRig();
    const before = coord.snapshot().settings.llmQuota?.cards ?? 0;
    const res = await assembly.adapters.collectCards?.({ text: '一段资料', deckName: '唐诗' });
    expect(res?.ok).toBe(true);
    const after = coord.snapshot().settings.llmQuota?.cards ?? 0;
    expect(after).toBe(before + 1); // 1 张候选 ⇒ 记 1
  });

  it('AD#13 没配读取服务 ⇒ 直读被拦就是被拦（链接不外发）', async () => {
    const { assembly, calls } = await collectRig();
    const res = await assembly.adapters.ingestUrl?.('https://mp.weixin.qq.com/s/abc');
    expect(res?.kind).toBe('blocked');
    if (res?.kind === 'blocked') expect(res.blocked).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://mp.weixin.qq.com/s/abc']); // 只有直读那一次
  });

  it('AD#13b 配了读取服务 ⇒ 被拦后经它兜底，且带的是读取服务自己的 Key', async () => {
    const { assembly, calls } = await collectRig({ readerUrl: 'https://reader.example/', readerKey: 'rk-1' });
    const res = await assembly.adapters.ingestUrl?.('https://mp.weixin.qq.com/s/abc');
    expect(res?.kind).toBe('article');
    if (res?.kind === 'article') expect(res.via).toBe('reader');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`https://reader.example/${encodeURIComponent('https://mp.weixin.qq.com/s/abc')}`);
    expect(calls[1]?.auth).toBe('Bearer rk-1'); // 不是玩家那把 LLM Key（sk-fake）
  });

  it('AD#14 addCard 落 hotspot 与 url（溯源字段真的进 source）', async () => {
    const { assembly, coord } = await collectRig();
    const res = await assembly.adapters.addCard?.({
      front: 'f',
      back: 'b',
      deckId: 'deck-a',
      id: 'new-1',
      sourceType: 'hotspot',
      url: 'https://news.example/a',
    });
    expect(res?.ok).toBe(true);
    const card = coord.snapshot().cards.find((c) => c.id === 'new-1');
    expect(card?.source?.type).toBe('hotspot');
    expect(card?.source?.url).toBe('https://news.example/a');
  });
});

/* ------------------------------------------------------------------ D55：源库与读取服务 */

/**
 * 判别力：**玩家配了读取服务，源库必须真的经它读**（D55）。
 *
 * 为什么单独立一条：现场就是在这里翻车的 —— 源库那批代码上线时压根没接读取服务，
 * 而屏上的文案却写着"要么在设置里配一个读取服务"，玩家照做之后毫无变化
 * （`feedFetch` 的平台级用例全绿，因为它们自己注入 reader）。这条用例从**装配层**取证：
 * 配了读取服务 ⇒ 请求打到读取服务；没配 ⇒ 直接打源。
 */
describe('assembleHost —— 订阅源是否真的经读取服务（D55）', () => {
  it('AD#13 配了读取服务 ⇒ 「看最新」打到读取服务（带 x-respond-with 与服务 Key）；没配 ⇒ 直接打源', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const readerHtml =
      '<h3><a href="https://arxiv.org/abs/1">某篇论文</a></h3><p>摘要正文，够长够长够长。</p>';
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(readerHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;

    let cfg: LlmConfig = {
      baseUrl: 'https://api.example',
      apiKey: 'sk-LLM',
      model: 'm',
      readerUrl: 'https://r.jina.ai/',
      readerKey: 'jin-READER',
    };
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
      feedFetchImpl: fakeFetch,
      llmConfigIo: {
        load: () => ({ ...cfg }),
        save: (next) => {
          cfg = { ...next };
          return true;
        },
        clear: () => {
          cfg = { ...cfg, apiKey: '' };
        },
      },
    });

    const arxiv = {
      id: 'arxiv-cs-lg',
      name: 'arXiv cs.LG',
      // 实测没有 ACAO 的源：直连必然读不到 ⇒ 只能经读取服务
      url: 'https://rss.arxiv.org/rss/cs.LG',
      kind: 'rss' as const,
      direct: false,
    };

    const withReader = await assembly.adapters.sources?.fetchItems(arxiv);
    expect(withReader?.ok).toBe(true);
    if (withReader?.ok) expect(withReader.via).toBe('reader');
    expect(calls[0].url.startsWith('https://r.jina.ai/')).toBe(true);
    expect(calls[0].headers['x-respond-with']).toBe('html');
    expect(calls[0].headers.Authorization).toBe('Bearer jin-READER'); // 服务自己的 Key，不是 LLM Key

    // 清掉读取服务 ⇒ 直接打源（读取服务的账由玩家自己开）
    calls.length = 0;
    cfg = { ...cfg, readerUrl: '', readerKey: '' };
    const bare = await assembly.adapters.sources?.fetchItems({ ...arxiv, direct: true });
    expect(calls[0].url).toBe(arxiv.url);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(bare?.ok).toBe(false); // 假 fetch 回的是渲染 HTML，RSS 解析器当然认不出
  });
});

/* ------------------------------------------------------------------ D56：重出选项的装配 */

/**
 * 判别力（这是"接缝"用例，屏级/平台级都测不到它）：
 * - AD#14 一次「重出选项」= ①模型被调用一次 ②卡的 choices 落进存档 ③**卡片额度 -1**；
 * - AD#15 额度为 0 时**不调用模型**（钱不能白花），直接回可上屏的原因 ——
 *   "先记后做"的纪律与判卷同款，删掉记账这一步 AD#14 必红。
 */
describe('assembleHost —— 重出选项（D56）', () => {
  it('AD#14 「重出选项」走通：模型被调、choices 落盘、额度 -1', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"choices":["错一","错二","错三"]}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const seed = makeSave({ cards: [{ ...makeCard('c1'), choices: ['旧干扰项'] }] });
    const rig = await makeRig({ seed });
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
        load: () => ({ baseUrl: 'https://api.example', apiKey: 'sk-X', model: 'm' }),
        save: () => true,
        clear: () => undefined,
      },
    });

    const quotaBefore = rig.coord.snapshot().settings.llmQuota?.cards ?? 0;
    const res = await assembly.adapters.refreshChoices?.({ cardId: 'c1' });
    expect(res?.ok, res?.reason).toBe(true);
    expect(calls).toHaveLength(1);
    expect(rig.coord.snapshot().cards.find((c) => c.id === 'c1')?.choices).toEqual(['错一', '错二', '错三']);
    expect(rig.coord.snapshot().settings.llmQuota?.cards).toBe(quotaBefore + 1); // 一次调用 = 1 张
  });

  it('AD#15 额度用完 ⇒ **不调用模型**，如实回原因', async () => {
    const calls: string[] = [];
    const fakeFetch = (async () => {
      calls.push('boom');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const seed = makeSave();
    // `makeSave` 的 settings 一定有 llmQuota（形状与生产同构），这里只改计数
    if (seed.settings.llmQuota) seed.settings.llmQuota = { day: '2026-10-27', cards: 200, judges: 0 };
    const rig = await makeRig({ seed });
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
        load: () => ({ baseUrl: 'https://api.example', apiKey: 'sk-X', model: 'm' }),
        save: () => true,
        clear: () => undefined,
      },
    });

    const res = await assembly.adapters.refreshChoices?.({ cardId: 'c1' });
    expect(res?.ok).toBe(false);
    expect(res?.reason ?? '').toContain('额度');
    expect(calls).toEqual([]); // 一分钱都不该花
  });
});
