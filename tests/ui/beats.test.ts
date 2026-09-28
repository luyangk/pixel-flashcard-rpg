// @vitest-environment happy-dom
/**
 * tests/ui/beats.test.ts —— Plan 4 · T6：战报碎片池（LORE §5.2）。
 *
 * 契约（brief Interfaces + LORE §5.2）：
 * - `nextBeat(pool, cursor)` 抽完重置：**一轮内普通碎片各出现一次**（不重复），
 *   一轮抽满后自动重置（下一轮照常出句，不空转、不卡死）；
 * - 暗线前奏（`arc:true`）按**权重**低频混入：3 条 arc × 0.25 权重 ⇒ 每轮 1 条
 *   （≈3.6% 的抽取），普通碎片的覆盖名额不被它占掉；
 * - `cursor` 是**累计抽取数**（单调递增，落盘到 `settings.story.beatIndex`）。
 *   单个整数游标无法持久化整张抽序，故排期由 (池长, 轮次) 确定性派生：
 *   同 (pool, cursor) 恒得同一句 —— 这也是本套件能判别实现的前提。
 *   脏游标 fail-closed（空句 + 原值退回），与写侧 `saveBeatCursor` 同口径。
 *
 * 判别力（T4/T5 教训②）：
 * - B#2 断言"抽满一轮后再抽仍得池内句子"：朴素 `pool[cursor]`（无重置）实现必红；
 * - B#6/B#7 断言每轮恰 1 条 arc、280 抽恰 10 条：把 arc 当普通条目同权乱排的
 *   实现会得 ~28 条 ⇒ 必红；
 * - B#10 断言脏游标不出句：把脏游标归一成 0 的 fail-open 实现必红。
 *
 * 本文件不碰 DOM（beats.ts 是纯函数）：per-file happy-dom 仅为与 T6 另一测试文件
 * 保持同一环境口径，不给全局 config 添分支。
 */
import { describe, expect, it } from 'vitest';
import { nextBeat, type BeatTemplate } from '../../src/ui/beats';
import beatsJson from '../../assets/narrative/beats.json';

/* ------------------------------------------------------------------ 夹具 */

const NORMAL_TEXTS = [
  '甲句一',
  '乙句二',
  '丙句三',
  '丁句四',
  '戊句五',
  '己句六',
  '庚句七',
] as const;

const ARC_TEXTS = ['暗线甲', '暗线乙', '暗线丙'] as const;

/** 7 普通 + 3 暗线的混合池（小规模等比例版：权重口径下每轮 ≈0.26 条 arc）。 */
function mixedPool(): BeatTemplate[] {
  return [
    ...NORMAL_TEXTS.map((text) => ({ text })),
    ...ARC_TEXTS.map((text) => ({ text, arc: true })),
  ];
}

/** 27 普通 + 3 暗线：与 assets/narrative/beats.json 同规模，权重口径 ⇒ 每轮 1 条 arc。 */
function realisticPool(): BeatTemplate[] {
  const normals = Array.from({ length: 27 }, (_, i) => ({ text: `普通-${i}` }));
  const arcs = ARC_TEXTS.map((text) => ({ text, arc: true }));
  return [...normals, ...arcs];
}

/* ------------------------------------------------------------------ 抽完重置 */

describe('nextBeat —— 抽完重置', () => {
  it('B#1 无暗线的字符串池：连抽一轮，池内每句恰出现一次（不重复）', () => {
    const pool = [...NORMAL_TEXTS];
    let cursor = 0;
    const got: string[] = [];
    for (let i = 0; i < pool.length; i++) {
      const draw = nextBeat(pool, cursor);
      got.push(draw.text);
      cursor = draw.next;
    }
    expect(new Set(got).size).toBe(pool.length); // 无重复
    expect([...got].sort()).toEqual([...pool].sort()); // 恰好全覆盖
  });

  it('B#2 抽满一轮后自动重置：再抽得池内句子、游标继续单调推进（朴素 pool[cursor] 实现必红）', () => {
    const pool = [...NORMAL_TEXTS];
    let cursor = 0;
    for (let i = 0; i < pool.length; i++) cursor = nextBeat(pool, cursor).next;

    const after = nextBeat(pool, cursor);
    expect(pool).toContain(after.text); // 旧式"游标即下标"实现此处得到 undefined ⇒ 红
    expect(after.next).toBe(cursor + 1); // 游标单调递增（累计抽取数），不是池内下标

    // 重置后的一整轮同样不重复
    const round: string[] = [after.text];
    cursor = after.next;
    for (let i = 1; i < pool.length; i++) {
      const d = nextBeat(pool, cursor);
      round.push(d.text);
      cursor = d.next;
    }
    expect(new Set(round).size).toBe(pool.length);
  });

  it('B#3 空池防御：返回空文本且游标不推进（不抛异常）', () => {
    expect(nextBeat([], 0)).toEqual({ text: '', next: 0 });
    expect(nextBeat([], 9)).toEqual({ text: '', next: 9 });
  });

  it('B#4 确定性：同 (pool, cursor) 两次调用结果逐字相同（落盘游标可复现的前提）', () => {
    const pool = mixedPool();
    for (const cursor of [0, 3, 11, 40, 123]) {
      const a = nextBeat(pool, cursor);
      const b = nextBeat(pool, cursor);
      expect(a).toEqual(b);
      expect(a.text).not.toBe('');
    }
  });

  it('B#10 脏游标 fail-closed：不出句、原值退回（与写侧 saveBeatCursor 同口径；"按 0 重来"必红）', () => {
    const pool = mixedPool();
    for (const dirty of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // 旧实现把脏游标归一成 0 ⇒ 此处会拿到非空句子 + next=1，必红
      expect(nextBeat(pool, dirty)).toEqual({ text: '', next: dirty });
    }
    // 0 是合法的"从未抽过"，不能跟着一起被拒（防"一律拒绝"的过度修复）
    expect(nextBeat(pool, 0).text).not.toBe('');
  });

  it('B#5 字符串池与对象池等价：同一个池两种写法得同一抽序（brief 的 readonly string[] 签名仍成立）', () => {
    const asObjects: BeatTemplate[] = NORMAL_TEXTS.map((text) => ({ text }));
    let c1 = 0;
    let c2 = 0;
    for (let i = 0; i < NORMAL_TEXTS.length; i++) {
      const a = nextBeat(asObjects, c1);
      const b = nextBeat([...NORMAL_TEXTS], c2);
      expect(a.text).toBe(b.text);
      c1 = a.next;
      c2 = b.next;
    }
  });
});

