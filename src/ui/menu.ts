/**
 * menu.ts —— Plan 4 · T7：主菜单屏（四入口 + 本地榜 Top10 + 备份提醒横幅）。
 *
 * 屏职责边界（与 battleScreen 同纪律）：**只渲染快照 + 回传意图**。
 * - 「开始修炼 / 卡组 / 藏书阁 / 设置」四入口是**屏内导航**，不属于会话（控制器只有
 *   boot/menu/prepare/fight/result 五个会话位）——故经 `deps.onNav` 交给宿主壳切屏，
 *   本模块不持有路由状态，也不知道别的屏长什么样。
 * - 本地榜读 `save.settings.leaderboard`（缺席 = 空榜，不是错误），排序委托 core 的
 *   `rankRuns`：榜的口径只有一处权威，UI 不自己写排序比较。
 * - 备份提醒是 `snapshot.reminderDue`（7 天闸门）的展示位：横幅给「去备份」「知道了」
 *   两条路。「知道了」只记在**本屏实例内**（不是设置、不落盘）——它表达的是"这一轮别
 *   再念叨"，冷启动后闸门仍是唯一判据（R-T5-p3-a 的闸门口径不因 UI 而改）。
 *
 * 文案双轨（LORE §6）：这里是功能文本——全大白话，不为氛围牺牲可理解性。
 */
import { rankRuns, type RunRecord } from '@core/leaderboard';
import type { ControllerSnapshot, GameController } from '../app/controllerTypes';
import { levelFromExp, playerStatsFor } from '../app/growth';
import { h } from './dom';

/** 屏内导航目标（宿主壳的切屏词表；'prepare' 也走 host，控制器不替宿主决定何时开局）。 */
export type MenuTarget = 'prepare' | 'decks' | 'codex' | 'practice' | 'settings';

export interface MenuDeps {
  /** 屏内导航回调（宿主壳实现；必填——菜单的全部入口都得有去处）。 */
  readonly onNav: (target: MenuTarget) => void;
  /** 榜单展示条数（缺省 10）。 */
  readonly topN?: number;
}

export interface MenuHandle {
  unmount(): void;
}

const DEFAULT_TOP_N = 10;
/** 空榜的共享常量：让"从未上榜"这一态在引用比较下稳定（免每次 render 重建空列表）。 */
const EMPTY_RECORDS: readonly RunRecord[] = [];
const TITLE = '知识侠客';
const REMINDER_TEXT = '已经 7 天没备份了。建议现在导出一份存档，换手机/清缓存都不怕。';

/** 四入口（顺序即屏上顺序；文案大白话）。 */
const ENTRIES: ReadonlyArray<{ readonly target: MenuTarget; readonly label: string }> = [
  // 「开始复习」而不是「开始修炼」（终审 Minor）：LORE §8 明令"全局武侠化 UI 术语一律不进
  // 功能界面"，menu.ts 文件头也自认这里是功能文本轨。而且"复习=伤害"正是本作的核心循环，
  // 大白话反而更准。
  { target: 'prepare', label: '开始复习' },
  { target: 'decks', label: '卡组' },
  // 「练功」= 用户指定的入口名（D44 的**登记例外**：LORE §8 要求功能界面走大白话，
  // 但产品负责人明确要这个词，例外只开在入口标签与屏标题这两个字面上——屏内文案照旧大白话）。
  { target: 'practice', label: '练功' },
  { target: 'codex', label: '藏书阁' },
  { target: 'settings', label: '设置' },
];

/** 一行榜单文本：`3. 生活常识 · 128 分 · 胜`（lost 恒 0 分，但仍在榜上——那是战绩）。 */
function rankRowText(rank: number, r: RunRecord): string {
  const outcome = r.result === 'won' ? '胜' : '败';
  const kind = r.kind === 'boss' ? ' · 卷灵' : '';
  return `${rank}. ${r.domain} · ${r.score} 分 · ${outcome}${kind}`;
}

/**
 * 在 root 里挂主菜单。订阅快照以刷新榜单与提醒横幅（存档一变，榜就可能变）。
 * 备份提醒被「知道了」压掉后，**同一实例内**不再弹；新实例（重新进菜单/冷启动）重新按
 * `reminderDue` 判定。
 */
