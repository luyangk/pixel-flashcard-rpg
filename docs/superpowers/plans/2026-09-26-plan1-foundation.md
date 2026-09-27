# 知识侠客 · 地基工程实施计划（Plan 1/5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可测试、可部署的工程地基：仓库/工具链、纯 TS 核心模块（SM-2 引擎、有效复习计数、伤害公式）、抽象存储层 + JSON 备份导出导入。

**Architecture:** 三层分离——`src/core/` 纯 TypeScript 零 DOM 零平台 API（APK/小程序迁移的前提，PRD §1）；`src/platform/` 存储等能力抽象接口 + IndexedDB 实现；渲染/UI 层属后续计划，本计划不触碰浏览器画面。Vitest 只测 core 与 storage 逻辑。

**Tech Stack:** Node 24 / npm、TypeScript 5（strict）、Vitest 3、Vite 7（仅脚手架与占位页）、git + GitHub Actions → GitHub Pages。

**Spec:** `docs/PRD.md` v2.0（§1 平台约束、§6 数据模型与持久化、§10 工程与交付）；世界观文案不涉及本计划。

## 后续计划（本计划完成后依次立项）

| # | 计划 | 覆盖 PRD 条目 |
|---|---|---|
| 2 | SRS 调度与战斗循环 | §2 玩法、§3 备战、§8 MVP 1–4 |
| 3 | 叙事系统（序章/战报/Boss/图鉴/假记忆） | §9 故事规格 |
| 4 | LLM 管线（辅建卡/称号/彩蛋 + §4.4 安全底线） | §4.3/§4.4 |
| 5 | PWA 离线化 + Pages 部署上线 | §8 MVP 11/13、§10 |

## Global Constraints

- TypeScript `strict: true`；`src/core/**` 禁止 import 任何 DOM/Node 平台 API（用 `import type` 之外一律不允许）。
- 时间一律以毫秒时间戳入参传入纯函数，core 内不得调用 `Date.now()`（可测性要求，见 Review Focus）。
- 日期口径统一为本地日历日字符串 `YYYY-MM-DD`（"同日只计一次"的判定基准）。
- 包名/仓库沿用 `pixel-flashcard-rpg`；代码注释与标识符用英文，面向玩家的文案用中文。
- 每个 Task 结束即 commit（消息格式 `feat:`/`chore:`/`test:` 前缀）。
- 依赖版本下限：typescript ≥5.5、vitest ≥3、vite ≥7。

## Review Focus

PRD 未逐条写明、但最可能咬人的输入类别——每条在对应 Task 里钉了测试：

1. **时钟边界**：23:59 开始、00:01 结束的复习算不算"间隔 ≥1 天"？预期按日历日而非时长判定。（Task 4）
2. **畸形导入存档**：字段缺失/类型错误/未来 schemaVersion 的 JSON 必须整包拒绝且给出可读原因，绝不部分写入。（Task 6）
3. **IndexedDB 不可用**（隐私模式/配额满）：降级到内存存储并显式警告，而不是静默丢进度。（Task 5）
4. **数值域外输入**：负 ease、NaN interval、空卡组等不能让公式抛异常或产出 NaN 伤害。（Task 3）
5. **重复初始化幂等**：同 deck+day 连续记录两次有效复习，计数只 +1。（Task 4）

---

### Task 1: 仓库初始化与工具链

**Files:**
- Create: `.gitignore`、`tsconfig.json`、`vitest.config.ts`、`index.html`、`src/main.ts`（占位入口）
- Modify: —

**Interfaces:**
- Consumes: —
- Produces: 可运行的 `npm test` / `npm run build` / `npm run dev` 脚本面；`tsconfig` 路径别名 `@core/* → src/core/*`、`@platform/* → src/platform/*`。

- [x] **Step 1: git init 与 .gitignore**

```bash
cd /sdcard/Documents/Projects/pixel-flashcard-rpg
git init -b main
printf 'node_modules/\ndist/\n*.local\n.DS_Store\n' > .gitignore
```

- [x] **Step 2: 安装依赖**

Run: `npm install -D typescript vitest vite && npx tsc --version && npx vitest --version`
Expected: tsc ≥5.5、vitest ≥3，退出码 0

