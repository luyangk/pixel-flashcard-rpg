# 知识侠客 · Plan 6：作答模式（选择题 / 问答 / 看答案）实施计划

> **For agentic workers:** 由本会话按 executing-plans 逐任务实现（checkbox 追踪）；最后统一终审。

**Goal:** 把"点一下我觉得记住了"换成**有验证的作答**：默认出**选择题**（答对=记住了、答错=记错了，答对后可用「其实是猜的」改判），可切**问答模式**（玩家写自己的理解，玩家自带的 LLM 判定并指出缺了哪些要点），随时可退到**直接看答案**（记为答错）。三者都遵守同一条铁律 —— **作答之后先展开完整答案，再由玩家点「继续」放行**。

**Architecture:** 沿用四层纪律，**core 引擎（`battle.ts` / `sm2.ts` / `GRADES`）一行不改**：
- `src/core/choices.ts`（纯逻辑）：选项三级来源（**卡上自带 `choices`** → 同领域其他卡背面/自带选项 → 少给选项或回落）+ 选项标签的截断与去重（注入 rng，零 DOM / 零时钟 / 零网络）。
- `src/core/llmParse`：`parseVerdict`（对/错 + 理由 + 缺失要点）+ `parseCards` 接受并严检 `choices`。
- `src/app/llmFlow`：判卷提示词与 `judgeAnswer`；卡片生成提示词顺手要 `choices`（**生成卡那一刻产出干扰项，复习时不再临时调模型** —— D41）。
- `src/app/quota`：两本账（卡数 200/天、判定 300/天）。
- `src/ui/battleScreen`：作答区从"看答案 → 四档自评"改成"选项/输入 → **判定面板（完整答案）** → 继续"，UI **只发 `good` / `again`**。

**Spec:** `docs/PRD.md` §3.1（作答模式）、§4.4（D42 的例外）、§6.2（`answerMode` / `Card.choices`）、§6.6（两本账）、§9（战斗屏作答区、设置页）、§11 D41/D42/D45。

## Global Constraints

- **答案必须展开**：任何一次作答（选中选项 / 提交问答 / 点「直接看答案」/ 判卷失败后自评）都必须先在屏上显示**完整答案**，再由玩家点「继续」放行。**绝不替玩家猜**。
- **UI 只发两档**：`good`（答对）与 `again`（答错 / 看答案 / 判错 / 「其实是猜的」改判）。`easy`/`hard` 在 UI 上不可达 —— 这是 D41 登记过的代价，不要"顺手"把四档按钮加回来。
- **干扰项只在生成卡时调模型**：复习路径**不得**发起任何 LLM 请求来造选项（省额度；也是这个功能的性能前提）。
- **数据最小化只破一个口**：问答模式会把「卡正面 + 答案 + 玩家输入」发给玩家自己的服务商（D42），**只在问答模式、只在点提交那一刻**；辅建卡 / 称号 / 彩蛋三条路径的发送范围一字不改，设置页必须写明例外。
- **不可信输出**：判卷与卡片都走 core 严格解析（布尔 `match`、`missing` ≤5×≤60 码点、`choices` ≤5×≤200 码点、控制字符剥离）；失败即失败，不做字符串嗅探。
- 分层守卫全绿；门禁五段全绿才 commit：`typecheck → check:purity → test → build:only → smoke:dist`。

## Review Focus

1. **答案会不会"没看到就过去了"**：答对、答错、判卷失败、判定到顶、退出本局重进 —— 每条路上答案都要真的留在屏上（→ 任务 6/7）。
2. **选项凑不出来 / 分不清**：领域只有一张卡、`choices` 与背面重复、多个选项截断后文本相同、干扰项全被去重掉（→ 任务 1/6）。
3. **判定失败的各种形状**：无 Key、401/429、超时 30s、非 JSON、`match` 是字符串、`missing` 超长带控制字符、`missing` 不是数组（→ 任务 2/3/7）。
4. **额度到顶与只读态**：判定 300 次用尽要**回落自评而不是锁住复习**；只读态下切模式会写失败，不能假装切成（→ 任务 4/7/8）。
5. **旧用例的语义漂移**：`tests/ui/battleScreen.test.ts` 现有断言建立在"看答案→四档"上，改造后必须逐条**重述**为"作答→判定面板→继续"，而不是删掉（→ 任务 6）。

