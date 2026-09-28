// @vitest-environment node
/**
 * tests/app/codexFlow.test.ts —— Plan 5 · T5：彩蛋写口（`setEggOnDeck`）。
 *
 * 为什么值得单测（而不是只靠 UI 的假写口）：这条链是"屏上贴的文本 → 权威存档"的唯一入口，
 * 而落盘自检对 `decks[i].egg` 是**整包拒**的（非空字符串 + 码点 ≤200）。脏值一旦放行，
 * 后果与 library.ts 的 I-2 同款：dirty 永久为真、此后**任何**改动都写不进存储。
 * 判别力：
 * - CF#1 正常写：值经消毒后落地（剥控制字符、折叠空白、去首尾）；
 * - CF#2 拒绝面：空白 / 非字符串 / 超 200 码点 ⇒ `{ok:false, reason}` 且**不触存储**；
 *   按 `.length` 判上限的实现在"200 个 emoji"那条上必红（UTF-16 长度 400）；
 * - CF#3 领域不存在 ⇒ 可上屏 reason，不写；
 * - CF#4 只读态 ⇒ 先给 reason（不抛），闩锁仍是兜底（绕过判断也写不进去）；
 * - CF#5 同值不重写：`dirty()` 不会被一次重复确认点亮（写放大纪律）。
 */
import { describe, expect, it } from 'vitest';
import type { SaveFile } from '@core/types';
import { createMemoryStorage } from '@platform/memoryStore';
import { createCoordinator } from '../../src/app/persist';
import { sanitizeEggText, setEggOnDeck } from '../../src/app/codexFlow';
import { makeCard, makeDeck, makeSave } from '../ui/support';

const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);

function seed(): SaveFile {
  return makeSave({
    decks: [makeDeck('d1', '唐诗', { purifiedAt: 100 }), makeDeck('d2', '英语词根')],
    cards: [makeCard('c1', { deckId: 'd1' })],
  });
}

async function rig(save: SaveFile | null = seed()) {
  const store = createMemoryStorage();
  if (save) await store.save(save);
  const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
  return { store, coord };
}

describe('sanitizeEggText —— 消毒口径', () => {
  it('CF#1 剥控制字符（含零宽）、折叠空白、去首尾；200 码点（含 emoji）放行', () => {
    expect(sanitizeEggText('  雷声\u200b与闪电  ')).toEqual({ ok: true, text: '雷声 与闪电' });
    expect(sanitizeEggText('雷声\u0000与\u007f闪电')).toEqual({ ok: true, text: '雷声 与 闪电' });
    expect(sanitizeEggText('⚡'.repeat(200))).toEqual({ ok: true, text: '⚡'.repeat(200) });
  });

  it('CF#2 空白/非字符串/超 200 码点 ⇒ 可上屏 reason', () => {
    for (const bad of ['', '   ', '\n\t', null, 42, { text: 'x' }]) {
      const r = sanitizeEggText(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    const tooLong = sanitizeEggText('⚡'.repeat(201)); // UTF-16 长度 402：按 .length 判的实现会误判
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toContain('200');
  });
});

describe('setEggOnDeck —— 写口', () => {
  it('CF#1b 正常写：消毒后的正文进 deck.egg，只动目标领域', async () => {
    const { coord } = await rig();
    const res = await setEggOnDeck(coord, 'd1', '  李白\u200b号青莲居士。  ');
    expect(res).toEqual({ ok: true });
    expect(coord.snapshot().decks.find((d) => d.id === 'd1')?.egg).toBe('李白 号青莲居士。');
    expect(coord.snapshot().decks.find((d) => d.id === 'd2')?.egg).toBeUndefined();
  });

  it('CF#2b 脏值/空值/超长 ⇒ 拒绝且**不触存储**（dirty 仍为 false）', async () => {
    const { coord } = await rig();
    for (const bad of ['', '   ', '⚡'.repeat(201)] as string[]) {
      const res = await setEggOnDeck(coord, 'd1', bad);
      expect(res.ok).toBe(false);
      expect(typeof res.reason).toBe('string');
    }
    expect(coord.snapshot().decks.find((d) => d.id === 'd1')?.egg).toBeUndefined();
    expect(coord.dirty()).toBe(false);
  });

  it('CF#3 领域不存在 ⇒ 可上屏 reason，不写盘', async () => {
    const { coord } = await rig();
    const res = await setEggOnDeck(coord, 'ghost', '一段彩蛋。');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('领域');
    expect(coord.dirty()).toBe(false);
  });

  it('CF#4 只读态：先给 reason（不抛），闩锁仍是兜底', async () => {
    const store = createMemoryStorage();
    await store.save({ schemaVersion: 2 } as unknown as SaveFile); // 不可恢复坏档 ⇒ 只读闩锁
    const coord = await createCoordinator(store, { now: () => NOW, debounceMs: 0 });
    expect(coord.readOnly()).toBe(true);

    const res = await setEggOnDeck(coord, 'd1', '一段彩蛋。');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('只读');
    // 存储原样保留（写口没有绕过闩锁偷偷落盘）
    expect(((await store.load()) as unknown as { schemaVersion: number }).schemaVersion).toBe(2);
    // 兜底：即便有人绕过 readOnly() 判断，mutate 也会抛
    await expect(coord.mutate(() => undefined)).rejects.toThrow();
  });

  it('CF#5 同值不重写：重复确认同一段文本不会点亮 dirty（写放大纪律）', async () => {
    const { coord } = await rig();
    await setEggOnDeck(coord, 'd1', '一段彩蛋。');
    expect(await coord.flush()).toBe(true);
    expect(coord.dirty()).toBe(false);

    const again = await setEggOnDeck(coord, 'd1', '一段彩蛋。');
    expect(again).toEqual({ ok: true });
    expect(coord.dirty()).toBe(false); // 重写派实现在此必红
  });
});
