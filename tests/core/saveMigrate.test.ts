/**
 * saveMigrate —— 存档校验与 JSON 导出/导入（DoD5 地基）。
 *
 * validateSave 是 core 全链路唯一整包拒绝点（core 其余函数消毒容忍），
 * 故本套件的严格性即数据完整性的最后防线：
 * - 任一畸形 → { ok:false, reason }，reason 含可读 JSON 路径（如 `cards[3].srs.ease`）；
 * - importAndSave 任一步失败不落盘（Review Focus #2）。
 */

import { describe, expect, it } from 'vitest';
import type { Card, Deck, SaveFile } from '@core/types';
import type { GameStorage } from '@platform/storage';
// 仅借用已测实现当 GameStorage 载体（断言对象是 importAndSave，非 memoryStore）；
// core → platform 只 import type，运行时零依赖，core 纯净不破。
import { createMemoryStorage } from '@platform/memoryStore';
import { MAX_EFFECTIVE_DAYS } from '@core/reviewLedger';
import { importAndSave, migrateSave, serializeSave, validateSave } from '@core/saveMigrate';

const T0 = 1761955200000; // 2025-11-01T00:00Z 附近的中性时间戳，纯数据不作时钟

// ---------------------------------------------------------------------------
// 样本构造
// ---------------------------------------------------------------------------

function deck(id: string, over: Partial<Deck> = {}): Deck {
  return { id, name: `卡组-${id}`, isPreset: false, ...over };
}

function card(id: string, deckId: string, over: Partial<Card> = {}): Card {
  return {
    id,
    deckId,
    front: `问-${id}`,
    back: `答-${id}`,
    tags: ['t1'],
    source: { type: 'manual', createdAt: T0 },
    srs: {
      ease: 2.5,
      interval: 4,
      reps: 2,
      lapses: 1,
      due: T0 + 86_400_000,
      stability: 'review',
      effectiveReviewDays: ['2025-11-01', '2025-11-02'],
    },
    ...over,
  };
}

function validSave(): SaveFile {
  return {
    schemaVersion: 1,
    decks: [deck('d1'), deck('d2', { bossName: '卷灵·二', purifiedAt: T0 })],
    cards: [card('c1', 'd1'), card('c2', 'd1'), card('c3', 'd2'), card('c4', 'd2')],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 1, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
    },
    meta: { savedAt: T0, plays: 7 },
  };
}

/** 取合法样本的浅克隆，供逐字段 mutate 出畸形变体。 */
function sample(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validSave()));
}

/** v2.1 之前的旧形状档：settings 无 battle（RF#4 迁移对象）。 */
function legacySample(): Record<string, unknown> {
  const raw = sample();
  delete (raw.settings as Record<string, unknown>).battle;
  return raw;
}

// ---------------------------------------------------------------------------
// validateSave —— 合法侧
// ---------------------------------------------------------------------------