---

### Task 1: `core/choices` —— 选项三级来源 + 标签截断去重（纯逻辑）

**Files:** Create `src/core/choices.ts`；Test `tests/core/choices.test.ts`

**Interfaces:**
```ts
export const CHOICE_COUNT_DEFAULT = 4;   // 含正确项
export const CHOICE_COUNT_MIN = 2;
export const CHOICE_LABEL_MAX = 40;      // 屏上预览长度（码点）
export interface ChoiceSet {
  readonly options: readonly string[];   // 已洗牌；options[correctIndex] === answer
  readonly labels: readonly string[];    // 与 options 一一对应：截断后的**互不相同**的预览
  readonly correctIndex: number;
}
export function buildChoices(input: {
  readonly answer: string;
  readonly stored?: readonly string[];   // 卡上自带的 choices（模型在生成卡时产出）
  readonly pool?: readonly string[];     // 同领域其他卡的背面 + 它们的 choices
  readonly count?: number;
  readonly rng: Rng;
}): ChoiceSet | null;
export function previewLabel(text: string, max?: number): string;   // 码点安全截断 + 省略号
```
**口径：** `answer` trim 后为空 ⇒ `null`。干扰项 = `stored` 优先、不足再用 `pool` 补；逐项 trim、剔空、**与 answer 逐字相同者剔除**、相互去重（去重按 trim 后的原文）；用注入 rng 洗牌后取 `count-1` 个；一个都凑不出 ⇒ `null`；最终选项数 `1 + 实际干扰项数`。`labels` 由 `options` 逐项 `previewLabel` 得到。**撞车规则（实现时修正）**：截断预览与已有选项相同的干扰项，在**挑选阶段就剔除**（`seenLabel` 去重，正确答案的标签先占位）—— 宁可少一个选项，也不显示两个"看起来一模一样"的选项；"加长到能区分"会把预览拉到 60+ 字，正好抵消截断的初衷。因此所有候选都与答案撞车时 ⇒ `null`（回落看答案）。`previewLabel` 只在超出时追加 `'…'`，按码点截断（不切坏代理对）。
- [ ] Step 1 失败测试：CHO#1 四选项且 `options[correctIndex] === answer`；CHO#2 `stored` 优先于 `pool`（同一 rng 下对比两条来源）；CHO#3 `stored` 只有 1 条 ⇒ 用 `pool` 补到 4；CHO#4 空/空白 answer ⇒ null；CHO#5 干扰项全与答案相同 ⇒ null；CHO#6 洗牌用注入 rng（同种子同顺序；两种子至少一次不同）；CHO#7 `count` 越界（1/7/2.5）⇒ 回落 4；CHO#8 截断撞车 ⇒ 撞车干扰项被剔除（构造两个前 40 字相同的 60 字选项：只有一条候选时 `null`；另有可区分候选时选项数少一个且 `labels` 仍 ≤40 且互不相同）；CHO#8c 全部候选撞车 ⇒ `null`；CHO#9 代理对边界（emoji 在截断点）⇒ 不出现半个代理对
- [ ] Step 2 跑 `node node_modules/vitest/vitest.mjs run tests/core/choices.test.ts`，确认红
- [ ] Step 3 实现（Fisher–Yates + 标签加长循环；永不抛）
- [ ] Step 4 复跑绿；`node node_modules/typescript/bin/tsc --noEmit` 干净
- [ ] Step 5 Commit `feat(core): 选择题生成（三级来源 + 标签截断去重）`

### Task 2: `core/llmParse` —— 判卷解析 + 卡片带选项

**Files:** Modify `src/core/llmParse.ts`；Test `tests/core/llmParse.test.ts`（追加两组）