/* ------------------------------------------------------------------ 暗线低频混入 */

describe('nextBeat —— 暗线前奏按权重低频混入', () => {
  it('B#6 一轮内普通碎片恰好各一次 + 恰 1 条暗线（同权乱排实现必红）', () => {
    const pool = realisticPool();
    const normals = new Set(pool.filter((e) => !e.arc).map((e) => e.text));
    const arcs = new Set(pool.filter((e) => e.arc).map((e) => e.text));

    let cursor = 0;
    const seen = new Set<string>();
    let arcCount = 0;
    while (seen.size < normals.size) {
      const draw = nextBeat(pool, cursor);
      cursor = draw.next;
      if (arcs.has(draw.text)) {
        arcCount += 1;
      } else {
        expect(seen.has(draw.text)).toBe(false); // 普通碎片轮内不重复
        seen.add(draw.text);
      }
      expect(cursor).toBeLessThan(10_000); // 死循环护栏：实现若永不覆盖全池即在此炸
    }
    // 权重口径（3 条 × 0.25 ⇒ 每轮期望 0.75 ⇒ 取整 1 条）：
    // 把 arc 与普通条目同权乱排的实现在覆盖 27 条普通碎片时会混入 ~2.7 条 ⇒ 必红。
    expect(arcCount).toBe(1);
  });

  it('B#7 280 抽（≈10 轮）恰 10 条暗线：低频是权重结论，不是"顺带混进去"', () => {
    const pool = realisticPool();
    let cursor = 0;
    let arcCount = 0;
    for (let i = 0; i < 280; i++) {
      const draw = nextBeat(pool, cursor);
      cursor = draw.next;
      if (ARC_TEXTS.includes(draw.text as (typeof ARC_TEXTS)[number])) arcCount += 1;
    }
    expect(arcCount).toBe(10); // ≈3.6% 的抽取是暗线
    expect(arcCount / 280).toBeLessThan(0.1); // 远低于"每轮 3 条"的 10.7%
  });

  it('B#8 暗线轮转：连续三轮各得不同的暗线句（暗线池抽完才回绕）', () => {
    const pool = realisticPool();
    const got = new Set<string>();
    let cursor = 0;
    // 一轮 = 27 普通 + 1 暗线 = 28 抽；取每轮第 27 抽附近的位置靠"全轮扫描"更稳，
    // 这里直接扫三轮并把出现的暗线收集起来。
    for (let i = 0; i < 28 * ARC_TEXTS.length; i++) {
      const draw = nextBeat(pool, cursor);
      cursor = draw.next;
      if (ARC_TEXTS.includes(draw.text as (typeof ARC_TEXTS)[number])) got.add(draw.text);
    }
    expect([...got].sort()).toEqual([...ARC_TEXTS].sort());
  });

  it('B#9 只有暗线的池也不崩：照常出句', () => {
    const pool: BeatTemplate[] = ARC_TEXTS.map((text) => ({ text, arc: true }));
    const draw = nextBeat(pool, 0);
    expect(ARC_TEXTS).toContain(draw.text);
    expect(draw.next).toBe(1);
  });
});

/* ------------------------------------------------------------------ 真实模板池（assets/narrative/beats.json） */

describe('assets/narrative/beats.json —— 模板池内容', () => {
  const beats: readonly BeatTemplate[] = beatsJson.beats;

  it('BJ#1 恰 30 条模板，文本互不重复、非空', () => {
    expect(beats).toHaveLength(30);
    const texts = beats.map((b) => b.text);
    expect(texts.every((t) => t.trim().length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(30);
  });

  it('BJ#2 每条 ≤30 字（LORE §5.2 语言规范）', () => {
    for (const b of beats) {
      expect([...b.text].length, `超长：${b.text}`).toBeLessThanOrEqual(30);
    }
  });

  it('BJ#3 暗线前奏 3–4 条且标记为 arc:true', () => {
    const arcs = beats.filter((b) => b.arc === true);
    expect(arcs.length).toBeGreaterThanOrEqual(3);
    expect(arcs.length).toBeLessThanOrEqual(4);
  });

  it('BJ#4 真实池抽 28 次（一轮）恰 1 条暗线、普通碎片互不重复', () => {
    const arcs = new Set(beats.filter((b) => b.arc === true).map((b) => b.text));
    let cursor = 0;
    let arcCount = 0;
    const normals = new Set<string>();
    for (let i = 0; i < 28; i++) {
      const draw = nextBeat(beats, cursor);
      cursor = draw.next;
      if (arcs.has(draw.text)) arcCount += 1;
      else normals.add(draw.text);
    }
    expect(arcCount).toBe(1);
    expect(normals.size).toBe(27);
  });
});
