/**
 * tests/core/choices.test.ts —— Plan 6 · T1：选择题生成（选项三级来源 + 标签截断去重）。
 *
 * 这一组守的是"作答真的有验证"里的第一环：**选项得凑得出、凑得对、在屏上分得清**。
 * 判别力（每条都写清"坏实现为何必红"）：
 * - CHO#1/CHO#2 **卡上自带的 `choices` 优先**（D41：干扰项在生成卡那一刻产出并随卡保存，
 *   复习时不再临时调模型）——把 `pool` 排在 `stored` 前面的实现必红；
 * - CHO#5 干扰项被去重到空 ⇒ `null`（返回"只有正确答案一项"的实现必红：那就不是选择题了）；
 * - CHO#6 洗牌必须用**注入的 rng**（core 禁 Math.random；用全局随机的实现在同种子下不可复现 ⇒ 红）；
 * - CHO#8 **标签去重**：两个前 40 字相同的长选项截断后会变成"两个一模一样的选项"，
 *   必须自动加长到能区分（只做 `slice` 的实现在这条上必红）；
 * - CHO#9 截断按**码点**（切坏代理对会产出乱码选项）。
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@core/rng';
import {
  CHOICE_COUNT_DEFAULT,
  CHOICE_LABEL_MAX,
  buildChoices,
  previewLabel,
} from '../../src/core/choices';

const ANSWER = '杜甫';

describe('buildChoices —— 选项三级来源', () => {
  it('CHO#1 四选项、含正确答案一次，且 correctIndex 指的就是它', () => {
    const set = buildChoices({
      answer: ANSWER,
      stored: ['李白', '王维', '白居易'],
      rng: mulberry32(1),
    });
    expect(set).not.toBeNull();
    if (!set) return;
    expect(set.options).toHaveLength(CHOICE_COUNT_DEFAULT);
    expect(set.options.filter((o) => o === ANSWER)).toHaveLength(1);
    expect(set.options[set.correctIndex]).toBe(ANSWER);
    // labels 与 options 一一对应（屏上显示 labels，提交按 index 取 options）
    expect(set.labels).toHaveLength(set.options.length);
    expect(set.labels[set.correctIndex]).toBe(ANSWER);
  });

  it('CHO#2 卡上自带的 choices 优先于 pool（同一 rng 下两条来源产出不同选项）', () => {
    const input = { answer: ANSWER, count: 3, rng: mulberry32(42) } as const;
    const fromStored = buildChoices({ ...input, stored: ['李白', '王维'], rng: mulberry32(42) });
    const fromPool = buildChoices({ ...input, pool: ['李白', '王维'], rng: mulberry32(42) });
    // 两条来源都只用各自的候选，所以选项集合相同；关键差别在**来源被用到了**：
    // stored 在场时 pool 里的内容不该出现
    const mixed = buildChoices({
      answer: ANSWER,
      stored: ['李白'],
      pool: ['苏轼'],
      count: 3,
      rng: mulberry32(7),
    });
    expect(fromStored?.options.slice().sort()).toEqual(fromPool?.options.slice().sort());
    expect(mixed?.options).toContain('李白');
    expect(mixed?.options).toContain('苏轼'); // stored 不够时用 pool 补
    // **优先级取证**：只要一个干扰项时，拿到的必须是 stored 那条（把 pool 排在前面的实现必红）
    const one = buildChoices({ answer: ANSWER, stored: ['李白'], pool: ['王维', '白居易'], count: 2, rng: mulberry32(11) });
    expect(one?.options).toHaveLength(2);
    expect(one?.options).toContain('李白');
    expect(one?.options).not.toContain('王维');
    expect(one?.options).not.toContain('白居易');
  });

  it('CHO#3 stored 只有 1 条 ⇒ 用 pool 补到目标数量', () => {
    const set = buildChoices({
      answer: ANSWER,
      stored: ['李白'],
      pool: ['王维', '白居易', '苏轼'],
      count: 4,
      rng: mulberry32(3),
    });
    expect(set?.options).toHaveLength(4);
    expect(set?.options).toContain(ANSWER);
    expect(set?.options).toContain('李白'); // stored 优先
    // pool 里的两条是洗牌后取的 ⇒ 只断言"来自 pool 且不重复"
    const fromPool = set?.options.filter((o) => o !== ANSWER && o !== '李白') ?? [];
    expect(fromPool).toHaveLength(2);
    expect(fromPool.every((o) => ['王维', '白居易', '苏轼'].includes(o))).toBe(true);
  });

  it('CHO#4 空/空白 answer ⇒ null（这种卡不该出选择题）', () => {
    for (const answer of ['', '   ', '\n\t']) {
      expect(buildChoices({ answer, stored: ['李白', '王维'], rng: mulberry32(1) })).toBeNull();
    }
  });

  it('CHO#5 干扰项全被去重掉（空串 / 与答案相同 / 互相重复）⇒ null', () => {
    expect(buildChoices({ answer: ANSWER, stored: [], rng: mulberry32(1) })).toBeNull();
    expect(buildChoices({ answer: ANSWER, stored: ['', '  '], rng: mulberry32(1) })).toBeNull();
    expect(buildChoices({ answer: ANSWER, stored: [' 杜甫 ', '杜甫'], rng: mulberry32(1) })).toBeNull();
  });

  it('CHO#6 洗牌用注入的 rng：同种子同顺序、不同种子至少一次不同', () => {
    const args = { answer: ANSWER, stored: ['李白', '王维', '白居易'], count: 4 } as const;
    // 同种子 → 同结果：8 组独立复现（用全局随机源的实现不可能八组全过）
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const p1 = buildChoices({ ...args, rng: mulberry32(seed) });
      const p2 = buildChoices({ ...args, rng: mulberry32(seed) });
      expect(p2?.options).toEqual(p1?.options);
      expect(p2?.correctIndex).toBe(p1?.correctIndex);
    }
    const orders = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        buildChoices({ ...args, rng: mulberry32(seed) })?.correctIndex,
      ),
    );
    expect(orders.size).toBeGreaterThan(1); // 正确项位置随种子变化，不固定在某一格
  });

  it('CHO#7 count 越界（1 / 7 / 2.5）⇒ 回落默认 4；count 合法时按给定值', () => {
    for (const count of [1, 7, 2.5, Number.NaN]) {
      const set = buildChoices({ answer: ANSWER, stored: ['李白', '王维', '白居易', '苏轼'], count, rng: mulberry32(1) });
      expect(set?.options).toHaveLength(CHOICE_COUNT_DEFAULT);
    }
    const two = buildChoices({ answer: ANSWER, stored: ['李白', '王维'], count: 2, rng: mulberry32(1) });
    expect(two?.options).toHaveLength(2);
    expect(two?.options).toContain(ANSWER);
  });
});

describe('previewLabel / labels —— 截断与可分性', () => {
  it('CHO#8 截断后撞车的干扰项**直接不要**（宁可少一个选项，也不显示两个分不清的选项）', () => {
    const long1 = '甲'.repeat(60) + '尾巴一';
    const long2 = '甲'.repeat(60) + '尾巴二'; // 前 40 字与 long1 完全相同
    // 唯一候选与正确答案截断后撞车 ⇒ 凑不出干扰项 ⇒ null（调用方回落看答案）
    expect(buildChoices({ answer: long1, stored: [long2], count: 2, rng: mulberry32(9) })).toBeNull();

    // 有别的候选时：撞车的那条被丢掉，剩下能区分的照常出题
    const set = buildChoices({ answer: long1, stored: [long2, '李白'], count: 3, rng: mulberry32(9) });
    expect(set).not.toBeNull();
    if (!set) return;
    expect(set.options).toHaveLength(2); // 正确答案 + 李白（long2 被剔除）
    expect(set.options).not.toContain(long2);
    expect(set.labels).toHaveLength(2);
    // 每条标签都 ≤40 码点、互不相同、非空
    for (const label of set.labels) {
      expect(Array.from(label).length).toBeLessThanOrEqual(CHOICE_LABEL_MAX);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(set.labels[0]).not.toBe(set.labels[1]);
  });

  it('CHO#8c 所有候选都与正确答案撞车 ⇒ null（这类卡在屏上分不出选项，不硬出题）', () => {
    const same = '乙'.repeat(50);
    expect(
      buildChoices({ answer: same + 'A', stored: [same + 'B', same + 'C'], count: 4, rng: mulberry32(4) }),
    ).toBeNull();
  });

  it('CHO#8b 短选项不截断、不加省略号', () => {
    expect(previewLabel('李白')).toBe('李白');
    expect(previewLabel('  李白  ')).toBe('李白');
    expect(previewLabel('')).toBe('');
  });

  it('CHO#9 截断按码点：不切坏代理对（emoji / 星号补充平面字符）', () => {
    const emoji = '🌟'.repeat(30);
    const label = previewLabel(emoji, 10);
    expect(Array.from(label).length).toBeLessThanOrEqual(10);
    expect(label).not.toContain('\uFFFD'); // 不出现替换字符
    // 没有孤立代理项
    for (const ch of label) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code < 0xd800 || code > 0xdfff).toBe(true);
    }
  });

  it('CHO#10 干扰项含首尾空白 ⇒ trim 后进选项且不出现空串', () => {
    const set = buildChoices({ answer: ANSWER, stored: [' 李白 ', '   ', '王维'], count: 4, rng: mulberry32(2) });
    expect(set?.options).toContain('李白');
    expect(set?.options).toContain('王维');
    expect(set?.options.every((o) => o.trim().length > 0)).toBe(true);
  });
});