**Interfaces:**
```ts
export interface Verdict { readonly match: boolean; readonly reason: string; readonly missing: readonly string[] }
export function parseVerdict(text: string): { ok: true; value: Verdict } | { ok: false; reason: string };
export interface CardCandidate { readonly front: string; readonly back: string; readonly tags: readonly string[]; readonly choices: readonly string[] }
export const CHOICES_MAX = 5;
export const CHOICE_TEXT_MAX = 200;
```
**口径：** `parseVerdict` 复用 `extractJson` + `sanitizeExternalText`：`match` **必须是布尔**（`"true"`/`1`/缺失 ⇒ 拒）；`reason` 字符串（缺失补 `''`、≤120 码点）；`missing` **必须是数组**（缺失 ⇒ `[]`），逐项字符串、剔空、去重、≤5 条、每条 ≤60 码点、剥控制字符；非 JSON/结构不符 ⇒ `{ok:false, reason:'没能读懂模型的判定结果。'}`；**永不抛**。
`parseCards` 追加 `choices`：缺失/非数组 ⇒ `[]`；逐项字符串、剔空、去重、**剔除与 `back` 逐字相同者**、≤`CHOICES_MAX` 条、每条 ≤`CHOICE_TEXT_MAX` 码点。既有字段行为一字不改（旧调用方拿到 `choices: []`）。
- [ ] Step 1 追加失败测试：LP#11 标准判定；LP#12 `match:"true"` ⇒ 拒；LP#13 缺 `match` ⇒ 拒；LP#14 `missing:['a',null,'a','','b']` ⇒ 只留 `['a','b']`；LP#15 `missing` 是字符串 ⇒ `[]`（不拒）；LP#16 `missing` 10 条 / 每条 200 码点 ⇒ 截到 5×≤60；LP#17 判定的 `reason` 带 U+202E ⇒ 被剥；LP#18 `parseCards` 收到 `choices` 正常项 ⇒ 保留；LP#19 `choices` 含与 `back` 相同项 / 空串 / 非字符串 ⇒ 逐项剔除；LP#20 `choices` 20 条 ⇒ 截到 5；LP#21 旧形状（无 `choices`）⇒ `choices: []` 且其余字段不变
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(core): parseVerdict（含缺失要点）与卡片 choices 严检`

### Task 3: `app/llmFlow` —— 判卷提示词 + `judgeAnswer` + 生成卡时产出选项

**Files:** Modify `src/app/llmFlow.ts`；Test `tests/app/llmFlow.test.ts`（追加一组）

**Interfaces:**
```ts
export const REPLY_MAX = 500;
export function buildJudgePrompt(input: { front: string; answer: string; reply: string }): readonly ChatMessage[];
export async function judgeAnswer(deps: LlmDeps, input: { front: string; answer: string; reply: string }):
  Promise<{ ok: true; match: boolean; reason: string; missing: readonly string[] } | { ok: false; reason: string }>;
```
**口径：** 判卷 system 提示词要求**只回** `{"match":true|false,"reason":"≤60字","missing":["缺的要点", …]}`，并写明判据（同义/换词/更口语算**对**；漏掉答案里的关键点写进 `missing`；答非所问或空答算错）；三段材料各自经 `wrapUntrusted('卡面'|'参考答案'|'玩家作答', …)`；`reply` 按码点截 `REPLY_MAX`；`chat` 抛错或 `parseVerdict` 失败 ⇒ `{ok:false, reason}`。
`buildCardPrompt` 的 system 追加一句：每条候选额外给 `choices`（**3 个"看起来像答案但不对"的干扰项**，不得与 `back` 相同）；既有 JSON 形状说明同步更新。**不改** `suggestCards` 的返回类型（`CardCandidate` 在 Task 2 已带 `choices`）。
- [ ] Step 1 追加失败测试：LF#12 判卷提示词含三段定界且答案确实在 prompt 里（D42 的例外必须真的发生）；LF#13 `reply` 超长 ⇒ 按码点截断；LF#14 `chat` 回标准 JSON ⇒ `match/reason/missing` 三样都对；LF#15 `chat` 回 `match:"true"` ⇒ `{ok:false}`；LF#16 `chat` 抛错 ⇒ `{ok:false}` 且 reason 直接可用；LF#17 `buildCardPrompt` 的 system 里出现 `choices` 且候选解析后 `choices` 非空
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(app): 判卷提示词与 judgeAnswer；生成卡时一并产出干扰项`

### Task 4: `app/quota` —— 两本账（卡数 200/天、判定 300/天）

