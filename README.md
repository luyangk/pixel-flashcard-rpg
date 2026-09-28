# 知识侠客（Pixel Flashcard RPG）

把间隔重复（SM-2）复习包装成回合制卡牌战斗的**本地优先单机游戏**：答对一张卡就造成一次伤害，
打穿一个知识领域的"卷灵"Boss，把学过的知识变成角色的等级与六维。纯前端、无后端、无账号——
因此进度的唯一保全手段是**导出 JSON 备份**，离线也能玩。

技术底座是三层分离：`src/core/` 纯 TypeScript 逻辑核（零 DOM、零平台 API、时间与随机全部入参化）、
`src/platform/` 平台能力抽象（IndexedDB / 内存存储、时钟、时区、随机播种）、`src/app/` 装配层
（游戏会话数据流主干）。渲染层按计划后置，当前仓库是"无画面的可玩游戏"。

## 五个计划 · 进度

| # | 计划 | 覆盖 | 状态 |
|---|---|---|---|
| 1 | 地基工程：仓库与工具链、SM-2 引擎、有效复习账本、存储抽象、JSON 备份导出/导入 | PRD §1/§6 | ✅ 已完成 |
| 2 | SRS 调度与战斗循环：备战配池（80/20）、确定性回合制战斗、经验与 Boss 触发、headless 数值模拟 | PRD §2/§3/§6.3–6.5 | ✅ 已完成 |
| 3 | 游戏装配层（App Wiring）：会话编排、全库口径属性派生、复习落账链、攒批持久化、7 天备份提醒、本地战绩榜、假记忆素材池 | PRD §2.2–2.4/§5/§6.1/§6.5、LORE §5.5 | 🚧 **收尾中**（T8 为最后一个任务） |
| 4 | 界面层：DOM/Canvas 渲染与叙事呈现（菜单→备战→战斗→结算、Boss 净化与图鉴、主题筛选 UI），LLM 管线（辅建卡/称号/彩蛋） | PRD §4.3–4.4、LORE §6 | ⏳ 待立项 |
| 5 | PWA 离线化 + GitHub Pages 上线 | PRD §8 MVP 11/13、§10 | ⏳ 待立项 |

> 注：Plan 1 的原始路线图把"叙事系统"与"LLM 管线"单列为 Plan 3/4；实际执行时 Plan 3 改为
> 装配层（数据流主干），这两块随渲染层并入 Plan 4。

## 质量门禁：`npm run verify`

[![CI](https://github.com/luyangk/pixel-flashcard-rpg/actions/workflows/ci.yml/badge.svg)](https://github.com/luyangk/pixel-flashcard-rpg/actions/workflows/ci.yml)

一条命令跑完三段门禁，**全绿才允许 commit**（CI 在 push / PR 上跑同一条命令）：

```bash
npm run verify        # = npm run typecheck && npm run check:purity && npm test
```

| 段 | 命令 | 把什么变成机器检查 |
|---|---|---|
| 类型 | `npm run typecheck` | TypeScript strict（含 `@ts-expect-error` 的"类型层确实拦住了"断言） |
| 纯净 | `npm run check:purity` | `src/core/**` 禁 DOM/Node API、禁 `Date.now(`、禁 `Math.random(`（`scripts/check-core-purity.mjs`） |
| 测试 | `npm test` | Vitest 全量（当前 25 文件 / 476 用例），含 headless 整局冒烟的端到端证据链 |

单跑某一部分：`npm test -- tests/app/fullSession.smoke.test.ts`、`npm run build`（typecheck + Vite 构建）。

## Plan 4 / 5 预告

**Plan 4 · 界面层**：Plan 3 已把"打一局"的数据流主干做成可编程驱动（`src/app/`），Plan 4 只需挂上
DOM/Canvas 并接上这些入口——

- 备战：`startFight(save, { size, deckIds, rng, nowMs, stats: playerStatsFor(save) })`（失败面是返回值，直接渲染大白话引导）；
- 战斗：`answerCurrent(view, grade, { rng })` 逐题推进；卡池耗尽未杀敌时用 `pickFakes(pool, 1~2, …)` 播假记忆演出（纯演出、零数值后果）；
- 结算：`settleFight` → `coordinator.settleAndRecord` → `recordRun`（榜单落盘），收口一律 `flush() && !dirty()`；
- 导入/导出：走 `src/app/transfer.ts` 的守卫入口（脏入参不产出残信封、解析异常不逃到 UI），提示文案用它的 `ok:false.reason`；
- 提醒：`backupReminderDue(snapshot().meta.lastExportedAt ?? null, now)` 驱动 7 天横幅，导出成功后 `coordinator.markExported(now)`。

**Plan 5 · 上线**：Service Worker 离线缓存 + 安装提示（PWA），以及 GitHub Pages 部署流水线
（当前 CI 只跑 verify，部署刻意留到这一步）。
