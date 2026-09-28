/**
 * gameController.ts —— Plan 4 · T3：会话编排核（DOM 无关）。
 *
 * 职责边界（单向数据流）：
 * - **唯一真值持有者**：coordinator（存档）、FightView（战斗）、screen（屏位）；
 * - UI（T4/T5/T7 的屏组件）只做两件事：`subscribe` 读快照渲染、`intent` 派发玩家意图；
 * - 控制器本身零 DOM、零时钟读取（now/tzOffsetMin/rng 全部经 deps 注入，符合 core 同款纪律）。
 *
 * 一局的生命周期（answer intent 是唯一的推进口）：
 *   preparing → startFight → fighting →（每次 answer：answerCurrent + 可选终局结算）
 *   终局时内部串完三条落库义务，且**全部 await 收口**后才发快照：
 *     ① settleFight：对已消耗卡走 applyReview（R-T4-d 唯一复习入口）；
 *     ② settleAndRecord：cards 整体替换 + progress.exp 累加 + meta.plays+1；
 *     ③ recordRun：本局记入 settings.leaderboard（截 50）。
 *
 * 只读态（D29）：任一写入面抛 SaveReadOnlyError 都被捕获，转为快照 readOnly=true + notice；
 * 调用方（UI）据此常驻横幅。**游戏流程不中断**——玩家可以继续看题，只是不再落盘。
 */
import type { Grade } from '@core/sm2';
import type { SaveFile } from '@core/types';
import type { BattleState } from '@core/battle';
import type { Rng } from '@core/rng';
import type { PlayerStats } from '@core/stats';
import type { FightView } from './battleFlow';
import { answerCurrent, startFight } from './battleFlow';
import type { Coordinator } from './persist';
import { playerStatsFor, levelFromExp, settleFight } from './growth';
import { recordRun, buildRunInput } from './results';
import { backupReminderDue } from './backup';
import type {
  ControllerSnapshot,
  ControllerScreen,
  GameController,
  GameIntent,
  RunSummary,
} from './controllerTypes';

/** 控制器依赖（全部注入，测试可控；生产由 src/main.ts 装配）。 */
export interface GameControllerDeps {
  readonly coord: Coordinator;
  /** 随机源：一条流贯穿建池与战斗（与 startFight 契约一致）。 */
  readonly rng: Rng;
  /** 时钟读数（毫秒）——生产传 platform/clock.now。 */
  readonly now: () => number;
  /** 本地时区偏移分钟（UTC+8 → +480，R-T4-a 约定）。 */
  readonly tzOffsetMin: number;
  /** 存档载入时是否已处于只读态（migrateSave 不可恢复失败的场景由 coordinator 判定）。 */
  readonly noticeText?: { readonly readOnly: string; readonly saveFailed: string };
}

const DEFAULT_NOTICE = {
  readOnly: '存档无法读取，本次进度不会保存。',
  saveFailed: '这次没能写进存档，稍后会自动重试。',
} as const;

function isSaveReadOnlyError(e: unknown): boolean {
  // 结构化判别（不 import 类，避免与 persist 的运行期耦合）：name 由 persist 定义。
  return e instanceof Error && e.name === 'SaveReadOnlyError';
}

/** 本局评分来源：控制器把"玩家对当前卡的自评"原样透传。 */
function gradeSink(): { grade: Grade; set(g: Grade): void; get(): Grade } {
  let current: Grade = 3 as Grade; // good 兜底：未作答过就调 settleFight 属调用方 bug
  return {
    get grade() {
      return current;
    },
    set(g: Grade) {
      current = g;
    },
    get: () => current,
  };
}

