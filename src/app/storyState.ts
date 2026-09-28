/**
 * storyState.ts —— Plan 4 · T6：`settings.story`（叙事进度）的读写口。
 *
 * 为什么单独成文件：`settings.story` 是**必填**的三段式扩字段（core/types 定义形状 +
 * validateSave 严检 + migrateSave 补默认），但"谁在什么时候挂序章""碎片游标何时回写"
 * 是 app 侧的编排决定。把它收在这一个文件里，T7/T10 只 import 语义函数，不必各自
 * 记 settings 路径、也不必各自照抄只读态与写放大纪律。
 *
 * 分工（R-T6-p4-a 裁决，T7/T10 消费）：
 * - **挂不挂序章由宿主判断**：`needsPrologue(save)` 为真时，宿主（T7 菜单屏 / main.ts
 *   装配层）调 `mountPrologue(root, scenes, onDone)`；`onDone` 里派发
 *   `ctrl.intent({type:'seenPrologue'})`。控制器**不主动切 'prologue' 屏**——
 *   `ControllerScreen` 的 'prologue' 类型位保留，初始屏仍是 'menu'（保 GC#1 boot→menu
 *   断言与 T7 菜单契约）。
 * - **跳过与看完同待遇**：两者都等于"以后别再给我看序章"（LORE §5.1「可跳过」），
 *   故 `skipPrologue` / `seenPrologue` 两个 intent 在控制器里合并成同一件事：写
 *   `prologueSeen=true` 后回 menu。
 * - **战报碎片游标**：result 屏（T7）抽完一条后调 `saveBeatCursor(coord, draw.next)`
 *   回写，下局接着抽（`ui/beats.nextBeat` 的 next 是累计抽取数）。
 *
 * 写入纪律：所有写入都经 `Coordinator.mutate`（唯一写入口，只读态抛 SaveReadOnlyError，
 * 由调用方——控制器 guardedWrite / UI——折成快照位）。**同值不重写**：重复"记看过"
 * 不制造脏位，避免把 RF#1 的攒批窗白白推开一次。
 */
import type { SaveFile, StorySettings } from '@core/types';
import type { Coordinator } from './persist';

/** 读叙事进度（story 必填位；旧档在 load 时已经 migrateSave 补齐，故此处无需兜底）。 */
export function storyOf(save: SaveFile): StorySettings {
  return save.settings.story;
}

/** 序章是否还需演出（宿主据此决定挂不挂 mountPrologue）。 */
export function needsPrologue(save: SaveFile): boolean {
  return !save.settings.story.prologueSeen;
}

/**
 * 记下"序章看过"（跳过与看完共用这一个写口）。已为 true 时直接返回，不碰存档。
 * 只读态下 mutate 抛 SaveReadOnlyError —— 由调用方（控制器）捕获并折成只读快照位。
 */
export async function markPrologueSeen(coord: Coordinator): Promise<void> {
  if (coord.snapshot().settings.story.prologueSeen) return; // 同值不重写（写放大约束）
  await coord.mutate((save) => {
    save.settings.story.prologueSeen = true;
  });
}

/**
 * 回写战报碎片游标（result 屏抽完一条后调用）。
 * 非法游标（负数 / 小数 / NaN）**不写**：它是 nextBeat 的累计抽取数，脏值无合法来源，
 * 而落盘自检（validateSave 的 story.beatIndex 非负整数域）会因此整包拒——fail-closed
 * 不把脏值放进权威位（与 Coordinator.markExported 对非法时刻的处理同向）。
 */
export async function saveBeatCursor(coord: Coordinator, cursor: number): Promise<void> {
  if (!Number.isInteger(cursor) || cursor < 0) return;
  if (coord.snapshot().settings.story.beatIndex === cursor) return; // 同值不重写
  await coord.mutate((save) => {
    save.settings.story.beatIndex = cursor;
  });
}