describe('validateSave —— 合法存档', () => {
  it('合法样本通过并返回强类型 save', () => {
    const r = validateSave(validSave());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save.meta.plays).toBe(7);
  });

  it('可选字段缺省合法：source / bossName / purifiedAt / url 均可缺席', () => {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    delete cards[0].source;
    const decks = raw.decks as Record<string, unknown>[];
    delete decks[1].bossName;
    delete decks[1].purifiedAt;
    const r = validateSave(raw);
    expect(r.ok).toBe(true);
  });

  it('空 decks/cards/tags/effectiveReviewDays 数组合法', () => {
    const raw = sample();
    raw.decks = [];
    raw.cards = [];
    const r = validateSave(raw);
    expect(r.ok).toBe(true);
  });

  it('stability 四个枚举值均合法', () => {
    for (const s of ['new', 'learning', 'review', 'mastered'] as const) {
      const raw = sample();
      (raw.cards as Record<string, unknown>[])[0].srs = {
        ...(raw.cards as Record<string, unknown>[])[0].srs as object,
        stability: s,
      };
      expect(validateSave(raw).ok).toBe(true);
    }
  });

  it('不深拷贝入参：save 与 raw 同引用（消毒责任在调用方之前已终结）', () => {
    const raw = validSave();
    const r = validateSave(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// validateSave —— 非法侧（每种都要求整包拒绝 + reason 含 JSON 路径）
// ---------------------------------------------------------------------------

describe('validateSave —— schemaVersion', () => {
  it('schemaVersion:2 → 拒绝且提示升级', () => {
    const raw = sample();
    raw.schemaVersion = 2;
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('schemaVersion');
      expect(r.reason).toMatch(/升级|更新/);
    }
  });

  it('schemaVersion:0 / "1"（字符串）→ 拒绝并给路径', () => {
    for (const v of [0, '1']) {
      const raw = sample();
      raw.schemaVersion = v;
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('schemaVersion');
    }
  });
});

describe('validateSave —— 缺失顶层字段', () => {
  for (const key of ['decks', 'cards', 'settings', 'meta'] as const) {
    it(`缺 ${key} → 拒绝且 reason 含 "${key}"`, () => {
      const raw = sample();
      delete raw[key];
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(key);
    });
  }

  it('非对象输入（null / 数字 / 数组 / 字符串）一律拒绝，不抛异常', () => {
    for (const bad of [null, undefined, 42, 'x', [1, 2]]) {
      const r = validateSave(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.reason).toBe('string');
    }
  });
});

describe('validateSave —— 结构与类型逐项检查（reason 必须给 JSON 路径）', () => {
  it('decks 不是数组 → 路径 decks', () => {
    const raw = sample();
    raw.decks = {};
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('decks');
  });

  it('decks[].name 类型错 → 路径含 decks[0].name', () => {
    const raw = sample();
    (raw.decks as Record<string, unknown>[])[0].name = 123;
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('decks[0].name');
  });

  it('decks[].isPreset 非布尔 → 路径含 decks[1].isPreset', () => {
    const raw = sample();
    (raw.decks as Record<string, unknown>[])[1].isPreset = 'true';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('decks[1].isPreset');
  });

  it('deck id 重复 → 悬空引用无从判别，拒绝并定位 decks[1].id', () => {
    const raw = sample();
    (raw.decks as Record<string, unknown>[])[1].id = 'd1';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('decks[1].id');
  });

  it('cards[3].srs.ease 类型错 → 拒绝且 reason 恰含该路径', () => {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    (cards[3].srs as Record<string, unknown>).ease = 'hard';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cards[3].srs.ease');
  });

  it('stability 枚举外值 → 路径 cards[0].srs.stability', () => {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    (cards[0].srs as Record<string, unknown>).stability = 'expert';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cards[0].srs.stability');
  });

  it('effectiveReviewDays 元素非字符串 → 路径 cards[0].srs.effectiveReviewDays[1]', () => {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    (cards[0].srs as Record<string, unknown>).effectiveReviewDays = ['2025-11-01', 7];
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cards[0].srs.effectiveReviewDays[1]');
  });

  it('tags 非字符串数组 → 路径 cards[2].tags[0]', () => {
    const raw = sample();
    (raw.cards as Record<string, unknown>[])[2].tags = [null];
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cards[2].tags[0]');
  });

  it('source.type 枚举外值 → 路径 cards[0].source.type', () => {
    const raw = sample();
    (raw.cards as Record<string, unknown>[])[0].source = { type: 'chatgpt', createdAt: T0 };
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cards[0].source.type');
  });

  it('NaN 数值一律拒绝（JSON 里也是 null，两者都要拦） → 路径 cards[0].srs.due', () => {
    const raw = sample();
    (raw.cards as Record<string, unknown>[])[0].srs = {
      ...(raw.cards as Record<string, unknown>[])[0].srs as object,
      due: NaN,
    };
    expect(validateSave(raw).ok).toBe(false);
    const viaJson = validateSave(JSON.parse(JSON.stringify(raw)));
    expect(viaJson.ok).toBe(false);
    if (!viaJson.ok) expect(viaJson.reason).toContain('cards[0].srs.due');
  });

  it('bossThresholdTier 非 15/30/50 → 路径 settings.bossThresholdTier', () => {
    for (const tier of [20, '30', 0]) {
      const raw = sample();
      (raw.settings as Record<string, unknown>).bossThresholdTier = tier;
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.bossThresholdTier');
    }
  });

  it('sm2Params 缺字段 → 路径 settings.sm2Params.minEase', () => {
    const raw2 = sample();
    const sm2 = (raw2.settings as Record<string, Record<string, unknown>>).sm2Params;
    delete sm2.minEase;
    const r = validateSave(raw2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('settings.sm2Params.minEase');
  });

  // ---- settings.battle 域（Task 8：v2.1 新增 defaultPoolSize，合法域 10–25 整数）----

  it('battle.defaultPoolSize=99 / 3.5 / "x" → 拒绝且 reason 含路径 settings.battle.defaultPoolSize', () => {
    for (const v of [99, 3.5, 'x']) {
      const raw = sample();
      (raw.settings as Record<string, Record<string, unknown>>).battle = { defaultPoolSize: v };
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.battle.defaultPoolSize');
    }
  });

  it('battle.defaultPoolSize 边界 10 / 25 合法；battle 整体非对象同样拒', () => {
    for (const v of [10, 25]) {
      const raw = sample();
      (raw.settings as Record<string, Record<string, unknown>>).battle = { defaultPoolSize: v };
      expect(validateSave(raw).ok).toBe(true);
    }
    const raw2 = sample();
    (raw2.settings as Record<string, unknown>).battle = 'x';
    const r2 = validateSave(raw2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('settings.battle');
  });

  it('缺 settings.battle（v1 旧形状）→ validate 拒并给路径——补默认是 migrateSave 的职责', () => {
    const r = validateSave(legacySample());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('settings.battle');
  });
  it('meta.savedAt 类型错 → 路径 meta.savedAt', () => {
    const raw = sample();
    (raw.meta as Record<string, unknown>).savedAt = 'yesterday';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('meta.savedAt');
  });
});

describe('validateSave —— deckId 引用闭合', () => {
  it('悬空 deckId → 拒绝且 reason 含 cards[2].deckId 与目标 id', () => {
    const raw = sample();
    (raw.cards as Record<string, unknown>[])[2].deckId = 'ghost-deck';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('cards[2].deckId');
      expect(r.reason).toContain('ghost-deck');
    }
  });

  it('deckId 为空串 → 拒绝', () => {
    const raw = sample();
    (raw.cards as Record<string, unknown>[])[0].deckId = '';
    expect(validateSave(raw).ok).toBe(false);
  });
});

describe('validateSave —— id 唯一性（deck 与 card 同标准）', () => {
  it('cards[1].id 与 cards[0] 重复 → 拒绝且 reason 含路径与重复值', () => {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    cards[1].id = cards[0].id; // c1
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('cards[1].id');
      expect(r.reason).toContain('重复');
      expect(r.reason).toContain('c1');
    }
  });
});

describe('validateSave —— 数值域防护（I-3：唯一整包拒绝点必须严格到域）', () => {
  /** 改 cards[0].srs 的某字段。 */
  function withSrs(field: string, value: unknown): unknown {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    cards[0].srs = { ...(cards[0].srs as Record<string, unknown>), [field]: value };
    return raw;
  }

  function rejectPath(raw: unknown, path: string): void {
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(path);
  }

  it('ease 必须有限正数：-8 / 0 / NaN 拒，路径 cards[0].srs.ease', () => {
    for (const v of [-8, 0, Number.NaN]) rejectPath(withSrs('ease', v), 'cards[0].srs.ease');
    expect(validateSave(withSrs('ease', 1.3) as never).ok).toBe(true);
  });

  it('interval：≥1 天必须整数（2.7 拒），亚日级小数合法（sm2 分钟级设计）', () => {
    rejectPath(withSrs('interval', 2.7), 'cards[0].srs.interval');
    rejectPath(withSrs('interval', -1), 'cards[0].srs.interval');
    // sm2 明确「天级取整、分钟级保留小数」（firstInterval=10/60）——不得误杀亚日间隔
    expect(validateSave(withSrs('interval', 10 / 60) as never).ok).toBe(true);
    expect(validateSave(withSrs('interval', 0.4) as never).ok).toBe(true);
    expect(validateSave(withSrs('interval', 3) as never).ok).toBe(true);
    rejectPath(withSrs('reps', 1.5), 'cards[0].srs.reps');
    rejectPath(withSrs('lapses', -3), 'cards[0].srs.lapses');
    for (const f of ['interval', 'reps', 'lapses']) {
      expect(validateSave(withSrs(f, 0) as never).ok).toBe(true);
    }
  });

  it('meta.plays 必须非负整数：-1e9 / 0.4 拒', () => {
    for (const v of [-1e9, 0.4]) {
      const raw = sample();
      (raw.meta as Record<string, unknown>).plays = v;
      rejectPath(raw, 'meta.plays');
    }
  });

  it('effectiveReviewDays 长度 ≤ MAX_EFFECTIVE_DAYS(400)：401 拒、400 过', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return d;
    });
    rejectPath(withSrs('effectiveReviewDays', mk(MAX_EFFECTIVE_DAYS + 1)), 'cards[0].srs.effectiveReviewDays');
    expect(validateSave(withSrs('effectiveReviewDays', mk(MAX_EFFECTIVE_DAYS)) as never).ok).toBe(true);
  });

  it('日键须是真实历法日期：形状外/月份越界/不存在的 2 月 30 日均拒', () => {
    for (const bad of ['9999-99-99', '2025-02-30', '2025-13-01', '2024-02-30', '2025-1-1', '25-01-01', '2025-01-01x']) {
      rejectPath(withSrs('effectiveReviewDays', [bad]), 'cards[0].srs.effectiveReviewDays[0]');
    }
    // 闰年 2024-02-29 合法
    expect(validateSave(withSrs('effectiveReviewDays', ['2024-02-29']) as never).ok).toBe(true);
  });

  it('时间戳限 Date 可表示范围（±8.64e15）：due 超界拒且 JSON 往返同样拦下', () => {
    rejectPath(withSrs('due', 1e18), 'cards[0].srs.due');
    rejectPath(withSrs('due', -8.64e15 - 1), 'cards[0].srs.due');
    // JSON 往返后 Infinity→null（类型检查）、超界大数原样保留（范围检查）——两路都要拒
    const viaJson = validateSave(JSON.parse(JSON.stringify(withSrs('due', 1e18))));
    expect(viaJson.ok).toBe(false);
    if (!viaJson.ok) expect(viaJson.reason).toContain('cards[0].srs.due');
    // 边界内合法
    expect(validateSave(withSrs('due', 8.64e15) as never).ok).toBe(true);
  });

  it('source.createdAt / purifiedAt / meta.savedAt 同样受时间戳范围约束', () => {
    const raw = sample();
    const cards = raw.cards as Record<string, unknown>[];
    cards[0].source = { type: 'manual', createdAt: 9e18 };
    rejectPath(raw, 'cards[0].source.createdAt');

    const raw2 = sample();
    (raw2.decks as Record<string, unknown>[])[1].purifiedAt = Infinity;
    rejectPath(raw2, 'decks[1].purifiedAt');

    const raw3 = sample();
    (raw3.meta as Record<string, unknown>).savedAt = -1e18;
    rejectPath(raw3, 'meta.savedAt');
  });
});