**Files:** Create `src/app/quota.ts`；Test `tests/app/quota.test.ts`

**Interfaces:**
```ts
export const DAILY_CARD_CAP = 200;
export const PER_REQUEST_CARD_CAP = 20;
export const DAILY_JUDGE_CAP = 300;
export function normalizeQuota(q: LlmQuota | undefined, nowMs: number, tzOffsetMin: number): LlmQuota;
export function remainingCards(q: LlmQuota | undefined, nowMs: number, tzOffsetMin: number): number;
export function remainingJudges(q: LlmQuota | undefined, nowMs: number, tzOffsetMin: number): number;
export function planCharge(q: LlmQuota | undefined, want: number, nowMs: number, tzOffsetMin: number):
  { readonly quota: LlmQuota; readonly granted: number; readonly refused: number };
export function planJudge(q: LlmQuota | undefined, nowMs: number, tzOffsetMin: number):
  { readonly quota: LlmQuota; readonly allowed: boolean };
```
**口径：** 日界 = `core/reviewLedger.localDayString(nowMs, tzOffsetMin)`；`day` 不同 ⇒ 两本账都归零；`want` 非有限/负 ⇒ 0，超 `PER_REQUEST_CARD_CAP` 先夹到 20；`granted = min(want, 剩余)`；`planJudge` 在剩余 >0 时 `judges+1` 并 `allowed:true`，否则 `allowed:false` 且**不改账**。脏值（负/小数/NaN/`day:''`）按 0 与今天处理。**不读时钟**。
- [ ] Step 1 失败测试：Q#1 空额度 ⇒ 剩 200 / 剩 300；Q#2 同日 `cards:200` ⇒ 剩 0 且全拒；Q#3 剩 3 而要 20 ⇒ granted 3 / refused 17；Q#4 `want:50` ⇒ 夹 20；Q#5 跨天 ⇒ 两本账都归零；Q#6 脏值消毒（含 `day:''`、`cards:-5`、`judges:1.5`、NaN）；Q#7 `planJudge` 第 300 次 `allowed:true`、第 301 次 `allowed:false` 且账不变；Q#8 纯函数（同入参同结果，不改入参对象）；Q#9 两个时区对同一时刻的日界不同
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(app): 额度两本账（卡 200/天、判定 300/天）`

### Task 5: 存档三段式扩位（`answerMode` / `llmQuota` / `Card.choices`）+ 写口

**Files:** Modify `src/core/types.ts`、`src/core/saveMigrate.ts`、`src/app/persist.ts`（`DEFAULT_SETTINGS` 与种子档）、`src/app/settingsFlow.ts`、`src/app/library.ts`；Test `tests/core/saveMigrate.test.ts`、`tests/app/settingsFlow.test.ts`、`tests/app/library.test.ts`

**Interfaces:**
```ts
export type AnswerMode = 'choice' | 'qa';
export interface LlmQuota { day: string; cards: number; judges: number }
export function setAnswerMode(coord: Coordinator, mode: AnswerMode): Promise<SettingsWriteResult>;
export function setLlmQuota(coord: Coordinator, quota: LlmQuota): Promise<SettingsWriteResult>;
// library.addCard 入参追加
readonly choices?: readonly string[];   // 经 core 同一套严检后落 Card.choices（缺席 = 不写该字段）
```
**口径：** 三个字段都**可选且缺席不拒**（做成拒绝点会让旧档整包打不开）；在场严检（`answerMode` ∈ 枚举；`llmQuota.day` 非空字符串且两计数为非负整数；`Card.choices` 为字符串数组、≤5 条、每条 ≤200 码点）；`migrateSave` 为缺席档补 `'choice'` 与 `{day:'',cards:0,judges:0}`，**不补** `choices`（缺席 = 没有）；两个 setter 同值不重写、域外值拒绝并回可上屏 reason；`addCard` 的 `choices` 经 core 严检后**只在非空时**写字段。
- [ ] Step 1 失败测试：SM#? 旧档（三字段全缺）⇒ 迁出后 `answerMode==='choice'`、`llmQuota` 全零、卡片无 `choices`；`answerMode:'x'` ⇒ 整包拒；`llmQuota.cards:-1`/`1.5`/`'3'` ⇒ 拒；`choices:['a', 3]` ⇒ 拒；`choices` 20 条 ⇒ 拒；SF#? `setAnswerMode` 切换成功+落盘、同值零写入、域外值失败；`setLlmQuota` 同上且脏值被拒；LB#? `addCard` 带 choices ⇒ 落盘保留，带空数组 ⇒ **不写字段**（`'choices' in card === false`）
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(core,app): answerMode/llmQuota/Card.choices 扩位与写口`

