/**
 * codexFlow.ts —— Plan 5 · T5：藏书阁彩蛋的**写口**（`deck.egg`）。
 *
 * ## 为什么单独成文件（与 library.ts 同一条理由）
 * `ui/codex.ts` 只负责渲染与"玩家点了什么"，写存档一律经 app 层的窄函数走
 * `coord.mutate`。彩蛋正文的来源有两类——AI 产出经玩家点「用这段」确认、以及将来的手写——
 * 两者都经本函数消毒后落地，因此"屏幕上贴的东西 = 存档里的东西"这条等式有唯一入口。
 *
 * ## 消毒口径（宁可不写，不写脏值）
 * 落盘自检 `validateSave` 对 `decks[i].egg` 是**在场严检**（非空字符串、码点 ≤200）且整包拒，
 * 一个超长/空白的彩蛋会让**所有**改动一起写不进存储（同 library.ts 的 I-2 病灶）。
 * 故这里在 mutate 之前就 trim → 剥控制字符 → 封顶 → 拒空，把"内容不合法"变成可上屏的大白话。
 *
 * ## 只读态：先给原因，再靠闩锁兜底
 * `coord.readOnly()` 为真时**不抛异常**，而是回一条可上屏的 reason（与 library.ts 同口径）；
 * 闩锁本身仍是权威——即便有人绕过这道判断，`coord.mutate` 也会抛 `SaveReadOnlyError`
 * （UI 的 catch 负责收成一句提示，见 ui/codex.ts）。
 *
 * 时间与随机一律不读：本模块零时钟、零 DOM（与 app 层同纪律）。
 */
import type { Deck } from '@core/types';
import { EGG_MAX } from '@core/llmParse';
import type { Coordinator } from './persist';

/** 写彩蛋的结果面：`reason` 是可直接上屏的大白话。 */
export interface SetEggResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** 只读态的统一文案（与 library.READ_ONLY_LIBRARY_REASON 同义，按"改彩蛋"的口吻说）。 */
const READ_ONLY_EGG_REASON = '存档没法读取（只读保护中）：现在改不了彩蛋，你的存档原样保留。';

/**
 * 控制字符与"看起来像空白但不显示"的字符（含零宽、方向控制符、BOM）——一律剥掉。
 * 与 `core/llmParse` 的 CONTROL_RE 同域：那里的产出直接喂到这里，两处不一致就会出现
 * "解析器放行、写口落盘让整包拒"的裂缝。（llmParse 的该常量为模块私有，故此处复刻；
 * 若将来要收敛成一处，应在 core 导出，而不是让写口依赖解析器的私有实现。）
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** 消毒一段彩蛋正文：剥控制字符 → 折叠空白 → 去首尾 → 封顶码点。失败给可上屏 reason。 */
export function sanitizeEggText(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: '彩蛋内容不对（不是一段文字）。' };
  const collapsed = raw.replace(CONTROL_RE, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  if (collapsed.length === 0) return { ok: false, reason: '彩蛋是空的——先让 AI 写一段吧。' };
  const points = [...collapsed];
  if (points.length > EGG_MAX) {
    return { ok: false, reason: `彩蛋最多 ${EGG_MAX} 个字，这段太长了（${points.length} 字）。` };
  }
  return { ok: true, text: collapsed };
}

function findDeck(save: { decks: readonly Deck[] }, deckId: string): Deck | null {
  for (const d of save.decks) if (d && d.id === deckId) return d;
  return null;
}

/**
 * 把一个领域的彩蛋写进存档（`deck.egg`）。
 *
 * 拒绝面（全部 `{ok:false, reason}`，**不触存储**）：领域为空/不存在、内容空白或超长、
 * 只读态。同值不重写（写放大纪律，与 `bossFlow.setBossName` 同款）——重复点「用这段」
 * 不该让存档变脏、进而触发一次多余的落盘。
 */
export async function setEggOnDeck(coord: Coordinator, deckId: string, raw: string): Promise<SetEggResult> {
  if (typeof deckId !== 'string' || deckId.trim().length === 0) {
    return { ok: false, reason: '彩蛋没能写进存档：不知道是哪个领域。' };
  }
  const cleaned = sanitizeEggText(raw);
  if (!cleaned.ok) return { ok: false, reason: cleaned.reason };
  if (coord.readOnly()) return { ok: false, reason: READ_ONLY_EGG_REASON };

  const save = coord.snapshot();
  const decks = Array.isArray(save.decks) ? save.decks : [];
  const deck = findDeck({ decks }, deckId);
  if (deck === null) return { ok: false, reason: '这个领域已经不在了——刷新一下藏书阁再试。' };
  if (deck.egg === cleaned.text) return { ok: true }; // 同值不重写

  // 走到这里说明判断放行了；闩锁仍会在 mutate 内再拒一次（fail-closed 的第二道）。
  await coord.mutate((s) => {
    const target = s.decks.find((d) => d && d.id === deckId);
    if (target) target.egg = cleaned.text;
  });
  return { ok: true };
}
