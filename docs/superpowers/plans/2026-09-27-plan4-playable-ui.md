# 知识侠客 · Plan 4/5：画面与玩法闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让逻辑核第一次变成手机上可玩的游戏：DOM 壳（菜单/备战/结算/卡组/藏书阁/设置）+ Canvas 战斗舞台 + 序章演出 + Boss 净化与图鉴 + 只读态 UI，交付 DoD2/DoD4 的可玩证据。

**Architecture:** DOM 层负责一切表单与列表（`src/ui/`，原生 DOM 组件，无框架）；Canvas 层只画战斗舞台（`src/stage/`，rAF 驱动、整数缩放、事件回传）；两者由 `src/app/gameController.ts` 统一编排——controller 持有 Coordinator/FightView 真值，视图只做渲染与意图回传（单向数据流）。像素素材经 pixel-art-studio 生成 PNG 静态资源，运行时 drawImage。

**Tech Stack:** TypeScript strict / Vite（已有）/ Vitest + happy-dom（新增 devDep，仅测 DOM 组件）/ Canvas 2D。**不引入游戏引擎与 UI 框架**（PRD D01/D24 分层约束）。

**Spec:** `docs/PRD.md` v2.2（§2 玩法+D28 反击、§3 备战、§6.5 四红线、§7 美术规格、§9 故事系统、§8 MVP 6/叙事全套）；`docs/LORE.md`（§4 命名、§5 呈现结构、§6 文案双轨制）；Plan 3 终审 triage 的「带入 Plan 4」义务清单（见 Global Constraints 末段）。

## Global Constraints