### Task 6: 战斗屏选择题 + 判定面板（含「其实是猜的」）

**Files:** Modify `src/ui/battleScreen.ts`、`src/ui/styles.css`；Test `tests/ui/battleScreen.test.ts`（**改造既有用例**）

**Interfaces（`BattleScreenDeps` 追加）:**
```ts
readonly judge?: (input: { front: string; answer: string; reply: string }) => Promise<
  { ok: true; match: boolean; reason: string; missing: readonly string[] } | { ok: false; reason: string }>;
readonly setAnswerMode?: (mode: AnswerMode) => Promise<SettingsWriteResult>;
```
**当前模式从快照读**（`snap.save.settings.answerMode ?? 'choice'`），不另存本地模式状态。
**新增 DOM：** `[data-ui="answer-choices"]`（`button[data-choice]`，附 `data-choice-index`，文本 = `labels[i]`）、`[data-ui="verdict"]`（`[data-ui="verdict-result"]`、`[data-ui="verdict-reason"]`、`[data-ui="answer-full"]`、`button[data-ui="verdict-guess"]`（「其实是猜的」）、`button[data-ui="verdict-continue"]`）；原 `button[data-grade]` **移除**（D41）。
**流程：** `asking` →（选中选项）`verdict`：屏上先显示 `答对了`/`答错了` + **完整答案**，**此时不派发 intent**；点「继续」才派发（答对 `good` / 答错 `again`）；点「其实是猜的」（只在答对时出现）⇒ 把待发 grade 改成 `again` 并在屏上标明"按答错记"。`[data-ui="reveal"]`（「直接看答案」）⇒ `verdict` + grade `again`。换下一张卡时判定面板、选项、猜的按钮全部重置。干扰项输入：`view.current.choices` 作 `stored`；`pool` = 本局其他卡的 `back` + 它们的 `choices` + `snap.save.cards` 中同 `deckId` 的卡（同上去重），rng 走既有注入位。
- [ ] Step 1 改造/新增测试：`answerChoice(root, i)` / `continueBtn(root)` 辅助；BS#A1 选项数 = `buildChoices` 结果且含答案；BS#A2 点正确项 ⇒ 面板显示「答对了」+ `answer-full` 全文，**快照未推进**；BS#A3 点「继续」才派发 `good`；BS#A4 点错误项 ⇒ 「答错了」+ 全文 + `again`；BS#A5「直接看答案」⇒ 全文 + `again`；BS#A6 领域只有一张卡 ⇒ 不出选项、回落看答案并说明；BS#A7 答对后点「其实是猜的」⇒ 派发的是 `again` 且屏上标了"按答错记"；BS#A8 换卡后面板/选项/猜按钮全清；BS#A9 只读态行为不变；既有 12 条断言逐条重述到新流程
- [ ] Step 2 红 → Step 3 实现（含样式：选项可换行、判定面板高亮对错、**答案不截断**） → Step 4 绿 → Step 5 Commit `feat(ui): 战斗屏选择题 + 判定面板（完整答案 + 其实是猜的）`

### Task 7: 战斗屏问答模式（判定 + 缺失要点 + 到顶回落 + 本局切换）

**Files:** Modify `src/ui/battleScreen.ts`、`src/ui/hostTypes.ts`、`src/ui/hostAdapters.ts`、`src/ui/host.ts`；Test `tests/ui/battleScreen.test.ts`、`tests/ui/host.test.ts`、`tests/ui/hostAdapters.test.ts`

