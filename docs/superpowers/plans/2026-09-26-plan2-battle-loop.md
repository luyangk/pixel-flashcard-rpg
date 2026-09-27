# 知识侠客 · Plan 2/5：SRS 调度与战斗循环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通"备战选卡 → 系统依序出卡 → 作答判定 → 伤害结算 → 胜负 → 经验升级 → Boss 触发/净化"的完整可玩核心循环（纯逻辑层 + headless 模拟验收），并落实 Plan 1 终审遗留的三个契约闭环。

**Architecture:** 全部新代码仍是 `src/core/**` 纯函数/纯状态机（零 DOM、时间入参化）；复习流程收口为单一入口 `applyReview()`（兑现 R-T4-d 端到端契约）；战斗是确定性状态机，随机性经注入式 RNG 隔离，headless 模拟器做数值曲线验证。UI/Canvas 渲染属 Plan 3+，本计划不触碰画面。

**Tech Stack:** 沿用 Plan 1（TypeScript strict / Vitest / npm run verify 门禁）。无新依赖。

**Spec:** `docs/PRD.md` v2.1 —— §2（玩法）、§3（备战）、§6.3–6.5（算法与数值基线，含 D27）、§8（MVP 1–4）。世界观口径 `docs/LORE.md` §2/§4。

## Global Constraints

- `src/core/**` 禁 DOM/Node API、禁 `Date.now()`——时间一律毫秒入参（purity 守卫执法，黑名单见 scripts/check-core-purity.mjs）。
- ΔEF 门控（D27）：q≥5 上调 EF、q=3 保持 EF 不变、q<3 按原公式下调；clamp 下界 minEase。
- 难度系数 verbatim：遭遇战 `0.7`、Boss `1.5`；`expToNext(L) = ceil(100 × L^1.3)`；基础属性 攻10 防5 血100，每级 力+2 体+2 血+10；体力/精神除数 10/8；单卡浮动 `uniform(0.9, 1.1)`；damageMultiplier 四档 0.1/0.5/1.0/1.5（Plan 1 已交付，不改值）。
- 一切随机经 `Rng = () => number`（[0,1)）注入，生产用 mulberry32 种子发生器包装 `Math.random`；core 内禁止直接调用 `Math.random`。
- 有效复习唯一写入口径（R-T4-c）：任何模块不得自行 append `effectiveReviewDays`；只允许 `reviewLedger.recordEffectiveReview` 写入。
- 存档向后兼容：`Settings` 新增字段必须带默认值合并（旧档缺字段可导入）；`schemaVersion` 仍为 1。
- DRY/YAGNI/TDD，每任务 commit（feat:/fix:/test:/chore: 前缀）；npm run verify 全绿才可提交。

## Review Focus

规格隐含但单任务测试未必覆盖、最可能咬人的输入/失效面（每条钉到归属任务的测试）：

1. **复习漏账**：走完整复习流程但没调 `recordEffectiveReview` → 账本永空、Boss 永不现身（静默失败）。→ Task 3 端到端断言"一次 applyReview → count 恰 +1"。
2. **同秒双答**：同一张卡在同一毫秒被结算两次（连点）→ SRS 更新两次但日历日只计一次；伤害却算了两次。→ Task 4 战斗状态机对"同一 cardId 在队列中出现两次"整局拒绝。
3. **空/超短卡池**：备战结果为 0 张或 1 张时 HP 反推公式不得除零或产出必胜/必死局。→ Task 5 `enemyHpForPool` 边界用例。
4. **旧档升级导入**：v2.1 之前的存档（无 settings.battle 字段）导入后必须能补默认值正常开局。→ Task 8 migrateSave 用例。
5. **数值漂移**：难度改动引入回归——性质 A「全对必胜」必须锁死；miss-40% 失败率以实测曲线为回归基线（规格事实：当前常数下余量大，见 Task 7 说明；B 的断言口径由 controller 裁决后落定）。→ Task 7。

---

### Task 1: SM-2 ΔEF 门控修正（D27）

**Files:**
- Modify: `src/core/sm2.ts`（ease 更新处）
- Test: `tests/core/sm2.test.ts`（改锚点 + 新用例）

**Interfaces:**
- Consumes: `review(srs, grade, nowMs, p)`、`Sm2Params`（现签名不变）
- Produces: 语义变更后的 `review`——`GRADES.good(3)`：ease 严格不变；`easy(5)`：ΔEF = +0.1（即 q=5 代入原 delta 公式的值，独立常数 `EASE_BONUS = 0.1`）；`again/hard`：原公式下调。briefNext 同构器同步。

