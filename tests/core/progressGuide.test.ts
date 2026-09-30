/**
 * tests/core/progressGuide.test.ts —— 进度说明的派生口径（D63）。
 *
 * 判别力（这是"说明不许编数字"的钉子）：
 * - PG#1 `expToLevelTotal` 必须是**累计**需求（只写"下一级 100"的实现必红）；
 * - PG#2 `expGapToNextLevel` 与 `expToNext`/`applyExp` **同一口径**（拿真实升级点验算）；
 * - PG#3 `bossProgress` 的 X/Y/还差 Z 与 `bossReady` 一致（说明与规则各说一套的实现必红）；
 * - PG#4 `cardStatusHint` 的"还差什么"必须指向**真实晋升阈值**（间隔 ≥7 天算已掌握）。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '@core/types';
import { applyExp, expToNext } from '@core/stats';
import {
  bossProgress,
  cardStatusHint,
  expGapToNextLevel,
  expToLevelTotal,
  stabilityExplainer,
} from '@core/progressGuide';

const NOW = Date.UTC(2026, 9, 30, 4, 0, 0);

function card(id: string, over: Partial<Card['srs']> = {}): Card {
  return {
    id,
    deckId: 'd1',
    front: `q-${id}`,
    back: `a-${id}`,
    tags: [],
    srs: {
      ease: 2.5,
      interval: 0,
      reps: 0,
      lapses: 0,
      due: NOW,
      stability: 'new',
      effectiveReviewDays: [],
      ...over,
    },
  };
}

describe('core/progressGuide —— 经验与等级（D63）', () => {
  it('PG#1 expToLevelTotal 是累计需求（逐级累加）', () => {
    expect(expToLevelTotal(1)).toBe(0); // 已经在 L1：不需要经验
    expect(expToLevelTotal(2)).toBe(expToNext(1)); // 到 L2 要 L1 那一级的量
    expect(expToLevelTotal(3)).toBe(expToNext(1) + expToNext(2));
    expect(expToLevelTotal(4)).toBe(expToNext(1) + expToNext(2) + expToNext(3));
  });

  it('PG#2 expGapToNextLevel 与真实升级点一致（applyExp 验算）', () => {
    for (const total of [0, 50, 99, 100, 137, 240, 500, 1_000]) {
      const { level } = applyExp(1, total);
      const gap = expGapToNextLevel(level, total);
      // 差 gap 点经验，正好跨过一级；差 gap-1 点，还在本级
      expect(applyExp(1, total + gap).level, `total=${total} 应正好升级`).toBe(level + 1);
      if (gap > 0) {
        expect(applyExp(1, total + gap - 1).level, `total=${total} 不该提前升级`).toBe(level);
      }
    }
  });

  it('PG#2b 脏输入不崩、不撒谎（负数/NaN 一律当 0）', () => {
    expect(expGapToNextLevel(1, NaN)).toBeGreaterThan(0);
    expect(expGapToNextLevel(1, -50)).toBeGreaterThan(0);
    expect(expToLevelTotal(0.5 as never)).toBeGreaterThanOrEqual(0);
  });
});

describe('core/progressGuide —— 卷灵进度（D63）', () => {
  it('PG#3 X/Y/还差 Z 与 bossReady 同口径', () => {
    const cards = [
      card('a', { effectiveReviewDays: ['2026-10-28', '2026-10-29'] }),
      card('b', { effectiveReviewDays: ['2026-10-30'] }),
    ];
    const p = bossProgress(cards, 30);
    expect(p.count).toBe(3);
    expect(p.threshold).toBe(30);
    expect(p.remaining).toBe(27);
    expect(p.ready).toBe(false);

    const many = Array.from({ length: 30 }, (_, i) =>
      card(`c${i}`, { effectiveReviewDays: ['2026-10-30'] }),
    );
    const q = bossProgress(many, 30);
    expect(q.count).toBe(30);
    expect(q.remaining).toBe(0);
    expect(q.ready).toBe(true); // 与 bossReady(many, 30) === true 一致
  });

  it('PG#3b 脏输入：非数组/脏天数一律消毒（不虚报进度）', () => {
    const p = bossProgress(null as never, 15);
    expect(p.count).toBe(0);
    expect(p.remaining).toBe(15);
    expect(p.ready).toBe(false);

    const dirty = bossProgress([card('a', { effectiveReviewDays: ['假的', 42] as never })], 15);
    expect(dirty.count).toBe(0);
  });
});

describe('core/progressGuide —— 卡片状态的大白话（D63）', () => {
  it('PG#4 四档各自说清"还差什么"（阈值必须是真的）', () => {
    const fresh = cardStatusHint(card('a'));
    expect(fresh.label).toBe('初识');
    expect(fresh.hint).toContain('答对');

    const learning = cardStatusHint(card('b', { stability: 'learning', reps: 1, interval: 0.5 }));
    expect(learning.label).toBe('在学');
    expect(learning.hint).toContain('7 天'); // 指向"已掌握"的真实阈值

    // D64：跨过 2 天才是真的"复习"（夹具补上账本日，否则只能算"在学"）
    const reviewing = cardStatusHint(
      card('c', { stability: 'review', reps: 2, interval: 3, effectiveReviewDays: ['2026-10-28', '2026-10-29'] }),
    );
    expect(reviewing.label).toBe('复习');
    expect(reviewing.hint).toContain('7 天');

    const mastered = cardStatusHint(
      card('d', {
        stability: 'mastered',
        reps: 4,
        interval: 21,
        effectiveReviewDays: ['2026-10-26', '2026-10-27', '2026-10-28'],
      }),
    );
    expect(mastered.label).toBe('已掌握');
    expect(mastered.hint).toContain('稳住'); // 已掌握没有"下一档"，只说稳住
  });

  it('PG#4b 复习档的提示里带上**当前间隔**（玩家能看到进度在动）', () => {
    const hint = cardStatusHint(
      card('c', { stability: 'review', reps: 2, interval: 3, effectiveReviewDays: ['2026-10-28', '2026-10-29'] }),
    ).hint;
    expect(hint).toContain('3 天');
  });

  it('PG#5 间隔够了但只跨过 1 天 ⇒ 标签不许说"已掌握"，且直说差在天数上', () => {
    // 这正是玩家现场问的那件事："昨天刚建的卡今天就已掌握"——同一天练三次 interval 就到 15 天了
    const hint = cardStatusHint(
      card('e', { stability: 'review', reps: 3, interval: 15, effectiveReviewDays: ['2026-10-29'] }),
    );
    expect(hint.label).toBe('复习');
    expect(hint.hint).toContain('15 天'); // 间隔确实够了
    expect(hint.hint).toContain('只跨过 1 天');
    expect(hint.hint).toContain('再隔天复习 2 次'); // 还差两次（差在**天**上）
  });

  it('PG#5b《状态怎么升》也把"跨过几天"写进去（不然玩家以为间隔够了就算掌握）', () => {
    const text = stabilityExplainer()
      .map((r) => `${r.label}：${r.text}`)
      .join('\n');
    expect(text).toContain('跨过 3 个复习日');
    expect(text).toContain('不算掌握');
  });
});