**口径：**
- `answerMode==='qa'` 且 `judge` 在场 ⇒ 显示 `textarea[data-ui="qa-input"]` + `button[data-ui="qa-submit"]`；输入 trim 为空 ⇒ 提交禁用；提交 ⇒ `judging`（禁用 + `正在判…`）⇒ 成功 `verdict`（判对 `good` / 判错 `again`，屏上显示 AI 的一句话理由、**缺失要点**（`missing` 逐条列出）与**完整答案**）；`{ok:false}` ⇒ 未判定形态：「没判成（原因）」+ `[data-ui="verdict-self-right"]` / `[data-ui="verdict-self-wrong"]`，点了才派发。
- **判定到顶（300 次/天）**：宿主的口在额度用尽时回 `{ok:false, reason:'今天的判定额度用完了（300 次），这次你自己定对错。'}` ⇒ 走同一条自评回落。屏上不出现"问答模式被禁用"。
- 无 `judge` 口但存档模式是 `qa` ⇒ 说明"没配 AI，问答模式用不了"并停在选择题形态。
- `[data-ui="mode-toggle"]`：点击 ⇒ `deps.setAnswerMode(另一档)`；成功 ⇒ toast + 快照驱动切换；失败（只读）⇒ 如实 toast 且**停在原模式**。
- 宿主：`judge` 口 = 「先 `planJudge` 记一次判定，再 `judgeAnswer`」的包装（`boundChat()` 每次现读配置）、`setAnswerMode` = `setAnswerMode(coord, m)`，并在 `host.ts` 的 `mountBattleScreen` 参数里**显式透传**（历史教训：漏透传 = 生产死功能而单测全绿）。
- [ ] Step 1 失败测试：BS#Q1 提交后 judge 入参含 front/answer/reply；BS#Q2 判对 ⇒ `good` + 理由 + 缺失要点 + 全文；BS#Q3 判错 ⇒ `again`；BS#Q4 判卷失败 ⇒ 两个自评按钮、点了才派发、理由上屏；BS#Q5 空输入 ⇒ 提交禁用；BS#Q6 判定额度到顶的 reason ⇒ 走自评回落且文案是"额度用完"；BS#Q7 无 judge 口 ⇒ 提示"没配 AI"且仍可作答；BS#Q8 切换成功/失败两条路；HS#? 真 `mountHost` 里 battle 屏拿到 `judge`/`setAnswerMode`（漏透传必红）；AD#? 装配面：判定**每次现读配置**且**每次先记额度**（假配额注入取证）
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(ui): 问答模式（判定/缺失要点/到顶回落/本局切换）`

### Task 8: 设置页「作答方式」+ 卡片生成携带选项 + 真产物冒烟

**Files:** Modify `src/ui/settings.ts`、`src/ui/decks.ts`（候选携带 `choices` → `addCard`）、`src/ui/practice*.ts`（若已存在，采新卡同样携带）、`tests/ui/settings.test.ts`、`tests/e2e/dist.boot.test.ts`（DB#6）、`README.md`

**口径：** 设置页新增「作答方式」组：两个按钮（选择题 / 问答模式）+ 一行如实文案（"问答模式会把这张卡的答案与你的输入发给你自己的 AI 服务商"）+ 今日额度两行（生成剩 N/200、判定剩 M/300）；没配 AI 时问答按钮禁用并说明。`decks.ts` 的辅建卡候选把 `choices` 一起写进 `addCard`（候选卡片上不显示干扰项——玩家不需要在入库时审它们，但**入库后它们决定选择题质量**）。
- [ ] Step 1 失败测试：SA#1 `aria-pressed` 跟快照；SA#2 点击调 `setAnswerMode`；SA#3 文案含"答案"与"服务商"；SA#4 没配 AI ⇒ 问答禁用+说明；SA#5 额度两行文案来自注入口；DA#? 候选携带 `choices` 入库（`addCard` 入参含 `choices`，且与解析出的条数一致）；DB#6 真产物里设置页有作答方式组、战斗屏出现 `button[data-choice]`
- [ ] Step 2 红 → Step 3 实现 → Step 4 `npm run verify` 五段全绿 → Step 5 Commit + 推送 → 确认 CI/Deploy 双绿

---

**执行顺序：** 1 → 2 → 3 →（4 → 5：数据与额度）→ 6 → 7 → 8。每个任务一个 commit；跨任务接口名以本文件的 Interfaces 块为唯一权威。
