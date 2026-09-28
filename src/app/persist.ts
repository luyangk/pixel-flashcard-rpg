/**
 * persist.ts —— Plan 3 · T4 PersistenceCoordinator：攒批落盘 + 崩溃一致性。
 *
 * 移动端两条红线在此兑现：
 * - **RF#1 写放大**（配额与耗电保护）：mutate 只标脏 + 重排 debounce 窗，
 *   窗内 mutate×N 至多触发一次 store 写；maxBatchMs（默认 5000）到点强制落盘，
 *   保证"高频小改动"既不打穿存储配额也不无限悬空；干净状态下定时器不空转。
 * - **RF#2 崩溃一致性**：store 里永远只有"某次成功 flush 的完整快照"——
 *   flush 之前进程死亡 = 回滚到最后一次 flush。恢复侧 createCoordinator 重新
 *   load + validateSave，半途状态不可能存在于存储中。
 *
 * 落盘前自检（N-5 推广）：structuredClone 出纯数据快照 → validateSave 整包校验
 * → 才交给 store.save。内存权威对象被外部（越过 mutate）mutate 出的非法形状
 * 一律拦在 coordinator 内；已提交值与内存对象零共享引用。
 *
 * 失败语义（配额模拟）：save reject ⇒ dirty 保持、flush 返回 false、错误经
 * **返回值**上抛给 UI 层提示（console 之外不落——本模块不 import console、
 * 不弹窗、不重试策略外的任何副作用）。重排的窗口会自然带来退避重试。
 *
 * 时间纪律：now 一律 opts 注入（生产方传 platform/clock.now），本文件不读时钟；
 * src/app 层亦不得触碰 DOM（画面属 Plan 4）。
 *
 * 落库义务（R-T3-p3-b / M-2）：settleAndRecord 是战斗结算 → progress.exp 的
 * 唯一编排点——settleFight 的 {cards,exp,won} 经此写回 cards / settings.progress.exp /
 * meta.plays，杜绝"等级永远 L1"。
 *
 * Plan 3 · T7 增补：①种子档带上空榜 settings.leaderboard（与 migrateSave 为旧档补的
 * 缺省同形）；②`markExported(nowMs)` 是 meta.lastExportedAt（7 天备份提醒的唯一喂入位）
 * 的生产写入路径，自带 flushToClean 收口——"导出已记时"返回即已在存储里。
 */

import type { Card, SaveFile, Settings } from '@core/types';
import type { GameStorage } from '@platform/storage';
import { validateSave } from '@core/saveMigrate';
import type { SettleResult } from './growth';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** debounce 窗：mutate 后静置此时长即自动落盘（brief 未定值，裁决见报告）。 */
export const DEFAULT_DEBOUNCE_MS = 500;

/** maxBatchMs 默认值（brief verbatim：5000）——攒批的时间上限，到点强制落盘。 */
export const DEFAULT_MAX_BATCH_MS = 5000;

/**
 * flushToClean 的步数上限（R-T4-p3-d 收口用）：正常路径一轮即净，上限只为防
 * "持续有并发 mutate"时把调用方无限挂住。不导出：它不是可调参数，只是自旋护栏。
 */
const MAX_FLUSH_ROUNDS = 5;

/**
 * 时间戳上界（Date 可表示范围 ±8.64e15ms），**与 core/saveMigrate.requireTimestamp /
 * requireNonNegTimestamp 同值同域**——markExported 的守卫必须与落盘自检的域严格一致，
 * 否则放行的值会在下一次 flush 里让 validateSave 整包拒（I1 的实证教训：1e300 进档后
 * dirty 恒 true、连无关改动都写不进去）。
 *
 * 此处是本地副本而非 import：core 侧该常量尚未导出（R-T6-d 的"不发明新导出面"），
 * 而 core 文件不在本任务授权面内。域值若变更（几乎不可能），两处需同步——已登记报告。
 */
const MAX_TIME_MS = 8.64e15;

/** brief Produces 声明的最小接口；实现返回的对象是其超集（结构兼容，CT#3 钉住）。 */
export interface Coordinator {
  /** 对权威存档做一次可变更新并标脏；fn 可为 async，mutate 之间串行执行（无交错丢更新）。 */
  mutate(fn: (save: SaveFile) => void | Promise<void>): Promise<void>;
  /** 立即落盘。true = 已写入或本就干净；false = 自检/写入失败（dirty 保持）。 */
  flush(): Promise<boolean>;
  /** 是否有未落盘的改动。 */
  dirty(): boolean;
  /** 最近一次成功落盘时刻（opts.now 口径）；从未落盘为 null。 */
  lastSavedAt(): number | null;