- [ ] **Step 1: 改写失败锚点**——good-only 链 ease 恒定 2.5、interval 1→6→15→29（round(15×… wait：reps=4 = round(15×2.5)=38——以 briefNext('old') 同构复算为准写期望，锚点断言 `s.ease === 2.5` 三连 good 后不变）；hard 后 ease 下降且 <2.5；easy 后 ease = 2.5+0.1。
- [ ] **Step 2: 跑测试确认失败**（当前实现在 good 下 −0.14）
- [ ] **Step 3: 实现门控**：`if (grade >= GRADES.easy) ease += EASE_BONUS; else if (grade <= GRADES.hard) ease += delta(q); /* good: unchanged */` 再 clamp(minEase)。注意 hard=2、good=3、easy=5 的档位序，用显式比较而非符号假设。
- [ ] **Step 4: 跑测试通过 + 全量回归**（dueQueue/damageMultiplier/域外输入用例不应动）
- [ ] **Step 5: Commit** `fix(sm2): gate EF updates per Wozniak semantics (D27)`

### Task 2: 确定性 RNG 工具

**Files:**
- Create: `src/core/rng.ts`
- Test: `tests/core/rng.test.ts`

**Interfaces:**
- Produces: `export type Rng = () => number;`、`export function mulberry32(seed: number): Rng`、`export function uniform(rng: Rng, lo: number, hi: number): number`、`export function pickWeighted<T>(rng: Rng, items: readonly T[], weightOf: (t: T) => number): T | null`（权重和 ≤0 或空数组返回 null，不抛）。
- Consumes: 无。

- [ ] **Step 1: 失败测试**——同 seed 序列可复现；mulberry32 输出 ∈[0,1)；uniform(0.9,1.1) 落界内；pickWeighted 空/null 权重表返回 null；分布冒烟（1000 次加权 3:1 比例粗断 ±15%）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(core): injectable deterministic rng`

### Task 3: 复习流程单一入口（R-T4-d 契约兑现）

**Files:**
- Create: `src/core/reviewFlow.ts`
- Test: `tests/core/reviewFlow.test.ts`

**Interfaces:**
- Consumes: `review`（sm2）、`recordEffectiveReview`（reviewLedger）、`Grade`
- Produces: `export interface ReviewOutcome { card: Card; graded: Grade; answeredAt: number }`、`export function applyReview(card: Card, grade: Grade, nowMs: number, tzOffsetMin: number, params: Sm2Params): ReviewOutcome` —— 内部先 `review()` 再对结果 `recordEffectiveReview()`，顺序固定；返回的 card 同时携带新 SRS 与新账本。

- [ ] **Step 1: 失败测试**——RF#1：`applyReview` 后 `domainReviewCount([out.card]) === 1`（初始空账本）、同日第二次 `=== 1`、次日第三次…各形态；不可变性（入参 card 引用不变）；账本键与 `localDayString(nowMs, tzOffset)` 一致。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（两行编排 + 注释声明"唯一合法复习入口，UI/战斗层必须经此"）→ **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(core): applyReview single entry closes ledger contract`

### Task 4: 战斗状态机（回合制纯函数）

**Files:**
- Create: `src/core/battle.ts`
- Test: `tests/core/battle.test.ts`

**Interfaces:**
- Consumes: `Card`、`applyReview` 的下游消费者角色（战斗结算产出的复习事件列表由上层转交 applyReview——battle 本身不调它，保持纯）、`damageMultiplier`（sm2）、`Rng/uniform`（rng）
- Produces:
```ts
export type BattlePhase = 'ready' | 'answering' | 'won' | 'lost';
export interface BattleState { readonly phase: BattlePhase; readonly pool: readonly string[]; readonly idx: number; readonly enemyHp: number; readonly playerHp: number; readonly maxPlayerHp: number; readonly log: readonly BattleEvent[]; }
export interface BattleEvent { readonly kind: 'damage'|'miss'|'end'; readonly cardId?: string; readonly amount?: number }
export function createBattle(poolCards: readonly Card[], enemyHp: number, playerStats: PlayerStats, rng: Rng): BattleState   // 重复 cardId → throw Error('duplicate-card'); 空池 → throw Error('empty-pool')
export function answer(state: BattleState, card: Card, grade: Grade, rng: Rng): BattleState   // 非 answering 态幂等返回自身
```
- 规则 verbatim：answer 时 grade ≥ GRADES.good → damage = attack × damageMultiplier(card.srs.stability) × uniform(rng,0.9,1.1)，enemyHp -= round(damage)，事件 damage；grade < good → miss 事件、零伤害、敌人不反击（答错仅空转）；idx 恒 +1；idx === pool.length 时：enemyHp ≤ 0 → won，否则 lost；enemyHp 先归零 → 立即 won（剩余卡作废，log 记 end）。玩家掉血路径本版不存在但保留 playerHp 字段（假记忆演出与后续机制预留）。

- [ ] **Step 1: 失败测试**——RF#2 重复 cardId 拒绝；空池拒绝；全 good 池（attack=10、倍率 review=1.0、rng≡0.5→浮动1.0、HP=池数×7）恰好 won；一 miss → lost；miss 不产生负向事件之外的状态变化；won 后 answer 幂等；idx 单调；log 追加序正确；stability=new 的卡伤害 0.1×atk 取整可为 0（记录 damage 事件 amount=0 仍算命中）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(core): deterministic turn-based battle state machine`

### Task 5: 属性体系与敌人 HP 反推（PRD §6.5）

**Files:**
- Create: `src/core/stats.ts`
- Test: `tests/core/stats.test.ts`

**Interfaces:**
- Produces:
```ts
export interface PlayerStats { level: number; vit: number; spi: number; atk: number; def: number; maxHp: number }
export function deriveStats(level: number, masteredCount: number, spiritCount: number): PlayerStats
// vit=vitCount? no: vit=masteredCount(已入脑卡数), spi=spiritCount(合格自建卡数)
// atk = 10 + level*2 + floor(spiritCount/8); def = 5 + level*2 + floor(vitCount/10); maxHp = 100 + (level-1)*10
export const DIFFICULTY = { encounter: 0.7, boss: 1.5 } as const;
export const BASE_CARD_DAMAGE = 10;   // verbatim §6.5 基准单卡伤害
export function enemyHpForPool(poolSize: number, difficulty: keyof typeof DIFFICULTY): number  // ceil(poolSize × BASE_CARD_DAMAGE × DIFFICULTY[d])
export function expToNext(level: number): number            // ceil(100 × level^1.3)
export function victoryExp(poolCards: readonly Card[], difficulty: keyof typeof DIFFICULTY): number  // round(30 × DIFFICULTY[d] + 5 × mastered释放数)
export function applyExp(level: number, exp: number): { level: number; exp: number }  // 连续升级消费余数
```
- [ ] **Step 1: 失败测试**——RF#3：poolSize 0 → throw、1 → ceil(10×0.7)=7；deriveStats 三档手算样本（L1/0/0 → atk10 def5 hp100；L5/250/80 → atk=10+10+10=30 def=5+10+25=40 hp140）；expToNext(1)=100、(2)=ceil(100×2.4622…)=247；applyExp 跨两级；victoryExp mastered 计数只算池内。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(core): stat derivation and pool-derived enemy hp (§6.5)`

### Task 6: 备战卡池生成（80/20 + 主题筛选 + Boss 达标检查）

**Files:**
- Create: `src/core/deckBuild.ts`
- Test: `tests/core/deckBuild.test.ts`

**Interfaces:**
- Consumes: `dueQueue`（sm2）、`bossReady/domainReviewCount`（reviewLedger）、`Rng/pickWeighted`
- Produces:
```ts
export interface PoolOptions { size: number; deckIds?: readonly string[]; rng: Rng }
export function buildPool(cards: readonly Card[], opts: PoolOptions): Card[]
// 智能段(80%,至少1)：dueQueue 过滤(可选 deckIds 限定)按紧迫度取；不足则放宽至未到期卡(仍限 deckIds)；自选段(20%)：rng 从剩余池加权抽(权重=1，留接口)
// 总可用 < size 时返回全部可用并按实际长度；0 可用返回 []
export function bossCheck(deckCards: readonly Card[], tier: 15|30|50): { ready: boolean; count: number; threshold: number }
```
- [ ] **Step 1: 失败测试**——80/20 分割取整（size=15 → 12+3；size=1 → 1+0）；deckIds 多选过滤生效；到期不足降级路径；全空返回 []；bossCheck 三态（差 1 未达/恰达/已过）与计数透传；同 seed 两次 buildPool 结果全等（可复现）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(core): 80/20 smart pool builder with theme filter + boss check`

### Task 7: 数值平衡 headless 模拟器

**Files:**
- Create: `tests/sim/balance.sim.test.ts`（测试即产物，不建 src 导出面）
- Test: 本体即测试

**Interfaces:**
- Consumes: buildPool/deriveStats/enemyHpForPool/createBattle/damageMultiplier 全链
- Produces: RF#5 两条锁死性质 + 报告数字。

- [ ] **Step 1: 写模拟测试**——构造 200 张合成卡组（stability 分布 new20%/learning20%/review40%/mastered20%，ease/interval 合理填充）：
  - 性质 A「全对必胜」：seed 遍历 50 个，buildPool(size15) → enemyHpForPool(encounter) → createBattle 全 good 作答 → 断言 50/50 won；
  - 性质 B「错 40% 必败」：**miss 率必须参数化扫描 {0.3, 0.4}，取最小失败率为判据**。注意实测事实：本曲线余量大（L1 atk=12、全 review 池总输出 ≈180 vs HP 105），miss 0.4 时期望伤害仍 ≈108 > 105——**B 大概率跑出"未败"**。这不是实现 bug，是 §6.5 常数决定的规格属性；
  - 打印中位胜率随错误率曲线（0/10/20/30/40%）与 B 的最小失败率进报告；
- [ ] **Step 2: 跑红即停**——若 B 在 miss≤0.4 区间存在未败 seed：**不得私调常数**（BASE_CARD_DAMAGE/难度系数/浮动区间都是 spec 值），回报 controller 附实测曲线，等裁决（预期裁决方向：把 B 的性质表述改为"锁死 A + 记录 B 实测值作为回归基线"，或调低系数走 PRD 修订）。
- [ ] **Step 3: A 绿 + B 按裁决口径落定后 commit**
- [ ] **Step 4: Commit** `test(sim): lock win property and record miss-rate curve`

### Task 8: Settings 扩展 + 旧档迁移（RF#4）

**Files:**
- Modify: `src/core/types.ts`（Settings 增 `battle: { defaultPoolSize: number }`，默认 15；范围 10–25）
- Modify: `src/core/saveMigrate.ts`（validateSave 接受缺 battle 字段的 v1 档 → normalizeSave 补默认；设置校验扩 battle 域）
- Test: `tests/core/saveMigrate.test.ts` 扩、`tests/core/types.smoke.test.ts` 扩

**Interfaces:**
- Produces: `export function migrateSave(raw: unknown): SaveFile`（validate 通过后补默认字段；对已是新档幂等）。
- [ ] **Step 1: 失败测试**——旧形状档（无 battle）validate 拒 → migrateSave 注入 `{battle:{defaultPoolSize:15}}` 后再 validate 过；新档 migrate 幂等；battle.defaultPoolSize=99 被 validate 拒（reason 带路径）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit** `feat(save): settings.battle field with v1 migration`

### Task 9: 本地战绩榜（PRD §5 首版本地榜）

**Files:**
- Create: `src/core/leaderboard.ts`
- Test: `tests/core/leaderboard.test.ts`

**Interfaces:**
- Consumes: `SaveFile.meta.plays`、BattleState、PlayerStats
- Produces:
```ts
export interface RunRecord { id: string; at: number; result: 'won'|'lost'; kind: 'encounter'|'boss'; domain: string; cards: number; misses: number; level: number; score: number }
export function scoreRun(r: Omit<RunRecord,'score'|'id'>): number   // won? (cards-misses)*10 + level*5 + (kind==='boss'?50:0) : 0；下限 0
export function rankRuns(records: readonly RunRecord[], limit?: number): RunRecord[]  // score 降序，同分 at 新者前；limit 默认 20
```
- [ ] **Step 1: 失败测试**——计分手算三例；排序稳定性；空表；limit 截断。
- [ ] **Step 2–4** 常规 → **Step 5: Commit** `feat(core): local run leaderboard scoring`

---

## Self-Review 结论（已执行）

1. **Spec coverage：** PRD §2.1→T5；§2.2→T4；§2.3→T4(miss 规则)；§2.4 Boss→T6(bossCheck)+T9(kind:'boss')；§3 备战→T6；§6.3 D27→T1；§6.5→T5；§8-MVP1→T4+T6；本地榜→T9；终审遗留三契约→T1(ΔEF)/T3(recordEffective)/T8(信封字段以 battle 默认值方式起步，备份时刻信封仍留 UI 层)。渲染、图鉴页、叙事不在本计划（Plan 3）。
2. **Step scan：** 各步单一动作；T7 Step 3 显式设"停下回报而非私调常数"闸口。
3. **Type consistency：** `Rng`/`Grade`/`PlayerStats`/`DIFFICULTY` 定义与消费方逐字对齐；`createBattle` 的 pool 用 cardId 串数组、answer 收 Card——两处类型不同名有意为之（state 持身份、事件持数据）。
4. **Review Focus：** 五条各有归属（T3/T4/T5/T8/T7）。
5. **Proportion：** 9 任务 ≈ spec §2+§6.5 的实现论证，代码块仅签名与常数表。
