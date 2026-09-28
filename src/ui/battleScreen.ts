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
 * 卡面流程（自评，**两段式**）：先只显示 front + "看答案"；翻面后才显示该卡 back 且四档
 * 解禁；评分后换到下一张卡时，答案立即收回。**答案恒属于当前这张卡**——首版把"上一张的
 * back"挂在"下一张的 front"上（真实同步快照链路整局错配，评审 Important）。
 * 假记忆演出属 T7。
 */
import { GRADES, type Grade } from '@core/sm2';
import { buildChoices, CHOICE_COUNT_DEFAULT, type ChoiceSet } from '@core/choices';
import type { Rng } from '@core/rng';
import type { AnswerMode, Card } from '@core/types';
import type { BattleEvent } from '@core/battle';
import type { FightView } from '../app/battleFlow';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import type { SettingsWriteResult } from '../app/settingsFlow';
import { mountBattleStage, type BattleStage, type BattleStageDeps } from '../stage/battleStage';
import type { StageSprites } from '../stage/renderer';
import { docOf, h, setHidden } from './dom';
import { mountBanner, showToast } from './toast';

/**
 * 作答区的文案（Plan 6 · D41/D42；功能文本轨大白话）。
 *
 * **为什么没有四档**：UI 只发 `good`（答对）/ `again`（答错 / 看答案 / 判错）两档 ——
 * `easy`/`hard` 在界面上不可达（core 的 `GRADES` 与引擎一字未改，四档语义完整保留）。
 * 这是 D41 登记过的代价：`easy` 的 `interval×1.3` 与 `EF+0.1` 路径随之消失。
 */
const RESULT_RIGHT = '答对了';
const RESULT_WRONG = '答错了';
/** 点它把这次答对改判为答错（4 选 1 有 25% 蒙对率，不该静默记成"记住了"）。 */
const GUESS_TEXT = '其实是猜的';
const GUESSED_TEXT = '答对了（按「猜的」记 —— 这次记为答错）';
const CONTINUE_TEXT = '继续';
const NO_CHOICE_HINT = '这个领域只有这一张卡，凑不出选项——先看答案吧。';
const ANSWER_PREFIX = '答案：';
/** 问答模式（D42）的文案。 */
const QA_PLACEHOLDER = '用你自己的话写下这张卡的答案（写要点就行）';
const QA_SUBMIT_TEXT = '让 AI 判一判';
const QA_JUDGING_TEXT = '正在判…';
const QA_UNAVAILABLE_HINT = '这条存档选的是问答模式，但还没配 AI —— 先用选择题吧。';
const QA_EMPTY_TEXT = '先写一句你自己的理解，再交给 AI 判。';
const SELF_RIGHT_TEXT = '我觉得对了';
const SELF_WRONG_TEXT = '我觉得错了';
const UNKNOWN_PREFIX = '没判成 —— ';
const MODE_TO_QA_TEXT = '换成问答模式';
const MODE_TO_CHOICE_TEXT = '换回选择题';
const UNKNOWN_RESULT = '这题没判成';

const DEFAULT_BANNER_TEXT = '只读模式：存档当前不可写，本局的改动不会保存';
const MISS_HINT_TEXT = '空转 —— 这题没想起来，怪物纹丝不动';
/** 战斗中唯一的退出口（终审 I-2：此前拒战只能刷新页面）。文案是功能轨大白话。 */
const QUIT_TEXT = '退出本局';
/**
 * 新卡伤害低到几乎打不动的说明（终审 J-1："首战必败但玩家不知道为什么"）。
 * 只在当前卡还是 `new` 时挂着——这正是玩家最可能的第一场，也是"苦修"循环的入口；
 * 一旦背熟（稳定度晋升）它自动消失。文案是功能轨大白话，不编叙事。
 */
const NEW_CARD_HINT = '新卡每击只有三成伤害——背熟它（稳定度升到「复习」）伤害会翻倍。';
/**
 * 教学局提示（Plan 5 数值改进）：第一场战斗的敌人是弱化版。**必须告诉玩家**——
 * 难度变化不能是暗改，否则第二场突然变难会让人以为游戏出问题了。
 */
