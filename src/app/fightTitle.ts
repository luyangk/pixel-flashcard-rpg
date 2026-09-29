/**
 * fightTitle.ts —— **遭遇战名字**（D58）。
 *
 * ## 为什么要它
 * 战绩记录里原来只写**一个**领域名（`domainOfView` 取池中首个 deck），于是多领域合练的一局
 * 看起来像"生活常识"一局 —— 玩家原话："多选领域只写一个领域名其实有点奇怪"。
 * 现在每局都有一个 `雅号 · 组合` 的名字，例：「长安夜雨 · 唐诗 × 成语典故」。
 *
 * ## 两条路，兜底永远先到
 * 1. **本地兜底（确定性）**：按领域组合的哈希从词表取一个雅号 —— 同一组合必得同一个名字，
 *    不需要 Key、不花钱、即时可写。**结算写记录时用的就是它**；
 * 2. **LLM 升级（可选）**：有 Key 时再问一次模型要个更好的雅号，回来了就把记录里的名字换掉
 *    （结算屏与榜单都会跟着变）。**AI 永远不挡在结算路径上**（D38 的口径：不用 AI 也一切照常）。
 */
import type { Card, SaveFile } from '@core/types';

/** 雅号上限（码点）：短才像雅号，"长安夜雨"四个字正好。 */
export const YAHAO_MAX = 6;
/** 整名上限（码点）。名字太长会把战绩行挤爆（手机上就一行）。 */
export const TITLE_MAX = 24;
/** 组合与雅号之间的分隔符（`splitCombo` 依赖它，别改着玩）。 */
export const TITLE_SEP = ' · ';

/**
 * 兜底雅号词表（40 个，两字或四字，水墨武侠气）。
 *
 * 为什么手写而不是从领域名拼：这是**兜底**，要在"没配 AI"时也读起来像个名字；
 * 而按组合哈希取词保证同一组合永远同一个（记录不会飘）。
 */
const YAHAO_POOL: readonly string[] = [
  '长安夜雨', '孤灯残卷', '松间清露', '剑气书声', '夜半钟声', '纸上烟云', '灯下十年', '砚底波澜',
  '雪夜闭门', '江湖夜雨', '青灯黄卷', '晓风残月', '落笔生花', '一灯如豆', '半窗竹影', '墨池春水',
  '三更灯火', '五更鸡鸣', '书山有径', '学海无涯', '囊萤映雪', '凿壁偷光', '悬梁刺股', '闻鸡起舞',
  '寒窗苦读', '笔耕不辍', '手不释卷', '温故知新', '格物致知', '温润如玉', '金石为开', '水滴石穿',
  '一以贯之', '日拱一卒', '积羽沉舟', '集腋成裘', '聚沙成塔', '绳锯木断', '铁杵成针', '功不唐捐',
];

/** 领域名的清洗：非字符串/空白剔掉，去重保序（池子顺序就是玩家看到的顺序）。 */
function cleanNames(names: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(names) ? names : []) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0 || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 组合文案：单域只写名字；双域 `A × B`；三域以上 `A / B / C`。 */
export function comboLabel(names: readonly unknown[]): string {
  const list = cleanNames(names);
  if (list.length === 0) return '练功'; // 一个领域名都拿不到时的兜底（不该发生，但别留空）
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} × ${list[1]}`;
  return list.join(' / ');
}

/** 稳定的字符串哈希（FNV-1a 变体；不依赖随机数，故同一组合必得同一个雅号）。 */
function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 兜底雅号：按组合的稳定哈希从词表取一个。 */
export function fallbackYahao(names: readonly unknown[]): string {
  const list = cleanNames(names);
  const key = list.length === 0 ? '练功' : list.join('|');
  return YAHAO_POOL[stableHash(key) % YAHAO_POOL.length];
}

/** 码点安全截断。 */
function clip(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length > max ? cps.slice(0, max).join('') : text;
}

/** 从模型输出里取雅号：只留汉字/字母/数字，剃掉引号、顿号、换行等一切杂字，并截到 6 码点。 */
export function sanitizeYahao(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const kept = text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  return clip(kept, YAHAO_MAX);
}

/**
 * 拼出整名：`雅号 · 组合`，并封顶 `TITLE_MAX`。
 *
 * 雅号为空（模型给了空串/全是标点）⇒ 用兜底雅号 —— **名字永远不为空**。
 */
export function composeTitle(yahao: unknown, names: readonly unknown[]): string {
  const clean = sanitizeYahao(yahao);
  const label = comboLabel(names);
  const head = clean.length > 0 ? clean : fallbackYahao(names);
  // 先给组合留足位置：雅号最多 6，剩下的都给组合，拼起来就不会被截成"… · 唐诗 ×"
  const room = Math.max(2, TITLE_MAX - Array.from(head).length - Array.from(TITLE_SEP).length);
  return `${head}${TITLE_SEP}${clip(label, room)}`;
}

/** 从整名里取回组合部分（升级雅号时要用：`雅号 · 组合` → `组合`）。 */
export function splitCombo(title: unknown): string {
  const text = typeof title === 'string' ? title : '';
  const idx = text.indexOf(TITLE_SEP);
  return idx < 0 ? '' : text.slice(idx + TITLE_SEP.length).trim();
}

/**
 * 这一局涉及哪些领域名（按池内顺序去重）。
 *
 * 与 `results.domainOfView`（只取一个）不同：这里要的是**全部**参战领域 ——
 * 多领域合练的名字正该把它们都写上。
 */
export function fightDomainNames(pool: readonly Card[], save: SaveFile | undefined): string[] {
  const decks = Array.isArray(save?.decks) ? save.decks : [];
  const names: string[] = [];
  for (const card of Array.isArray(pool) ? pool : []) {
    const deckId = card?.deckId;
    if (typeof deckId !== 'string' || deckId.length === 0) continue;
    const deck = decks.find((d) => d && d.id === deckId);
    const name = typeof deck?.name === 'string' && deck.name.trim().length > 0 ? deck.name.trim() : deckId;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