- **D28 verbatim**：`damageToPlayer = max(1, enemyPower − def) × uniform(rng,0.9,1.1)` 取整；`enemyPower = ceil(BASE_CARD_DAMAGE × difficulty)`（遭遇战 7 / Boss 11）；每回合玩家行动后结算（miss 不免除）；`playerHp ≤ 0 → lost`。答错仅空转不变。
- **D29 verbatim**：只读态三件套——常驻横幅「存档无法读取，本次进度不会保存」+ 坏档原文逐字节导出（文件名 `zx-xia-corrupt-<YYYY-MM-DD>.json`）+ `SaveReadOnlyError` 全捕获可见。
- 装配红线 N-1/N-2/N-3/N-4（PRD §6.5）继续生效；`flush() && !dirty()` 为"已持久"唯一判据（R-T4-p3-d）。
- 视觉：水墨低饱和为底、赛博高饱和光效只给怪物（D15）；**整数缩放**（canvas CSS 尺寸 = 逻辑尺寸 × 整数倍，禁非整数）；竖屏单手布局，主操作热区在屏幕下半。
- 文案双轨（LORE §6）：叙事半文半白 ≤30 字；功能大白话。字体：中文位图字体不可行 → 用系统字体 + `-webkit-font-smoothing: none` 近似，UI 文本不走 Canvas（走 DOM），Canvas 内只有 sprite 与数字伤害值（英文数字无字体问题）。
- core/app 既有纪律不破：core 零 DOM；**新代码 src/ui、src/stage 允许 DOM**，但 `src/core/**` 扫描守卫（purity）与「除 platform/clock.ts 外禁 Date.now(」的冒烟扫描必须继续全绿——stage 的 rAF 时间戳由参数注入，不读钟。
- Plan 3 triage 带入项在本计划兑现：非法 size 文案分流（T2）、Phase 死类型处置（T2）、flushToClean 第三调用方出现即提取（T7）、importAndSave 先剔字段再校验（FFW out-of-scope）、只读 UI（D29）。
- TDD：ui 组件用 happy-dom 行为测试（断言 DOM 状态而非快照字符串）；stage 用纯 reducer/几何函数测试（渲染循环本体不强测）；npm run verify 全绿才 commit。
- 素材：`assets/` 目录进仓库；占位素材先行（纯色块 sprite 也要跑通管线），正式素材在 T9 替换，两阶段同接口。

## Review Focus

使用者最可能撞上、而单任务测试易漏的失效面（每条钉到归属任务）：

1. **回合时序**：敌人反击发生在"玩家作答之后、下一题之前"——若实现成先扣血再判胜，会出现"同花顺局双双阵亡"的错误结局。预期：先判敌 HP 归零（won 优先），未归零才轮到玩家承伤。→ Task 2。
2. **旋转/尺寸变化**：手机横竖屏切换或浏览器工具栏收起导致可视区变化时，Canvas 不得拉伸变形（破坏整数缩放）。预期：resize 重算整数倍并居中，永不非整数缩放。→ Task 4。
3. **连点/双触发**：快速双击答案按钮发出两次 answerCurrent（同一题被结算两次）。预期：按钮点击后立即禁用直至状态回传，且 controller 以 idx 幂等去重。→ Task 5。
4. **只读会话中的全部写路径**：只读态下每一处会触发的写（settleAndRecord/recordRun/markExported/mutate）都必须被捕获并提示，一处不漏。预期：横幅在场时任何操作都不产生未捕获异常。→ Task 8。
5. **长列表性能**：数百张卡的卡组页一次性建 DOM 造成卡顿。预期：卡组页按 50 条分页/懒挂载，滚动帧率不因数据量崩塌。→ Task 7。

---

### Task 1: 反击规则（battle.ts 扩展，D28）

**Files:**
- Modify: `src/core/battle.ts`（answer 主体加敌方回击段）
- Test: `tests/core/battle.test.ts`（CB#13 起新增组）

**Interfaces:**
- Consumes: 现有 BattleState（含 atk/playerHp/maxPlayerHp）、GRADES、uniform/Rng。
- Produces: `export function enemyPowerFor(difficulty: 'encounter'|'boss'): number`（= ceil(BASE_CARD_DAMAGE × DIFFICULTY[d])，放 stats.ts 更合职责——**裁决：放 stats.ts**，battle 从 './stats' import type 不引运行值则破环？stats 不 import battle，安全：battle.ts `import { enemyPowerFor } from './stats'`）；`answer` 返回态中 `playerHp` 真实递减；新事件 `{kind:'retaliate', amount:number}` 追加于本回合 damage/miss 之后、end 之前；lost 判定扩为 `playerHp ≤ 0 || idx===pool.length`（后者维持），**won 优先于承伤**。

- [ ] Step 1: 失败测试——手算样本：def=5、enemyPower=7、rng≡0.5 → 反击 round(max(1,2)×1.0)=2/回合；miss 回合仍反击；最后一题击杀 → won 且 playerHp 不再扣（反击被胜负短路吞掉）；playerHp 恰好归零当回合判 lost（idx 未到池尽也算）；duplicate/end 后幂等不变。
- [ ] Step 2: 确认失败 → Step 3: 实现（answer 内在命中/空转分支后统一走 retaliation 段，phase 计算顺序：敌≤0→won；否则己≤0→lost；否则池尽→lost；否则 answering）
- [ ] Step 4: 通过 + 全量回归（旧 AN/EW 用例中 playerHp 恒满的断言需按新语义更新者，逐处注释来历）
- [ ] Step 5: Commit `feat(core): enemy retaliation settles against def/playerHp (D28)`

### Task 2: 数值曲线复验（sim 更新）

**Files:**
- Modify: `tests/sim/balance.sim.test.ts`
- Test: 本体

**Interfaces:**
- Produces: 新基线曲线（def=7、hp=100、L1 场景）：胜率随 miss 率的迁移量；「全对必胜」改为「全对必 survives」硬断言（100 回合内不死 + 仍 won）；SM#1 冒烟夹具若受波及同步（本波只改 sim，冒烟在 T6 复核）。

- [ ] Step 1: 跑现状取数（50 seed × miss{0,10,20,30,40}%，含死亡回合统计）
- [ ] Step 2: 依实测改写 SIM#A 为 survived&&won 双断言、SIM#B 基线区间重录（报告贴表）
- [ ] Step 3: 若发现「全对也死」（survival 失败）→ 停，报 BLOCKED_WITH_DATA（意味着 enemyPower 常数需要 spec 修订，勿私调）
- [ ] Step 4: 绿 → Commit `test(sim): re-baseline curve under D28 retaliation`

### Task 3: gameController（DOM 无关的会话编排核）

**Files:**
- Create: `src/app/gameController.ts`、`src/app/controllerTypes.ts`
- Test: `tests/app/gameController.test.ts`

**Interfaces:**
- Consumes: persist.Coordinator、battleFlow.{startFight,answerCurrent}、growth.{playerStatsFor,settleFight,levelFromExp}、results.{recordRun,buildRunInput}、backup.{backupReminderDue}、transfer.{importBackupAndSave,exportAndMark}、platform.{clock,env,rngProvider}。
- Produces:
```ts
export type ControllerSnapshot = Readonly<{ screen: 'boot'|'menu'|'prologue'|'prepare'|'fight'|'result'; fight: FightView | null; save: SaveFile; readOnly: boolean; reminderDue: boolean; lastResult: RunSummary | null }>
export interface GameIntent = { type:'startFight'; size:number; deckIds?:string[] } | { type:'answer'; grade:Grade } | { type:'finish' } | { type:'toMenu' } | { type:'skipPrologue' } | { type:'seenPrologue' }
export interface GameController { snapshot(): ControllerSnapshot; intent(i: GameIntent): Promise<void>; subscribe(cb:(s:ControllerSnapshot)=>void): ()=>void }
export async function createGameController(deps:{coord:Coordinator; rng:Rng; now:()=>number; tzOffsetMin:number}): Promise<GameController>
```
- 关键语义：`answer` intent 内部 = answerCurrent + 若终局则 settleFight→recordRun→settleAndRecord（await flush 收口），全程 try/catch SaveReadOnlyError→置 readOnly 快照位；订阅者在快照变化时收到新对象（浅比较可辨）；`startFight` 返回 error 时快照停留 prepare 并带 `lastError:string`（新增字段，供分流文案——兑现 T2 deferred「非法 size 与空库同码 no-cards」：**同时把 startFight 错误码细化为 'no-cards'|'invalid-size'**，battleFlow 一行改动 + 其测试更新）。
- Phase 死类型处置（T2 deferred）：sessionTypes.Phase 若本任务仍零消费 → 删除该类型导出并在 PRD 决策日志无需动（ledger 记录）。

- [ ] Step 1: 失败测试——boot→load→menu 快照链；startFight(size 非法)→lastError='invalid-size'；answer 至 won → lastResult 有 exp/levelUp、save.settings.progress.exp 增加、leaderboard 长度 1、reminderDue 初始 true（从未导出）；skipPrologue 后 seenPrologue 持久（settings 新可选位 `story:{prologueSeen:boolean}` 三段式——types/saveMigrate 扩，缺省 false）
- [ ] Step 2: 确认失败 → Step 3: 实现 → Step 4: 通过 → Step 5: Commit `feat(app): game controller as the single session orchestrator`

### Task 4: Canvas 战斗舞台（渲染器 + resize 整数缩放）

**Files:**
- Create: `src/stage/layout.ts`、`src/stage/renderer.ts`、`src/stage/battleStage.ts`
- Test: `tests/stage/layout.test.ts`（几何纯函数）

**Interfaces:**
- Produces:
```ts
// layout.ts（纯函数，强测）
export const LOGICAL_W = 320; export const LOGICAL_H = 240
export function fitScale(viewW:number, viewH:number, maxInt?:number): number   // floor(min(viewW/320, viewH/240)) ≥1，钳 maxInt 默认 4
export function letterbox(viewW:number, viewH:number, scale:number): {x:number;y:number;w:number;h:number}
// renderer.ts
export interface StageSprites { hero:HTMLImageElement; mob:HTMLImageElement; boss:HTMLImageElement; bg:HTMLImageElement }
export function drawFrame(ctx:CanvasRenderingContext2D, st:BattleState, view:FightView, sprites:StageSprites, tMs:number): void  // tMs 入参驱动动画（闪烁/抖动），不读钟
// battleStage.ts
export function mountBattleStage(host:HTMLElement, deps:{sprites:StageSprites}): { frame(st:BattleState,view:FightView,tMs:number):void; destroy():void; onResize(w:number,h:number):void }
```
- 视觉规则：背景/侠客/怪物三层 drawImage（imageSmoothingEnabled=false）；怪物受击闪白=连续两帧 globalCompositeOperation 覆盖；miss 回合怪物不动；血条/HP 数字画在 Canvas（ASCII 数字安全）。
- [ ] Step 1: 失败测试（layout）：fitScale(640,480)=2、(1280,720)=3（floor(720/240)=3 vs 1280/320=4 取小）、(319,239)=1、maxInt 钳制；letterbox 居中偏移公式。
- [ ] Step 2: 红 → Step 3: 实现三文件（battleStage 内部只管 canvas 元素与 scale 应用，onResize 重算整数倍）→ Step 4: 绿（renderer 本体不强测，冒烟在 T6 用 stub ctx 断言 drawFrame 不抛且调用序列含三层 drawImage）
- [ ] Step 5: Commit `feat(stage): integer-scaled canvas battle stage with pure layout math`

### Task 5: DOM 组件库（shell + 战斗界面接线）

**Files:**
- Create: `src/ui/dom.ts`（h() 助手）、`src/ui/battleScreen.ts`、`src/ui/toast.ts`
- Test: `tests/ui/battleScreen.test.ts`（happy-dom）

**Interfaces:**
- Consumes: gameController.GameController/GameIntent；stage.battleStage。
- Produces: `mountBattleScreen(root:HTMLElement, ctrl:GameController, stage:Deps):{unmount():void}`；四档大按钮（again/hard/good/easy，中文「忘了/想起来了/对了/太简单」——功能白话）；卡面显示 front，作答后才显 back（自评流程）；**RF#3 防连点**：intent 发出→按钮 disabled 直到新快照到达；**RF#1 时序可视化**：反击数字飘字晚于玩家出卡。
- [ ] Step 1: 装 happy-dom（devDep），失败测试——mount 后存在 4 按钮；点击 good 恰发一次 intent 且按钮进入 disabled；新快照解除；miss 快照渲染「空转」提示；只读快照渲染横幅（横幅组件归 T8 接口位预留）。
- [ ] Step 2: 红 → Step 3: 实现 → Step 4: 绿 → Step 5: Commit `feat(ui): battle screen wiring with double-tap guard`

### Task 6: 序章演出 + 战报碎片

**Files:**
- Create: `src/ui/prologue.ts`、`src/ui/beats.ts`、`assets/narrative/prologue.json`（8 屏脚本照 LORE §5.1 verbatim）、`assets/narrative/beats.json`（30 条模板池）
- Test: `tests/ui/prologue.test.ts`、`tests/ui/beats.test.ts`

**Interfaces:**
- Produces: beats.ts：`nextBeat(pool:readonly string[], seenIdx:number):{text:string;next:number}`（抽完重置）；prologue.ts：`mountPrologue(root, scenes, onDone)` 逐屏点击推进、右上「跳过」。
- 内容验收：JSON 里旁白与 LORE §5.1 八句逐字一致；暗线前奏 3–4 条标记 `arc:true` 低频混入（beats 池权重实现）。
- [ ] Step 1: 失败测试（beats 重置/不重复直到抽完；prologue 8 屏顺序、跳过后 onDone 且 settings.story.prologueSeen=true 经 ctrl intent）
- [ ] Step 2: 红 → Step 3: 实现 + 静态插画占位（灰阶色块 PNG，T9 换正稿）→ Step 4: 绿 → Step 5: Commit `feat(ui): prologue staging and beat pool with reset-on-exhaust`

### Task 7: 菜单/备战/结算/卡组四屏

**Files:**
- Create: `src/ui/menu.ts`、`src/ui/prepare.ts`、`src/ui/result.ts`、`src/ui/decks.ts`
- Test: `tests/ui/prepare.test.ts`、`tests/ui/decks.test.ts`

**Interfaces:**
- menu：开始修炼/卡组/藏书阁/设置 四入口 + 本地榜 Top10（rankRuns 现成）+ 备份横幅位。
- prepare：领域多选 chips + size 三挡（10/15/25，映射 settings.battle.defaultPoolSize 为默认选中）+ 「随机」项；startFight intent；错误分流文案（invalid-size/no-cards 两支——兑现 T2 deferred）。
- result：胜负图标 + 经验/升级 + 战报碎片一条 + 「再来一场/回菜单」。
- decks：卡组列表（**RF#5：50 条分页挂载**，「加载更多」按钮）+ 手动加卡表单（front/back/deck 选择）+ 导入/导出按钮接 transfer。
- [ ] Step 1: 失败测试——prepare chips 多选状态进 intent.deckIds；decks 120 张卡首屏仅 ≤50 DOM 节点、加载更多 +50；导出按钮 click→transfer.exportAndMark 恰一次且成功 toast、失败 toast 且 text 仍可下载（FFW-p3-b 义务：ok:false 也不丢 text）
- [ ] Step 2: 红 → Step 3: 实现 → Step 4: 绿 → Step 5: Commit `feat(ui): menu, prepare, result and paginated deck screens`

### Task 8: Boss 卷灵战 + 净化 + 藏书阁 + 只读态 UI（D29）

**Files:**
- Create: `src/ui/codex.ts`、`src/app/bossFlow.ts`；Modify: `src/core/types.ts`+`src/core/saveMigrate.ts`（Deck.purifiedAt 已有；新增 `settings.story.beatIndex:number` 若 T6 未建则此处建——核对后择一）、`src/app/persist.ts`（readOnly 消费者接线）
- Test: `tests/app/bossFlow.test.ts`、`tests/ui/codex.test.ts`

**Interfaces:**
- bossFlow：`bossGate(cards:Card[], tier):{ready, count, threshold}`（deckBuild.bossCheck 复用）；达标领域在 prepare 屏显「卷灵现身」chip，点开 = startFight({deckIds:[d], size:min(池,25)}) + difficulty 'boss'（**注意**：battleFlow.startFight 现签名无 difficulty——本任务扩 `opts.difficulty?:'encounter'|'boss'`（默认 encounter），enemyHp 与 enemyPower 同源切换；T1/T2 不受影响因默认值）。
- 净化：won 且 kind==='boss' → mutate 写 `deck.purifiedAt=now`、exp 加成已在 victoryExp('boss')；首次触发自建领域 Boss 的称号询问弹窗（默认模板/{卡组名}·卷灵 + 自拟 ≤30 字输入框）写 deck.bossName。
- codex（藏书阁一级页）：条目=已净化领域（水墨卷轴风卡）、彩蛋占位（预置手写 4 条进 assets/narrative/eggs.json；自建领域 MVP 期显示「已净化」——LLM 生成留 Plan 5 依赖 Key 故降级，申报偏离 PRD §9 之「MVP 即 LLM」：**裁决 R-P4-a：LLM 全线移出 Plan 4，集中 Plan 5**，理由：Key 配置 UI 与网络面属上线阶段，先立玩法闭环）、练习关入口（重战）、行记区（历史 beats 与三幕里程碑：净化 3/6/9 检查点，暗线文案 arcBeats 三条各配一屏插画）。
- 只读态（D29）：App 根挂横幅组件（toast.ts 的 banner 变体）+「导出原始存档」按钮（读 store.load 原文?——坏档不回写机制下 load 结果已被 validate 拒；导出出口需在 coordinator 增 `rawDump():Promise<string|null>`（persist.ts 一处新增，直读 store 原始 JSON 字符串化）+ 用例）+ 所有 intent 的 SaveReadOnlyError catch 汇入 toast。
- [ ] Step 1: 失败测试——bossGate 阈值边界；boss chip→startFight difficulty 透传；won→purifiedAt 写入且 flush 收口；称号弹窗默认/自拟两路；codex 条目排序=净化时间新者前；3/6/9 里程碑各触发一次且不重复；readOnly：rawDump 返回原文、横幅在场、任意 intent 不抛未捕获
- [ ] Step 2: 红 → Step 3: 实现 → Step 4: 绿 → Step 5: Commit `feat(app): boss purging, library codex and read-only UI (D29)`

### Task 9: 像素素材正式化（pixel-art-studio 管线）

**Files:**
- Create: `assets/sprites/*.png`（hero/mob×4/boss×4/bg/prologue×8 占位替换）、`assets/README.md`（规格表）、`scripts/gen-sprites.mjs`（Pillow 脚本入库）
- Test: `tests/assets/assets.contract.test.ts`

**Interfaces:**
- 契约测试：每个 PNG 存在、尺寸 ∈ {16,32,64}²、调色板 ≤32 色（PNG 解析计数）、Boss 64×64、hero 32×32；index.html 引用路径有效。
- [ ] Step 1: 写契约测试（红：占位素材超色板/缺文件）
- [ ] Step 2: 用 pixel-art-studio skill 按《像素美术规范》逐张产出（水墨底色+怪物霓虹双色分区），gen-sprites.mjs 固化生成过程
- [ ] Step 3: 契约绿 → Step 4: 人工目检截图（present 给用户）→ Commit `feat(assets): ink-wash sprite set per art spec (pixel-art-studio)`

### Task 10: 端到端可玩冒烟 + README 进度更新

**Files:**
- Modify: `tests/app/fullSession.smoke.test.ts`（或新建 `tests/e2e/playable.smoke.test.ts`）、`README.md`
- Test: 本体

- [ ] Step 1: 新冒烟——冷启动→序章 8 屏→首战（生活常识引导域）→ 30 张导入→五场遭遇战（含一次 bossGate 达标→卷灵战→净化→codex 条目出现→彩蛋）→备份导出/导入 roundtrip→只读态演练（人为塞 schemaVersion:2 重建 controller 断言横幅与 rawDump）→提醒闸门翻转链 true→false→true。全程 fake timers。
- [ ] Step 2: 修接缝 bug（发现即修，报告列明）
- [ ] Step 3: README 进度表更新（Plan 4 完成、DoD2/DoD4 证据指向冒烟用例名）
- [ ] Step 4: verify 全绿 → Commit `test(e2e): playable smoke covering boss flow and read-only drill`

---

## Self-Review 结论（已执行）

1. **Spec coverage：** PRD §2.1 def/maxHp 消费→T1/T2；§2.4 Boss→T8；§3 备战→T7；§8 MVP 6 叙事全套→T6（序章/战报）+T8（暗线里程碑/图鉴/假记忆素材在 Plan3 已有、T5 接线渲染）；§7 素材规格→T9；D29→T8；LORE §5.1 八屏→T6 verbatim。**已知缺口申报：**假记忆战败演出的画面闪现组件——T5 的 result 屏承接（lost 时展示 FakeCard 红黑卡面 + 打叉揭示），素材源用 Plan 3 fakeMemory，接线在 T5 Step 3 内一并做（并入 reason 说明，不单开任务避免碎片化）。LLM 三职能（辅建卡/称号建议/彩蛋）整体移 Plan 5（R-P4-a），PRD §8 的 MVP 第 7 项相应顺延——**需用户知悉**。
2. **Step scan：** 每步单一动作；T2 Step 3、T9 Step 2 设了停等闸口。
3. **Type consistency：** FightView/BattleState/GameIntent/ControllerSnapshot 跨 T3–T8 同名同形；difficulty 扩展只在 startFight opts（T8），enemyPowerFor 归 stats（T1 裁决）。
4. **Review Focus：** 五条归属 T1/T4/T5/T8/T7。
5. **Proportion：** 10 任务对应 PRD §2/§8/§9/§7 的画面化论证，代码块仅签名级。
