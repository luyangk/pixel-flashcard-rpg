/**
 * knowledgeFlow.ts —— Plan 8 · T4：分块生成 + 去重 + 额度扣减。
 *
 * ## 为什么不是"把整篇丢给模型"
 * 一次调用的提示词预算有限（实测长文既贵又慢，产出还不稳），所以按段落把正文切成 ≤4000 码点的块，
 * 逐块让模型出卡，最后合并去重。**额度按实际生成的张数扣**（不是按请求数）——
 * 玩家感知的额度就是"能拿到多少张新卡"，而分块长文会一次触发多次请求。
 *
 * ## 三条如实申报的纪律
 * 1. 额度用尽 ⇒ **拒绝，且一次请求都不发**（先调后判等于白花钱）；
 * 2. 中途失败 ⇒ 有产出就 `ok:true + truncated:true`（不谎报"全成"），没产出才 `ok:false`；
 * 3. 返回的是**尚未落盘**的额度（由装配层写回存档）——本模块不认识 persist。
 */
import type { CardCandidate } from '@core/llmParse';
import type { LlmQuota } from '@core/types';
import { PER_REQUEST_CARD_CAP, normalizeQuota, planCharge, remainingCards } from './quota';
import { suggestCards, suggestOutline, type ChatFn } from './llmFlow';
import { outlineInputFor } from './outlineInput';

/** 每块的最大码点数（与 llmFlow.PASTE_MAX 同值：那块提示词就是按这个预算写的）。 */
export const CHUNK_CHARS = 4000;
/**
 * 超过这么多码点就先提炼提纲（D59）。
 *
 * 1500 是实测出来的分界：从来源库点的 arXiv 摘要约 1500–2000 字，正好在线上；
 * 再短（自己粘的三五句笔记）跑两次调用不划算。
 */
export const OUTLINE_MIN_TEXT = 1500;

/**
 * 把长文切成块：**优先按段落边界**（`\n`），单段超长才硬切。
 * 切分一律按**码点**（`.slice` 会劈开代理对，产出乱码）。
 */
export function chunkText(text: string, max: number = CHUNK_CHARS): string[] {
  const limit = typeof max === 'number' && Number.isFinite(max) && max >= 1 ? Math.floor(max) : CHUNK_CHARS;
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim().length === 0) return [];
  const paragraphs = raw
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur.trim().length > 0) chunks.push(cur.trim());
    cur = '';
  };
  for (const para of paragraphs) {
    const points = [...para];
    if (points.length > limit) {
      // 单段超长：先收掉手头这块，再把这一段按码点硬切
      flush();
      for (let i = 0; i < points.length; i += limit) {
        chunks.push(points.slice(i, i + limit).join(''));
      }
      continue;
    }
    if ([...cur].length + (cur.length > 0 ? 1 : 0) + points.length > limit) flush();
    cur = cur.length > 0 ? `${cur}\n${para}` : para;
  }
  flush();
  return chunks;
}

