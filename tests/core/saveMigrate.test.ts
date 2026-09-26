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
import { exportAsJson, importAndSave, serializeSave, validateSave } from '@core/saveMigrate';

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
    },
    meta: { savedAt: T0, plays: 7 },
  };
}

/** 取合法样本的浅克隆，供逐字段 mutate 出畸形变体。 */
function sample(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validSave()));
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

describe('exportAsJson', () => {
  it('文件名带本地日键与 .json 后缀，内容可回灌校验通过', () => {
    const { filename, text } = exportAsJson(validSave(), 1762008000000); // UTC+8 → 2025-11-02
    expect(filename).toMatch(/^pixel-flashcard-save-\d{4}-\d{2}-\d{2}\.json$/);
    expect(validateSave(JSON.parse(text)).ok).toBe(true);
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
