# 知识侠客（Pixel Flashcard RPG）

把间隔重复（SM-2）复习包装成回合制卡牌战斗的**本地优先单机游戏**：答对一张卡就造成一次伤害，
打穿一个知识领域的"卷灵"Boss，把学过的知识变成角色的等级与六维。纯前端、无后端、无账号——
因此进度的唯一保全手段是**导出 JSON 备份**，离线也能玩。

技术底座是四层分离：`src/core/` 纯 TypeScript 逻辑核（零 DOM、零平台 API、时间与随机全部入参化）、
`src/platform/` 平台能力抽象（IndexedDB / 内存存储、时钟、时区、随机播种、图片与文件口）、
`src/app/` 编排层（会话控制器、Boss 净化、预算内容种子、导入导出）、`src/ui/` + `src/stage/`
（原生 DOM 屏组件与 Canvas 战斗舞台，无框架、无游戏引擎）。

## 五个计划 · 进度

| # | 计划 | 覆盖 | 状态 |
|---|---|---|---|
| 1 | 地基工程：仓库与工具链、SM-2 引擎、有效复习账本、存储抽象、JSON 备份导出/导入 | PRD §1/§6 | ✅ 已完成 |
| 2 | SRS 调度与战斗循环：备战配池（80/20）、确定性回合制战斗、经验与 Boss 触发、headless 数值模拟 | PRD §2/§3/§6.3–6.5 | ✅ 已完成 |
| 3 | 游戏装配层（App Wiring）：会话编排、全库口径属性派生、复习落账链、攒批持久化、7 天备份提醒、本地战绩榜、假记忆素材池 | PRD §2.2–2.4/§5/§6.1/§6.5、LORE §5.5 | ✅ 已完成 |
| 4 | 界面层：DOM/Canvas 渲染与叙事呈现（序章→菜单→备战→战斗→结算→卡组→藏书阁→设置）、Boss 净化与图鉴、只读保护（D29）、像素素材集 | PRD §3/§7/§9、LORE §5/§6 | ✅ 已完成（LLM 管线移至 Plan 5，见下） |
| 5 | PWA 离线化 + GitHub Pages 上线 + LLM 管线（辅建卡/称号建议/彩蛋生成） | PRD §8 MVP 11/13、§10 | ⏳ 待立项 |

> 注 1：Plan 1 的原始路线图把"叙事系统"与"LLM 管线"单列为 Plan 3/4；实际执行时 Plan 3 改为
> 装配层（数据流主干），这两块随渲染层并入 Plan 4。
> 注 2：**LLM 三职能（辅建卡 / 卷灵称号建议 / 图鉴彩蛋生成）整体移到 Plan 5**（裁决 R-P4-a）——
> 它们都需要"玩家自带 API Key + 网络"，属上线阶段；Plan 4 先立玩法闭环：自建领域的彩蛋显示
> 「已净化」占位，不编造内容。

## 玩一局（本地）

```bash
npm install          # 首次；/sdcard（noexec）上还需 node scripts/link-native-bindings.mjs
npm run dev -- --host 127.0.0.1
# 手机/浏览器打开 http://127.0.0.1:5173
```

首次启动会自动灌入 4 个预置领域（成语典故 / 英语词根 / 生活常识 / 唐诗，共 30 张手写卡）。
**玩法要点**：新卡（stability `new`）每击只造成 `atk × 0.1` 伤害，首战几乎必败——这是刻意的
"苦修"循环：先输、背卡、卡片稳定度晋升到 `review` 后每击 `atk × 1.0`，打赢几场遭遇战攒经验升级，
再回头挑战卷灵 Boss。战败不是白输：败局会演出"假记忆注入"（LORE §5.5，纯演出、零数值后果）。

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
| 测试 | `npm test` | Vitest 全量（当前 **49 文件 / 789 用例**），含 headless 逻辑链冒烟与**有画面的可玩性冒烟** |

单跑某一部分：`npm test -- tests/e2e/playable.smoke.test.ts`、`npm run build`（typecheck + Vite 构建）。

### DoD 证据指向

| DoD | 证据用例 |
|---|---|
| DoD1 无画面也能打完一局（SRS/经验/榜单/备份全链一致） | `tests/app/fullSession.smoke.test.ts` · SM#1 |
| DoD2 3 天内能击败首个 Boss（引导领域 15 次阈值） | `tests/e2e/playable.smoke.test.ts` · E2E#4（卷灵达标 → 卷灵战 → 净化 → 藏书阁条目） |
| DoD4 界面上能玩完整闭环（序章→首战→结算→卡组→图鉴） | `tests/e2e/playable.smoke.test.ts` · E2E#1–#4 |
| DoD5 导出→清环境→导入后进度完整 | `tests/app/fullSession.smoke.test.ts` · SM#1、`tests/e2e/playable.smoke.test.ts` · E2E#3/#5 |
| D29 只读三件套（横幅 / 坏档原文导出 / 写路径全捕获可见） | `tests/e2e/playable.smoke.test.ts` · E2E#6、`tests/ui/readOnly.test.ts` |

## 素材与叙事

- `assets/sprites/`：像素素材（hero 32²、小怪 4 × 32²、卷灵 4 × 64²、可平铺荒原 64²、
  序章 8 屏与暗线三幕各 64²），由 `scripts/gen-sprites.mjs`（pixel-art-studio 管线）生成，
  重跑幂等；规格表与调色板见 `assets/README.md`，契约测试见 `tests/assets/`。
- `assets/narrative/`：序章八屏剧本（`prologue.json`，与 `docs/LORE.md` §5.1 逐字一致）、
  战报碎片池（`beats.json` 30 条）、三幕暗线（`arc.json`）、图鉴彩蛋（`eggs.json`）、
  假记忆词替换表（`fake-words.json`）。
- `assets/content/preset.json`：4 个预置领域的手写卡（首次启动灌入，空库才灌）。
- `docs/PRD.md`（需求基线）、`docs/LORE.md`（世界观与文案权威）、`docs/SKILLS.md`（所用技能清单）。

## Plan 5 预告

Service Worker 离线缓存 + 安装提示（PWA）、GitHub Pages 部署流水线（当前 CI 只跑 verify）、
LLM 管线（玩家自带 Key：辅建卡 / 称号建议 / 彩蛋生成，输出视为不可信候选、人审后入库）。
