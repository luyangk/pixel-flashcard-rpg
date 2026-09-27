/**
 * 备战卡池生成（Plan 2 · T6）—— PRD §3「80% 系统智能配卡 + 20% 玩家自选」的数据层。
 * 纯函数零平台依赖：到期判定用调用方传入的 nowMs（缺省 0，即"无显式时钟时全部未到期、
 * 走降级链"），core 层禁 Date.now()/DOM/Node/Math.random。
 *
 * verbatim 规则（brief）：
 * - 分割：智能段 = max(1, round(size×0.8))、自选段 = size − 智能段；size=1 → 1+0。
 * - 智能段：dueQueue 过滤（可选 deckIds 限定）按紧迫度取；不足则放宽至未到期卡（仍限 deckIds）。
 * - 自选段：rng 从剩余池加权抽（权重恒 1，pickWeighted 留接口给后续偏好加权）。
 * - 总可用 < size 时返回全部可用并按实际长度；0 可用返回 []。
 *
 * 不变量（终审 grep 项预告）：输出天然无重复 cardId——上层把 buildPool 输出直接喂
 * createBattle，脏 id 会让整局 duplicate-card throw。实现上以 seen-id 集合贯穿三段抽取，
 * 同 id 的后来对象一律跳过；输入含重复 id 的脏数据时输出仍干净。
 */

import type { Card } from './types';
import { dueQueue } from './sm2';
import { bossReady, domainReviewCount } from './reviewLedger';
import { pickWeighted, type Rng } from './rng';

/** 智能配卡占比（PRD §3 verbatim：80% 智能 + 20% 自选）。 */
const SMART_RATIO = 0.8;

export interface PoolOptions {
  size: number;
  /** 主题筛选（多选卡组）；undefined = 不限定。空数组 = 命中 0 张 → 返回 []。 */
  deckIds?: readonly string[];
  rng: Rng;
  /** 到期判定时钟（毫秒时间戳）。缺省 0：不读真实时间，与 sm2/reviewLedger 的注入口径一致。 */
  nowMs?: number;
}

/** 有限正整数校验：非有限 / ≤0 / 非整数一律视为非法 size。 */
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 剔除 nullish、非对象项与非法 id（存档脏数据入口消毒，与 sm2.dueQueue 的 filter 同风格）。 */
function usableCards(cards: readonly Card[]): Card[] {
  if (!Array.isArray(cards)) return [];
  return cards.filter(
    (c): c is Card => c != null && typeof c === 'object' && typeof c.id === 'string',
  );
}

/**
 * 80/20 卡池生成。
 * 永不抛异常：非法 size（0/负/小数/NaN/Infinity）、缺失 rng、脏 cards 一律安全回落 []。
 */
export function buildPool(cards: readonly Card[], opts: PoolOptions): Card[] {
  const size = opts?.size;
  if (!isPositiveInt(size)) return [];
  const rng: Rng = typeof opts.rng === 'function' ? opts.rng : () => 0;
  const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : 0;

  // 主题筛选：deckIds 为 undefined 时不过滤；空数组命中 0 张 → 后续自然返回 []。
  const deckSet = Array.isArray(opts.deckIds) ? new Set<string>(opts.deckIds) : null;
  const scoped = usableCards(cards).filter((c) => (deckSet ? deckSet.has(c.deckId) : true));
  if (scoped.length === 0) return [];

  // verbatim 分割：智能段至少 1 张，自选段吃掉余量（size=1 → 1+0）。
  const smartWant = Math.max(1, Math.round(size * SMART_RATIO));
  const selfWant = size - smartWant;

  const out: Card[] = [];
  const seen = new Set<string>(); // 无重复 id 不变量的唯一守卫，贯穿三段

  /** 收一张卡；id 已见过则拒绝（false 供抽取循环剔除重试）。 */
  const take = (c: Card | null | undefined): boolean => {
    if (c == null || seen.has(c.id)) return false;
    seen.add(c.id);
    out.push(c);
    return true;
  };

  // —— 智能段：到期队列（dueQueue 已按紧迫度升序）→ 不足则放宽至未到期卡（仍限 deckIds）——
  const due = dueQueue(scoped, nowMs); // dueQueue 不改入参、自带 nullish 过滤
  for (const c of due) {
    if (out.length >= smartWant) break;
    take(c);
  }
  if (out.length < smartWant) {
    // 降级第一跳：未到期卡。按 due 升序补位（越接近到期的越优先），保持"紧迫度优先"语义。
    const fresh = scoped
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => (a.srs?.due ?? Infinity) - (b.srs?.due ?? Infinity));
    for (const c of fresh) {
      if (out.length >= smartWant) break;
      take(c);
    }
  }

  // —— 自选段：从剩余池（未被智能段选走的卡）不放回加权抽 ——
  if (selfWant > 0) {
    let remaining = scoped.filter((c) => !seen.has(c.id));
    // 每轮 pickWeighted 抽一张家后从候选中移除该 id（不放回 ⇒ 无重复 id）。
    // 权重恒 1（均匀）——weightOf 签名保留，供后续按 tags/玩家偏好加权。
    // 选中项若因脏数据（重复 id）不可收，同样剔除后 i-- 重试同一轮，不缩水输出长度。
    for (let i = 0; i < selfWant; i++) {
      if (remaining.length === 0) break; // 降级第二跳：总可用 < size，按实际长度返回
      const picked = pickWeighted(rng, remaining, () => 1);
      if (picked == null) break; // 防御：weight≡1 且 remaining 非空时不会触发
      // R-T6-c：兑现上方注释承诺的防御行。当前结构下 remaining 由 seen-id filter 构造，
      // picked.id ∈ seen 恒假 → take 拒绝不可达（穷举实证见 task-7-report 可达性分析）；
      // 本行为零变更，仅在语义上闭合注释与代码的落差。remaining 每轮严格收缩，循环仍单调终止。
      if (!take(picked)) i--;
      remaining = remaining.filter((c) => c.id !== picked.id);
    }
  }

  return out;
}

/**
 * Boss 达标检查：领域累计有效复习数是否唤醒卷灵。
 * 计数与阈值判定逐字委托 reviewLedger（Boss 口径的唯一权威），本函数只做三态打包。
 * 非法 tier（运行时脏数据）经 bossReady 保守判未触发；threshold 原样回显供 UI 展示。
 */
export function bossCheck(
  deckCards: readonly Card[],
  tier: 15 | 30 | 50,
): { ready: boolean; count: number; threshold: number } {
  const cards = Array.isArray(deckCards) ? (deckCards as Card[]) : [];
  return {
    ready: bossReady(cards, tier),
    count: domainReviewCount(cards),
    threshold: tier,
  };
}
