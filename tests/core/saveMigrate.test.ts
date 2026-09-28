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
import { scoreRun, type RunRecord } from '@core/leaderboard';

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
      progress: { exp: 0 },
      // Plan 4 · T6：settings.story 是**必填**位（与 battle/progress 同构的三段式），
      // 夹具显式带上它——缺它 validateSave 会整包拒，而"当前形状的完整档"必须能过校验。
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
      // Plan 3 · T7：排行榜持久位。夹具显式带上它，三个理由：
      // ①它虽是可选字段，但 migrateSave 会为缺席档补 []——夹具缺席会让"新档同引用透传"
      //   与 backup 侧 toStrictEqual 逐键无损断言把归一化误读成丢字段；
      // ②它是当前形状的一部分，夹具应代表"当前形状的完整档"；
      // ③meta.lastExportedAt 刻意**不**在此列：缺席 = 从未导出，是合法且语义化的缺省。
      leaderboard: [],
    },
    meta: { savedAt: T0, plays: 7 },
  };
}

/** 一条合法榜单行（九字段；score 用 scoreRun 复算，避免手填失真）。 */
function runRow(over: Partial<RunRecord> = {}): RunRecord {
  const row: RunRecord = {
    id: 'run-1',
    at: T0,
    result: 'won',
    kind: 'encounter',
    domain: 'd1',
    cards: 10,
    misses: 2,
    level: 3,
    score: 0,
    ...over,
  };
  if (over.score === undefined) row.score = scoreRun(row);
  return row;
}

