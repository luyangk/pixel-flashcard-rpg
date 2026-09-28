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
 *
 * 【T8 接线】boss 档取胜时额外两笔（同一 guardedWrite 内）：`bossFlow.markPurified`
 * 写 `deck.purifiedAt`，跨过 3/6/9 净化数时 `markArcSeen` 推进 `settings.story.arcSeen`。
 * 这是 T8 对"冻结文件"的唯一改动面（R-T8-p4-a 授权），除此之外骨架未动。
 */
import { GRADES, type Grade } from '@core/sm2';
import type { SaveFile } from '@core/types';
import type { BattleState } from '@core/battle';
import type { Rng } from '@core/rng';
import type { FightView } from './battleFlow';
import { answerCurrent, startFight } from './battleFlow';
import type { Coordinator } from './persist';
import { playerStatsFor, levelFromExp, settleFight } from './growth';
import { recordRun } from './results';
import { backupReminderDue } from './backup';
import { markPrologueSeen } from './storyState';
import { actsUnlockedBy, markArcSeen, markPurified, purifiedCount } from './bossFlow';
import type {
  ControllerSnapshot,
  ControllerScreen,
  GameController,
  GameIntent,
  RunSummary,
  StartError,
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
  /** 提示文案覆盖位（可选）：readOnly=只读保护提示，saveFailed=写入失败提示。 */
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

export async function createGameController(deps: GameControllerDeps): Promise<GameController> {
  const { coord, rng, now, tzOffsetMin } = deps;
  const notices = { ...DEFAULT_NOTICE, ...(deps.noticeText ?? {}) };

  let screen: ControllerScreen = 'menu';
  let fight: FightView | null = null;
  let lastResult: RunSummary | null = null;
  let lastError: StartError | null = null;
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
      gradeOf: (c) => grades.get(c.id) ?? GRADES.good,
      nowMs: now(),
      tzOffsetMin,
      params: save.settings.sm2Params,
    });
    const won = result.won;
    const levelBefore = levelFromExp(save.settings.progress.exp);

    // 顺序说明（与 brief 字面 settleFight→recordRun→settleAndRecord 相反，语义等价且更稳）：
    // 先落账（exp/plays/cards），再写榜单——recordRun 内部的 flushToClean 收口会把
    // 前一步的脏一并落盘，且它的 level 取到**含本局 exp** 的等级（results.ts）。
    // **不变量**：此处两步都不得自行 flush 之外的收口，flush 只由 recordRun 负责
    // （若后续重构拆掉 recordRun 的 flushToClean，本链的"落盘完成"承诺随之失效——
    // GC#6 的 exp>0/榜单 1 条/plays=1 三断言即该不变量的回归钉子）。
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

    // T8：卷灵净化 + 暗线里程碑（只在 boss 档取胜时）。顺序与语义：
    // ① markPurified 把本局参战领域写 purifiedAt（已净化的不重写，重战当练习关）；
    // ② 净化数跨过 3/6/9 时把 story.arcSeen 推进到对应幕（只前进），codex 的行记区据此
    //    决定哪一幕可回看。两步都在同一个 guardedWrite 里：只读态下一起被折成快照位，
    //    不会出现"净化写上了、里程碑没写"的半截状态被当成正常。
    if (won && kind === 'boss') {
      const deckIds: string[] = [];
      for (const c of view.pool) {
        if (typeof c?.deckId === 'string' && c.deckId.length > 0 && !deckIds.includes(c.deckId)) {
          deckIds.push(c.deckId);
        }
      }
      await guardedWrite(async () => {
        const fresh = await markPurified(coord, deckIds, now());
        if (fresh.length === 0) return;
        const act = actsUnlockedBy(purifiedCount(coord.snapshot()));
        if (act > 0) await markArcSeen(coord, act);
      });
    }

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
            stats: playerStatsFor(save),
            difficulty: i.difficulty,
          },
        );
        if ('error' in res) {
          // 失败是值不是异常：屏停留备战；码供分流、文案供上屏（T7 prepare 屏消费）。
          lastError = { code: res.error, message: res.message };
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
        if (fight === null) break; // 无战可答：静默忽略
        // C-1：**相位守卫必须在此**——answerCurrent 只要有当前卡就造新 view（引用不等），
        // 仅靠 `next === fight` 挡不住"终局后同帧再来一次 answer"（won 提前击杀与气血
        // 归零型 lost 的 idx 都还在池内）⇒ 会二次结算 exp/plays/榜单并对已答卡重复
        // applyReview（SRS 双推进=数据损坏）。守卫落在调用前，与 answerCurrent 的
        // 空卡短路形成双保险。
        if (fight.state.phase !== 'answering') break;
        const current = fight.pool[fight.state.idx];
        if (current === undefined) break;
        const next = answerCurrent(fight, i.grade, { rng });
        if (next === fight) break; // 空卡/畸形视图：引用幂等短路（相位守卫之上的兜底）
        grades.set(current.id, i.grade);
        fight = next;
        if (next.state.phase === 'won' || next.state.phase === 'lost') {
          lastResult = await settleToStorage(next);
          // 终局后 fight **刻意保留**：result 屏要展示终局棋盘与战报（controllerTypes
          // 的快照注释随之澄清为"结算离场（finish/toMenu）后为 null"）。
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
        // T6（R-T6-p4-a）：两个 intent 语义合并——跳过与看完都等于"以后别再给我看序章"
        // （LORE §5.1 可跳过），唯一副作用是 settings.story.prologueSeen=true；屏始终回 menu。
        // "何时挂序章"归宿主（storyState.needsPrologue + mountPrologue），控制器不主动切
        // 'prologue' 屏（初始屏仍 menu，保 GC#1 与 T7 菜单契约）。
        // 只读态：guardedWrite 折成 notice + readOnly 位，不让异常逃到 UI 事件处理器。
        await guardedWrite(async () => {
          await markPrologueSeen(coord);
        });
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
