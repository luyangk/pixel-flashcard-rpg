/**
 * host.ts —— Plan 4 · T11：宿主壳（屏路由 + 序章挂载 + 只读横幅 + 依赖注入）。
 *
 * ## 为什么需要这一层（R-P4-d 的登记）
 * plan 的十个任务把每块屏都做出来了，但**没有**任何任务负责回答"现在该显示哪一屏"。
 * 控制器的 `screen` 只覆盖会话位（menu/prepare/fight/result）；卡组/藏书阁/设置三屏
 * 是**屏内导航**，不进会话。于是宿主的职责是：
 *   会话位（fight/result/prepare 错误停留）**优先**，其余按本地路由（HostRoute）走。
 * 这条优先关系就是 `resolveView`——它是本文件里唯一有分支逻辑的纯函数，因此单独测。
 *
 * ## 序章（T6 顾虑 #1 的闭环）
 * `needsPrologue(save)` 为真时**先挂序章**，`onDone` 派发 `seenPrologue` 意图；
 * 序章是本地状态（`prologueActive`），不占控制器的会话位（R-T6-p4-a）。
 * 只读态下 `seenPrologue` 写不进（R-T6-p4-c）⇒ 每次冷启动都会再演一次序章，
 * 这是 fail-closed 的固有结果，宿主不做特殊处理（横幅同时在屏上说明原因）。
 *
 * ## 依赖注入的边界
 * 所有写口/文件口/rng 都由 `main.ts` 在装配层接好（`HostAdapters`），host 本身
 * 不认识 coordinator、也不读时钟——所以本文件能在 happy-dom 里整屏驱动。
 */
import type { Rng } from '@core/rng';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { pickFakes } from '../app/fakeMemory';
import { needsPrologue } from '../app/storyState';
import type { BattleScreenDeps, BattleScreenHandle } from './battleScreen';
import { mountBattleScreen } from './battleScreen';
import type { BeatEntry } from './beats';
import type { ArcAct } from './codex';
import { mountCodex } from './codex';
import { mountDecks } from './decks';
import { mountMenu } from './menu';
import { mountPrepare } from './prepare';
import { mountPrologue, type PrologueScene } from './prologue';
import { mountReadOnlyBar } from './readOnly';
import { mountResult } from './result';
import { mountSettings } from './settings';
import type { HostAdapters } from './hostTypes';

export type { HostAdapters } from './hostTypes';

/** 屏内导航的本地路由（不含会话位；会话位的优先级见 resolveView）。 */
export type HostRoute = 'menu' | 'prepare' | 'decks' | 'codex' | 'settings';

/** 当前该显示什么。 */
export type HostView =
  | { readonly kind: 'prologue' }
  | { readonly kind: 'battle' }
  | { readonly kind: 'result' }
  | { readonly kind: 'prepare' }
  | { readonly kind: 'screen'; readonly route: HostRoute };

/**
 * 会话位优先于本地路由（唯一的分支权威）：
 * 1. 序章在演 → 只有序章；
 * 2. `fight` → 战斗屏（本地路由此刻无意义）；
 * 3. `result` → 结算屏（同上）；
 * 4. `prepare` → 备战屏（startFight 失败后控制器把屏停在 prepare，此时**必须**回备战屏
 *    让玩家看到 `lastError`，哪怕本地路由是"卡组页"）；
 * 5. 其余（menu/boot）→ 本地路由。
 */
export function resolveView(snap: ControllerSnapshot, route: HostRoute, prologueActive: boolean): HostView {
  if (prologueActive) return { kind: 'prologue' };
  if (snap.screen === 'fight') return { kind: 'battle' };
  if (snap.screen === 'result') return { kind: 'result' };
  if (snap.screen === 'prepare') return { kind: 'prepare' };
  return { kind: 'screen', route };
}

export interface HostDeps extends HostAdapters {
  /** 战斗屏挂载覆盖位（测试注入假 stage；生产用真 mountBattleScreen）。 */
  readonly mountBattle?: (root: HTMLElement, ctrl: GameController, deps: BattleScreenDeps) => BattleScreenHandle;
  /** 初始本地路由（缺省 menu）。 */
  readonly initialRoute?: HostRoute;
}

export interface HostHandle {
  unmount(): void;
}

/**
 * 视图 → 用于判"要不要换屏"的稳定 key（同类视图只在关键状态变化时重建）。
 * 对 `snap.fight` 的取用**全程防御**：换屏判据不该因为一个畸形视图把整屏搞崩
 * （真 FightView 必有 state.pool，但宿主的健壮性不该建立在"上游永不脏"的假设上）。
 */
function viewKey(view: HostView, snap: ControllerSnapshot): string {
  const pool = snap.fight?.state?.pool;
  if (view.kind === 'battle') return `battle#${Array.isArray(pool) ? pool.join(',') : ''}`;
  if (view.kind === 'result') return `result#${snap.fight?.state?.phase ?? ''}#${String(snap.lastResult?.won)}`;
  return view.kind === 'screen' ? `screen#${view.route}` : view.kind;
}

/**
 * 挂宿主：只读横幅常驻 + 按 `resolveView` 换屏。
 * 换屏 = 先 unmount 旧的（干净拆除是各屏自己的契约），再 mount 新的；同 key 不重建
 * （屏自己订阅快照做增量渲染）。
 */