  // —— 以下为装配层扩展面（T5/T8 消费）——

  /** 内部权威存档本体（受控可变视图：UI 层只读使用，改动须走 mutate/markDirty）。 */
  snapshot(): SaveFile;
  /** 战斗结算落库编排点（M-2）：写回 cards、累加 progress.exp、plays+1。 */
  settleAndRecord(result: SettleResult): Promise<void>;
  /** 外部失控改过 snapshot() 后的显式标脏（正常路径不需要，SN#3b 测试用）。 */
  markDirty(): void;
  /**
   * 记下"备份导出成功"的时刻（Plan 3 · T7，R-T5-p3-a）：写 `meta.lastExportedAt`
   * 并收口到"已持久"（flush() && !dirty() 语义，见 R-T4-p3-d）。
   *
   * 这是 7 天提醒闸门 backupReminderDue 的**唯一生产写入位**——没有它，闸门只能靠
   * 调用方手工改 meta，7 天提醒就是一段死代码。非法时刻（非有限 / 负值）**不写**：
   * fail-closed 不把脏值放进权威位（脏值会让落盘自检整包失败，连累所有其它改动），
   * 而闸门对缺席/坏值本就 fail-open（宁可多提醒一次），两者方向一致。
   */
  markExported(nowMs: number): Promise<void>;
  /** flush 的详细结果面（boolean 面由 `=== true` 比较即可判别）。 */
  flushDetailed(): Promise<FlushResult>;
}

export type FlushResult = { ok: true } | { ok: false; reason: string };

export interface CoordinatorOptions {
  /** 时钟注入点（生产传 platform/clock.now；测试传 fake 时钟）。coordinator 自身绝不读钟。 */
  now: () => number;
  /** maxBatchMs：距上次成功落盘超过此时长强制 flush。默认 5000。 */
  maxBatchMs?: number;
  /** debounce 窗长。默认 500。 */
  debounceMs?: number;
  /**
   * 存储里的档过不了 validateSave 时的回调（reason 为大白话素材，UI 层决定文案）。
   * 裁决：坏档**不回写**——种子档接管内存，但存储原样保留，给用户手动导出抢救留路。
   */
  onRecoverableLoadError?: (reason: string) => void;
}

// ---------------------------------------------------------------------------
// 默认设置与种子档
// ---------------------------------------------------------------------------

/** 与 core/sm2 FALLBACK_PARAMS 逐字同值的规范默认（settings.sm2Params 的种子）。 */
const DEFAULT_SM2_PARAMS = { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 };

/** 新装玩家的默认设置（bossThresholdTier=30：PRD §6.5 Boss 门槛中档起步）。 */
const DEFAULT_SETTINGS: Settings = {
  bossThresholdTier: 30,
  sm2Params: DEFAULT_SM2_PARAMS,
  battle: { defaultPoolSize: 15 },
  progress: { exp: 0 },
  // T7：新档直接带空榜（与 migrateSave 为旧档补的缺省同形），
  // 免得"种子档"与"迁移档"两种形状长期分叉。数组本体在 seedSave 里每次新建。
  leaderboard: [],
};

/**
 * 种子档：decks/cards 空、settings 默认、meta{savedAt:now(),plays:0}（brief verbatim）。
 * decks 恒为 [] —— 但 validateSave 要求 cards[].deckId 引用闭合，故 mutate 侧提供
 * ensureDefaultDeck 兜底：首张卡落地前补一个默认领域卡组（PC#2 钉住这条链）。
 * 每次调用新建深拷贝，绝不被跨实例共享 mutate。
 */
function seedSave(nowMs: number): SaveFile {
  return {
    schemaVersion: 1,
    decks: [],
    cards: [],
    settings: {
      ...DEFAULT_SETTINGS,
      sm2Params: { ...DEFAULT_SETTINGS.sm2Params },
      battle: { ...DEFAULT_SETTINGS.battle },
      progress: { ...DEFAULT_SETTINGS.progress },
      leaderboard: [], // 每份种子档各持一个空数组，绝不跨实例共享可变引用
    },
    // meta 不含 lastExportedAt：缺席正是"从未导出"（R-T5-p3-a），种子档不得假装已备份。
    meta: { savedAt: nowMs, plays: 0 },
  };
}