export async function createGameController(deps: GameControllerDeps): Promise<GameController> {
  const { coord, rng, now, tzOffsetMin } = deps;
  const notices = { ...DEFAULT_NOTICE, ...(deps.noticeText ?? {}) };

  let screen: ControllerScreen = 'menu';
  let fight: FightView | null = null;
  let lastResult: RunSummary | null = null;
  let lastError: string | null = null;
  let notice: string | null = null;
  let readOnly = coord.readOnly();
  // 每局的自评记录：settleFight 需要"每张已作答卡当时的 grade"，而 FightView 不存评定。
  let grades = new Map<string, Grade>();
  const listeners = new Set<(s: ControllerSnapshot) => void>();

  function snapshot(): ControllerSnapshot {
    return {
      screen,
      fight,
      save: coord.snapshot(),
      readOnly,
      reminderDue: backupReminderDue(coord.snapshot().meta.lastExportedAt ?? null, now()),
      lastResult,
      lastError,
      notice,
    };
  }

  function emit(): void {
    const s = snapshot();
    for (const cb of listeners) cb(s);
  }

  /** 写路径统一收口：只读与写入失败都转成快照位，绝不让异常逃到 UI 事件处理器。 */
  async function guardedWrite(fn: () => Promise<void>): Promise<void> {
    if (readOnly) {
      notice = notices.readOnly;
      return;
    }
    try {
      await fn();
    } catch (e) {
      if (isSaveReadOnlyError(e)) {
        readOnly = true;
        notice = notices.readOnly;
      } else {
        notice = notices.saveFailed;
      }
    }
  }

  /** 终局结算链（三步一体，见文件头注释）。 */
  async function settleToStorage(view: FightView): Promise<RunSummary> {
    const save = coord.snapshot();
    const result = settleFight(save.cards, view, {
      gradeOf: (c) => grades.get(c.id) ?? (3 as Grade),
      nowMs: now(),
      tzOffsetMin,
      params: save.settings.sm2Params,
    });
    const won = result.won;
    const levelBefore = levelFromExp(save.settings.progress.exp);

    await guardedWrite(async () => {
      await coord.settleAndRecord({ cards: result.cards, exp: result.exp, won });
    });

    // 榜单：kind 取本局难度（boss 档在 T8 经 intent.difficulty 传入后由 fight 侧带出）。
    const state = view.state;
    const kind = view.difficulty === 'boss' ? 'boss' : 'encounter';
    const domain = domainOfView(view, save);
    await guardedWrite(async () => {
      await recordRun(coord, view, state, {
        nowMs: now(),
        domain,
        kind,
        level: levelFromExp(coord.snapshot().settings.progress.exp),
      });
    });

    const expAfter = coord.snapshot().settings.progress.exp;
    const levelAfter = levelFromExp(expAfter);
    return {
      won,
      expGained: result.exp,
      levelBefore,
      levelAfter,
      leveledUp: levelAfter > levelBefore,
      misses: countMisses(state),
      poolLen: view.pool.length,
    };
  }

  function countMisses(state: BattleState): number {
    let n = 0;
    for (const e of state.log) if (e?.kind === 'miss') n += 1;
    return n;
  }

  function domainOfView(view: FightView, save: SaveFile): string {
    const deckId = view.pool[0]?.deckId;
    if (typeof deckId !== 'string' || deckId.length === 0) return 'unknown';
    const deck = save.decks.find((d) => d.id === deckId);
    const name = deck?.name;
    return typeof name === 'string' && name.length > 0 ? name : 'unknown';
  }

  async function handle(i: GameIntent): Promise<void> {
    // intent 边界清旧的一次性消息（lastError 归 startFight 自己管）。
    notice = null;
    switch (i.type) {
      case 'startFight': {
        lastError = null;
        const save = coord.snapshot();
        const res = startFight(
          { decks: save.decks, cards: save.cards },
          {
            size: i.size,
            deckIds: i.deckIds,
            rng,
            nowMs: now(),
            stats: playerStatsFor(save) as PlayerStats,
            difficulty: i.difficulty,
          },
        );
        if ('error' in res) {
          // 失败是值不是异常：屏停留备战，分流文案交给 UI（T7 prepare 屏）。
          lastError = res.message;
          screen = 'prepare';
          break;
        }
        fight = res;
        grades = new Map();
        lastResult = null;
        screen = 'fight';
        break;
      }
      case 'answer': {
        if (fight === null) break; // 无战可答：静默忽略（双击/迟到事件的幂等面）
        const current = fight.pool[fight.state.idx];
        if (current === undefined) break;
        const next = answerCurrent(fight, i.grade, { rng });
        if (next === fight) break; // 非 answering 态：幂等短路，不重复结算
        grades.set(current.id, i.grade);
        fight = next;
        if (next.state.phase === 'won' || next.state.phase === 'lost') {
          lastResult = await settleToStorage(next);
          screen = 'result';
        }
        break;
      }
      case 'finish': {
        // result → menu 的收口：清战斗与摘要（本局已落库）。
        fight = null;
        lastResult = null;
        grades = new Map();
        screen = 'menu';
        break;
      }
      case 'toMenu': {
        // 弃战：未终局的仗不落账（SRS/exp/榜单都不动），仅丢弃视图。
        fight = null;
        grades = new Map();
        screen = 'menu';
        break;
      }
      case 'skipPrologue':
      case 'seenPrologue': {
        // 管道先建（T6 接 prologue 屏与 settings.story 持久位）；此处直达菜单。
        screen = 'menu';
        break;
      }
    }
    if (coord.readOnly()) readOnly = true;
    emit();
  }

  return {
    snapshot,
    intent: handle,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** 供 T5/T7 复用的派生工具：把 RunSummary 变成 result 屏的一行摘要文案素材。 */
export function resultHeadline(r: RunSummary): string {
  if (!r.won) return '这一局没打完混沌。';
  return r.leveledUp ? `胜。修为进境，已至 ${r.levelAfter} 级。` : '胜。混沌又退了一尺。';
}

/** 备用：把 buildRunInput 暴露给需要"预览本局分数"的屏（T7 result 展示）。 */
export { buildRunInput };