export function mountHost(root: HTMLElement, ctrl: GameController, deps: HostDeps): HostHandle {
  if (!root || !ctrl) throw new Error('mount-host: root/controller required');

  let route: HostRoute = deps.initialRoute ?? 'menu';
  let prologueActive = needsPrologue(ctrl.snapshot().save);
  let destroyed = false;
  let currentKey = '';
  let current: { unmount(): void } | null = null;
  /** 上一次看到的会话屏：用于"回到 menu 时重置本地路由"。 */
  let lastScreen: ControllerSnapshot['screen'] = ctrl.snapshot().screen;

  const readOnlyBar = mountReadOnlyBar(root, ctrl, {
    now: deps.now,
    tzOffsetMin: deps.tzOffsetMin,
    rawDump: deps.rawDump,
    saveTextFile: deps.saveTextFile,
    toastMs: deps.toastMs,
  });

  function onNav(target: HostRoute): void {
    if (destroyed) return;
    route = target;
    sync(ctrl.snapshot());
  }

  function mountFor(view: HostView, snap: ControllerSnapshot): { unmount(): void } {
    switch (view.kind) {
      case 'prologue':
        return mountPrologue(root, deps.prologueScenes as readonly PrologueScene[], () => {
          prologueActive = false;
          // 看完/跳过都派同一个意图（T6 的语义合并）；哪怕只读态写不进，屏也该回到菜单
          void ctrl.intent({ type: 'seenPrologue' }).catch(() => undefined);
          sync(ctrl.snapshot());
        });
      case 'battle': {
        const mount = deps.mountBattle ?? mountBattleScreen;
        return mount(root, ctrl, {
          sprites: deps.sprites,
          win: deps.win,
          raf: deps.raf,
          caf: deps.caf,
          toastMs: deps.toastMs,
          bannerText: deps.readOnlyText,
        });
      }
      case 'result': {
        const pool = snap.fight?.pool ?? [];
        const lost = snap.lastResult !== null && !snap.lastResult.won;
        // 假记忆素材在**挂屏这一刻**生成（纯演出、零数值后果；宿主决定条数上限 2）
        const fakes = lost && deps.wordTable ? pickFakes([...pool], 2, { rng: deps.rng, wordTable: deps.wordTable }) : [];
        return mountResult(root, ctrl, {
          beats: deps.beats as readonly BeatEntry[],
          fakes,
          onBeatDrawn: deps.onBeatDrawn,
          onReplay: deps.onReplay,
          setTimer: deps.setTimer,
          clearTimer: deps.clearTimer,
          flashMs: deps.flashMs,
          holdMs: deps.holdMs,
        });
      }
      case 'prepare':
        return mountPrepare(root, ctrl, { onNav: (t) => onNav(t), setBossName: deps.setBossName, toastMs: deps.toastMs });
      case 'screen':
        switch (view.route) {
          case 'prepare':
            return mountPrepare(root, ctrl, { onNav: (t) => onNav(t), setBossName: deps.setBossName, toastMs: deps.toastMs });
          case 'decks':
            return mountDecks(root, ctrl, {
              onNav: () => onNav('menu'),
              addCard: deps.addCard,
              addDeck: deps.addDeck,
              exportBackup: deps.exportBackup,
              importBackup: deps.importBackup,
              pickBackupText: deps.pickBackupText,
              saveTextFile: deps.saveTextFile,
              now: deps.now,
              tzOffsetMin: deps.tzOffsetMin,
              newId: deps.newId,
              toastMs: deps.toastMs,
            });
          case 'codex':
            return mountCodex(root, ctrl, {
              onNav: () => onNav('menu'),
              onPractice: deps.onPractice,
              eggs: deps.eggs,
              acts: deps.acts as readonly ArcAct[],
              beats: deps.beats as readonly BeatEntry[],
              tzOffsetMin: deps.tzOffsetMin,
            });
          case 'settings':
            return mountSettings(root, ctrl, {
              onNav: () => onNav('menu'),
              setTier: deps.setTier,
              setParams: deps.setParams,
              setPoolSize: deps.setPoolSize,
              replayPrologue: deps.replayPrologue,
              toastMs: deps.toastMs,
            });
          case 'menu':
          default:
            return mountMenu(root, ctrl, { onNav: (t) => onNav(t as HostRoute), topN: deps.topN });
        }
    }
  }

  function sync(snap: ControllerSnapshot): void {
    if (destroyed) return;
    // 回到会话的 menu 位 ⇒ 本地路由复位（否则"回菜单"后会继续停在卡组页）
    if (snap.screen === 'menu' && lastScreen !== 'menu') route = 'menu';
    lastScreen = snap.screen;

    const view = resolveView(snap, route, prologueActive);
    const key = viewKey(view, snap);
    if (key === currentKey) return;

    current?.unmount();
    current = null;
    currentKey = key;
    current = mountFor(view, snap);
  }

  const unsubscribe = ctrl.subscribe((snap) => sync(snap));
  sync(ctrl.snapshot());

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    current?.unmount();
    current = null;
    readOnlyBar.unmount();
  }

  return { unmount: destroy };
}
