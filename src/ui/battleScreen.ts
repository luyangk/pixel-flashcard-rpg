/**
 * battleScreen.ts —— Plan 4 · T5：战斗屏接线（DOM 外壳 + stage 生命周期 + 自评四档）。
 *
 * 这一层是"胶水"，刻意不承载任何游戏口径：战斗推进/落账在 controller，绘制在 stage，
 * SRS 档位在 core/sm2.GRADES。本文件只做四件事：
 *
 * 1. **挂载与拆除**：建 DOM 外壳 → mountBattleStage 拿 stage → rAF 循环 → window.resize；
 *    unmount 全部反向清干净（cancelAnimationFrame / 摘监听 / stage.destroy / 摘 DOM）。
 *    stage 自身不注册 rAF、不读钟、不听 resize（T4 的刻意切分），所以这两件事只能在这儿做。
 * 2. **时间注入**：rAF 回调的 `timestamp` **原样**作为 tMs 传 stage.frame —— 不在本层读
 *    Date.now()/performance.now()，否则演出节奏会随"读钟点"漂移，测试也无法注入时钟。
 * 3. **防连点（RF#3，UI 层那一半）**：点击即把四档全部 disabled，**只有新快照**（对象引用
 *    变化，不是重放同一对象）才解禁；controller 侧的 phase 守卫是第二层兜底。
 *    intent 抛错/被拒时也要解禁——否则一次失败会把屏幕永久冻住。
 * 4. **脉冲式反馈（T4 教训①）**：只对"本次快照新增的战报条目"显示空转提示与回击飘字，
 *    下一快照即清空。用 `log.some(kind==='miss')` 那种累计口径写，会让提示永远挂着。
 *
 * 卡面流程（自评）：**先只显示 front**；玩家按下一档 = 作答，随即显示那张卡的 back 作为
 * 确认（"我评的是这张"），并停留在屏上直到开新局。作答与下一帧出新题之间没有中间屏，
 * 这是 T5 的既定范围（假记忆演出属 T7）。
 */
import { GRADES, type Grade } from '@core/sm2';
import type { BattleEvent } from '@core/battle';
import type { FightView } from '../app/battleFlow';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { mountBattleStage, type BattleStage, type BattleStageDeps } from '../stage/battleStage';
import type { StageSprites } from '../stage/renderer';
import { docOf, h, setHidden } from './dom';
import { mountBanner, showToast } from './toast';

/** 四档按钮（顺序即屏上顺序）：白话文案 ↔ GRADES 的映射就这一处。 */
const GRADE_BUTTONS: ReadonlyArray<{ readonly key: string; readonly grade: Grade; readonly label: string }> = [
  { key: 'again', grade: GRADES.again, label: '忘了' },
  { key: 'hard', grade: GRADES.hard, label: '想起来了' },
  { key: 'good', grade: GRADES.good, label: '对了' },
  { key: 'easy', grade: GRADES.easy, label: '太简单' },
];

const DEFAULT_BANNER_TEXT = '只读模式：存档当前不可写，本局的改动不会保存';
const MISS_HINT_TEXT = '空转 —— 这题没想起来，怪物纹丝不动';

/** resize 监听只需要这么点面：够注入假 window，也够真 window 直接喂进来。 */
export interface BattleScreenWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: 'resize', cb: () => void): void;
  removeEventListener(type: 'resize', cb: () => void): void;
}

export interface BattleScreenDeps {
  /** 舞台素材（转交 mountBattleStage）。 */
  readonly sprites: StageSprites;
  /** 缩放倍数上限（透传 stage）。 */
  readonly maxInt?: number;
  /** 文档覆盖位（缺省取 root.ownerDocument）。 */
  readonly doc?: Document;
  /** 视口覆盖位（缺省取全局 window；测试注入假 window） 。 */
  readonly win?: BattleScreenWindow;
  /** rAF/cAF 覆盖位（缺省取全局；测试注入以断言取消与时间戳透传）。 */
  readonly raf?: (cb: (tMs: number) => void) => number;
  readonly caf?: (handle: number) => void;
  /** 舞台挂载覆盖位（缺省真 mountBattleStage；测试注入假 stage）。 */
  readonly mountStage?: (host: HTMLElement, deps: BattleStageDeps) => BattleStage;
  /** toast 存活毫秒（透传 showToast；测试可给 0 免定时器）。 */
  readonly toastMs?: number;
  /** 只读横幅文案覆盖位。 */
  readonly bannerText?: string;
}

/** 挂载句柄：unmount/destroy 同一件事（unmount 是 brief 的对外名，destroy 是行文习惯）。 */
export interface BattleScreenHandle {
  unmount(): void;
  destroy(): void;
}

