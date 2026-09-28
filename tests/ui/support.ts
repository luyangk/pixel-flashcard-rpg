// @vitest-environment happy-dom
/**
 * tests/ui/support.ts —— T7 四个屏的共用夹具（**不是** .test.ts，不会被 vitest 收集）。
 *
 * 为什么抽出来：菜单/备战/结算/卡组四屏的测试都要一个"假控制器 + 一份合法存档"，
 * 各写一份就会出现四处漂移（save 形状一变，四个文件各红一次）。
 * 这里只放**夹具与查询小工具**，不放断言——断言的判别力归各测试文件自己负责。
 */
import type { Card, Deck, SaveFile, SRSState } from '@core/types';
import type { ControllerSnapshot, GameController, GameIntent } from '../../src/app/controllerTypes';

export function makeSrs(over: Partial<SRSState> = {}): SRSState {
  return {
    ease: 2.5,
    interval: 10,
    reps: 3,
    lapses: 0,
    due: 0,
    stability: 'review',
    effectiveReviewDays: [],
    ...over,
  };
}

export function makeCard(id: string, over: Partial<Card> = {}): Card {
  return { id, deckId: 'deck-a', front: `q-${id}`, back: `a-${id}`, srs: makeSrs(), tags: [], ...over };
}

export function makeDeck(id: string, name: string, over: Partial<Deck> = {}): Deck {
  return { id, name, isPreset: false, ...over };
}

/** 一份合法新档（形状与 persist.seedSave 同构；测试要改哪块就传 over）。 */
export function makeSave(over: Partial<SaveFile> = {}): SaveFile {
  const base: SaveFile = {
    schemaVersion: 1,
    decks: [makeDeck('deck-a', '生活常识')],
    cards: [makeCard('c1')],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: false, beatIndex: 0, arcSeen: 0 },
      leaderboard: [],
    },
    meta: { savedAt: 0, plays: 0 },
  };
  return { ...base, ...over };
}

export function makeSnap(over: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  return {
    screen: 'menu',
    fight: null,
    save: makeSave(),
    readOnly: false,
    reminderDue: false,
    lastResult: null,
    lastError: null,
    notice: null,
    ...over,
  };
}

export interface FakeCtrl extends GameController {
  readonly intents: GameIntent[];
  push(next: ControllerSnapshot): void;
}

/** 假控制器：记录 intent、可手动 push 新快照（订阅者同步收到）。 */
export function makeCtrl(initial: ControllerSnapshot = makeSnap()): FakeCtrl {
  let cur = initial;
  const subs = new Set<(s: ControllerSnapshot) => void>();
  const intents: GameIntent[] = [];
  return {
    intents,
    snapshot: () => cur,
    intent: (i: GameIntent) => {
      intents.push(i);
      return Promise.resolve();
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    push(next: ControllerSnapshot) {
      cur = next;
      for (const cb of [...subs]) cb(cur);
    },
  };
}

export function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

/** 按 data-ui 取元素（缺了就抛：测试里"元素不见"必须是显式失败，不是 undefined 链）。 */
export function ui(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector(`[data-ui="${name}"]`);
  if (!el) throw new Error(`缺少 data-ui=${name}`);
  return el as HTMLElement;
}

export function all(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector)) as HTMLElement[];
}

/** 点击（happy-dom 的 click 会冒泡；本包里的屏都直接监听目标自身）。 */
export function click(el: Element): void {
  (el as HTMLElement).click();
}

/** 手动定时器：注入给需要"演出节奏"的组件，测试自己决定何时到点。 */
export function makeScheduler(): {
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (h: number) => void;
  pending: () => number;
  fire: () => void;
} {
  let seq = 0;
  const jobs = new Map<number, () => void>();
  return {
    setTimer: (cb: () => void) => {
      seq += 1;
      jobs.set(seq, cb);
      return seq;
    },
    clearTimer: (h: number) => void jobs.delete(h),
    pending: () => jobs.size,
    fire: () => {
      const first = jobs.entries().next();
      if (first.done) throw new Error('手动调度器：没有待触发的定时器');
      const [handle, cb] = first.value;
      jobs.delete(handle);
      cb();
    },
  };
}

/**
 * 让所有 microtask 结算（await 出来的 promise 链在断言前收敛）。
 * 轮数给足：有的链路是"点一次 → await 写口 → await intent → finally"三层 await，
 * 少排一轮就会在断言时看到中间态（假红/假绿都出现过）。
 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
