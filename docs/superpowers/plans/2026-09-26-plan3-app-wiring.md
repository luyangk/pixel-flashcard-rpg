# 知识侠客 · Plan 3/5：游戏装配层（App Wiring）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 1/2 的纯逻辑核装配成一个可编程驱动的游戏会话：GameSession 状态机（菜单→备战→战斗→结算）、全库口径属性派生、复习落账链、本地持久化与备份提醒、战绩榜落盘、假记忆注入素材池——即"无画面的可玩游戏"，Plan 4 只需给它挂 DOM/Canvas。

**Architecture:** 新增 `src/app/` 层（允许平台 API，不在 core purity 扫描范围）持有全部可变性：GameSession 用显式 reducer 风格推进；持久化经 Plan 1 的 GameStorage 抽象；随机与时钟从 platform/clock.ts、platform/rngProvider.ts 单点注入。测试用 memoryStore + fake clock + seeded rng，headless 跑通整局遭遇战。

**Tech Stack:** 沿用现有工具链（TS strict / Vitest）。无新依赖。DOM/Canvas 属 Plan 4，本计划零画面。

**Spec:** `docs/PRD.md` v2.1 §2/§3/§6.5（含装配红线 N-1/N-2/N-3）/§8 MVP 1–4、7；`docs/LORE.md` §5.5（假记忆）、§4.2（卷灵命名模板）。

## Global Constraints