const EMPTY_EVENTS: readonly BattleEvent[] = [];

/** 快照是否处于"可以作答"的状态（终局/离开 fight 屏都要锁住四档）。 */
function canAnswer(snap: ControllerSnapshot): boolean {
  const fight = snap.fight;
  return !!fight && snap.screen === 'fight' && fight.state.phase === 'answering' && fight.current !== null;
}

/**
 * 在 root 里挂一屏战斗界面。
 *
 * 依赖全部可注入（sprites 之外），所以本模块在 happy-dom 里能完整测到：rAF 时间戳透传、
 * resize 转发、destroy 的取消与摘除、以及防连点的两个快照边界。
 */
export function mountBattleScreen(
  root: HTMLElement,
  ctrl: GameController,
  deps: BattleScreenDeps
): BattleScreenHandle {
  if (!root || !ctrl) throw new Error('mount-battle-screen: root/controller required');
  const doc = deps.doc ?? docOf(root);
  const win =
    deps.win ?? (typeof window !== 'undefined' ? (window as unknown as BattleScreenWindow) : null);
  const raf =
    deps.raf ??
    (typeof requestAnimationFrame === 'function' ? (cb: (tMs: number) => void) => requestAnimationFrame(cb) : null);
  const caf =
    deps.caf ??
    (typeof cancelAnimationFrame === 'function' ? (handle: number) => cancelAnimationFrame(handle) : null);

  /* ------------------------------------------------------------ DOM 外壳 */
  const hpEl = h('div', { 'data-ui': 'hp', class: 'hp' });
  const stageHost = h('div', {
    'data-ui': 'stage-host',
    class: 'stage-host',
    style: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' },
  });
  const fxEl = h('div', { 'data-ui': 'fx', class: 'fx' });
  const missEl = h('div', { 'data-ui': 'miss-hint', class: 'miss-hint', hidden: true }, MISS_HINT_TEXT);
  const frontEl = h('div', { 'data-ui': 'card-front', class: 'card-front' });
  const backEl = h('div', { 'data-ui': 'card-back', class: 'card-back', hidden: true });
  const cardEl = h('div', { 'data-ui': 'card', class: 'card' }, [frontEl, backEl]);

  const gradeButtons = GRADE_BUTTONS.map((spec) => {
    const b = h(
      'button',
      { 'data-grade': spec.key, class: 'grade-btn', type: 'button' },
      spec.label
    ) as HTMLButtonElement;
    b.addEventListener('click', () => onGrade(spec));
    return b;
  });
  const gradesEl = h('div', { 'data-ui': 'grades', class: 'grades' }, gradeButtons);

  const screen = h('div', { 'data-ui': 'battle-screen', class: 'battle-screen' }, [
    hpEl,
    stageHost,
    fxEl,
    missEl,
    cardEl,
    gradesEl,
  ]);
  root.appendChild(screen);

  /* ------------------------------------------------------------ stage 生命周期 */
  const stage = (deps.mountStage ?? mountBattleStage)(stageHost, {
    sprites: deps.sprites,
    maxInt: deps.maxInt,
    doc,
  });

  let destroyed = false;
  let frameHandle: number | null = null;

  /** 视口尺寸 → stage 重算整数缩放/居中。stage 内部对 host 尺寸不敏感，故传视口。 */
  const onResize = (): void => {
    if (destroyed || !win) return;
    stage.onResize(win.innerWidth, win.innerHeight);
  };

  /** 每帧：拿当前快照画一帧，tMs 用 rAF 的 timestamp（本层绝不自己读钟）。 */
  const loop = (tMs: number): void => {
    if (destroyed) return;
    const snap = ctrl.snapshot();
    if (snap.fight) stage.frame(snap.fight.state, snap.fight, tMs);
    frameHandle = raf ? raf(loop) : null;
  };

  /* ------------------------------------------------------------ 渲染与脉冲 */
  let primed = false; // 首帧只对齐：挂载时已有的历史战报不重放（T4 FX_UNPRIMED 同口径）
  let seenLogLen = 0;
  let lastGraded: FightView['current'] = null;
  let fightPool: readonly string[] | null = null;
  let lastNotice: string | null = null;
  let bannerOff: (() => void) | null = null;

  /** 只把"本次快照新增的战报条目"当事件；回退（新一局的 log 更短）时全量视为新。 */
  function newEvents(log: readonly BattleEvent[]): readonly BattleEvent[] {
    if (!primed) {
      primed = true;
      seenLogLen = log.length;
      return EMPTY_EVENTS;
    }
    if (log.length < seenLogLen) {
      seenLogLen = log.length;
      return log;
    }
    const fresh = log.slice(seenLogLen);
    seenLogLen = log.length;
    return fresh;
  }

  function renderCard(snap: ControllerSnapshot): void {
    const fight = snap.fight;
    const current = fight?.current ?? null;
    frontEl.textContent = current ? current.front : fight ? '本局结束' : '未在战斗中';
    setHidden(backEl, lastGraded === null);
    if (lastGraded) {
      backEl.textContent = `答案：${lastGraded.back}`;
    }
  }

  function render(snap: ControllerSnapshot): void {
    const fight = snap.fight;
    // 换局（池子对象变了）就把上一局的答案确认收掉；fight 清空时也收。
    if ((fight?.state.pool ?? null) !== fightPool) {
      fightPool = fight?.state.pool ?? null;
      lastGraded = null;
    }

    const fresh = fight ? newEvents(fight.state.log) : ((seenLogLen = 0), EMPTY_EVENTS);
    renderCard(snap);

    if (fight) {
      hpEl.textContent = `我方 ${fight.state.playerHp}/${fight.state.maxPlayerHp} · 敌 ${fight.state.enemyHp}`;
    } else {
      hpEl.textContent = '';
    }

    // 脉冲①：空转提示（只在本次新增 miss 时亮，下一快照自动灭）
    setHidden(missEl, !fresh.some((e) => e.kind === 'miss'));

    // 脉冲②：回击飘字容器每帧重挂，只画本次新增的 retaliate（RF#1：晚于玩家出卡）
    fxEl.replaceChildren();
    for (const e of fresh) {
      if (e.kind === 'retaliate') {
        fxEl.appendChild(h('div', { class: 'fx-retaliate', text: `-${e.amount ?? 0}` }));
      }
    }

    // 常驻横幅：只读态在就得在（与 toast 的"说完就算"分开，见 toast.ts）
    if (snap.readOnly && !bannerOff) {
      bannerOff = mountBanner(screen, deps.bannerText ?? DEFAULT_BANNER_TEXT);
    } else if (!snap.readOnly && bannerOff) {
      bannerOff();
      bannerOff = null;
    }

    // 一次性消息位：换了一条才弹（同一条重放不重复弹）
    if (snap.notice) {
      if (snap.notice !== lastNotice) {
        lastNotice = snap.notice;
        showToast(screen, snap.notice, { ms: deps.toastMs });
      }
    } else {
      lastNotice = null;
    }

    setEnabled(!pending && canAnswer(snap));
  }

  function setEnabled(on: boolean): void {
    for (const b of gradeButtons) b.disabled = !on;
  }

  /* ------------------------------------------------------------ 防连点（UI 层） */
  let pending = false;
  let snapshotAtClick: ControllerSnapshot | null = null;

  function onGrade(spec: { readonly grade: Grade; readonly key: string }): void {
    if (destroyed || pending) return;
    const snap = ctrl.snapshot();
    if (!canAnswer(snap)) return;

    // ① 立刻锁住四档；记下点击时的快照对象，只有"新对象"能解禁（重放不解禁）。
    pending = true;
    snapshotAtClick = snap;
    setEnabled(false);
    // ② 作答即确认答案：把这张卡的背面显示出来（front 保持到下一快照）。
    lastGraded = snap.fight?.current ?? null;
    renderCard(snap);

    const unlock = (): void => {
      if (destroyed) return;
      pending = false;
      setEnabled(canAnswer(ctrl.snapshot()));
    };

    try {
      const res = ctrl.intent({ type: 'answer', grade: spec.grade });
      // intent 抛错/被拒也要解禁，否则一次失败就把屏幕冻死（controller 侧 phase 守卫仍是第二层）。
      void Promise.resolve(res).catch(unlock);
    } catch {
      unlock();
    }
  }

  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    if (pending && snap !== snapshotAtClick) pending = false;
    render(snap);
  });

  /* ------------------------------------------------------------ 起来 */
  render(ctrl.snapshot());
  if (win) {
    win.addEventListener('resize', onResize);
    onResize(); // 首帧就按视口摆一次，避免等到第一次旋转才正位
  }
  if (raf) frameHandle = raf(loop);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (frameHandle !== null && caf) caf(frameHandle);
    frameHandle = null;
    if (win) win.removeEventListener('resize', onResize);
    unsubscribe();
    if (bannerOff) {
      bannerOff();
      bannerOff = null;
    }
    stage.destroy();
    screen.remove();
  }

  return { unmount: destroy, destroy };
}