export type CollectResult =
  | {
      readonly ok: true;
      readonly candidates: readonly CardCandidate[];
      /** 尚未落盘的额度（装配层写回）。 */
      readonly quota: LlmQuota;
      /** 实际发起的请求数（分块长文会 >1；UI 要如实告诉玩家）。 */
      readonly requests: number;
      /** 是否**没能按请求量拿满**（中途失败 / 额度不足）—— UI 据此别把话说过头。 */
      readonly truncated: boolean;
      /**
       * 这次走了**降级路**（I1，复查发现）：例如两段式的提纲没提炼出来，回落到分块生成。
       * 与 `truncated` **必须分开** —— 降级不等于"资料没处理完"：分块路径可能把每一块都处理干净了。
       * 屏上据此说的是"这次先按老办法出的卡"，而不是"没能全部处理完，再点一次"（后者会诱导玩家再花一轮钱）。
       */
      readonly degraded?: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export interface CollectInput {
  readonly text: string;
  readonly deckName: string;
  readonly quota: LlmQuota | undefined;
  /**
   * 进度回调（D59）：长文现在是"先提炼主线，再出卡"两次调用，
   * 第一次调用没有任何卡片产出，屏上必须说清在干什么，否则像卡住了。
   */
  readonly onStage?: (stage: 'outline' | 'cards') => void;
  /** 想要几张（缺省单次上限 20；会被当日余额夹住）。 */
  readonly want?: number;
  readonly nowMs: number;
  readonly tzOffsetMin: number;
}

/** 去重键：正面 trim + 小写（"李白是谁" 与 "李白是谁 " 是同一张卡）。 */
function frontKey(front: string): string {
  return String(front ?? '').trim().toLowerCase();
}

/**
 * 从一段（可能很长的）正文生成候选卡。**只回候选与额度，不写任何存储。**
 */
export async function collectCards(
  deps: { readonly chat: ChatFn },
  input: CollectInput,
): Promise<CollectResult> {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (text.trim().length === 0) return { ok: false, reason: '先粘一段资料（或抓一篇文章）再生成。' };

  const want = typeof input.want === 'number' && Number.isFinite(input.want) && input.want > 0
    ? input.want
    : PER_REQUEST_CARD_CAP;
  // 先算**预算**（不记账）：当日余额 ∩ 单次上限 ∩ 玩家要的张数。
  // 为什么不用 planCharge 预算：它当场就扣（是"预留"语义）——这里要的是"先看能拿几张，
  // 按**实际生成数**逐块扣"（首版用它算预算 ⇒ 每块又扣一次，额度被算了双份）。
  const budget = Math.min(want, PER_REQUEST_CARD_CAP, remainingCards(input.quota, input.nowMs, input.tzOffsetMin));
  if (budget <= 0) {
    return { ok: false, reason: '今天的新知识额度用完了（200 张/天），明天再来。' };
  }
  let quota = normalizeQuota(input.quota, input.nowMs, input.tzOffsetMin);

  const out: CardCandidate[] = [];
  const seen = new Set<string>();
  let requests = 0;
  let failed = false;
  let truncated = false;
  let degraded = false;

  /**
   * 两段式（D59）：长文**先提炼提纲**，再按提纲出卡。
   *
   * 为什么不是"分块直接出卡"：卡片生成一次请求只能装下一块，而分块会让主线/因果在切块
   * 那一步就散掉（现场症状：卡片都是"来源日期"这类碎片）。提纲看的是**整篇**，所以骨架不丢；
   * 而且长文从此只花两次调用（提纲 + 出卡），比分块出卡**更便宜**。
   *
   * 提纲失败一律**回落单次/分块生成**：新路不许成为新的失败点。
   */
  const longEnoughForOutline = Array.from(text).length >= OUTLINE_MIN_TEXT;
  if (longEnoughForOutline) {
    input.onStage?.('outline');
    requests += 1;
    // 长文的提纲输入**采样后**再给（D61）：头 + 尾 + 中间等距取样 ⇒ 覆盖全篇、长度可控。
    // 直接给前 20k 字等于"只看开头"，而主线/结论常在后面。
    const outlineRes = await suggestOutline(
      { chat: deps.chat },
      { text: outlineInputFor(text), deckName: input.deckName },
    );
    if (outlineRes.ok) {
      input.onStage?.('cards');
      requests += 1;
      const res = await suggestCards(
        { chat: deps.chat },
        { text: outlineRes.outline, deckName: input.deckName, max: budget, mode: 'outline' },
      );
      if (res.ok) {
        let produced = 0;
        for (const c of res.value) {
          produced += 1;
          const key = frontKey(c.front);
          if (key.length === 0 || seen.has(key)) continue;
          seen.add(key);
          out.push(c);
        }
        if (produced > 0) quota = planCharge(quota, produced, input.nowMs, input.tzOffsetMin).quota;
        if (res.truncated) truncated = true;
        return { ok: true, candidates: out, quota, requests, truncated, ...(degraded ? { degraded: true } : {}) };
      }
      // 出卡那一步失败：继续往下走分块路（下面还会再试一次），并记一笔"没按请求拿满"
      truncated = true;
    } else {
      // 提纲没成 ⇒ 这是**降级**，不是"资料没处理完"（分块路径照样能把每一块处理干净）
      degraded = true;
    }
  }

  input.onStage?.('cards');
  const chunks = chunkText(text);

  for (const chunk of chunks) {
    if (out.length >= budget) break; // 预算已用满：不再发请求
    const remaining = budget - out.length;
    requests += 1;
    const res = await suggestCards({ chat: deps.chat }, { text: chunk, deckName: input.deckName, max: remaining });
    if (!res.ok) {
      failed = true;
      if (out.length === 0) {
        // 第一块就没成：如实回失败（额度不动 —— 没产出就没有可扣的东西）
        return { ok: false, reason: res.reason };
      }
      truncated = true;
      break;
    }
    let produced = 0;
    for (const c of res.value) {
      produced += 1; // 生成的都算（哪怕下面因去重被丢掉 —— 钱已经花在这一次请求上了）
      const key = frontKey(c.front);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    // 逐块扣减：按**生成张数**（不是入选项数）。planCharge 自己会把 granted 累加进
    // quota.cards，这里直接接住它的结果即可 —— 首版在这里又做了一次加减，等于把账算反。
    if (produced > 0) {
      quota = planCharge(quota, produced, input.nowMs, input.tzOffsetMin).quota;
    }
    if (res.truncated) truncated = true;
  }

  if (out.length === 0) {
    return { ok: false, reason: failed ? '这次没能生成卡片，稍后再试。' : '模型没有给出可用的卡片。' };
  }
  return {
    ok: true,
    candidates: out,
    quota,
    requests,
    truncated: truncated || failed,
    ...(degraded ? { degraded: true } : {}),
  };
}
