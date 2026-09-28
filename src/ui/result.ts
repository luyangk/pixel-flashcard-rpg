/**
 * result.ts —— Plan 4 · T7：结算屏（胜负 + 经验/升级 + 战报碎片 + 假记忆战败演出）。
 *
 * 数据全部来自 `snapshot.lastResult`（RunSummary）与 `snapshot.save.settings.story`，
 * 本模块**不算数**：经验/等级的权威在 app/growth，碎片抽取在 ui/beats，假记忆素材在
 * app/fakeMemory（由宿主注入）。这里只把它们摆到屏上。
 *
 * ## 战败演出（LORE §5.5，R-P4-preflight-b 从 T5 移到本屏）
 * 卡池耗尽未杀敌 → 闪现 1–2 张**篡改版卡面**（红黑故障感）→ 打叉揭示"假的。幸好你没
 * 记住它。"。三件事都按 LORE 的"短暂闪现"来，但**时长与推进都可注入**（`flashMs`/
 * `holdMs`/`setTimer`），因为演出节奏在真机上要调、在测试里要确定：
 *   - 每张假记忆两拍：`闪现`（flashMs，只显示被篡改的答案）→ `打叉`（holdMs，露出 ✕ 与
 *     揭示语）→ 下一张；打完最后一张进入终态（停在 ✕ 上，操作按钮可用）；
 *   - 「跳过演出」把状态机直接推到终态（与序章的「跳过」同款：不想看的玩家不该被
 *     时长挟持）——**跳过的只是演出，不是事实**：终态依旧显示最后一张假记忆与揭示语。
 *   - **零数值后果**（LORE 明令）：本屏不写任何 SRS/计数；唯一写口是碎片游标回传
 *     （`onBeatDrawn` → 宿主写 `settings.story.beatIndex`），那是叙事进度不是数值。
 *
 * ## 为什么碎片回传只做一次，且只对胜局做
 * 订阅会因任何快照变化重放本屏；若每次 render 都抽一句并回传，玩家每点一次按钮就会
 * 连跳好几句（且落盘写口会被无意义地反复唤醒）。故本屏实例内**只在首次拿到
 * lastResult 时抽一次**，之后不再抽。
 * **只胜局抽**（T7 评审判 I-1）：LORE §5.2 / PRD §9 都是"每场**胜利**后 1–2 句"，
 * 败局该给的是假记忆演出。败局也抽的实现会静默吃掉叙事库存（含低频暗线前奏）。
 *
 * ## 演出何时起（T7 评审判 M-5）
 * 起演出的判据放在 **render 内**（`staged` 一次性闸门），而不是挂载时判一次快照：
 * 挂载时 lastResult 还是 null、稍后才推入败局快照的路径（宿主先挂屏再结算）也必须能起
 * 演出——否则画面卡在"闪现拍"，只剩「跳过演出」能到终态。
 */
import type { BeatEntry } from './beats';
import { nextBeat } from './beats';
import type { FakeCard } from '../app/fakeMemory';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { h, setHidden } from './dom';

export interface ResultDeps {
  /** 战报碎片模板池（缺省空池 ⇒ 不显示碎片）。 */
  readonly beats?: readonly BeatEntry[];
  /** 败局假记忆素材（宿主用 app/fakeMemory.pickFakes 生成；空数组 ⇒ 不演出）。 */
  readonly fakes?: readonly FakeCard[];
  /** 碎片游标回传（宿主写 settings.story.beatIndex）；抽到空句时不会被调用。 */
  readonly onBeatDrawn?: (cursor: number) => void;
  /** 「再来一场」（宿主按上一局参数重开；缺省时该按钮不显示）。 */
  readonly onReplay?: () => void;
  /** 假记忆闪现时长（默认 800ms）；`0` 表示立即揭示（测试可用）。 */
  readonly flashMs?: number;
  /** 打叉揭示停留时长（默认 1200ms）。 */
  readonly holdMs?: number;
  /** 定时器注入位（默认全局 setTimeout/clearTimeout；测试注入手动调度器）。 */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  readonly clearTimer?: (handle: number) => void;
}

export interface ResultHandle {
  unmount(): void;
}

const DEFAULT_FLASH_MS = 800;
const DEFAULT_HOLD_MS = 1200;
const REVEAL_TEXT = '假的。幸好你没记住它。';
/**
 * 败局的一句"下一步"（终审 J-1/J-2：两处必败都没有任何解释与引导）。
 * 功能轨大白话，只讲机制与动作，不编叙事。
 */
const LOSE_HINT =
  '空转不计伤害，而敌人每回合都会出手。把卡背熟——稳定度从「初识」升到「复习」后，每击伤害会从一成涨到十成，再来打。';
const CROSS = '✕';

/** 败局演出的状态：第 `idx` 张假记忆是否已打叉，以及是否已走完。 */
interface FakeStage {
  idx: number;
  revealed: boolean;
  done: boolean;
}