// ---------------------------------------------------------------------------
// migrateSave —— 旧档补默认（RF#4：v2.1 之前的存档导入后能正常开局）
// 两层分工（brief Step 1 既定语义，勿混）：validate 拒缺 battle；migrate 负责补。
// ---------------------------------------------------------------------------

describe('migrateSave', () => {
  it('旧形状档（无 battle）→ validate 先拒 → migrate 注入 {battle:{defaultPoolSize:15}} 后再 validate 过', () => {
    const raw = legacySample();
    expect(validateSave(raw).ok).toBe(false);
    const save = migrateSave(raw);
    expect(save.settings.battle).toEqual({ defaultPoolSize: 15 });
    expect(validateSave(save).ok).toBe(true);
  });

  it('迁移保留其余字段原值（plays/deckId 引用均不丢），schemaVersion 仍恰为 1', () => {
    const raw = legacySample();
    const save = migrateSave(raw);
    expect(save.schemaVersion).toBe(1);
    expect(save.meta.plays).toBe((raw.meta as { plays: number }).plays);
    expect(save.cards.map((c) => c.deckId)).toEqual(['d1', 'd1', 'd2', 'd2']);
    expect(save.settings.bossThresholdTier).toBe(30);
    // 不发明新顶层字段：键集与规范 SaveFile 完全一致
    expect(Object.keys(save).sort()).toEqual(['cards', 'decks', 'meta', 'schemaVersion', 'settings']);
  });

  it('新档幂等：migrate(migrate(x)) deepEqual migrate(x)；已是新档时同引用返回、零 mutate', () => {
    const fresh = validSave();
    const once = migrateSave(fresh);
    expect(once).toBe(fresh); // 现状核实：validateSave 容忍未知多余键且同引用返回，故无需拷贝重建
    expect(migrateSave(once)).toEqual(once);
    expect(migrateSave(once)).toBe(once);
    // 深比较版幂等（对 JSON 克隆同样成立）
    const cloned = JSON.parse(JSON.stringify(fresh));
    const m1 = migrateSave(cloned);
    expect(migrateSave(m1)).toEqual(m1);
  });

  it('畸形档（非仅缺 battle）→ 抛可读错误，reason 含 JSON 路径', () => {
    const raw = sample();
    (raw.cards as Record<string, unknown>[])[3].deckId = 'ghost';
    let msg = '';
    try {
      migrateSave(raw);
      expect.unreachable('应抛出');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('cards[3].deckId');
    expect(msg).toContain('ghost');
  });

  it('battle.defaultPoolSize=99（域外）→ migrate 拒绝而非消毒改写——域检查归 validateSave', () => {
    const raw = sample();
    (raw.settings as Record<string, Record<string, unknown>>).battle = { defaultPoolSize: 99 };
    expect(() => migrateSave(raw)).toThrow(/settings\.battle\.defaultPoolSize/);
  });

  it('JSON 文本往返（导入真实形态）：旧档 parse→migrate→validate 过', () => {
    const text = JSON.stringify(legacySample());
    const save = migrateSave(JSON.parse(text));
    expect(validateSave(save).ok).toBe(true);
    expect(save.settings.battle.defaultPoolSize).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// serializeSave
// ---------------------------------------------------------------------------

describe('serializeSave', () => {
  it('2 空格缩进、含 exportedAt（派生自 meta.savedAt，core 不读时钟）', () => {
    const text = serializeSave(validSave());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.exportedAt).toBe(T0);
    expect(text).toContain('\n  "schemaVersion": 1'); // 2 空格缩进证据
  });

  it('序列化→解析→校验→落盘 往返：存档本体与原档 deepEqual', async () => {
    const f = validSave();
    const r = validateSave(JSON.parse(serializeSave(f)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // exportedAt 是导出信封字段，经 importAndSave 落盘后不应残留在存储里
    const store = createMemoryStorage();
    await importAndSave(serializeSave(f), store);
    expect(await store.load()).toEqual(f);
  });
});

// ---------------------------------------------------------------------------
// importAndSave —— Review Focus #2：任一步失败不落盘
// ---------------------------------------------------------------------------

async function storeWithOld(): Promise<GameStorage> {
  const store = createMemoryStorage();
  await store.save(validSave());
  return store;
}

describe('importAndSave', () => {
  it('落盘值等于剔除 exportedAt 后的存档本体（信封不残留）', async () => {
    const store = await storeWithOld();
    const incoming = validSave();
    incoming.meta.plays = 99;
    expect(await importAndSave(serializeSave(incoming), store)).toEqual({ ok: true });
    expect(await store.load()).toEqual(incoming);
  });

  it('合法文本 → ok:true 且落盘进度完整（plays/deckId 引用均保真）', async () => {
    const store = await storeWithOld();
    const incoming = validSave();
    incoming.meta.plays = 99;
    const r = await importAndSave(serializeSave(incoming), store);
    expect(r.ok).toBe(true);
    const loaded = await store.load();
    expect(loaded?.meta.plays).toBe(99);
    expect(loaded?.cards.map((c) => c.deckId)).toEqual(['d1', 'd1', 'd2', 'd2']);
  });

  it('非 JSON 文本 → reject 不抛裸异常，旧值完好', async () => {
    const store = await storeWithOld();
    const before = await store.load();
    const r = await importAndSave('<html>404 Not Found</html>', store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('JSON');
    expect(await store.load()).toEqual(before);
  });

  it('JSON 但结构畸形 → 整包拒绝，reason 透传校验器路径，旧值完好', async () => {
    const store = await storeWithOld();
    const before = await store.load();
    const bad = sample();
    (bad.cards as Record<string, unknown>[])[3].deckId = 'nowhere';
    const r = await importAndSave(JSON.stringify(bad), store);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('cards[3].deckId');
      expect(r.reason).toContain('nowhere');
    }
    expect(await store.load()).toEqual(before);
  });

  it('未来 schemaVersion → 拒绝提示升级，旧值完好', async () => {
    const store = await storeWithOld();
    const before = await store.load();
    const future = sample();
    future.schemaVersion = 999;
    const r = await importAndSave(JSON.stringify(future), store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/升级|更新/);
    expect(await store.load()).toEqual(before);
  });

  it('store.save 抛错（配额满形态）→ 捕获为 ok:false，绝不无声成功', async () => {
    const good = serializeSave(validSave());
    const broken: GameStorage = {
      kind: 'memory',
      load: async () => null,
      save: async () => {
        throw new Error('QuotaExceededError: storage full');
      },
      clear: async () => {},
    };
    const r = await importAndSave(good, broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('QuotaExceededError');
  });

  it('空串 / 纯空白 → 拒绝为 JSON 解析失败，不抛', async () => {
    const store = await storeWithOld();
    for (const text of ['', '   ']) {
      const r = await importAndSave(text, store);
      expect(r.ok).toBe(false);
    }
  });
});
