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

/**
 * 让 `fakeChat` 认识**提纲调用**（D59）：system 里含【主线】就是提纲那一步。
 *
 * 为什么这两条用例要走"提纲失败 ⇒ 回落分块"：它们守的是**老的**
 * 分块/去重/如实申报口径；而两段式是另一条路（KF#O 那组用例守它）。
 * 让提纲返回一句太短的话 ⇒ 调用方回落单次/分块 —— 这正好也证明了
 * **新路不许成为新的失败点**。
 */
function withOutlineFallback(
  results: Array<{ ok: true; text: string } | { ok: false; reason: string }>,
): { chat: (m: readonly { role: string; content: string }[]) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>; calls: number } {
  const f = fakeChat(results);
  let calls = 0;
  const chat = (messages: readonly { role: string; content: string }[]) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('【主线】')) {
      calls += 1;
      return Promise.resolve({ ok: true as const, text: '太短' }); // 短提纲 ⇒ 判为失败 ⇒ 回落
    }
    return f.chat(messages);
  };
  return { chat, calls };
}

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
    const f = withOutlineFallback([cardsJson(['同一张', '第一块的']), cardsJson(['同一张', '第二块的'])]);
    const res = await collectCards({ chat: f.chat }, {
      text, deckName: '唐诗', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.front)).toEqual(['同一张', '第一块的', '第二块的']);
    // 提纲 1 次（失败回落，如实计数）+ 分块 2 次 = 3
    expect(res.requests).toBe(3);
    expect(res.quota.cards).toBe(4); // 生成 4 张（含被去重的那张）就该记 4 —— 钱是真花了的
  });

  it('KF#6 中途失败但有产出 ⇒ ok:true + truncated:true（如实申报，不谎报全成/全败）', async () => {
    const para = '甲'.repeat(3000);
    const text = `${para}\n\n${para}`;
    const f = withOutlineFallback([cardsJson(['第一块的']), { ok: false, reason: '被限流了' }]);
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

/* ------------------------------------------------------------------ D59：两段式建卡 */

/**
 * 判别力：
 * - KF#O1 长文（≥1500 字）⇒ **先提纲、再出卡**两次调用；提纲调用**不占卡片额度**（它不产卡）；
 * - KF#O2 短文本仍单次（粘一句笔记也跑两次调用 = 白花钱）；
 * - KF#O3 进度回调按顺序给出 `outline` → `cards`（屏上要说清"在提炼主线"，否则像卡住了）；
 * - KF#O4 **提纲失败 ⇒ 回落分块生成**（新路不许成为新的失败点），且如实记一笔 requests；
 * - KF#O5 提纲那次调用带上了【主线】等四段骨架要求与"禁元信息"（prompt 契约）。
 */
/** KF#O6 用的"够长的提纲"（≥60 码点，否则会被判成没提炼出来）。 */
const outlineText_forKF6 = [
  '【主线】',
  '- 超长资料的第一条主线结论',
  '【步骤】',
  '- 第一步先做什么，第二步再做什么',
].join('\n');

describe('collectCards —— 两段式（D59）', () => {
  const longText = '甲'.repeat(2000); // ≥1500 ⇒ 走两段式
  // 提纲要**过 60 码点**这条闸（太短会被判成"没提炼出来"⇒ 回落分块，见 KF#O4）
  const outlineText = [
    '【主线】',
    '- 复用式持续学习不必依赖专门的离线阶段',
    '- 局部睡眠期间也能完成巩固',
    '【步骤】',
    '- 先用隔离规则约束回放',
    '- 再让网络在清醒期做间歇巩固',
    '【因果】',
    '- 因为局部睡眠只影响单个回路，所以不必停掉整个训练',
    '【易混】',
    '- 别把"离线阶段"与"暂停训练"混为一谈',
  ].join('\n');

  it('KF#O1/O3 长文：先提纲再出卡，提纲不占卡片额度，进度回调有序', async () => {
    const stages: string[] = [];
    const f = fakeChat([
      { ok: true, text: outlineText }, // 第 1 次：提纲
      cardsJson(['主线卡', '步骤卡']), // 第 2 次：出卡
    ]);
    const res = await collectCards({ chat: f.chat }, {
      text: longText,
      deckName: 'AI',
      quota: quota(),
      nowMs: NOW,
      tzOffsetMin: TZ,
      onStage: (stage) => void stages.push(stage),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(f.calls).toHaveLength(2); // 长文只花两次调用（比分块更便宜）
    expect(res.candidates.map((c) => c.front)).toEqual(['主线卡', '步骤卡']);
    expect(res.quota.cards).toBe(2); // 只有产出的两张卡计额度
    expect(res.requests).toBe(2);
    expect(stages).toEqual(['outline', 'cards']);
    // 第二次调用带的是**骨架**（而不是原文）：提示词里会说明按骨架出卡
    const secondSystem = f.calls[1].find((m) => m.role === 'system')?.content ?? '';
    expect(secondSystem).toContain('骨架');
  });

  it('KF#O2 短文本 ⇒ 不跑提纲（一次调用）', async () => {
    const f = fakeChat([cardsJson(['短卡'])]);
    const res = await collectCards({ chat: f.chat }, {
      text: '短资料：一句话',
      deckName: 'AI',
      quota: quota(),
      nowMs: NOW,
      tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(f.calls).toHaveLength(1);
    expect(res.requests).toBe(1);
  });

  it('KF#O6 超长文：提纲那一步拿到的是**采样后的全篇**（含结尾，且长度受控）', async () => {
    // 30k 字：超过提纲输入预算（20k）⇒ 必须采样；结尾留一个独有标记，验证"尾部真的带上了"
    const text = `${'甲'.repeat(15_000)}${'乙'.repeat(14_000)}结尾标记甲乙丙`;
    const f = fakeChat([{ ok: true, text: outlineText_forKF6 }, cardsJson(['x'])]);
    await collectCards({ chat: f.chat }, {
      text, deckName: 'AI', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    const userMsg = f.calls[0].find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('结尾标记甲乙丙'); // 尾部带上了（"只看开头"的实现必红）
    expect(Array.from(userMsg).length).toBeLessThan(Array.from(text).length); // 确实采样过
  });

  it('KF#O4 提纲失败（或太短）⇒ 回落分块生成，且如实记 requests', async () => {
    const para = '甲'.repeat(3000);
    const f = fakeChat([
      { ok: true, text: '太短' }, // 提纲：判为失败
      cardsJson(['第一块']),
      cardsJson(['第二块']),
    ]);
    const res = await collectCards({ chat: f.chat }, {
      text: `${para}\n\n${para}`,
      deckName: 'AI',
      quota: quota(),
      nowMs: NOW,
      tzOffsetMin: TZ,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.front)).toEqual(['第一块', '第二块']);
    expect(res.requests).toBe(3); // 提纲 1 + 分块 2
    expect(f.calls).toHaveLength(3);
    // I1（复查发现）：提纲没成要记成**降级**（degraded），不能记成 truncated ——
    // 分块那两块其实**都成功处理完**了，报 truncated 会让屏上说"资料没能全部处理完，可再点一次接着挖"，
    // 那是一句假话，还会诱导玩家再花一轮真钱。
    expect(res.degraded).toBe(true);
    expect(res.truncated).toBe(false);
  });

  it('KF#O5 提纲提示词含四段骨架与"禁元信息"（prompt 契约）', async () => {
    const f = fakeChat([{ ok: true, text: outlineText }, cardsJson(['x'])]);
    await collectCards({ chat: f.chat }, {
      text: longText, deckName: 'AI', quota: quota(), nowMs: NOW, tzOffsetMin: TZ,
    });
    const firstSystem = f.calls[0].find((m) => m.role === 'system')?.content ?? '';
    for (const piece of ['【主线】', '【步骤】', '【因果】', '【易混】', '不要**写日期、作者、来源']) {
      expect(firstSystem, `提纲提示词缺：${piece}`).toContain(piece);
    }
  });
});