function defaultSetTimer(cb: () => void, ms: number): number {
  return setTimeout(cb, ms) as unknown as number;
}
function defaultClearTimer(handle: number): void {
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

/**
 * 在 root 里挂结算屏。
 * `lastResult === null`（比如直接冷启动到本屏、或被外部清了）时不炸：显示一句大白话
 * 与「回菜单」，让玩家有路可走。
 */
export function mountResult(root: HTMLElement, ctrl: GameController, deps: ResultDeps = {}): ResultHandle {
  if (!root || !ctrl) throw new Error('mount-result: root/controller required');

  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  const flashMs = typeof deps.flashMs === 'number' && deps.flashMs >= 0 ? deps.flashMs : DEFAULT_FLASH_MS;
  const holdMs = typeof deps.holdMs === 'number' && deps.holdMs >= 0 ? deps.holdMs : DEFAULT_HOLD_MS;
  const beats = Array.isArray(deps.beats) ? deps.beats : [];
  const fakes = Array.isArray(deps.fakes) ? deps.fakes : [];

  let destroyed = false;
  let timer: number | null = null;
  let stage: FakeStage = { idx: 0, revealed: false, done: false };
  let beatDrawn = false;
  let replaying = false;
  /** 假记忆演出是否已起过（一次性闸门；见文件头"演出何时起"）。 */
  let staged = false;

  /* ------------------------------------------------------------ DOM 外壳 */
  const outcomeEl = h('div', { 'data-ui': 'outcome', class: 'outcome' });
  const expEl = h('div', { 'data-ui': 'exp', class: 'exp' });
  const levelEl = h('div', { 'data-ui': 'level', class: 'level' });
  const statsEl = h('div', { 'data-ui': 'stats', class: 'stats' });

  // 假记忆：卡面（front 保真 / 答案被篡改）+ 打叉层
  const fakeFrontEl = h('div', { 'data-ui': 'fake-front', class: 'fake-front' });
  const fakeBackEl = h('div', { 'data-ui': 'fake-back', class: 'fake-back' });
  const fakeCrossEl = h('div', { 'data-ui': 'fake-cross', class: 'fake-cross', hidden: true }, [
    h('span', { class: 'cross-mark' }, CROSS),
    h('span', { 'data-ui': 'fake-reveal-text', class: 'fake-reveal-text' }, REVEAL_TEXT),
  ]);
  const fakeCardEl = h('div', { 'data-ui': 'fake-card', class: 'fake-card' }, [
    fakeFrontEl,
    fakeBackEl,
    fakeCrossEl,
  ]);
  const fakeProgressEl = h('div', { 'data-ui': 'fake-progress', class: 'fake-progress' });
  const fakeSkipBtn = h('button', { 'data-ui': 'fake-skip', class: 'fake-skip', type: 'button' }, '跳过演出') as HTMLButtonElement;
  const fakeEl = h('section', { 'data-ui': 'fake-memory', class: 'fake-memory', hidden: true }, [
    h('h2', { class: 'fake-title' }, '记忆开始褪色'),
    fakeCardEl,
    fakeProgressEl,
    fakeSkipBtn,
  ]);

  const loseHintEl = h('p', { 'data-ui': 'lose-hint', class: 'lose-hint', hidden: true }, LOSE_HINT);
  const beatEl = h('p', { 'data-ui': 'beat', class: 'beat', hidden: true });
  const replayBtn = h('button', { 'data-ui': 'replay', class: 'replay-btn', type: 'button' }, '再来一场') as HTMLButtonElement;
  const menuBtn = h('button', { 'data-ui': 'to-menu', class: 'menu-btn', type: 'button' }, '回菜单') as HTMLButtonElement;
  const actionsEl = h('div', { 'data-ui': 'result-actions', class: 'result-actions' }, [replayBtn, menuBtn]);

  const summaryEl = h('section', { 'data-ui': 'summary', class: 'summary' }, [
    outcomeEl,
    expEl,
    levelEl,
    statsEl,
  ]);
  const emptyEl = h('p', { 'data-ui': 'no-result', class: 'no-result', hidden: true }, '这里还没有可结算的战绩。');

  const screen = h('div', { 'data-ui': 'result-screen', class: 'result-screen' }, [
    summaryEl,
    emptyEl,
    loseHintEl,
    fakeEl,
    beatEl,
    actionsEl,
  ]);
  root.appendChild(screen);

  /* ------------------------------------------------------------ 假记忆演出状态机 */
  function clearTimerIfAny(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /** 到终态：停表、停在 ✕ 上（最后一张若还没揭示，补上揭示）。 */
  function toFinal(): void {
    clearTimerIfAny();
    if (fakes.length > 0) stage = { idx: fakes.length - 1, revealed: true, done: true };
    render();
  }

  /** 安排下一拍：未揭示 → 揭示；已揭示 → 下一张；已是最后一张 → 终态。 */
  function scheduleNext(): void {
    clearTimerIfAny();
    if (stage.done) return;
    if (!stage.revealed) {
      timer = setTimer(() => {
        timer = null;
        if (destroyed) return;
        stage = { ...stage, revealed: true };
        if (stage.idx + 1 >= fakes.length) {
          // 最后一张：揭示即终态（揭示语要留在屏上，不再自动翻页）
          stage = { ...stage, done: true };
          render();
          return;
        }
        render();
        scheduleNext();
      }, flashMs);
      return;
    }
    timer = setTimer(() => {
      timer = null;
      if (destroyed) return;
      stage = { idx: stage.idx + 1, revealed: false, done: false };
      render();
      scheduleNext();
    }, holdMs);
  }

  /** 假记忆区渲染：藏起来的唯一判据是"这一局是败局且确实有素材"。 */
  function renderFake(lost: boolean): void {
    const on = lost && fakes.length > 0;
    setHidden(fakeEl, !on);
    if (!on) return;
    const fake = fakes[Math.min(stage.idx, fakes.length - 1)];
    fakeFrontEl.textContent = fake.front;
    fakeBackEl.textContent = fake.tamperedBack;
    fakeCardEl.setAttribute('data-fake-rule', fake.rule);
    fakeCardEl.setAttribute('data-revealed', String(stage.revealed));
    setHidden(fakeCrossEl, !stage.revealed);
    fakeProgressEl.textContent = `${stage.idx + 1} / ${fakes.length}`;
    setHidden(fakeSkipBtn, stage.done);
  }

  /* ------------------------------------------------------------ 渲染 */
  function render(): void {
    const snap = ctrl.snapshot();
    const res = snap.lastResult;
    setHidden(summaryEl, res === null);
    setHidden(emptyEl, res !== null);
    if (res) {
      outcomeEl.textContent = res.won ? '胜' : '败';
      outcomeEl.setAttribute('data-won', String(res.won));
      expEl.textContent = `经验 +${res.expGained}`;
      levelEl.textContent = res.leveledUp
        ? `等级 ${res.levelBefore} → ${res.levelAfter}（升级！）`
        : `等级 ${res.levelAfter}`;
      statsEl.textContent = `出战 ${res.poolLen} 张 · 空转 ${res.misses} 次`;
    }
    // 败局才有那句"下一步"（胜局不需要劝说）
    setHidden(loseHintEl, !(res !== null && !res.won));
    renderFake(res !== null && !res.won);

    // 只胜局抽碎片（LORE §5.2；败局的叙事面是假记忆演出）
    if (!beatDrawn && res !== null && res.won && beats.length > 0) {
      beatDrawn = true; // 先置位：onBeatDrawn 抛错/重入都不该让下一次 render 再抽一句
      // 游标兜底读法：story 是必填位、validateSave 已保证在场，但渲染层不该因为一次脏快照
      // 而炸掉整屏。**只把 undefined 当 0**（"字段不在"），显式 null/负数/小数照旧交给
      // nextBeat 的 fail-closed 闸门拒（beats.ts 的"脏游标两端同口径"是 T6 评审专门修过的，
      // 这里不能用一个 `??` 把它悄悄改成"当 0 重来"）。
      const raw = snap.save?.settings?.story?.beatIndex as number | null | undefined;
      const cursor = raw === undefined ? 0 : raw;
      // 断言：null 在这里是**故意**穿到 nextBeat 的（类型上收窄成 number，运行时仍按脏值处理）
      const draw = nextBeat(beats, cursor as number);
      beatEl.textContent = draw.text;
      setHidden(beatEl, draw.text === '');
      if (draw.text !== '') deps.onBeatDrawn?.(draw.next);
    }

    // 败局 + 有素材 + 还没起过 ⇒ 起演出（挂载时判与后续推快照两条路共用）
    if (!staged && res !== null && !res.won && fakes.length > 0) {
      staged = true;
      scheduleNext();
    }

    replayBtn.disabled = replaying;
    setHidden(replayBtn, typeof deps.onReplay !== 'function');
  }

  /* ------------------------------------------------------------ 交互 */
  const onReplay = (): void => {
    if (destroyed || replaying || typeof deps.onReplay !== 'function') return;
    replaying = true;
    render();
    deps.onReplay();
  };
  const onMenu = (): void => {
    void ctrl.intent({ type: 'finish' }).catch(() => undefined);
  };
  const onSkip = (): void => toFinal();

  replayBtn.addEventListener('click', onReplay);
  menuBtn.addEventListener('click', onMenu);
  fakeSkipBtn.addEventListener('click', onSkip);

  const unsubscribe = ctrl.subscribe(() => {
    if (destroyed) return;
    replaying = false; // 新快照 = 会话动了（重开成功或换屏）；按钮若还在屏上应解禁
    render();
  });

  render();

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    clearTimerIfAny();
    unsubscribe();
    screen.remove();
  }

  return { unmount: destroy };
}