- [x] **Step 3: 写 tsconfig.json（strict、ES2022、别名）、vitest.config.ts（alias 同步 tsconfig）、index.html + src/main.ts 占位**

`src/main.ts` 内容就一行：`console.log('zx-xia placeholder');`

- [x] **Step 4: 验证脚本面**

在 `package.json` 加入 scripts：`"dev": "vite"`、`"build": "tsc --noEmit && vite build"`、`"test": "vitest run"`、`"typecheck": "tsc --noEmit"`。
Run: `npm run typecheck && npm run build && npm test --passWithNoTests`
Expected: 三条全部退出码 0

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold ts+vite+vitest toolchain"
```

---

### Task 2: 核心类型定义

**Files:**
- Create: `src/core/types.ts`
- Test: `tests/core/types.smoke.test.ts`

**Interfaces:**
- Produces: `Card`、`SRSState`、`Deck`、`SaveFile`、`Stability`、`SourceInfo`——后续所有 core 模块共用。签名锁定如下（字段照抄 PRD §6.2，`SaveFile` 为本计划新增容器）：

```ts
export type Stability = 'new' | 'learning' | 'review' | 'mastered';
export interface SourceInfo { type: 'preset'|'hotspot'|'domain'|'manual'|'llm'; url?: string; createdAt: number }
export interface SRSState { ease: number; interval: number; reps: number; lapses: number; due: number; stability: Stability; effectiveReviewDays: string[] }
export interface Card { id: string; deckId: string; front: string; back: string; source?: SourceInfo; srs: SRSState; tags: string[] }
export interface Deck { id: string; name: string; isPreset: boolean; bossName?: string; purifiedAt?: number }
export interface Settings { bossThresholdTier: 15|30|50; sm2Params: Sm2Params /* Task 3 定义 */ }
export interface SaveFile { schemaVersion: 1; decks: Deck[]; cards: Card[]; settings: Settings; meta: { savedAt: number; plays: number } }
```

- [x] **Step 1: 写失败测试** —— 构造一个最小合法 `SaveFile` 对象字面量并通过 `expectTypeOf`/运行时断言各字段存在（smoke 即可，类型正确性由 tsc 把关）。

- [x] **Step 2: 跑测试确认失败**（`npx vitest run tests/core/types.smoke.test.ts`，Expected: Cannot find module）

- [x] **Step 3: 实现 `types.ts`**（纯类型 + 无运行时代码；`Settings.sm2Params` 引用 Task 3 的 `Sm2Params`，此处先在本文件声明该 interface 以免循环依赖：`{ initialEase: number; minEase: number; firstInterval: number; secondInterval: number }`）

- [x] **Step 4: 跑测试确认通过 + typecheck**

- [x] **Step 5: Commit** `feat: core domain types (card/deck/srs/savefile)`

---

### Task 3: SM-2 复习引擎（纯函数）

**Files:**
- Create: `src/core/sm2.ts`
- Test: `tests/core/sm2.test.ts`

**Interfaces:**
- Consumes: `SRSState`、`Stability`（Task 2）
- Produces:
  - `export const GRADES = { again: 0, hard: 2, good: 3, easy: 5 } as const; export type Grade = (typeof GRADES)[keyof typeof GRADES];`
  - `export function createInitialSRS(nowMs: number): SRSState`（ease=2.5, interval=0, reps=0, lapses=0, due=nowMs, stability='new', effectiveReviewDays=[]）
  - `export function review(srs: SRSState, grade: Grade, nowMs: number, p: Sm2Params): SRSState` —— 返回新对象（不可变），SM-2 标准更新：ease′=clamp(ease+(0.1−(5−q)(0.08+(5−q)·0.02)), minEase, ∞)；again→reps=0、interval=firstInterval(分钟级用 10/60 表示天)、lapses+1、stability 回退 'learning'；good/hard/easy→reps+1，interval 按 reps=1→secondInterval、reps≥2→round(interval×ease)，easy ×1.3、hard ÷1.2；stability 晋升规则：interval≥7d→'mastered'，reps≥1 且 interval≥1d→'review'，否则 'learning'。
  - `export function dueQueue(cards: Card[], nowMs: number): Card[]` —— 到期卡按紧迫度升序（due 越早越前）。
  - `export function damageMultiplier(srs: SRSState): number` —— new=0.1, learning=0.5, review=1.0, mastered=1.5（PRD §2.1"熟练度倍率"；LORE"未入脑≈0"用 0.1 保底防零伤害死局）。
- 域外输入策略：非法 grade/NaN 参数一律回落默认值，输出永不含 NaN（Review Focus #4）。

- [x] **Step 1: 写失败测试**，至少覆盖：初始态字段；again 降 ease+清 reps+lapse+1；good 三连后 interval 序列 1→6→15（ease 2.6 时允许 ±1 容差断言具体数）；mastered 晋升；damageMultiplier 四档映射；`review(review(s,g,t,p))` 不改前值（不可变性）；grade=NaN 与 ease=-1 输入输出仍为有限数。
- [x] **Step 2: 跑测试确认失败** Expected: cannot find module
- [x] **Step 3: 实现 `sm2.ts`**（无 Date.now()、无 IO；纯算术 + 查表）
- [x] **Step 4: 跑测试确认通过**
- [x] **Step 5: Commit** `feat: pure SM-2 engine with immutability and NaN guards`

---

### Task 4: 有效复习计数（Boss 触发口径）

**Files:**
- Create: `src/core/reviewLedger.ts`
- Test: `tests/core/reviewLedger.test.ts`

**Interfaces:**
- Consumes: `Card`、`SRSState.effectiveReviewDays`（Task 2/3）
- Produces:
  - `export function localDayString(nowMs: number, tzOffsetMin: number): string` —— 由时间戳 + 分钟偏移得到 `YYYY-MM-DD`（core 不知时区，偏移由调用方传 `-new Date().getTimezoneOffset()`（R-T4-a 更正：UTC+8 → +480，实现与测试均按此约定））。
  - `export function recordEffectiveReview(card: Card, nowMs: number, tzOffsetMin: number): Card` —— 若当日不在 `effectiveReviewDays` 则追加（保持升序、去重、上限滚动保留最近 400 条），返回新对象；同日重复调用结果不变。
  - `export function domainReviewCount(deckCards: Card[]): number` —— Σ 每张卡的 `effectiveReviewDays.length`。
  - `export function bossReady(deckCards: Card[], threshold: 15|30|50): boolean`。

- [x] **Step 1: 写失败测试**，覆盖：同日两次 record 计数仍为 1（RF#5）；跨日 +1；**23:59 与次日 00:01 判为两天**（tzOffset=480 即 UTC+8：用两个具体毫秒戳断言 dayString 不同，RF#1）；乱序 days 数组经 record 后仍升序；bossReady 阈值边界（count=threshold−1 false / =threshold true）。
- [x] **Step 2: 跑测试确认失败**
- [x] **Step 3: 实现 `reviewLedger.ts`**
- [x] **Step 4: 跑测试确认通过**
- [x] **Step 5: Commit** `feat: calendar-day effective-review ledger driving boss triggers`

---

### Task 5: 存储抽象层 + IndexedDB 实现 + 内存降级

**Files:**
- Create: `src/platform/storage.ts`（接口）、`src/platform/idbStore.ts`、`src/platform/memoryStore.ts`
- Test: `tests/platform/memoryStore.test.ts`、`tests/platform/idbStore.fake.test.ts`（用 `fake-indexeddb`）

**Interfaces:**
- Consumes: `SaveFile`（Task 2）
- Produces:
  - `export interface GameStorage { load(): Promise<SaveFile|null>; save(f: SaveFile): Promise<void>; clear(): Promise<void>; readonly kind: 'idb'|'memory' }`
  - `export async function openStorage(dbName?: string): Promise<GameStorage>` —— 探测 IndexedDB 可用则 `idbStore`（单 store `saves`，键 `'current'`），否则回落 `memoryStore` 并由调用方决定 UI 警告文案（PRD 功能文案大白话："当前浏览器无法保存进度，关闭页面会丢失"）。
  - memoryStore 行为与 idbStore 完全一致（同一套契约测试跑两遍）。

- [x] **Step 1: 装 `npm i -D fake-indexeddb`，写共享契约测试套件**（save→load roundtrip、clear→load null、并发双 save 后 load 得后者、save 不接受被外部 mutate 的对象——内部深拷贝）。
- [x] **Step 2: 跑测试确认失败**
- [x] **Step 3: 实现三文件**。idbStore 用原生 IDB API 包 promise（不引第三方库）；open 失败/onerror 一律 catch 成降级路径。
- [x] **Step 4: 跑测试确认通过（两套 store 同绿）**
- [x] **Step 5: Commit** `feat: storage abstraction with idb impl and in-memory fallback`

---

### Task 6: 存档校验与 JSON 导出/导入

**Files:**
- Create: `src/core/saveMigrate.ts`
- Test: `tests/core/saveMigrate.test.ts`

**Interfaces:**
- Consumes: `SaveFile`（Task 2）、`GameStorage`（Task 5）
- Produces:
  - `export function validateSave(raw: unknown): { ok: true; save: SaveFile } | { ok: false; reason: string }` —— 手写窄校验器（不引 zod，YAGNI）：schemaVersion 必须恰为 1（未来版本给出"请升级后再导入"）；decks/cards/settings/meta 结构与关键字段类型逐项检查；cards[].deckId 必须指向存在的 deck；任一失败整包拒绝并在 reason 中给 JSON 路径（如 `cards[3].srs.ease`）。
  - `export function serializeSave(f: SaveFile): string`（2 空格缩进、含 `exportedAt`）
  - `export function importAndSave(text: string, store: GameStorage): Promise<{ ok: boolean; reason?: string }>` —— 解析→validate→store.save，任一步失败不落盘（Review Focus #2）。

- [x] **Step 1: 写失败测试**，覆盖：合法样本往返相等；缺 `settings` → reject 且 reason 含 `settings`；`schemaVersion: 2` → reject 提示升级；悬空 deckId → reject；非 JSON 文本 → reject 不抛裸异常；importAndSave 失败路径下 store.load() 保持旧值。
- [x] **Step 2: 跑测试确认失败**
- [x] **Step 3: 实现 `saveMigrate.ts`**
- [x] **Step 4: 跑测试确认通过**
- [x] **Step 5: Commit** `feat: strict save validation with atomic import`

---

### Task 7: core 平台纯净性守卫 + CI

**Files:**
- Create: `scripts/check-core-purity.mjs`、`.github/workflows/ci.yml`
- Modify: `package.json`（加 `"check:purity"` 并入 `"verify": "npm run typecheck && npm run check:purity && npm test"`）

**Interfaces:**
- Consumes: 全部已完成源码
- Produces: `npm run verify` 一键门禁；GitHub Actions push/PR 触发同一命令。

- [x] **Step 1: 写守卫脚本** —— 遍历 `src/core/**/*.ts`，正则检测 `document.|window.|localStorage|indexedDB|fetch(|Date.now(|require(` 出现即 exit 1 并打印命中行（`localDayString` 的 tzOffset 是入参不受影响；此清单落实 Global Constraints #2 与 PRD §1 平台约束）。
- [x] **Step 2: 本地跑 `npm run check:purity` 确认对现有代码通过**（故意在临时文件插入 `window.x` 验证能报错，然后删除）
- [x] **Step 3: 写 ci.yml**：`on: [push, pull_request]`，steps = checkout → setup-node 24 (cache npm) → `npm ci` → `npm run verify`。Pages 部署留给 Plan 5，此处不提前。
- [x] **Step 4: 跑 `npm run verify` 全绿**
- [x] **Step 5: Commit** `chore: core purity guard + CI verify pipeline`

---

## Self-Review 结论（已执行）

1. **Spec coverage：** PRD §6.2 数据模型→T2/T6；§6.3 SM-2→T3；§2.4 Boss 计数口径→T4；§6.1 存储与导出导入→T5/T6；§10 TDD 与安全评审节点→T7 purity + 计划头部标注 reviewing-security 属 Plan 4；战斗/叙事/PWA 明确划入后续计划。无遗漏项。
2. **Step scan：** 已消除 TBD 型步骤；公式类步骤给了精确签名与关键常数，其余留实现空间。
3. **Type consistency：** `Sm2Params` 定于 T2、T3 引用一致；`Grade/GRADES` 仅 T3 消费；`GameStorage.kind` 在 T5 契约测试断言。
4. **Review Focus：** 五条各有归属测试（T3/T4/T5/T6 分布如上）。
5. **Proportion：** 计划 ≈ spec 相关章节的 1.5 倍长度，代码块均为签名/常数值，未转录实现。
