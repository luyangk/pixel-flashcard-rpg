/**
 * tests/app/knowledgeFlow.test.ts —— Plan 8 · T4：分块生成 + 去重 + 额度扣减。
 *
 * 判别力（每条都写清"坏实现为何必红"）：
 * - KF#2 长文要**按段落切成多块**（一块塞 9000 字会给模型灌垃圾，也超过单次提示词预算）；
 *   分块按**码点**，`.slice` 会劈开代理对（KF#2b）；
 * - KF#3 额度为 0 时**一次 chat 都不该调**（先扣后判/先调后判的实现会白花钱）；
 * - KF#4 额度只剩 3 ⇒ 单块 `max` 传 3、产出 ≤3、返回的额度精确 +3；
 * - KF#5 两块产出同 front ⇒ 去重（重复卡会让卡库出现两张一样的卡）；
 * - KF#6 中途失败要**如实申报**：有产出就 ok:true + truncated，没产出才 ok:false；
 * - KF#9 候选自带的 choices 透传（丢了它就等于把"选项在生成时算一次"的设计废掉）。
 */
import { describe, expect, it } from 'vitest';
import type { CardCandidate } from '@core/llmParse';
import type { LlmQuota } from '@core/types';
import { localDayString } from '@core/reviewLedger';
import { CHUNK_CHARS, chunkText, collectCards } from '../../src/app/knowledgeFlow';

const NOW = Date.UTC(2026, 10, 1, 4, 0, 0);
const TZ = 480;
function quota(over: Partial<LlmQuota> = {}): LlmQuota {
  return { day: localDayString(NOW, TZ), cards: 0, judges: 0, ...over };
}
function candidate(front: string, back = '答案'): CardCandidate {
  return { front, back, tags: [], choices: [`不是 ${back}`] };
}
/** 假 chat：按调用次数返回预设结果（超出的调用返回最后一条）。 */
function fakeChat(results: Array<{ ok: true; text: string } | { ok: false; reason: string }>) {
  const calls: Array<readonly { role: string; content: string }[]> = [];
  let i = 0;
  return {
    calls,
    chat: (messages: readonly { role: string; content: string }[]) => {
      calls.push(messages);
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return Promise.resolve(r);
    },
  };
}
function cardsJson(fronts: string[]): { ok: true; text: string } {
  return {
    ok: true,
    text: JSON.stringify(fronts.map((f) => ({ front: f, back: '答案', tags: [], choices: ['干扰'] }))),
  };
}

describe('chunkText —— 按段落分块（码点安全）', () => {
  it('KF#1 短文单块；空/空白 ⇒ 空数组', () => {
    expect(chunkText('一段短资料')).toEqual(['一段短资料']);
    for (const bad of ['', '   ', '\n\n']) expect(chunkText(bad)).toEqual([]);
  });

  it('KF#2 长文按段落切，且每块 ≤ CHUNK_CHARS', () => {
    const para = '甲'.repeat(1500);
    const text = [para, para, para, para, para, para].join('\n\n'); // 9000 字
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect([...c].length).toBeLessThanOrEqual(CHUNK_CHARS);
    // 块内不该出现被腰斩的段落标记（说明是按段落边界切的）
    expect(chunks.every((c) => !c.startsWith('\n'))).toBe(true);
  });

  it('KF#2b 单段超长 ⇒ 硬切，但按码点（不劈开代理对）', () => {
    const text = '🐉'.repeat(CHUNK_CHARS + 50);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect([...c].length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(c).not.toContain('\uFFFD');
      expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
    }
  });
});