export function mountMenu(root: HTMLElement, ctrl: GameController, deps: MenuDeps): MenuHandle {
  if (!root || !ctrl) throw new Error('mount-menu: root/controller required');
  if (!deps || typeof deps.onNav !== 'function') throw new Error('mount-menu: onNav required');
  const topN = typeof deps.topN === 'number' && Number.isFinite(deps.topN) && deps.topN > 0 ? Math.floor(deps.topN) : DEFAULT_TOP_N;

  /* ------------------------------------------------------------ DOM 外壳 */
  const titleEl = h('h1', { 'data-ui': 'menu-title', class: 'menu-title' }, TITLE);
  const navEl = h(
    'nav',
    { 'data-ui': 'menu-nav', class: 'menu-nav' },
    ENTRIES.map((e) =>
      h(
        'button',
        { 'data-nav': e.target, class: 'menu-entry', type: 'button' },
        e.label,
      ),
    ),
  );
  // 逐条挂监听而不用 attrs.onXxx（dom.ts 拒绝字符串处理器，函数式也会把闭包写进 attrs，
  // 可读性差）：这里显式 addEventListener，销毁时统一摘。
  const navButtons = Array.from(navEl.querySelectorAll<HTMLButtonElement>('button[data-nav]'));
  const navHandler = (ev: Event): void => {
    const btn = (ev.currentTarget ?? ev.target) as HTMLElement | null;
    const target = btn?.getAttribute('data-nav') as MenuTarget | null;
    if (!target) return;
    deps.onNav(target);
  };
  for (const b of navButtons) b.addEventListener('click', navHandler);

  /**
   * 六维面板（终审 I-3）：PRD §2.1/§8-2 的核心体验承诺是"强度增长直接来自记忆水平"，
   * 但此前**没有任何屏显示 atk/def/体力/精神/气血**——玩家看不出自己为什么变强。
   * 数据全部来自 app 层已导出的派生函数（本屏不自己算，口径与战斗同源）：
   * 等级 = levelFromExp(exp)，其余六维 = playerStatsFor(save)（全体按全库口径，N-1）。
   */
  const statEls = new Map<string, HTMLElement>();
  const statDefs: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'level', label: '等级' },
    { key: 'atk', label: '攻击' },
    { key: 'def', label: '防御' },
    { key: 'vit', label: '体力' },
    { key: 'spi', label: '精神' },
    { key: 'maxHp', label: '气血' },
  ];
  const statsEl = h('dl', { 'data-ui': 'stats-panel', class: 'stats-panel' });
  for (const def of statDefs) {
    const dd = h('dd', { 'data-stat': def.key, class: 'stat-value' }, '—');
    statEls.set(def.key, dd);
    statsEl.appendChild(h('div', { class: 'stat' }, [h('dt', { class: 'stat-label' }, def.label), dd]));
  }

  const rankEl = h('ol', { 'data-ui': 'leaderboard', class: 'leaderboard' });
  const rankEmptyEl = h(
    'p',
    { 'data-ui': 'rank-empty', class: 'rank-empty' },
    '还没有战绩。打一场吧。',
  );
  const boardEl = h('section', { 'data-ui': 'board', class: 'board' }, [
    h('h2', { class: 'board-title' }, '本地榜'),
    rankEl,
    rankEmptyEl,
  ]);

  const recallBtn = h(
    'button',
    { 'data-ui': 'backup-go', class: 'backup-go', type: 'button' },
    '去备份',
  ) as HTMLButtonElement;
  const dismissBtn = h(
    'button',
    { 'data-ui': 'backup-dismiss', class: 'backup-dismiss', type: 'button' },
    '知道了',
  ) as HTMLButtonElement;
  const reminderEl = h('div', { 'data-ui': 'backup-reminder', class: 'backup-reminder', hidden: true }, [
    h('span', { class: 'backup-text' }, REMINDER_TEXT),
    recallBtn,
    dismissBtn,
  ]);

  const screen = h('div', { 'data-ui': 'menu-screen', class: 'menu-screen' }, [
    titleEl,
    reminderEl,
    statsEl,
    navEl,
    boardEl,
  ]);
  root.appendChild(screen);

  /* ------------------------------------------------------------ 状态与渲染 */
  let destroyed = false;
  let reminderDismissed = false;
  /** 上次渲染所依据的**源数组引用**（不是 rankRuns 的新数组）：同引用不重建 DOM。 */
  let shownSource: readonly RunRecord[] | null = null;

  function renderRank(source: readonly RunRecord[]): void {
    if (source === shownSource) return; // 同一批数据不重建 DOM（订阅可能因别处变化触发）
    shownSource = source;
    const records = rankRuns(source, topN);
    rankEl.replaceChildren();
    records.forEach((r, i) => {
      rankEl.appendChild(h('li', { 'data-ui': 'rank-row', class: 'rank-row' }, rankRowText(i + 1, r)));
    });
    rankEmptyEl.toggleAttribute('hidden', records.length > 0);
  }

  function render(snap: ControllerSnapshot): void {
    // 六维：等级取 exp 派生，其余取全库口径的属性快照（与战斗入口同一函数）
    const stats = playerStatsFor(snap.save);
    const level = levelFromExp(snap.save?.settings?.progress?.exp ?? 0);
    const values: Record<string, number> = {
      level,
      atk: stats.atk,
      def: stats.def,
      vit: stats.vit,
      spi: stats.spi,
      maxHp: stats.maxHp,
    };
    for (const [key, el] of statEls) el.textContent = String(values[key] ?? '—');

    const all = snap.save?.settings?.leaderboard;
    renderRank(Array.isArray(all) ? all : EMPTY_RECORDS);
    // 提醒横幅：闸门为真**且**这一实例里没被压掉。只读态横幅归 T8（D29），此处不重复。
    reminderEl.toggleAttribute('hidden', !(snap.reminderDue && !reminderDismissed));
  }

  const onRecall = (): void => {
    deps.onNav('decks'); // 备份入口在卡组页（导入/导出按钮所在屏）
  };
  const onDismiss = (): void => {
    reminderDismissed = true;
    render(ctrl.snapshot());
  };
  recallBtn.addEventListener('click', onRecall);
  dismissBtn.addEventListener('click', onDismiss);

  const unsubscribe = ctrl.subscribe((snap) => {
    if (destroyed) return;
    render(snap);
  });

  render(ctrl.snapshot());

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    for (const b of navButtons) b.removeEventListener('click', navHandler);
    recallBtn.removeEventListener('click', onRecall);
    dismissBtn.removeEventListener('click', onDismiss);
    screen.remove();
  }

  return { unmount: destroy };
}