/** 取合法样本并把 settings.leaderboard 换成指定值（畸形/边界用例的唯一取证手段）。 */
function withLeaderboard(records: unknown): Record<string, unknown> {
  const raw = sample();
  (raw.settings as Record<string, unknown>).leaderboard = records;
  return raw;
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

/** T3 前的旧形状档：battle 在场但无 progress（progress 缺省迁移对象）。 */
function legacyProgressSample(): Record<string, unknown> {
  const raw = sample();
  delete (raw.settings as Record<string, unknown>).progress;
  return raw;
}

/**
 * 全缺旧形状档：battle / progress / leaderboard / story 四项皆缺（真实的 v2.1 前存档形态）。
 *
 * leaderboard 也在删除之列（T7 fix round 1，评审 M1）：sample() 派生自 validSave，
 * 而 validSave 自 T7 起自带 `leaderboard: []`——不删的话"双缺旧档补空榜"那条断言
 * 恒真（空数组对空数组），覆盖不到真正的注入路径。真实的 T7 前旧档当然也没有榜单。
 * story 同理（T6 起必须删）：它自 T6 起是必填位，"全缺旧档一次迁移补齐"这条链
 * （跨模块串联用例会 deepEqual `validSave()`）只有把 story 也删掉才覆盖得到注入路径。
 */
function legacyBothSample(): Record<string, unknown> {
  const raw = legacyProgressSample();
  const settings = raw.settings as Record<string, unknown>;
  delete settings.battle;
  delete settings.leaderboard;
  delete settings.story;
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

  /**
   * Plan 5 · T5：`deck.egg` 三段式第一段——**合法侧**（含码点边界）。
   * 判别力：把"≤200"写成"<200"（或按 `.length` 算 emoji）的实现在这一条上必红——
   * 200 个汉字必须过，且 200 个**码点**的 emoji 串也必须过（`.length` 会算出 400）。
   */
  it('egg 合法：普通短文过、恰 200 码点过（含代理对，按码点数不按 UTF-16 长度）', () => {
    const raw = sample();
    const decks = raw.decks as Record<string, unknown>[];
    decks[0].egg = '雷声与闪电本是同一件事。';
    decks[1].egg = '字'.repeat(200); // 恰在上限
    const r = validateSave(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save.decks[0].egg).toBe('雷声与闪电本是同一件事。');

    const raw2 = sample();
    (raw2.decks as Record<string, unknown>[])[0].egg = '⚡'.repeat(200); // 200 码点 = 400 UTF-16 长度
    expect(validateSave(raw2).ok).toBe(true);
  });

  /**
   * Plan 5 · T5 第二段：**在场严检**。非字符串 / 空串 / 只空白 / 超长（201 码点）一律整包拒，
   * 且 reason 带 `decks[i].egg` 路径。
   * 判别力：只做"是字符串就放行"的实现（无空值与长度检查）在这条上必红。
   */
  it('egg 非法：非字符串/空串/全空白/超 200 码点 → 拒且 reason 含 decks[i].egg', () => {
    const bads: unknown[] = [123, null, '', '   ', '\n\t ', 1, { text: 'x' }, '字'.repeat(201)];
    for (const bad of bads) {
      const raw = sample();
      (raw.decks as Record<string, unknown>[])[1].egg = bad;
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('decks[1].egg');
    }
  });

  it('egg 缺席不拒（可选位，与 bossName/purifiedAt 同性质）；migrateSave 也不补默认', () => {
    const raw = sample();
    const decks = raw.decks as Record<string, unknown>[];
    for (const d of decks) delete d.egg;
    const r = validateSave(raw);
    expect(r.ok).toBe(true);

    const migrated = migrateSave(raw);
    for (const d of migrated.decks) expect('egg' in d).toBe(false);
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

  // ---- progress 域（Plan 3 · T3，R-P3-a 三段式之严检层）----

  it('缺 settings.progress（T3 前旧形状）→ validate 拒且 reason 含路径与 migrateSave 指路', () => {
    const r = validateSave(legacyProgressSample());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('settings.progress');
      expect(r.reason).toContain('migrateSave');
    }
  });

  it('progress.exp=-1 / 2.5 / "100" / NaN → 拒绝且 reason 含路径 settings.progress.exp', () => {
    for (const v of [-1, 2.5, '100', NaN]) {
      const raw = sample();
      (raw.settings as Record<string, Record<string, unknown>>).progress = { exp: v };
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.progress.exp');
    }
  });

  it('progress 整体非对象（数组/字符串）→ 路径 settings.progress；exp=0 合法', () => {
    const raw = sample();
    (raw.settings as Record<string, unknown>).progress = [0];
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('settings.progress');
    const raw2 = sample();
    (raw2.settings as Record<string, unknown>).progress = 'x';
    expect(validateSave(raw2).ok).toBe(false);
    const okRaw = sample();
    (okRaw.settings as Record<string, Record<string, unknown>>).progress = { exp: 0 };
    expect(validateSave(okRaw).ok).toBe(true);
  });

  // ---- story 域（Plan 4 · T6，R-P4-preflight-c 三段式之严检层）----

  it('缺 settings.story（T6 前旧形状）→ validate 拒且 reason 含路径与 migrateSave 指路', () => {
    const raw = sample();
    delete (raw.settings as Record<string, unknown>).story;
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('settings.story');
      expect(r.reason).toContain('migrateSave');
    }
  });

  it('story 域畸形：prologueSeen 非布尔 / beatIndex 为负、小数、字符串 → 拒且带路径', () => {
    const bad = [
      { prologueSeen: 'true', beatIndex: 0 },
      { prologueSeen: 1, beatIndex: 0 },
      { prologueSeen: false, beatIndex: -1, arcSeen: 0 },
      { prologueSeen: false, beatIndex: 2.5, arcSeen: 0 },
      { prologueSeen: false, beatIndex: '0', arcSeen: 0 },
    ];
    for (const story of bad) {
      const raw = sample();
      (raw.settings as Record<string, unknown>).story = story;
      const r = validateSave(raw);
      expect(r.ok, JSON.stringify(story)).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.story.');
    }
    // story 整体非对象同样拒（域检查归校验器，不做消毒改写）
    const raw2 = sample();
    (raw2.settings as Record<string, unknown>).story = [false, 0];
    expect(validateSave(raw2).ok).toBe(false);
    // 合法边界：prologueSeen=true、beatIndex=0 与较大整数均过
    const okRaw = sample();
    (okRaw.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 12345, arcSeen: 0 };
    expect(validateSave(okRaw).ok).toBe(true);
  });

  it('arcSeen 域（T8 扩位）：-1 / 4 / 1.5 / 字符串 / 缺席都拒且带路径；0 与 3 是合法边界', () => {
    // 缺席（T6/T7 形状）走 validate 的"严检"面：整包拒、reason 带路径与 migrate 指路
    const missing = sample();
    (missing.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 3 };
    const missRes = validateSave(missing);
    expect(missRes.ok).toBe(false);
    if (!missRes.ok) expect(missRes.reason).toContain('settings.story.arcSeen');

    for (const arcSeen of [-1, 4, 1.5, '0', null]) {
      const raw = sample();
      (raw.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 0, arcSeen };
      const r = validateSave(raw);
      expect(r.ok, `arcSeen=${String(arcSeen)} 应被拒`).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.story.arcSeen');
    }

    for (const arcSeen of [0, 3]) {
      const raw = sample();
      (raw.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 0, arcSeen };
      expect(validateSave(raw).ok, `arcSeen=${arcSeen} 应合法`).toBe(true);
    }
  });

  it('arcSeen 三段式（T8 评审判 C-1）：T6/T7 形状档（story 在场但缺 arcSeen）必须能被迁移补 0', () => {
    // 这正是"升级即只读闩锁"的病灶：schemaVersion 仍是 1，所以这种档真实存在于用户设备上
    const t6Shape = sample();
    (t6Shape.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 3 };
    expect(validateSave(t6Shape).ok).toBe(false); // 校验面：缺席整包拒

    const migrated = migrateSave(t6Shape);
    expect(migrated.settings.story).toEqual({ prologueSeen: true, beatIndex: 3, arcSeen: 0 }); // 迁移面：只补缺的那个键
    expect(validateSave(migrated).ok).toBe(true);
    (t6Shape.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 3, arcSeen: 0 };
    expect(migrateSave(t6Shape).settings.story).toEqual({ prologueSeen: true, beatIndex: 3, arcSeen: 0 });

    // 迁移不得"消毒改写"已畸形的 arcSeen（域检查归校验器）
    const dirty = sample();
    (dirty.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 0, arcSeen: 9 };
    expect(() => migrateSave(dirty)).toThrow();

    // 迁移后与入参不共享引用（改一份不污染另一份）
    const shared = sample();
    (shared.settings as Record<string, unknown>).story = { prologueSeen: false, beatIndex: 0 };
    const a = migrateSave(shared);
    a.settings.story.arcSeen = 3;
    expect(migrateSave(shared).settings.story.arcSeen).toBe(0);
  });

  it('meta.savedAt 类型错 → 路径 meta.savedAt', () => {
    const raw = sample();
    (raw.meta as Record<string, unknown>).savedAt = 'yesterday';
    const r = validateSave(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('meta.savedAt');
  });

  // ---- settings.leaderboard 域（Plan 3 · T7，R-P3-a 三段式之"在场严检"层）----

  it('leaderboard 缺席合法（可选位）：旧档不因缺榜单被拒；空数组同样合法', () => {
    const raw = sample();
    delete (raw.settings as Record<string, unknown>).leaderboard;
    expect(validateSave(raw).ok).toBe(true);
    expect(validateSave(withLeaderboard([])).ok).toBe(true);
  });

  it('合法榜单行通过：九字段逐项（id/at/result/kind/domain/cards/misses/level/score）', () => {
    const row = runRow();
    expect(Object.keys(row)).toHaveLength(9); // 九字段口径的活证据：新增字段必须同步校验
    expect(validateSave(withLeaderboard([row, runRow({ id: 'run-2', result: 'lost', score: 0 })])).ok).toBe(true);
  });

  it('leaderboard 非数组（对象/字符串/数字）→ 拒且路径 settings.leaderboard', () => {
    for (const bad of [{}, 'top', 42]) {
      const r = validateSave(withLeaderboard(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.leaderboard');
    }
  });

  it('leaderboard[0].score=-1 → 拒且 reason 恰含该 JSON 路径（brief 钉死用例）', () => {
    const r = validateSave(withLeaderboard([runRow({ score: -1 })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('settings.leaderboard[0].score');
    // 小数同样拒（分数是整数域：scoreRun 输出恒非负整数）
    const frac = validateSave(withLeaderboard([runRow({ score: 40.5 })]));
    expect(frac.ok).toBe(false);
    if (!frac.ok) expect(frac.reason).toContain('settings.leaderboard[0].score');
  });

  it('cards/misses/level 负数或小数 → 各自带路径拒绝', () => {
    for (const [field, bad] of [['cards', -1], ['misses', 1.5], ['level', -3]] as const) {
      const r = validateSave(withLeaderboard([runRow({ [field]: bad })]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(`settings.leaderboard[0].${field}`);
    }
  });

  it('result/kind 枚举外值 → 路径 .result / .kind', () => {
    const r1 = validateSave(withLeaderboard([runRow({ result: 'draw' as never })]));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('settings.leaderboard[0].result');
    const r2 = validateSave(withLeaderboard([runRow({ kind: 'raid' as never })]));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('settings.leaderboard[0].kind');
  });

  it('id/domain 空串或非字符串 → 路径 .id / .domain', () => {
    const r1 = validateSave(withLeaderboard([runRow({ id: '' })]));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('settings.leaderboard[0].id');
    const r2 = validateSave(withLeaderboard([runRow({ domain: 7 as never })]));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('settings.leaderboard[0].domain');
  });

  it('at 非时间戳（字符串/NaN/超界）→ 路径 .at；元素非对象同样给下标路径', () => {
    for (const bad of ['today', Number.NaN, 1e18]) {
      const r = validateSave(withLeaderboard([runRow({ at: bad as never })]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('settings.leaderboard[0].at');
    }
    const r2 = validateSave(withLeaderboard([null, runRow()]));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('settings.leaderboard[0]');
  });

  // ---- meta.lastExportedAt 域（Plan 3 · T7，R-T5-p3-a 三段式之"在场严检"层）----

  it('lastExportedAt 缺席合法（= 从未导出）；0 与普通时间戳合法', () => {
    const absent = sample();
    delete (absent.meta as Record<string, unknown>).lastExportedAt;
    expect(validateSave(absent).ok).toBe(true);
    for (const good of [0, T0]) {
      const raw = sample();
      (raw.meta as Record<string, unknown>).lastExportedAt = good;
      expect(validateSave(raw).ok).toBe(true);
    }
  });

  it('lastExportedAt 非法（-1/-Infinity/NaN/Infinity/"now"/超界）→ 拒且路径 meta.lastExportedAt', () => {
    for (const bad of [-1, Number.NEGATIVE_INFINITY, Number.NaN, Number.POSITIVE_INFINITY, 'now', 1e300]) {
      const raw = sample();
      (raw.meta as Record<string, unknown>).lastExportedAt = bad;
      const r = validateSave(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('meta.lastExportedAt');
    }
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

  // ---- progress 缺省迁移（Plan 3 · T3）----

  it('T3 前旧形状档（有 battle 无 progress）→ validate 拒 → migrate 补 {exp:0} 后过', () => {
    const raw = legacyProgressSample();
    expect(validateSave(raw).ok).toBe(false);
    const save = migrateSave(raw);
    expect(save.settings.progress).toEqual({ exp: 0 });
    expect(save.settings.battle).toEqual({ defaultPoolSize: 15 }); // 原值不被动
    expect(validateSave(save).ok).toBe(true);
  });

  it('双缺旧档（battle、progress 皆无）→ 一次 migrate 两项默认全补', () => {
    const raw = legacyBothSample();
    const save = migrateSave(raw);
    expect(save.settings.battle).toEqual({ defaultPoolSize: 15 });
    expect(save.settings.progress).toEqual({ exp: 0 });
    expect(validateSave(save).ok).toBe(true);
    // 幂等：migrate(migrate(x)) deepEqual migrate(x)
    expect(migrateSave(save)).toEqual(save);
  });

  it('progress.exp=2.5 / -1（域外）→ migrate 拒绝而非消毒改写——域检查归 validateSave', () => {
    for (const v of [2.5, -1]) {
      const raw = sample();
      (raw.settings as Record<string, Record<string, unknown>>).progress = { exp: v };
      expect(() => migrateSave(raw)).toThrow(/settings\.progress\.exp/);
    }
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

  // RF#4 全链回归网（T8 deferred 捎带，评审 Minor#3）：legacy 形状文本经
  // migrate→importAndSave 一路到 load，落盘读回必须是补齐 battle 的完整新形状。
  // 本用例是纯 core+memory 载体，不触 DOM/IDB——"正常开局"的地基钉进回归网。
  it('跨模块串联：legacy 文本 → validate 拒 → migrateSave → importAndSave → load 得完整新形状', async () => {
    const legacyText = serializeSave(migrateSave(legacyBothSample())); // 迁移后导出形态（双缺真实旧档形）
    expect(validateSave(JSON.parse(JSON.stringify(legacyBothSample()))).ok).toBe(false); // 原 legacy 仍被拒
    const store = createMemoryStorage();
    expect(await importAndSave(legacyText, store)).toEqual({ ok: true });
    const loaded = await store.load();
    expect(loaded).toEqual(validSave()); // deepEqual 完整新形状（含 battle + progress 默认）
    expect(loaded?.settings.battle).toEqual({ defaultPoolSize: 15 });
    expect(loaded?.settings.progress).toEqual({ exp: 0 });
  });

  // ---- leaderboard / lastExportedAt 扩域（Plan 3 · T7，R-P3-a 三段式之"migrate 补默认"层）----

  it('旧档缺 leaderboard → migrate 补 []；validate 前后皆过（可选位归一化，不是整包拒绝点）', () => {
    // 与 battle/progress 的分工差异：缺它**不拒**——只有 T7 前写下的档缺这个字段，
    // 做成拒绝点会把那些存档全部锁死（RF#4 的反面）。
    const raw = sample();
    delete (raw.settings as Record<string, unknown>).leaderboard;
    expect(validateSave(raw).ok).toBe(true);
    const save = migrateSave(raw);
    expect(save.settings.leaderboard).toEqual([]);
    expect(validateSave(save).ok).toBe(true);
    // 双缺旧档（battle/progress/leaderboard 皆无）一次迁移三项全补
    expect(migrateSave(legacyBothSample()).settings.leaderboard).toEqual([]);
  });

  // ---- story 扩域（Plan 4 · T6，R-P4-preflight-c 三段式之"migrate 补默认"层）----

  it('旧档缺 story → validate 拒 → migrate 补 {prologueSeen:false,beatIndex:0,arcSeen:0} 后过', () => {
    const raw = sample();
    delete (raw.settings as Record<string, unknown>).story;
    expect(validateSave(raw).ok).toBe(false); // 必填位：缺席整包拒
    const save = migrateSave(raw);
    expect(save.settings.story).toEqual({ prologueSeen: false, beatIndex: 0, arcSeen: 0 });
    expect(validateSave(save).ok).toBe(true);
    // 全缺旧档（battle/progress/leaderboard/story 皆无）一次迁移四项全补
    expect(migrateSave(legacyBothSample()).settings.story).toEqual({
      prologueSeen: false,
      beatIndex: 0,
      arcSeen: 0,
    });
  });

  it('已含 story 的新档：migrate 同引用透传、story 逐字不动（含非默认值）', () => {
    const fresh = validSave();
    fresh.settings.story = { prologueSeen: true, beatIndex: 42, arcSeen: 0 };
    const once = migrateSave(fresh);
    expect(once).toBe(fresh); // 四档皆在场 ⇒ 零拷贝透传
    expect(once.settings.story).toEqual({ prologueSeen: true, beatIndex: 42, arcSeen: 0 });
  });

  it('迁移补的 story 与入参不共享引用（改一份不污染另一份）', () => {
    const raw = sample();
    delete (raw.settings as Record<string, unknown>).story;
    const a = migrateSave(raw);
    const b = migrateSave(raw);
    expect(a.settings.story).not.toBe(b.settings.story);
    a.settings.story.beatIndex = 7;
    expect(b.settings.story.beatIndex).toBe(0);
    expect(validateSave(b).ok).toBe(true);
  });

  it('非默认 story 经 serialize→parse→validate 逐字保真（三段式的往返钉）', () => {
    const fresh = validSave();
    fresh.settings.story = { prologueSeen: true, beatIndex: 9, arcSeen: 0 };
    const round = JSON.parse(serializeSave(fresh)) as Record<string, unknown>;
    const r = validateSave(round);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save.settings.story).toEqual({ prologueSeen: true, beatIndex: 9, arcSeen: 0 });
  });

  it('migrate 不补 meta.lastExportedAt：缺席即"从未导出"，不发明假时刻', () => {
    const save = migrateSave(legacyBothSample());
    expect('lastExportedAt' in save.meta).toBe(false);
    expect(save.meta).toEqual({ savedAt: T0, plays: 7 });
  });

  it('已含榜单的新档：migrate 同引用透传、榜单逐字不动（不重排/不消毒）', () => {
    const fresh = validSave();
    fresh.settings.leaderboard = [runRow({ id: 'kept' })];
    const once = migrateSave(fresh);
    expect(once).toBe(fresh);
    expect(once.settings.leaderboard).toStrictEqual(fresh.settings.leaderboard);
  });

  it('榜单行域外（score=-1）→ migrate 拒绝而非消毒改写（域检查归 validateSave）', () => {
    expect(() => migrateSave(withLeaderboard([runRow({ score: -1 })]))).toThrow(
      /settings\.leaderboard\[0\]\.score/,
    );
  });

  it('lastExportedAt 在场但非法 → migrate 拒绝（不静默丢弃/改写用户的"已备份"时刻）', () => {
    const raw = sample();
    (raw.meta as Record<string, unknown>).lastExportedAt = -1;
    expect(() => migrateSave(raw)).toThrow(/meta\.lastExportedAt/);
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
  /**
   * R-T11-p4-a（Plan 4 Global Constraints 的 FFW 带入项 + T8 评审 C-1 的第二半）：
   * 只校验不迁移的实现会把"上一版导出的备份"判成坏档——而那种档的 schemaVersion 仍是 1，
   * 用户完全看不出为什么打不开。本用例钉"导入链路先剔字段、再迁移、最后落盘"。
   */
  it('T6/T7 形状的旧备份（story 在场但缺 arcSeen）能被导入：补 0 后落盘并校验通过', async () => {
    const store = await storeWithOld();
    const old = sample();
    (old.settings as Record<string, unknown>).story = { prologueSeen: true, beatIndex: 3 };
    const text = JSON.stringify({ ...old, exportedAt: T0 });

    expect(await importAndSave(text, store)).toEqual({ ok: true });
    const loaded = await store.load();
    expect(loaded?.settings.story).toEqual({ prologueSeen: true, beatIndex: 3, arcSeen: 0 });
    expect(validateSave(loaded).ok).toBe(true);
    expect(loaded !== null && 'exportedAt' in loaded).toBe(false);
  });

  it('缺 battle 的 v2.1 前旧备份同样能被导入（迁移面不只覆盖 story）', async () => {
    const store = await storeWithOld();
    const text = serializeSave(migrateSave(legacyBothSample()));
    expect(await importAndSave(text, store)).toEqual({ ok: true });
    const loaded = await store.load();
    expect(validateSave(loaded).ok).toBe(true);
    expect(loaded?.settings.battle).toEqual({ defaultPoolSize: 15 });
  });

  it('落盘值等于剔除 exportedAt 后的存档本体（信封不残留）', async () => {
    const store = await storeWithOld();
    const incoming = validSave();
    incoming.meta.plays = 99;
    expect(await importAndSave(serializeSave(incoming), store)).toEqual({ ok: true });
    expect(await store.load()).toEqual(incoming);
  });

  /**
   * R-T7-p3-a（Plan 3 · T8 强制义务）：导入档来自他机/他时刻，其 meta.lastExportedAt
   * 记录的是**那台机器**的导出史——对本机不成立。故 importAndSave 在剥 exportedAt 信封的
   * 同时一并剔除该字段，落库形状回到"从未导出"。
   *
   * fail-safe 方向：剔除 ⇒ 提醒闸门视作从未导出 ⇒ 宁可多提醒一次，也不会让别人的时刻
   * 把本机的 7 天提醒静默关掉 7 天（这正是本义务的存在理由）。闸门侧闭环
   * （backupReminderDue(lastExportedAt ?? null, now) === true）属 app 层，由
   * tests/app/fullSession.smoke.test.ts SM#3 取证；此处只钉 core 侧事实：字段确已不在落库值里。
   */
  it('导入含 meta.lastExportedAt 的他机档 → 落库后该字段缺席，其余 meta 字段保真', async () => {
    const store = await storeWithOld();
    const incoming = validSave();
    incoming.meta.plays = 42;
    incoming.meta.lastExportedAt = T0 - 3 * 86_400_000; // 他机"3 天前备份过"
    expect(await importAndSave(serializeSave(incoming), store)).toEqual({ ok: true });
    const loaded = await store.load();
    expect(loaded?.meta.plays).toBe(42);
    expect(loaded?.meta.savedAt).toBe(incoming.meta.savedAt);
    // 字段缺席（不是 undefined 占位）：JSON 往返后 meta 键集恰为 {savedAt, plays}
    expect(loaded !== null && 'lastExportedAt' in loaded.meta).toBe(false);
    expect(Object.keys(loaded!.meta).sort()).toEqual(['plays', 'savedAt']);
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