/** 种子档默认领域卡组的 id——与既有夹具（growth.test/makeSave）同用 'deck-a'。 */
export const DEFAULT_DECK_ID = 'deck-a';

/**
 * 引用闭合兜底：save 里没有任何 deck 时补一个默认领域卡组。
 * 只在 mutate/settleAndRecord 的落库路径上调用（不在构造期），保证 PC#1
 * 「空存储 → 种子档 decks=[]」的 brief verbatim 形状不被提前破坏；
 * 一旦有卡入档，decks 至少一组成员，validateSave 的悬空 deckId 检查即过。
 */
function ensureDefaultDeck(save: SaveFile): void {
  if (!Array.isArray(save.decks)) save.decks = [];
  if (save.decks.length === 0) {
    save.decks.push({ id: DEFAULT_DECK_ID, name: '我的领域', isPreset: false });
  }
}

// ---------------------------------------------------------------------------
// 消毒工具（fail-closed：宁可不落账，不落脏值）
// ---------------------------------------------------------------------------

/** 有限非负数取整回落 0（exp/plays 增量口径）。 */
function nonNegOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** 卡数组面消毒：非数组 → []；元素逐项要求带字符串 id（validateSave 同款前置）。 */
function sanitizeCards(v: unknown): Card[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c) => c != null && typeof (c as Card).id === 'string') as Card[];
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// createCoordinator
// ---------------------------------------------------------------------------