const TUTORIAL_HINT = '教学局：这是你的第一场，敌人会手下留情。打完这一场就按正常难度来了。';

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
  /**
   * 选项洗牌的随机源（Plan 6 · D41）。缺省用 `Math.random`：UI 层不在分层守卫的范围内
   * （`src/core`/`src/app` 才受限），而**正确项的位置必须每次都不同**——固定顺序会让
   * 玩家记住"永远选第三个"。测试注入 `mulberry32` 以断言确定性。
   */
  readonly rng?: Rng;
  /**
   * 判卷口（Plan 6 · T7 / D42；宿主接 `app/llmFlow.judgeAnswer`，并在装配层记账判定额度）。
   * **缺省 ⇒ 问答模式不可用**：屏上如实说明并停在选择题形态（绝不静默换成别的模式）。
   */
  readonly judge?: (input: {
    readonly front: string;
    readonly answer: string;
    readonly reply: string;
  }) => Promise<
    { readonly ok: true; readonly match: boolean; readonly reason: string; readonly missing: readonly string[] }
    | { readonly ok: false; readonly reason: string }
  >;
  /**
   * 作答模式写回（宿主接 `app/settingsFlow.setAnswerMode`）。缺省 ⇒ 不显示切换按钮。
   * 写失败（只读态）时屏上如实提示并**停在原模式**。
   */
  readonly setAnswerMode?: (mode: AnswerMode) => Promise<SettingsWriteResult>;
}

/** 挂载句柄：unmount/destroy 同一件事（unmount 是 brief 的对外名，destroy 是行文习惯）。 */
export interface BattleScreenHandle {
  unmount(): void;
  destroy(): void;
}

const EMPTY_EVENTS: readonly BattleEvent[] = [];

