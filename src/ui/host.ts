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
import { DAILY_CARD_CAP, DAILY_JUDGE_CAP, remainingCards, remainingJudges } from '../app/quota';
import { needsPrologue } from '../app/storyState';
import type { BattleScreenDeps, BattleScreenHandle } from './battleScreen';
import { mountBattleScreen } from './battleScreen';
import type { BeatEntry } from './beats';
import type { ArcAct } from './codex';
import { mountCodex } from './codex';
import { mountDecks } from './decks';
import { mountMenu } from './menu';
import { mountPractice } from './practice';
import { mountPrepare } from './prepare';
import { mountPrologue, type PrologueScene } from './prologue';
import { mountReadOnlyBar } from './readOnly';
import { mountResult } from './result';
import { mountSettings } from './settings';
import type { HostAdapters } from './hostTypes';

export type { HostAdapters } from './hostTypes';

/** 屏内导航的本地路由（不含会话位；会话位的优先级见 resolveView）。 */
export type HostRoute = 'menu' | 'prepare' | 'decks' | 'codex' | 'practice' | 'settings';

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
  /**
   * 重新演出序章（设置页的「重看序章」，T11 评审判 I-2）。
   *
   * 为什么需要这个显式方法：`prologueActive` 是在**挂载时**求值一次的本地状态——
   * 不能改成"每次快照都按 needsPrologue 重算"，因为 onDone 派发的 seenPrologue 是
   * 异步落库的，重算会在落库完成前把刚收起的序章又挂回来（自激循环）。
   * 于是由"发起方"显式要求重演：设置写口成功后宿主调它一次。
   */
  replayPrologue(): void;
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
  // 备战屏有两条来路（会话位 'prepare' = startFight 失败停留；本地路由 'prepare' = 玩家点进来），
  // 但它们是**同一个屏**、挂载参数也完全相同。两者必须归一到同一个 key（T11 评审判 I-3）：
  // 否则"开战失败"会被判成换屏 ⇒ 旧实例被拆、新实例重建 ⇒ 玩家刚选的池子/领域被静默复位
  // （实测：选 25 张 → 开战失败 → aria-pressed 回到 15）。
  if (view.kind === 'prepare') return 'prepare';
  if (view.kind === 'screen' && view.route === 'prepare') return 'prepare';
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
  /**
   * 练功屏「落在哪个分区」（D49）。两个入口来路不同：菜单进来是「看旧卡」（默认），
   * 卡组页的「采新卡」按钮进来要**直接开在采新卡分区**（不是落在首页让人自己找）。
   */
  let practiceTab: 'browse' | 'collect' = 'browse';
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

  /**
   * 今日额度的唯一口径（设置页与练功屏共用同一句）：**现算**——跨天与记账后都要跟手，
   * 缓存一行会让玩家看到昨天的数字。
   */
  function quotaText(): string {
    const q = ctrl.snapshot().save?.settings?.llmQuota;
    const nowMs = deps.now();
    const left = remainingCards(q, nowMs, deps.tzOffsetMin);
    const judges = remainingJudges(q, nowMs, deps.tzOffsetMin);
    return `今日：生成剩 ${left} / ${DAILY_CARD_CAP} · 判定剩 ${judges} / ${DAILY_JUDGE_CAP}`;
  }

  function onNav(target: HostRoute): void {
    if (destroyed) return;
    // 从菜单/其它一级屏进练功屏：一律回到默认分区（免得"上次从卡组页来"的记忆赖着不走）
    if (target === 'practice') practiceTab = 'browse';
    route = target;
    sync(ctrl.snapshot());
  }

  /** 卡组页的「采新卡」入口：切到练功屏并让它开在采新卡分区。 */
  function onCollect(): void {
    if (destroyed) return;
    practiceTab = 'collect';
    route = 'practice';
    sync(ctrl.snapshot());
  }

  /**
   * 各屏的挂载点。
   *
   * 【易错点】这里是**显式白名单**：`assembleHost` 造出来的依赖（`llm`/`llmCards`/`llmNames`/
   * `llmEgg`/`setEgg`/`resetSave`/`exportBackupNow`/`judge`/`setAnswerMode`）如果没在这里透传，
   * 功能在生产里就是死的——
   * 而"直挂屏组件"的单元测试仍然全绿（它们自己传 deps）。Plan 5 的 AI 接线就踩过一次，
   * 「重置存档」的接线又踩过一次（设置屏测了、宿主没透传），故这些行单独标注。
   */
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
          // 选项洗牌的随机源走宿主注入位（Plan 6 · T6）：测试要确定性，生产要每次都变
          rng: deps.rng,
          // 问答模式（Plan 6 · T7）：判卷口 + 模式写口。漏透传 = 生产里问答模式不可用
          // 而单测全绿（Plan 5 的 AI 接线踩过一次，这里的 HS#? 钉住）
          judge: deps.judge,
          setAnswerMode: deps.setAnswerMode,
        });
      }
      case 'result': {
        const pool = snap.fight?.pool ?? [];
        // 只有**真正的败局**才演假记忆：木桩练功不会输（Plan 7 · D46），
        // 给它演"记忆开始褪色"是纯噪音（清单 #5）。终局判定落在宿主这一处。
        const lost =
          snap.lastResult !== null && !snap.lastResult.won && snap.lastResult.mode !== 'drill';
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
        return mountPrepare(root, ctrl, { onNav: (t) => onNav(t), setBossName: deps.setBossName, llmNames: deps.llmNames, toastMs: deps.toastMs });
      case 'screen':
        switch (view.route) {
          case 'prepare':
            return mountPrepare(root, ctrl, { onNav: (t) => onNav(t), setBossName: deps.setBossName, llmNames: deps.llmNames, toastMs: deps.toastMs });
          case 'decks':
            return mountDecks(root, ctrl, {
              onNav: () => onNav('menu'),
              onCollect: deps.ingestUrl === undefined || deps.collectCards === undefined ? undefined : onCollect,
              addCard: deps.addCard,
              llmCards: deps.llmCards,
              addDeck: deps.addDeck,
              renameDeck: deps.renameDeck,
              removeDeck: deps.removeDeck,
              removeCard: deps.removeCard,
              exportBackup: deps.exportBackup,
              importBackup: deps.importBackup,
              pickBackupText: deps.pickBackupText,
              saveTextFile: deps.saveTextFile,
              now: deps.now,
              tzOffsetMin: deps.tzOffsetMin,
              newId: deps.newId,
              toastMs: deps.toastMs,
            });
          case 'practice':
            return mountPractice(root, ctrl, {
              onNav: () => onNav('menu'),
              initialTab: practiceTab,
              onDrill: deps.onDrill,
              refreshChoices: deps.refreshChoices,
              quotaText: deps.practiceQuotaText,
              updateCard: deps.updateCard,
              // 采新卡整块（Plan 8 · T9）：抓取 / 生成 / 清单 / 入库——**缺一个就整块收起**
              // （缺省不显示点了没反应的入口；漏透传 = 生产里功能是死的而单测全绿）
              collect:
                deps.ingestUrl === undefined || deps.collectCards === undefined
                  ? undefined
                  : {
                      ingestUrl: deps.ingestUrl,
                      collectCards: deps.collectCards,
                      inbox: deps.inbox,
                      // 来源库（D53）：读订阅源 + 玩家维护的那份库
                      sources: deps.sources,
                      addCard: deps.addCard,
                      addDeck: deps.addDeck,
                      newId: deps.newId,
                      sharedInput: deps.sharedInput ?? null,
                    },
              now: deps.now,
              tzOffsetMin: deps.tzOffsetMin,
              toastMs: deps.toastMs,
            });
          case 'codex':
            return mountCodex(root, ctrl, {
              onNav: () => onNav('menu'),
              onPractice: deps.onPractice,
              eggs: deps.eggs,
              acts: deps.acts as readonly ArcAct[],
              beats: deps.beats as readonly BeatEntry[],
              llmEgg: deps.llmEgg,
              setEgg: deps.setEgg,
              tzOffsetMin: deps.tzOffsetMin,
            });
          case 'settings':
            return mountSettings(root, ctrl, {
              onNav: () => onNav('menu'),
              llm: deps.llm,
              pwa: deps.pwa,
              setAnswerMode: deps.setAnswerMode,
              llmQuotaText: quotaText,
              setTier: deps.setTier,
              setParams: deps.setParams,
              setPoolSize: deps.setPoolSize,
              replayPrologue: deps.replayPrologue,
              resetSave: deps.resetSave,
              exportBackupNow: deps.exportBackupNow,
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
    // key 只在**挂载成功之后**才提交（T11 评审 m-4）：mountFor 抛错时若 key 已闩上，
    // 这个屏就再也重建不了（而且异常会穿进控制器的订阅回调）。
    const mounted = mountFor(view, snap);
    current = mounted;
    currentKey = key;
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

  return {
    unmount: destroy,
    replayPrologue(): void {
      if (destroyed) return;
      prologueActive = true;
      currentKey = ''; // 强制换屏（哪怕此刻正停在菜单）
      sync(ctrl.snapshot());
    },
  };
}