export async function createCoordinator(
  store: GameStorage,
  opts: CoordinatorOptions,
): Promise<Coordinator> {
  const now = opts.now;
  const maxBatchMs = typeof opts.maxBatchMs === 'number' && Number.isFinite(opts.maxBatchMs) && opts.maxBatchMs > 0
    ? opts.maxBatchMs
    : DEFAULT_MAX_BATCH_MS;
  const debounceMs = typeof opts.debounceMs === 'number' && Number.isFinite(opts.debounceMs) && opts.debounceMs >= 0
    ? opts.debounceMs
    : DEFAULT_DEBOUNCE_MS;

  // —— 初始态：load() 优先；null → 种子档；坏档 → 种子档接管但不回写 ——
  let save: SaveFile;
  try {
    const loaded = await store.load();
    if (loaded === null) {
      save = seedSave(now());
    } else {
      const validated = validateSave(loaded);
      if (validated.ok) {
        save = validated.save;
      } else {
        opts.onRecoverableLoadError?.(validated.reason);
        save = seedSave(now());
      }
    }
  } catch (e) {
    // load 抛错（IDB 权限突变等）：按空档处理，UI 可经 kind/后续 flush 失败感知
    opts.onRecoverableLoadError?.(`读取存档失败：${describeError(e)}`);
    save = seedSave(now());
  }

  // 攒批硬上界锚点：本批脏数据"首次被排窗"的时刻。maxBatch 的语义是"脏数据悬着的
  // 总时长上界"（Q#4 教训）。锚点有三个处置点，不都在 performFlush 一侧
  //（净态置 null 在 armWindow 的撤窗分支；另两处见下）：
  // - **成功**：批次在 `await store.save` **之前**就被认领，认领即置 null
  //   （本批已提交，下一批重新定格；见 performFlush 内的认领段）；
  // - **失败**：复位到当下（performFlush 的 catch 与 flushDetailed 尾部的失败重排各一处），
  //   使重试窗按**完整 debounce** 退避，而不是被陈旧 maxBatch
  //   界压成 0ms（否则"内容持续非法"时 0ms 定时器反复自触发空转）。退避这段时间
  //   因此不计入下一次的悬脏上界。
  let batchStartedAt: number | null = null;
  let dirty = false;
  let lastSaved: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<FlushResult> | null = null;
  // mutate 串行队列：fn 可为 async，队列保证「先 mutate 先应用」，无交错丢更新。
  let queueTail: Promise<unknown> = Promise.resolve();

  /** 下一次计划落盘的时刻（debounce 到期 / maxBatch 到点取先到者）。 */
  function scheduledTime(): number {
    const byDebounce = now() + debounceMs;
    // 攒批上界只在已标脏时有意义（未脏 ⇒ 无从攒批）。
    const byMaxBatch = batchStartedAt === null ? Infinity : batchStartedAt + maxBatchMs;
    return Math.min(byDebounce, byMaxBatch);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** debounce 到期 / maxBatch 到点时计划落盘；失败保留 dirty 并重排下一窗（Q#4 自愈）。 */
  function onWindowDue(): void {
    timer = null;
    if (!dirty) return;
    // performFlush 把所有 reject 收敛为 {ok:false}，此处永不 reject——
    // 静默失败即"等下次窗口重试"，错误面只经 flush()/flushDetailed() 返回值上抛。
    void flushDetailed();
  }

  /**
   * 宿主真实时钟读数：setTimeout 挂在这条时间轴上，而 `now` 是外部注入的。
   * 本模块不读钟（文件头纪律），故取"与 now 同口径的默认宿主实现"这一形态；
   * 用**函数引用**而非取值——vi.useFakeTimers({toFake:['Date']}) 会替换全局 Date，
   * 取值式快照会让 lag 恒为 0、守卫失效。仅供下面的失同步兜底，不参与任何落库值。
   */
  const hostNow: () => number = Date.now;

  /** 开窗：按注入时钟算出等待时长，挂一个到期落盘的定时器。 */
  function scheduleWindow(): void {
    clearTimer();
    const t = now();
    let wait = Math.max(0, scheduledTime() - t);
    // 双时钟补偿：wait 由**注入时钟**算出，setTimeout 却挂在**宿主时间轴**上
    // （生产二者同源：clock.now 即 Date.now，lag≈0，本分支恒不触发）。
    // 注入钟超前宿主轴 lag 毫秒时，宿主轴上的真实剩余就是 wait−lag；据此收缩，
    // 避免"注入钟已越过 deadline、宿主定时器却还要等满 wait"的错位。
    // 反方向（注入钟落后于宿主轴）无需补偿：宿主轴多走的部分只会让定时器更早
    // 到达，而下限由 Math.max(0, …) 兜住，不会出现负延迟。
    const lag = t - hostNow();
    if (lag > 0) wait -= Math.min(wait, lag);
    timer = setTimeout(onWindowDue, Math.max(0, wait));
    // Node 测试环境下不因挂起的定时器阻止进程退出（浏览器无此 API，可选链防御）。
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * 脏则开窗（幂等重排），净则撤窗并作废攒批锚点——干净状态下定时器绝不空转（省电）。
   *
   * 不得吞掉 deadline（RF1#3 的教训）：debounce 顺延每次重排都重取
   * min(debounce 界, maxBatch 界)，故后续 mutate 把 debounce 推远时，
   * maxBatch 到点依旧是触发时刻——兑现 brief verbatim「flush 在 maxBatchMs 超时
   * 或显式调用时」落盘，即"距上次落盘 ≥ maxBatchMs ⇒ 下一次定时器 tick 必写"。
   */
  function armWindow(): void {
    if (!dirty) {
      batchStartedAt = null;
      clearTimer();
      return;
    }
    // 攒批锚点：本批首次开窗定格，批内后续 mutate 不得后推（RF1#3 教训——
    // debounce 顺延不能连带推走 maxBatch 上界）。锚点不跨失败保持：失败时
    // performFlush / flushDetailed 会把它复位到当下，用完整 debounce 退避重试
    // （Q#4 的自愈节奏即由此而来）。递归防护不在锚点上做，而在 performFlush 的
    // 同步预检里（见该函数头部）——它保证"内容非法 ⇒ 永不触 store"，无论窗口何时到点。
    if (batchStartedAt === null) batchStartedAt = now();
    scheduleWindow();
  }

  /** 真正的落盘动作：clone → validate → store.save，全失败面收敛为 {ok:false,reason}。 */
  async function performFlush(): Promise<FlushResult> {
    if (!dirty) return { ok: true };
    // 快照自检（N-5 推广）：structuredClone 既隔离外部 mutate，也顺带把
    // 不可克隆成员（函数/类实例）炸出来——clone 失败即内容失控，拒绝落盘。
    //
    // 自检全程同步、先于任何 await（构造使然，非额外设计）：因此"内容非法 ⇒
    // 绝不触 store.save"是构造性成立的，与窗口何时到点无关。SN#3b 以
    // "save 计数零增长"钉住这条边界（非法快照连一次写都产生不了）。
    let copy: SaveFile;
    try {
      copy = structuredClone(save);
    } catch (e) {
      return { ok: false, reason: `存档含不可序列化内容，已拒绝落盘：${describeError(e)}` };
    }
    const validated = validateSave(copy);
    if (!validated.ok) {
      return { ok: false, reason: `存档自检未通过，已拒绝落盘：${validated.reason}` };
    }
    // meta.savedAt = 本次落盘时刻（导出信封 exportedAt 的数据源）。
    // clone 与 store.save 之间无任何 await——此刻内存对象不可能被并发 mutate 触碰，
    // 故把刷新值写回 copy 再提交是原子的：已存值与 lastSavedAt() 恒等（FL#5），
    // 且 copy 与内存权威对象零共享引用（SN#1 守护的正是这条边界）。
    const savedAt = now();
    copy.meta.savedAt = savedAt;
    // —— 在途批次认领（C1，本函数的数据安全核心）——
    // clone/validate 已通过，本次要写的内容此刻起与后续 mutate 无关，故在**首个
    // await 之前**同步清脏、同步作废锚点，语义是"这批改动已被本次写认领"：此后
    // 到达的 mutate 会重新标脏、重新定格锚点，属于下一批，必须由下一次写负责。
    // 若把清脏留到 await 之后，在途 mutate 置上的 dirty 会被无条件抹掉，那批改动
    // 再无人写（评审 P6 实测：live plays=42 / store plays=1 / flush()===true /
    // dirty()===false，空转 60s 无第二次写，销毁重建后蒸发）。
    // 附注：dirty() 只表示"内存里有尚未被任何一次写认领的改动"，**不是落盘凭据**
    // （认领瞬间写还没落，写失败还会重新标脏）——装配层不得只凭 dirty()===false
    // 断定"已持久"。
    dirty = false;
    batchStartedAt = null;
    try {
      await store.save(copy);
    } catch (e) {
      // 配额满 / 存储故障：本次认领作废——把批次重新标脏并复位锚点到当下
      // （退避，避免 0ms 自旋），错误经返回值上抛给 UI 层。重排窗口由
      // flushDetailed 尾部统一负责（Q#4 自愈），此处不重复开窗。
      dirty = true;
      batchStartedAt = now();
      return { ok: false, reason: `写入存储失败：${describeError(e)}` };
    }
    // 成功：只刷新落盘时刻。**不再清 dirty / 不再动锚点**——若在途 mutate 已重新
    // 标脏，那一位是下一批的凭据，必须原样留着（旧实现正是在这里把 C1 那批抹掉的）。
    save.meta.savedAt = savedAt;
    lastSaved = savedAt;
    return { ok: true };
  }

  async function flushDetailed(): Promise<FlushResult> {
    clearTimer();
    // 并发合流：同一时刻多个 flush 请求共享同一次写（FL#3）——合流的含义是
    // "已被认领的那一批只写一次"。performFlush 在首个 await 前同步取快照并同步清脏
    // （C1 的认领时机），故合流期间新到达的 mutate 不属于本次写，它自己会重新标脏
    // 并重排窗口（flushDetailed 尾部也会再 armWindow 一次），剩余批次由那个窗口兜底，
    // 不丢数据。据此：等待方拿到的 true 只承诺"被认领的那批已写"，dirty() 也只表示
    // "有未被认领的改动"——**dirty() 不是落盘凭据，装配层不得只信它**。
    if (inflight !== null) return inflight;
    if (!dirty) return { ok: true };
    const task = performFlush().finally(() => {
      inflight = null;
    });
    inflight = task;
    const result = await task;
    // 成功与失败统一重排下一窗：
    // - 成功：本次认领的批次已写。期间无新 mutate ⇒ dirty 为净，armWindow 走"净则
    //   撤窗"分支等下一次标脏；期间有在途 mutate ⇒ 它已重新标脏，armWindow 正好把
    //   那批排进下一窗（这正是 C1 的收尾：不再是"被清零后无人写"）；
    // - 失败：performFlush 已把批次重新标脏（Q#4）、lastSaved 不动（FL#4），此处再
    //   把攒批锚点复位到当下，使重试窗按完整 debounce 退避，而不是被陈旧 maxBatch 界
    //   压成 0ms——否则"内容持续非法"时会出现 0ms 定时器反复自触发的空转（虽永不触
    //   store，但白烧 CPU/电池）。复位后重试节奏 500ms 一档，配额恢复即自愈。
    if (!result.ok) batchStartedAt = now();
    armWindow();
    return result;
  }

  /** brief Produces 的 boolean 面；详细 reason 走 flushDetailed()。 */
  function flush(): Promise<boolean> {
    return flushDetailed().then((r) => r.ok);
  }

  async function mutate(fn: (save: SaveFile) => void | Promise<void>): Promise<void> {
    const run = queueTail.then(async () => {
      await fn(save);
      // 引用闭合兜底：卡进了档、deck 还没影 ⇒ 补默认领域卡组（validateSave 前置）。
      if (Array.isArray(save.cards) && save.cards.length > 0) ensureDefaultDeck(save);
      dirty = true;
      armWindow();
    });
    // 队列尾吞掉业务错误（防止一次坏 mutate 毒化后续所有 mutate），
    // 但错误原样经 run 上抛给本次调用方（Q#5）。
    queueTail = run.catch(() => undefined);
    await run;
  }

  /**
   * 战斗结算 → 落库的唯一编排点（R-T3-p3-b / M-2）。
   * 三写一体：cards 整体替换（settleFight 保序新数组）、progress.exp 累加、plays+1。
   * 入参消毒 fail-closed：exp 非有限/负 → 0（宁可漏发一场奖励，不写 NaN 进权威位）；
   * cards 非数组 → 不动库存卡（保留旧值即最保守解）。won=false 同样计 plays：
   * "打过一局"与胜负无关，PRD 的游玩计数即此口径。
   */
  async function settleAndRecord(result: SettleResult): Promise<void> {
    const nextCards = Array.isArray(result?.cards) ? sanitizeCards(result.cards) : null;
    const gained = nonNegOr0(result?.exp);
    await mutate((s) => {
      if (nextCards !== null) s.cards = nextCards;
      s.settings.progress.exp = nonNegOr0(s.settings.progress.exp) + gained;
      s.meta.plays = nonNegOr0(s.meta.plays) + 1;
    });
  }

  /**
   * "我的改动此刻已持久"的收口（R-T4-p3-d 的兑现处）：flush() 的 true 只承诺
   * "被认领的那批已写"，在途 mutate 的那批还没写——故必须循环到 dirty() 归假。
   * 步数上限只为防"持续有并发 mutate 时不返回"；正常路径一轮即净。
   * 返回 false 表示仍有未落盘改动（写失败或并发不断），错误面由 flush 返回值承载。
   */
  async function flushToClean(): Promise<boolean> {
    for (let i = 0; i < MAX_FLUSH_ROUNDS; i++) {
      if (!(await flushDetailed()).ok) return false;
      if (!dirty) return true;
    }
    return !dirty;
  }

  /**
   * 备份导出时刻的持久位（R-T5-p3-a）：唯一生产写入者是这里。
   *
   * 消毒 fail-closed，且**必须与存储域完全同界**：validateSave 对 meta.lastExportedAt 的
   * 严检是 `0 ≤ v ≤ MAX_TIME_MS`，故本守卫对 非有限 / 负值 / **超上界** 三档一律直接返回、
   * 不标脏。缺上界是评审判 I1 的实证缺陷：`markExported(1e300)` 曾把 1e300 写进权威位，
   * 之后每次落盘自检整包失败 ⇒ dirty 恒 true、`flush()` 恒 false，**无关改动也永久写不进去**
   * （自检失败不走退避自愈路径）。这正是此处注释自称要防的"毒化整包自检、拖住无关改动"，
   * 漏掉的恰是上界那一条。而闸门对"缺席"本就 fail-open（提醒照响），代价只是多提醒一次。
   */
  async function markExported(nowMs: number): Promise<void> {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_TIME_MS) {
      return;
    }
    await mutate((s) => {
      s.meta.lastExportedAt = nowMs;
    });
    await flushToClean();
  }

  return {
    mutate,
    flush,
    dirty: () => dirty,
    lastSavedAt: () => lastSaved,
    snapshot: () => save,
    settleAndRecord,
    markDirty: () => {
      dirty = true;
      armWindow();
    },
    markExported,
    flushDetailed,
  };
}