- **装配红线 verbatim（PRD §6.5）**：① 生产代码体力/精神按**全库**统计派生（vit = stability∈{review,mastered} 的全部卡数；spi = 合格自建卡数，口径见 §6.4：source.type ∈ {manual,llm} 且 stability ≥ 'review' 且 lapses ≤ 2）；② victoryExp 传**实际释放**子集（won 时 pool.slice(0, idx)，lost 时全池）；③ migrateSave 调用时机由导入入口显式决定。
- 时钟唯一入口 `platform/clock.ts: now(): number`（生产 = Date.now()；测试可 mock），除该文件外 src/** 不得出现 `Date.now(`。
- tzOffsetMin 唯一计算点 `platform/env.ts: tzOffsetMin(): number = -new Date().getTimezoneOffset()`（R-T4-a 约定），其余处只引用。
- RNG 唯一 Math.random 包装点 `platform/rngProvider.ts: makeRng(): Rng`（mulberry32 以 clock+熵混合播种；测试注入固定 seed）。
- 复习落账只经 `applyReview`（R-T4-d）；UI/session 任何路径不得直呼 sm2.review 或 recordEffectiveReview（终审 grep 项延续）。
- BattleState/playerStats 传入 createBattle 前必须 structuredClone 断引用（N-5 教训推广：凡进 storage 的对象图先 clone）。
- 文案双轨制（LORE §6）：叙事文本半文半白、≤30 字；功能文本大白话。假记忆篡改规则 verbatim（LORE §5.5）：数字替换 ±1~9 扰动 / 反义近似词替换，两形态各至少一种实现。
- DRY/YAGNI/TDD；npm run verify 全绿才 commit；每任务 feat:/fix:/test:/chore: 前缀。
- 台账遗留义务在本计划兑现：N-5（落盘 clone）、N-8（'ready' 死分支处置）、N-9（answer card===pool[idx] dev 断言）、N-11（非法 rng 回落语义注释）、N-12（graded 透传注释或消毒器导出）。

## Review Focus

规格沉默但使用者会撞上的失效面（每条钉到归属任务测试）：

1. **存档写放大**：每次作答都全量 save → 移动端配额风暴与卡顿。预期：session 内 SRS 变更攒批，回合边界/终局才落盘一次。→ Task 4 计数断言。
2. **中途退出**：战斗中关页面（模拟 destroy()）后重开，已答卡的复习结果不丢、未答的不凭空完成。预期：崩溃一致性=最后一回合边界。→ Task 4 恢复用例。
3. **空库开局**：新装玩家 cards=[] 点"开战"。预期：明确引导文案而非白屏或 throw。→ Task 3 guard 用例。
4. **重复落账竞态**：同一卡在同一场被 answer 两次（dev 违规）或同日两场战斗。预期：SRS 双推进但日历日恰计一次，dev 断言抓前者。→ Task 2（N-9）。
5. **备份横幅疲劳**：用户刚导出又被提醒。预期：exportBackup 成功即重置计时，7 天窗口内至多一条横幅。→ Task 5。

---

### Task 1: platform 基础件（clock / env / rngProvider）

**Files:**
- Create: `src/platform/clock.ts`、`src/platform/env.ts`、`src/platform/rngProvider.ts`
- Test: `tests/platform/env.test.ts`、`tests/platform/rngProvider.test.ts`

**Interfaces:**
- Produces: `export function now(): number`（clock.ts，生产读 Date.now，测试经 vi.mock）；`export function tzOffsetMin(): number`（env.ts，= -getTimezoneOffset()，UTC+8 环境返回 480）；`export function makeRng(seed?: number): Rng`（rngProvider.ts：seed 缺省时以 (now()*2^21 ^ performance.now?.())>>>0 混合播种——若 performance 不可用仅用 now；返回 mulberry32 实例）。
- Consumes: rng.mulberry32/Rng。

- [ ] Step 1: 失败测试——tzOffsetMin 在 TZ=Asia/Shanghai 进程下 ===480（vi.stubGlobal 或直接断言其等于 -new Date().getTimezoneOffset()）；makeRng(42) 序列与 mulberry32(42) 全等；makeRng() 两次不同流（低概率允许相等则用 5 次采样断言 ≥4 相异）。
- [ ] Step 2: 确认失败 → Step 3: 实现三文件 → Step 4: 通过
- [ ] Step 5: Commit `feat(platform): clock, env and rng provider single points`

### Task 2: GameSession 战斗段 reducer + dev 断言（N-9/N-12）

**Files:**
- Create: `src/app/sessionTypes.ts`（共享类型先行避免任务间漂移）、`src/app/battleFlow.ts`
- Modify: `src/core/battle.ts`（answer 首部加 dev-mode 断言：`import.meta.env.DEV` 不可用于纯 core——改为可选参数 `asserts?: (msg:string)=>void`，默认 undefined 零开销；同时删除 'ready' phase 联合成员并在头注释申报理由【N-8】）
- Test: `tests/app/battleFlow.test.ts`、`tests/core/battle.test.ts`（锚点同步）

**Interfaces:**
- Produces:
```ts
// sessionTypes.ts
export interface SessionCards { decks: Deck[]; cards: Card[] }        // 全库视图
export type Phase = 'menu'|'preparing'|'fighting'|'result';
// battleFlow.ts
export interface FightView { state: BattleState; pool: readonly Card[]; current: Card | null }
export function startFight(cards: SessionCards, opts: { size: number; deckIds?: string[]; rng: Rng; nowMs: number }): FightView | { error: 'no-cards' | 'insufficient-cards'; message: string }   // RF#3 空库/不足守卫
export function answerCurrent(view: FightView, grade: Grade, deps: { rng: Rng; asserts?: (m:string)=>void }): FightView
// answerCurrent 内部：card 恒取 view.pool[view.state.idx]；若调用方语义要答非当前卡，asserts('answer-card-mismatch') 且拒绝推进
```
- Consumes: deckBuild.buildPool、stats.{deriveStats,enemyHpForPool}、battle.{createBattle,answer}、sm2.GRADES。

- [ ] Step 1: 失败测试——startFight({cards:[]}) → {error:'no-cards', message 含"还没有卡片"}；size 请求 15 实得 8 → enemyHp 按 8 反推（=56）且 FightView.pool.length===8；answerCurrent 依序推进 idx、终局 phase='won' 时 current===null；mismatch：手工构造 view.state.idx 与传入 grade 时序错乱不成立（API 不收 card 参数即免疫 RF#4 主路径）——dev asserts 用例走 battle.answer 直调 + asserts 回调捕获 'answer-card-mismatch'。
- [ ] Step 2: 确认失败 → Step 3: 实现（battleFlow 纯编排，无 IO）→ Step 4: 通过（battle.ts 改动后全量回归，T4 原锚点仅删 'ready' 相关若有）
- [ ] Step 5: Commit `feat(app): fight flow with empty-pool guards and dev assertions`

### Task 3: 全库口径属性派生 + 复习落账链（N-1/N-2/N-3 兑现）

**Files:**
- Create: `src/app/growth.ts`
- Test: `tests/app/growth.test.ts`

**Interfaces:**
- Produces:
```ts
export function vitCount(cards: readonly Card[]): number            // 全库 stability∈{review,mastered}
export function spiCount(cards: readonly Card[]): number            // 全库 source.type∈{manual,llm} && stability≥'review' && lapses≤2
export function playerStatsFor(save: SaveFile): PlayerStats          // deriveStats(levelFromExp(save), vitCount, spiCount)
export function releaseSubset(pool: readonly Card[], state: BattleState): Card[]  // won→pool.slice(0,state.idx)；lost→[...pool]
export function settleFight(cards: readonly Card[], view: FightView, deps: { gradeOf: (c: Card) => Grade; tzOffsetMin: number; nowMs: number; params: Sm2Params }): { cards: Card[]; exp: number; won: boolean }
// settleFight：对每个已消耗回合(c=slice(0,idx))经 applyReview(grade=deps.gradeOf(c)) 落账 → 返回新 cards 数组；exp = won ? victoryExp(releaseSubset(...),'encounter') : 0；等级存 meta.plays 旁的新字段？——否：level 由 exp 累计需持久位，SaveFile 无 level 字段。**裁决内置**：level/exp 存 Settings 扩展 settings.progress:{exp:number}（Task 3 一并改 types.ts/saveMigrate.ts，schemaVersion 仍 1，validateSave 补 progress 域、migrateSave 补默认 {exp:0}）
```
- Consumes: growth 自算 vit/spi 喂 stats.deriveStats；reviewFlow.applyReview；saveMigrate（progress 域）。

- [ ] Step 1: 失败测试——RF#3 续：mixed 全库（含未到期/他组卡）vit/spi 计数正确且**不受池影响**（N-1 钉死：同卡集 sim 池内口径 vs 全库口径给出不同值，函数取后者）；settleFight 打完整场后 domainReviewCount 每参与卡 +1、SRS reps 推进（R-T4-d 端到端第二钉）；won-with-overkill：idx=3 提前杀 → exp 按 3 张释放子集算、第 4-15 张 SRS 不动；lost：全池 SRS 均推进、exp=0。settings.progress 缺省迁移用例。
- [ ] Step 2: 确认失败 → Step 3: 实现（含 types/saveMigrate 的 progress 扩域）→ Step 4: 通过
- [ ] Step 5: Commit `feat(app): whole-library stat caliber and review settlement chain`

### Task 4: PersistenceCoordinator —— 攒批落盘 + 崩溃一致性

**Files:**
- Create: `src/app/persist.ts`
- Test: `tests/app/persist.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Coordinator { mutate(fn: (save: SaveFile) => void | Promise<void>): Promise<void>; flush(): Promise<boolean>; dirty: () => boolean; lastSavedAt(): number | null }
export function createCoordinator(store: GameStorage, opts: { now: () => number; maxBatchMs?: number /*default 5000*/ }): Promise<Coordinator>
// load() 初始（null → 内存种子档 decks:[],cards:[],settings 默认,meta{savedAt:now(),plays:0}）；mutate 标脏并 debounce；flush 在 maxBatchMs 超时或显式调用时 structuredClone → validateSave 自检 → store.save；save 抛错（配额）→ 保留 dirty、返回 false、错误上抛给调用 UI 层提示（不落 console 之外）
```
- Consumes: platform/storage.GameStorage、saveMigrate.validateSave。

- [ ] Step 1: 失败测试——RF#1：10 次 mutate 后 flush 前 store.load() 仍旧值、flush 后新值；debounce 窗内 mutate×N 只触发一次写（store 包一层计数 spy）；maxBatchMs 超时自动落盘（vi.useFakeTimers + 注入 now）；RF#2：flush 前"崩溃"（丢弃 coordinator，重新 create 同一 store）→ 数据回滚到最后一次 flush 且 validateSave 过；save reject → dirty 保持 true、下次 flush 重试成功；写入内容 deepEqual 期望且**与内存对象无共享引用**（N-5 推广：改内存后 load 值不变）。
- [ ] Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过
- [ ] Step 5: Commit `feat(app): debounced persistence with crash-consistent flush`

### Task 5: 备份信封 + 7 天提醒横幅

**Files:**
- Create: `src/app/backup.ts`
- Test: `tests/app/backup.test.ts`

**Interfaces:**
- Produces:
```ts
export interface BackupEnvelope { format: 'zx-xia-backup'; version: 1; exportedAt: number; save: SaveFile }
export function exportBackup(save: SaveFile, nowMs: number): string                     // JSON.stringify(envelope, null, 2)
export function parseBackup(text: string, nowMs: number): { ok: true; save: SaveFile; sinceLastBackupDays: number } | { ok: false; reason: string }
// 信封校验失败给可读 reason；内层 save 走 validateSave，缺 battle/progress 的旧档经 migrateSave（N-3 显式时机在此兑现）
export function backupReminderDue(lastExportedAt: number | null, nowMs: number, periodDays?: 7): boolean
// RF#5：null→true；距今 <7d→false；≥7d→true；periodDays 参数化便于测试
```
- Consumes: saveMigrate.{validateSave,migrateSave}。

- [ ] Step 1: 失败测试——roundtrip：exportBackup→parseBackup deepEqual 原 save（v1 legacy 串经 migrate 升形）；畸形（非 JSON/缺 format/版本 2/save 域外 ease=-8）各拒且 reason 指向正确层；reminderDue 四态 + 导出成功后 coordinator 记录的 lastExportedAt 更新使 due 翻 false（与 Task 4 的 meta 集成一小例）。
- [ ] Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过
- [ ] Step 5: Commit `feat(app): backup envelope with explicit migration and reminder gate`

### Task 6: 假记忆素材池（LORE §5.5 规则引擎）

**Files:**
- Create: `src/app/fakeMemory.ts`
- Test: `tests/app/fakeMemory.test.ts`

**Interfaces:**
- Produces:
```ts
export interface FakeCard { id: string; realCardId: string; front: string; tamperedBack: string; rule: 'number-shift' | 'word-swap' }
export function tamperNumber(card: Card, rng: Rng): FakeCard | null      // 找 back 中第一个 /\d+/，±(1..9) 扰动（保持位数外观，负号处理），无可替换数字 → null
export function tamperWord(card: Card, table: ReadonlyMap<string,string>, rng: Rng): FakeCard | null  // 表命中则换近义词/反义词，未命中 null
export function pickFakes(pool: readonly Card[], count: number, deps: { rng: Rng; wordTable: ReadonlyMap<string,string> }): FakeCard[]
// 依序尝试两规则，产出不足 count 就少产（战败演出容忍 1-2 张，LORE §5.5）；输出不含真答案
```
- Consumes: rng.Rng/uniform/pickWeighted、types.Card。

- [ ] Step 1: 失败测试——"光年是距离单位，1秒≈30万公里"类样本数字扰动确定值（seed 固定）；无数字卡 → null 降级 word-swap；词表命中/未命中两路；pickFakes 对 15 张池产 ≤2 且每张 tamperedBack ≠ 原 back、front 保真；确定性（同 seed 同输出）。
- [ ] Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过
- [ ] Step 5: Commit `feat(app): fake-memory tamper rules for defeat staging`

### Task 7: 战绩榜落盘接线（RunRecord 组装归位）

**Files:**
- Create: `src/app/results.ts`
- Test: `tests/app/results.test.ts`

**Interfaces:**
- Produces:
```ts
export function buildRunInput(view: FightView, state: BattleState, extras: { domain: string; kind: 'encounter'|'boss'; level: number }): Omit<RunRecord,'score'|'id'>
// cards=min(idx,pool.length)、misses=log 中 kind==='miss' 计数、at=extras.nowMs?——签名定：extras 含 nowMs:number；result 由 phase 判定；未完局保守 'lost'（R-T9-a 转换器归装配层的兑现处）
export function recordRun(coord: Coordinator, view: FightView, state: BattleState, extras: {...}): Promise<RunRecord>
// scoreRun → rankRuns 截 50 存 settings.leaderboard: RunRecord[]（types/saveMigrate 扩域：leaderboard 可选数组，元素九字段校验，缺省 []；schemaVersion 仍 1）→ coord.mutate
```
- Consumes: leaderboard.{scoreRun,rankRuns,RunRecord}、persist.Coordinator、sessionTypes.FightView。

- [ ] Step 1: 失败测试——buildRunInput 对手工 FightView 产出字段逐项正确（miss 计数含 amount=0 的 damage 不误计）；recordRun 后 store.load() 的 settings.leaderboard 含新记录且按分排序、上限 50 截尾；validateSave 拒 leaderboard[0].score=-1 带路径；旧档缺 leaderboard migrate 补 []。
- [ ] Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过
- [ ] Step 5: Commit `feat(app): run recording into persisted leaderboard`

### Task 8: headless 整局冒烟 + README 进度节

**Files:**
- Create: `tests/app/fullSession.smoke.test.ts`；Modify: `README.md`（新建，项目状态节）
- Test: 本体即测试

**Interfaces:**
- Consumes: 全部 app 模块 + platform（memoryStore、mocked clock/rng/env）。
- Produces: DoD1 的可执行证据链。

- [ ] Step 1: 写冒烟测试——种子档导入 30 张预置卡（模拟 CSV 导入后的 cards[]）→ startFight(size 15) → 逐张 answerCurrent（grade 策略：70% good/30% again，seeded）→ settleFight 落账 → coordinator.flush → 重开 coordinator 同 store 恢复 → 断言：cards 全库 SRS 推进一致、domainReviewCount>0、leaderboard 有记录、exp 入账、备份导出再 parse roundtrip 无损。全程无真实时钟（vi fake timers + 注入 now）。
- [ ] Step 2: 跑通（发现接缝 bug 即修，修不动报 BLOCKED）
- [ ] Step 3: README.md：项目一句话、五计划进度表、verify 徽章说明、Plan 4/5 预告
- [ ] Step 4: npm run verify 全绿 → Commit `test(app): headless full-session smoke + project status readme`

---

## Self-Review 结论（已执行）

1. **Spec coverage：** PRD §2.2/2.3→T2；§3→T2(startFight)；§6.5 红线 N-1/2/3→T3；§6.1 存储/备份→T4/T5；LORE §5.5→T6；§5 本地榜→T7；DoD1→T8；台账 N-5/8/9/11/12 全部有归属（T2/T4/T5/T7）。Boss 净化流程（purifiedAt 写入、图鉴页）与主题筛选 UI 属 Plan 4 界面层联动，此处 bossCheck/startFight(deckIds) 已备数据口。
2. **Step scan：** 各步单一动作；T3 的 settings.progress 扩域在步骤内给了内置裁决不留 TBD。
3. **Type consistency：** FightView/SessionCards 定义于 T2 的 sessionTypes.ts，T3/T7/T8 引用同名；Coordinator 接口 T4 定义 T5/T7 消费；RunRecord 复用 core/leaderboard 不重定义。
4. **Review Focus：** 五条归属 T4/T4/T2/T2+T3/T5。
5. **Proportion：** 8 任务对应 spec 三个章节的装配论证，代码块均为签名级。