/** 翻面按钮文案（功能文本大白话；叙事文案归 T6/T7）。 */
const REVEAL_TEXT = '看答案';

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
  const newCardHintEl = h('p', { 'data-ui': 'new-card-hint', class: 'new-card-hint', hidden: true }, NEW_CARD_HINT);
  const tutorialHintEl = h('p', { 'data-ui': 'tutorial-hint', class: 'new-card-hint', hidden: true }, TUTORIAL_HINT);
  const frontEl = h('div', { 'data-ui': 'card-front', class: 'card-front' });
  // 两段式翻面：先看题面 → 点"看答案" → 再自评。答案因此恒属于**当前这张卡**，
  // 不会把上一张卡的 back 挂在下一张卡的 front 上（评审 Important 的修复面）。
  const revealBtn = h(
    'button',
    { 'data-ui': 'reveal', class: 'reveal-btn', type: 'button' },
    REVEAL_TEXT
  ) as HTMLButtonElement;
  revealBtn.addEventListener('click', () => onReveal());
  const cardEl = h('div', { 'data-ui': 'card', class: 'card' }, [frontEl, newCardHintEl, revealBtn]);

  /* -------- 作答区（Plan 6）：选项 → 判定面板（完整答案）→ 继续 -------- */
  const choicesEl = h('div', { 'data-ui': 'answer-choices', class: 'answer-choices' });
  const noChoiceHintEl = h(
    'p',
    { 'data-ui': 'no-choice-hint', class: 'field-hint', hidden: true },
    NO_CHOICE_HINT
  );
  const verdictResultEl = h('p', { 'data-ui': 'verdict-result', class: 'verdict-result' });
  const verdictReasonEl = h('p', { 'data-ui': 'verdict-reason', class: 'field-hint', hidden: true });
  const verdictMissingEl = h('ul', { 'data-ui': 'verdict-missing', class: 'verdict-missing', hidden: true });
  // 完整答案：**不截断**（选项里是预览，这里是玩家真正要读的那份）
  const answerFullEl = h('p', { 'data-ui': 'answer-full', class: 'answer-full' });
  const guessBtn = h('button', { 'data-ui': 'verdict-guess', class: 'guess-btn', type: 'button' }, GUESS_TEXT) as HTMLButtonElement;
  guessBtn.addEventListener('click', () => onGuess());
  const continueBtn = h(
    'button',
    { 'data-ui': 'verdict-continue', class: 'continue-btn', type: 'button' },
    CONTINUE_TEXT
  ) as HTMLButtonElement;
  continueBtn.addEventListener('click', () => onContinue());
  const selfRightBtn = h(
    'button',
    { 'data-ui': 'verdict-self-right', class: 'self-btn', type: 'button' },
    SELF_RIGHT_TEXT,
  ) as HTMLButtonElement;
  selfRightBtn.addEventListener('click', () => dispatchAnswer(GRADES.good));
  const selfWrongBtn = h(
    'button',
    { 'data-ui': 'verdict-self-wrong', class: 'self-btn', type: 'button' },
    SELF_WRONG_TEXT,
  ) as HTMLButtonElement;
  selfWrongBtn.addEventListener('click', () => dispatchAnswer(GRADES.again));
  const selfRowEl = h('div', { 'data-ui': 'verdict-self', class: 'self-row', hidden: true }, [
    selfRightBtn,
    selfWrongBtn,
  ]);
  const verdictEl = h('div', { 'data-ui': 'verdict', class: 'verdict', hidden: true }, [
    verdictResultEl,
    verdictReasonEl,
    verdictMissingEl,
    answerFullEl,
    selfRowEl,
    guessBtn,
    continueBtn,
  ]);

  /* -------- 问答模式（Plan 6 · T7 / D42）：写理解 → AI 判 -------- */
  const qaInput = h('textarea', {
    'data-ui': 'qa-input',
    class: 'qa-input',
    placeholder: QA_PLACEHOLDER,
    rows: '3',
    maxlength: '500',
  }) as HTMLTextAreaElement;
  // 空输入不给提交：既不浪费一次调用，也不把空话喂给模型
  const syncQaSubmit = (): void => {
    qaSubmitBtn.disabled = pending || judging || qaInput.value.trim().length === 0;
  };
  qaInput.addEventListener('input', syncQaSubmit);
  const qaSubmitBtn = h(
    'button',
    { 'data-ui': 'qa-submit', class: 'qa-submit', type: 'button' },
    QA_SUBMIT_TEXT,
  ) as HTMLButtonElement;
  qaSubmitBtn.addEventListener('click', () => void onQaSubmit());
  const qaStatusEl = h('p', { 'data-ui': 'qa-status', class: 'field-hint', hidden: true });
  const qaUnavailableEl = h(
    'p',
    { 'data-ui': 'qa-unavailable', class: 'field-hint', hidden: true },
    QA_UNAVAILABLE_HINT,
  );
  const qaEl = h('div', { 'data-ui': 'answer-qa', class: 'answer-qa', hidden: true }, [
    qaInput,
    qaSubmitBtn,
    qaStatusEl,
    qaUnavailableEl,
  ]);

  const modeToggleBtn = h(
    'button',
    { 'data-ui': 'mode-toggle', class: 'mode-toggle', type: 'button' },
    MODE_TO_QA_TEXT,
  ) as HTMLButtonElement;
  modeToggleBtn.addEventListener('click', () => void onToggleMode());

  const answerEl = h('div', { 'data-ui': 'answer-area', class: 'answer-area' }, [
    qaEl,
    choicesEl,
    noChoiceHintEl,
    verdictEl,
    modeToggleBtn,
  ]);
  // 退出本局：控制器早就有 toMenu（未终局不落账）——此前 UI 层没有任何生产者，
  // 玩家误选领域后只能刷新页面（终审 I-2）。这里补齐这个生产者。
  const quitBtn = h('button', { 'data-ui': 'quit', class: 'quit-btn', type: 'button' }, QUIT_TEXT) as HTMLButtonElement;
  quitBtn.addEventListener('click', () => {
    if (destroyed || pending) return;
    pending = true;
    setEnabled(false);
    try {
      void Promise.resolve(ctrl.intent({ type: 'toMenu' })).catch(() => undefined);
    } catch {
      pending = false;
    }
  });

  const screen = h('div', { 'data-ui': 'battle-screen', class: 'battle-screen' }, [
    hpEl,
    tutorialHintEl,
    quitBtn,
    stageHost,
    fxEl,
    missEl,
    cardEl,
    answerEl,
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

  /**
   * 尺寸 → stage 重算整数缩放/居中。
   *
   * **优先用 canvas 宿主自己的盒子，而不是视口**（终审 J-3）：canvas 是绝对定位在
   * `.stage-host`（`overflow:hidden`）里的，按视口算 letterbox 的居中偏移会把画布
   * 平移到容器之外裁掉——竖屏恰好放得下所以看不出来，一横屏/平板就破。
   * 宿主量不到（happy-dom 里 clientWidth 恒 0）时退回视口，保持既有测试口径。
   */
  const onResize = (): void => {
    if (destroyed || !win) return;
    const hostW = stageHost.clientWidth;
    const hostH = stageHost.clientHeight;
    const w = typeof hostW === 'number' && hostW > 0 ? hostW : win.innerWidth;
    const h = typeof hostH === 'number' && hostH > 0 ? hostH : win.innerHeight;
    stage.onResize(w, h);
  };

  /** 每帧：拿当前快照画一帧，tMs 用 rAF 的 timestamp（本层绝不自己读钟）。 */
  const loop = (tMs: number): void => {
    if (destroyed) return;
    const snap = ctrl.snapshot();
    if (snap.fight) stage.frame(snap.fight.state, snap.fight, tMs);
    // destroy 可能发生在 frame 回调内：此时不得再用新句柄覆盖 null（否则永不被 cancel）。
    frameHandle = !destroyed && raf ? raf(loop) : null;
  };

  /** 选项洗牌的随机源（缺省 Math.random：位置必须每次都变，见 BattleScreenDeps.rng）。 */
  const pickRng: Rng = deps.rng ?? (() => Math.random());

  /* ------------------------------------------------------------ 渲染与脉冲 */
  let primed = false; // 首帧只对齐：挂载时已有的历史战报不重放（T4 FX_UNPRIMED 同口径）
  let seenLogLen = 0;

  /** 当前显示的是哪张卡：换卡即重置翻面态（答案永远只属于它自己那张 front）。 */
  let shownCardId: string | null = null;
  /**
   * 作答区状态机（Plan 6 · D41）：`asking` 出选项/看答案 → `verdict` 展示对错与**完整答案**
   * → 玩家点「继续」才派发 `answer` intent。
   *
   * **为什么"继续"要单独一步**：判定与派发分开，才能保证"答案一定先于结算出现在屏上"。
   * 点完选项就派发的话，快照会立刻推进到下一张卡，玩家可能一眼都没看到那张卡的答案
   * ——而"看到答案"正是复习真正发生的地方。
   */
  let phase: 'asking' | 'verdict' = 'asking';
  /** 判定面板上「继续」要派发的档位（null = 尚未作答）。 */
  let pendingGrade: Grade | null = null;
  /** 判定面板的内容（对错 / 理由 / 缺失要点 / 是否已被「其实是猜的」改判）。 */
  let verdict: {
    kind: 'right' | 'wrong' | 'unknown';
    reason: string;
    missing: readonly string[];
    guessed: boolean;
  } | null = null;
  /** 判卷在途（Plan 6 · T7）：期间不接受第二次提交，也不放行任何派发。 */
  let judging = false;
  /** 当前作答模式（从快照读：切换按钮写回后由快照驱动，屏上不另存一份）。 */
  let mode: AnswerMode = 'choice';
  /** 有效模式（`mode` 再叠加"判卷口在不在场"）：屏上真正按哪个模式渲染由它决定。 */
  let effective: AnswerMode = 'choice';
  /** 当前卡的选项（`null` = 凑不出干扰项 ⇒ 回落看答案）。 */
  let choices: ChoiceSet | null = null;
  /** 选项按哪张卡算的（换卡即重算；同一张卡内不重算，避免快照重放时选项乱跳）。 */
  let choicesFor: string | null = null;
  let fightPool: readonly string[] | null = null;
  let lastNotice: string | null = null;
  let bannerOff: (() => void) | null = null;
  /** 未消失的 toast 的 dismiss：unmount/destroy 时一并调用，避免定时器漂到组件外。 */
  let toastOff: (() => void) | null = null;

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

  /** 卡面渲染：**只画当前这张卡**——front 常显，answer 区随作答状态切换。 */
  function renderCard(snap: ControllerSnapshot): void {
    const fight = snap.fight;
    const current = fight?.current ?? null;
    frontEl.textContent = current ? current.front : fight ? '本局结束' : '未在战斗中';
    // 答案的可见性**完全由判定面板负责**（Plan 6 起不再用一张独立的 back 块：
    // 作答之后对错与完整答案要在同一处一起给）——`card` 里只剩正面与提示。
    // 「直接看答案」只在"还没作答"时出现
    setHidden(revealBtn, !(current !== null && phase === 'asking' && canAnswer(snap)));
    // 新卡提示：跟着当前卡走（换卡即重算），背熟后自然消失
    setHidden(newCardHintEl, current?.srs?.stability !== 'new');
  }

  /**
   * 给当前卡算选项（Plan 6 · D41 的三级来源）：
   * ① 卡上自带的 `choices`（模型在生成这张卡时产出）→ ② 本局池里其他卡的背面与它们自带的选项
   * → ③ 本局池不够时用**同领域**其他卡补。凑不出 ⇒ `null`，由 UI 回落「看答案」并说明原因。
   *
   * 只在**换卡时**算一次（`choicesFor`）：同一张卡内重复计算会让选项在每次快照重放时重新洗牌，
   * 玩家刚看清的第二个选项下一帧就变了位置。
   */
  function ensureChoices(snap: ControllerSnapshot): void {
    const current = snap.fight?.current ?? null;
    if (current === null) {
      choices = null;
      choicesFor = null;
      return;
    }
    if (choicesFor === current.id) return;
    choicesFor = current.id;
    const others = (snap.fight?.pool ?? []).filter((c) => c && c.id !== current.id);
    const sameDeck = (snap.save?.cards ?? []).filter(
      (c) => c && c.id !== current.id && c.deckId === current.deckId,
    );
    const poolTexts: string[] = [];
    for (const c of [...others, ...sameDeck]) {
      if (typeof c.back === 'string') poolTexts.push(c.back);
      for (const extra of c.choices ?? []) poolTexts.push(extra);
    }
    choices = buildChoices({
      answer: current.back,
      stored: current.choices,
      pool: poolTexts,
      count: CHOICE_COUNT_DEFAULT,
      rng: pickRng,
    });
  }

  /** 选项按钮：按当前 `choices` 重建（数量少、内容短，直接 replaceChildren 最省心）。 */
  function renderChoices(snap: ControllerSnapshot): void {
    const asking = phase === 'asking' && canAnswer(snap);
    // 问答模式下不出选项（两条作答路径不能同时摆在屏上，否则玩家会以为要两边都做）
    const show = asking && effective === 'choice' && choices !== null;
    choicesEl.replaceChildren();
    if (show && choices) {
      choices.options.forEach((_option, i) => {
        const b = h(
          'button',
          { 'data-choice': String(i), class: 'choice-btn', type: 'button' },
          // 屏上是**截断预览**（完整答案在判定面板里）：长答案的四个选项会把舞台挤没
          choices?.labels[i] ?? '',
        ) as HTMLButtonElement;
        b.addEventListener('click', () => onChoice(i));
        choicesEl.appendChild(b);
      });
    }
    setHidden(choicesEl, !show);
    // 凑不出干扰项的情形必须说明原因（不静默把选择题变成"只能看答案"）
    setHidden(
      noChoiceHintEl,
      !(asking && effective === 'choice' && choices === null && (snap.fight?.current ?? null) !== null),
    );
  }

  /** 判定面板：对错 + （问答模式的）理由与缺失要点 + **完整答案** + 继续/其实是猜的。 */
  /**
   * 作答模式与问答区（Plan 6 · T7）：模式来自快照（`settings.answerMode`，缺省选择题）。
   * 问答模式要 `deps.judge` 在场；不在场就**如实说明**并停在选择题形态。
   */
  function renderMode(snap: ControllerSnapshot): void {
    mode = snap.save?.settings?.answerMode === 'qa' ? 'qa' : 'choice';
    const canJudge = typeof deps.judge === 'function';
    // **有效模式**：存档选了问答但没配 AI ⇒ 屏上按选择题走（并保留切换按钮，
    // 让玩家能一键改回选择题，而不是面对一个"点了没反应"的模式）。
    effective = mode === 'qa' && canJudge ? 'qa' : 'choice';
    const asking = phase === 'asking' && canAnswer(snap);
    const qaActive = effective === 'qa' && asking;
    setHidden(qaEl, !qaActive);
    setHidden(qaUnavailableEl, !(mode === 'qa' && !canJudge && canAnswer(snap)));
    if (qaActive && qaStatusEl.hasAttribute('hidden')) {
      qaStatusEl.textContent = '';
    }
    // 切换按钮：只有宿主给了写口才出现；判卷在途/在判定面板时不给切（避免半路改语义）
    setHidden(modeToggleBtn, typeof deps.setAnswerMode !== 'function' || !canAnswer(snap) || phase === 'verdict');
    modeToggleBtn.textContent = mode === 'qa' ? MODE_TO_CHOICE_TEXT : MODE_TO_QA_TEXT;
    modeToggleBtn.disabled = pending || judging;
    modeToggleBtn.setAttribute('data-mode', mode);
  }

  function renderVerdict(snap: ControllerSnapshot): void {
    const current = snap.fight?.current ?? null;
    const inVerdict = phase === 'verdict' && verdict !== null;
    setHidden(verdictEl, !inVerdict);
    if (!inVerdict || !verdict) {
      // 不在判定态时把两个按钮都收起来：留着「其实是猜的」在屏上，
      // 下一张卡作答时会变成一颗"看着能点、点了却什么也不发生"的按钮。
      setHidden(guessBtn, true);
      setHidden(selfRowEl, true);
      guessBtn.disabled = false;
      continueBtn.disabled = true;
      return;
    }
    verdictResultEl.textContent = verdict.guessed
      ? GUESSED_TEXT
      : verdict.kind === 'right'
        ? RESULT_RIGHT
        : verdict.kind === 'unknown'
          ? `${UNKNOWN_RESULT} —— 你自己定对错`
          : RESULT_WRONG;
    verdictResultEl.setAttribute('data-verdict-kind', verdict.guessed ? 'guessed' : verdict.kind);
    setHidden(verdictReasonEl, verdict.reason.length === 0);
    verdictReasonEl.textContent = verdict.reason;
    verdictMissingEl.replaceChildren();
    for (const item of verdict.missing) {
      verdictMissingEl.appendChild(h('li', { class: 'verdict-missing-item' }, item));
    }
    setHidden(verdictMissingEl, verdict.missing.length === 0);
    answerFullEl.textContent = current ? `${ANSWER_PREFIX}${current.back}` : '';
    // 「其实是猜的」只在"答对了且还没改判"时可用（答错了没有可改的东西）
    setHidden(guessBtn, verdict.guessed || verdict.kind !== 'right');
    // 没判成 ⇒ 二选一自评（**不替玩家猜**）；判定成功时这条不出现
    setHidden(selfRowEl, verdict.kind !== 'unknown');
    selfRightBtn.disabled = pending;
    selfWrongBtn.disabled = pending;
    // 「继续」在"没判成"时不出现（自评按钮就是那条路的派发口）
    setHidden(continueBtn, verdict.kind === 'unknown');
    continueBtn.disabled = pending || judging;
  }

  function render(snap: ControllerSnapshot): void {
    const fight = snap.fight;
    // 换局（池子对象变了）就把作答态收掉；fight 清空时也收。
    if ((fight?.state.pool ?? null) !== fightPool) {
      fightPool = fight?.state.pool ?? null;
      shownCardId = null;
      resetAnswer();
    }
    // 换卡（idx 前进）⇒ 新卡从"未作答"开始：答案与判定永远只属于它自己那张 front。
    const currentId = fight?.current?.id ?? null;
    if (currentId !== shownCardId) {
      shownCardId = currentId;
      resetAnswer();
    }
    ensureChoices(snap);

    // 教学局提示：按本局难度档显隐（快照驱动，不做一次性开关）
    setHidden(tutorialHintEl, fight?.difficulty !== 'tutorial');

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
        toastOff?.(); // 上一条仍在屏上则先撤，避免叠成一摞
        toastOff = showToast(screen, snap.notice, { ms: deps.toastMs });
      }
    } else {
      lastNotice = null;
    }

    renderMode(snap);
    renderChoices(snap);
    renderVerdict(snap);
    // 作答区的可用性必须在**每次渲染**时求值：T6 改造时把这一步挪丢了，于是
    // "空输入不给提交"只在点过之后才生效（BS#Q5 当场抓到）。
    setEnabled(!pending && !judging && canAnswer(snap));
  }

  /** 换卡/换局：把作答区收回"未作答"（判定面板、待发档位、猜的标记都清掉）。 */
  function resetAnswer(): void {
    phase = 'asking';
    pendingGrade = null;
    verdict = null;
    // 换卡即清空上一张的作答（留在框里会让玩家以为已经写过这张卡了）
    qaInput.value = '';
    // choices 不在这里清：ensureChoices 会按新卡 id 重算（清掉反而让"同卡重放"多算一次）
  }

  /** 锁/解锁作答区（选项、继续、看答案三处一起管）。 */
  function setEnabled(on: boolean): void {
    for (const b of Array.from(choicesEl.querySelectorAll('button'))) {
      (b as HTMLButtonElement).disabled = !on;
    }
    // 「继续」与二选一自评只在判定态可用（面板收起时它们不该是"能点"的状态——
    // 虽然点不动，但一块可点样式会给玩家错觉；R#1 钉住这条）
    const inVerdict = phase === 'verdict';
    continueBtn.disabled = !on || !inVerdict;
    selfRightBtn.disabled = !on || !inVerdict;
    selfWrongBtn.disabled = !on || !inVerdict;
    revealBtn.disabled = !on;
    // 问答提交还要看输入框空不空（空输入始终不给提交）
    qaSubmitBtn.disabled = !on || qaInput.value.trim().length === 0;
  }

  /* ------------------------------------------------------------ 防连点（UI 层） */
  let pending = false;
  let snapshotAtClick: ControllerSnapshot | null = null;

  /**
   * 进入判定面板：记下待发档位与对错内容，**先让玩家看到完整答案**，再由「继续」放行。
   * `reason` / `missing` 留给问答模式（Plan 6 · T7）；选择题与看答案都是空。
   */
  function enterVerdict(grade: Grade, info: { reason?: string; missing?: readonly string[] } = {}): void {
    const snap = ctrl.snapshot();
    if (!canAnswer(snap)) return;
    phase = 'verdict';
    pendingGrade = grade;
    verdict = {
      kind: grade >= GRADES.good ? 'right' : 'wrong',
      reason: info.reason ?? '',
      missing: info.missing ?? [],
      guessed: false,
    };
    render(snap);
  }

  /** 点选项：对 ⇒ good、错 ⇒ again（D41；没有第三档）。 */
  function onChoice(index: number): void {
    if (destroyed || pending || phase !== 'asking' || !choices) return;
    const grade = index === choices.correctIndex ? GRADES.good : GRADES.again;
    enterVerdict(grade);
  }

  /** 「直接看答案」：跳过作答，**记为答错**（D41：没回忆就记正分等于把自评时代的漏洞留着）。 */
  function onReveal(): void {
    if (destroyed || pending || phase !== 'asking') return;
    if (!canAnswer(ctrl.snapshot())) return;
    enterVerdict(GRADES.again);
  }

  /** 「其实是猜的」：把这次答对改判为答错（默认不用点，只有靠蒙的时候才多点一下）。 */
  function onGuess(): void {
    if (destroyed || pending || !verdict || verdict.kind !== 'right' || verdict.guessed) return;
    verdict = { ...verdict, guessed: true };
    pendingGrade = GRADES.again;
    render(ctrl.snapshot());
  }

  /**
   * 把作答真正派发出去 —— **判定面板与自评按钮是唯一的两个派发口**（`onChoice`/`onReveal`
   * 只负责把面板摆出来）。这样"答案先于结算上屏"这条不变量在结构上就成立。
   */
  function dispatchAnswer(grade: Grade): void {
    if (destroyed || pending || !canAnswer(ctrl.snapshot())) return;
    const snap = ctrl.snapshot();

    // ① 立刻锁住作答区；记下点击时的快照对象，只有"新对象"能解禁（重放不解禁）。
    pending = true;
    snapshotAtClick = snap;
    setEnabled(false);
    verdict = null; // 面板收起，避免在 intent 返回前被再点一次「继续」
    phase = 'asking';
    pendingGrade = null;
    renderCard(snap);
    renderVerdict(snap);

    const unlock = (): void => {
      if (destroyed) return;
      pending = false;
      setEnabled(canAnswer(ctrl.snapshot()));
    };

    try {
      const res = ctrl.intent({ type: 'answer', grade });
      // intent 抛错/被拒也要解禁，否则一次失败就把屏幕冻死（controller 侧 phase 守卫仍是第二层）。
      void Promise.resolve(res).catch(unlock);
    } catch {
      unlock();
    }
  }

  /** 「继续」：把判定面板上记着的档位派发出去。 */
  function onContinue(): void {
    if (destroyed || pending || judging || phase !== 'verdict' || pendingGrade === null) return;
    dispatchAnswer(pendingGrade);
  }

  /**
   * 问答模式提交（Plan 6 · T7 / D42）：把「卡面 + 答案 + 玩家输入」交给注入的判卷口。
   *
   * **绝不替玩家猜**：判卷失败（无 Key / 超时 / 模型回垃圾 / 判定额度到顶）一律进"没判成"
   * 形态 —— 显示原因、显示完整答案、给二选一自评，点了才派发。
   */
  async function onQaSubmit(): Promise<void> {
    if (destroyed || pending || judging || phase !== 'asking') return;
    const judge = deps.judge;
    if (typeof judge !== 'function') return;
    const snap = ctrl.snapshot();
    const current = snap.fight?.current ?? null;
    if (!canAnswer(snap) || current === null) return;
    const reply = qaInput.value.trim();
    if (reply.length === 0) {
      qaStatusEl.textContent = QA_EMPTY_TEXT;
      setHidden(qaStatusEl, false);
      return;
    }

    judging = true;
    qaStatusEl.textContent = QA_JUDGING_TEXT;
    setHidden(qaStatusEl, false);
    qaSubmitBtn.disabled = true;
    setEnabled(false);
    try {
      const res = await judge({ front: current.front, answer: current.back, reply });
      if (destroyed) return;
      if (res && res.ok === true) {
        enterVerdict(res.match ? GRADES.good : GRADES.again, { reason: res.reason, missing: res.missing });
      } else {
        const reason = res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '';
        enterUnknown(reason);
      }
    } catch (e) {
      // 判卷口自身抛错也要收敛成"没判成"（绝不把异常逃到事件处理器）
      enterUnknown(`AI 调用失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      judging = false;
      if (!destroyed) {
        qaStatusEl.textContent = '';
        setHidden(qaStatusEl, true);
        setEnabled(canAnswer(ctrl.snapshot()));
        syncQaSubmit();
        render(ctrl.snapshot());
      }
    }
  }

  /** 「没判成」形态：原因 + 完整答案 + 二选一自评。 */
  function enterUnknown(reason: string): void {
    const snap = ctrl.snapshot();
    if (!canAnswer(snap)) return;
    phase = 'verdict';
    pendingGrade = null; // 由自评按钮决定
    verdict = { kind: 'unknown', reason: `${UNKNOWN_PREFIX}${reason}`, missing: [], guessed: false };
    render(snap);
  }

  /** 在选择题 / 问答模式之间切换：写回成功由快照驱动换形态；失败如实提示并停在原模式。 */
  async function onToggleMode(): Promise<void> {
    if (destroyed || judging || typeof deps.setAnswerMode !== 'function') return;
    const next: AnswerMode = mode === 'qa' ? 'choice' : 'qa';
    try {
      const res = await deps.setAnswerMode(next);
      if (destroyed) return;
      if (res && res.ok === true) {
        // 写口成功：快照里的 answerMode 已更新，直接重渲染即可换形态
        render(ctrl.snapshot());
        return;
      }
      toastOff?.();
      toastOff = showToast(
        screen,
        res && typeof res.reason === 'string' && res.reason.length > 0 ? res.reason : '没能切换作答方式。',
        { ms: deps.toastMs },
      );
    } catch (e) {
      toastOff?.();
      toastOff = showToast(screen, `没能切换作答方式：${e instanceof Error ? e.message : String(e)}`, {
        ms: deps.toastMs,
      });
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
    if (toastOff) {
      toastOff(); // 撤掉在屏 toast 并清它的定时器（否则定时器会漂到组件之外）
      toastOff = null;
    }
    stage.destroy();
    screen.remove();
  }

  return { unmount: destroy, destroy };
}
