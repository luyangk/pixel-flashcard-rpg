# 已安装 Skills 清单

> **用户级**：`/root/.dsh/skills/`（rank 400，对本机所有项目可用）——存放通用 skill。
> **项目级**：`/sdcard/Documents/Projects/.dsh/skills/`（rank 100，仅当前工作区）——存放本项目专属 skill。
> 格式：DSH `dsh-skill-filesystem` 目录 bundle（`<name>/SKILL.md`），与 Claude Code skill 格式兼容。
> 安装日期：2026-09-26；同日将通用项提升至用户级。全部来自 GitHub 现成仓库，非自写；装前经内容安全扫描（无危险指令、无网络调用、脚本 import 面干净）。

## 按职能分组

| 职能 | Skill | 级别 | 来源仓库 | 说明 |
|---|---|---|---|---|
| 需求澄清 | `grill-me` | 用户级 | [RobMitt/grill-me-skill](https://github.com/RobMitt/grill-me-skill) | 决策树式连环追问 ✅已用过 |
| 产品设计 | `working-backwards-coach` | 用户级 | [diegosouzapw/awesome-omni-skill](https://github.com/diegosouzapw/awesome-omni-skill) | Amazon 逆向工作法：PR/FAQ、PRD、PMF 验证 |
| 项目规划 | `writing-plans` | 用户级 | [obra/superpowers](https://github.com/obra/superpowers) | 有 spec 后、动码前写实施计划 |
| 项目规划 | `executing-plans` | 用户级 | obra/superpowers | 按计划分步执行与核对 |
| UI/UX | `ui-ux` | 用户级 | awesome-omni-skill | 设计数据库：风格/色板/字体/UX 准则 |
| UI/UX | `frontend-design` | 用户级 | [anthropics/skills](https://github.com/anthropics/skills) | Anthropic 官方：有辨识度的视觉方向把控 |
| 工程实现 | `test-driven-development` (+writing-good-tests.md) | 用户级 | obra/superpowers | TDD 红绿重构纪律 |
| 工程实现 | `systematic-debugging` (+3 篇参考) | 用户级 | obra/superpowers | 先定根因再改代码 |
| 安全管控 | `reviewing-security` | 用户级 | awesome-omni-skill | 威胁建模 + OWASP 审查 + 风险分级 |
| 安全管控 | `secure-coding` | 用户级 | awesome-omni-skill | OWASP Proactive Controls：输入校验/输出编码 |
| 工程实现 | `web-games` | 项目级 | awesome-omni-skill | Web 游戏开发原则：框架选型/PWA/优化 |
| 像素美术 | `pixel-art-studio` (含 scripts/references 共 21 文件) | 项目级 | [Gamezxz/pixel-art-studio](https://github.com/Gamezxz/pixel-art-studio) | Pillow 逐像素作画：sprite/动画/调色板/spritesheet+JSON 导出 |

### 级别划分理由
- **用户级（10 个）**：需求澄清、产品/规划/UIUX/TDD/调试/安全是跨项目通用工作方法，任何新项目都应直接可用。
- **项目级（2 个）**：`web-games` 与 `pixel-art-studio` 绑定"网页像素游戏"这一技术形态；若未来本项目转 APK/小程序或做非游戏项目，不应继续污染其他会话的 skill 目录。若之后确认长期走 Web/PWA，也可再提升为全局。

## 依赖

- `pixel-art-studio` 需要 Python **Pillow**：已通过 `apt-get install python3-pil` 装好（10.2.0，系统级），渲染冒烟测试通过。注意 Pillow 装在容器系统里，若 DSH 容器重建需重装；skill 文件本身在 `/root/.dsh` 与工作区中持久。

## 已知缺口（未随装捆绑文件）

- `ui-ux` 引用了 `scripts/search.py` + `ui-reasoning.csv` 数据文件，上游仓库中实际不存在（该 mega-repo 收录时丢失）。SKILL.md 正文的设计准则仍完整可用，仅 BM25 检索不可用。
- `reviewing-security` 引用若干 `agents/security/references/*.md`，属其原框架的编排文件；skill 本体的审查方法论完整。

## 维护备注

- 直连 `raw.githubusercontent.com` 在本机会超时；下载走 jsDelivr CDN（`https://cdn.jsdelivr.net/gh/<repo>@<branch>/<path>`）或 GitHub contents API（匿名限 60 次/小时）。
- 缓存目录 `/tmp/skillcache`（重启会话后失效，重装需重新拉取）。