describe('collectCards —— 额度与失败面', () => {
  it('KF#3 额度用尽 ⇒ 拒绝，且一次 chat 都没调（不白花钱）', async () => {
    const f = fakeChat([cardsJson(['a'])]);
    const res = await collectCards({ chat: f.chat }, {
      text: '资料', deckName: '唐诗', quota: quota({ cards: 200 }), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('额度用完');
    expect(f.calls).toHaveLength(0);
  });

  it('KF#4 额度只剩 3 ⇒ max 传 3、产出 ≤3、返回额度精确 +3', async () => {
    const seen: string[] = [];
    const chat = (messages: readonly { role: string; content: string }[]) => {
      seen.push(messages.find((m) => m.role === 'system')?.content ?? '');
      return Promise.resolve(cardsJson(['a', 'b', 'c']));
    };
    const res = await collectCards({ chat }, {
      text: '资料', deckName: '唐诗', quota: quota({ cards: 197 }), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates).toHaveLength(3);
    expect(res.quota.cards).toBe(200);
    expect(seen[0]).toContain('3'); // system 里的"这次最多出 N 张"
  });

  it('KF#8 want 超过单次上限 ⇒ 夹到 20（并提出 20 张的额度）', async () => {
    const seen: string[] = [];
    const chat = (messages: readonly { role: string; content: string }[]) => {
      seen.push(messages.find((m) => m.role === 'system')?.content ?? '');
      return Promise.resolve(cardsJson(['a']));
    };
    const res = await collectCards({ chat }, {
      text: '资料', deckName: '唐诗', quota: quota(), want: 50, nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(seen[0]).toContain('20');
  });
});

describe('collectCards —— 分块、去重与如实申报', () => {
  it('KF#1b 短文本 ⇒ 单次请求，requests=1', async () => {
    const f = fakeChat([cardsJson(['a', 'b'])]);
    const res = await collectCards({ chat: f.chat }, {
      text: '短资料', deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.requests).toBe(1);
    expect(res.candidates.map((c) => c.front)).toEqual(['a', 'b']);
    expect(res.quota.cards).toBe(2);
  });

  it('KF#5 两块产出同 front ⇒ 去重后只剩一条，但额度按**实际生成数**扣', async () => {
    const para = '甲'.repeat(3000);
    const text = `${para}\n\n${para}`; // 两块
    const f = fakeChat([cardsJson(['同一张', '第一块的']), cardsJson(['同一张', '第二块的'])]);
    const res = await collectCards({ chat: f.chat }, {
      text, deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.front)).toEqual(['同一张', '第一块的', '第二块的']);
    expect(res.requests).toBe(2);
    expect(res.quota.cards).toBe(4); // 生成 4 张（含被去重的那张）就该记 4 —— 钱是真花了的
  });

  it('KF#6 中途失败但有产出 ⇒ ok:true + truncated:true（如实申报，不谎报全成/全败）', async () => {
    const para = '甲'.repeat(3000);
    const text = `${para}\n\n${para}`;
    const f = fakeChat([cardsJson(['第一块的']), { ok: false, reason: '被限流了' }]);
    const res = await collectCards({ chat: f.chat }, {
      text, deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.front)).toEqual(['第一块的']);
    expect(res.truncated).toBe(true);
    expect(res.quota.cards).toBe(1); // 只有真正生成的那张扣额度
  });

  it('KF#7 第一块就失败 ⇒ ok:false + 可上屏理由；额度不动', async () => {
    const f = fakeChat([{ ok: false, reason: '模型没返回可用内容。' }]);
    const res = await collectCards({ chat: f.chat }, {
      text: '资料', deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
  });

  it('KF#7b 模型回垃圾（解析不出候选）⇒ ok:false，且不扣额度', async () => {
    const f = fakeChat([{ ok: true, text: '这不是 JSON' }]);
    const res = await collectCards({ chat: f.chat }, {
      text: '资料', deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('KF#9 候选的 choices 透传（丢了它 = "选项在生成时算一次"的设计作废）', async () => {
    const f = fakeChat([
      {
        ok: true,
        text: JSON.stringify([{ front: 'f', back: 'b', tags: ['历史'], choices: ['错1', '错2'] }]),
      },
    ]);
    const res = await collectCards({ chat: f.chat }, {
      text: '资料', deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.candidates[0]?.choices).toEqual(['错1', '错2']);
  });

  it('KF#10 空资料 ⇒ 不调 chat、直接回人话', async () => {
    const f = fakeChat([cardsJson(['a'])]);
    const res = await collectCards({ chat: f.chat }, {
      text: '   ', deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
