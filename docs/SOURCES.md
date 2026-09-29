# 采新卡的「来源库」：实测数据与固化决策（D53）

> 这份文档记录的是**实测**（2026-09-29，容器与手机同一网络出口，`Origin: https://luyangk.github.io`），
> 不是"应该可以"。它决定了来源库里哪些源默认**直连可读**、哪些必须标注"需要读取服务"。

## 1. 为什么必须先测两件事

浏览器里的 `fetch` 能不能拿到一个源的正文，取决于**两件互不相干的事**：

1. **网络可达**：这台设备连不连得上那个域名（国内网络下很多站直接不通）；
2. **CORS 头**：响应里有没有 `Access-Control-Allow-Origin`（ACAO）。**没有 ACAO 的源，浏览器
   一律读不到内容** —— 这是同源策略，不是代码能绕的（与公众号那条路是同一堵墙，见 D48）。

一条源只要缺任何一件，它在屏上就只能是"点了没反应"或"点了报错"。所以固化之前先量。

## 2. 实测表（原样登记）

命令形状：`curl -L -m 25 -H 'Origin: https://luyangk.github.io' -D - -o body <url>`。

| 源 | 端点 | HTTP | Content-Type | 体积 | ACAO | 结论 |
|---|---|---|---|---|---|---|
| OpenAI 官方新闻 | `openai.com/news/rss.xml` | 200 | `text/xml` | 753 KB / 1234 条 | **无** | 可达但**读不到** |
| Hugging Face Blog | `huggingface.co/blog/feed.xml` | 200 | `application/rss+xml` | 257 KB / 869 条 | **无** | 可达但**读不到** |
| Google DeepMind | `deepmind.google/blog/feed/basic/` | 200 | `text/xml` | 70 KB / 100 条 | **无** | 可达但**读不到** |
| arXiv cs.AI | `rss.arxiv.org/rss/cs.AI` | 200 | `application/rss+xml` | 718 KB / 331 条 | **无** | 可达但**读不到** |
| arXiv cs.LG | `rss.arxiv.org/rss/cs.LG` | 200 | `application/rss+xml` | 701 KB / 332 条 | **无** | 可达但**读不到** |
| arXiv 查询 API | `export.arxiv.org/api/query?...` | 200 | `application/atom+xml` | 13 KB / 5 条 | **无** | 同上（换端点也白搭） |
| Lil'Log（Lilian Weng） | `lilianweng.github.io/feed.xml` | **404** | text/html | — | `*` | **端点写错了**；正确是 `…/index.xml` |
| Lil'Log（正确端点） | `lilianweng.github.io/index.xml` | 200 | `application/xml` | 80 KB / 53 条 | **`*`** | ✅ **直连可读** |
| GitHub Blog | `github.blog/feed/` | 200 | `application/rss+xml` | 293 KB / 10 条 | **`*`** | ✅ **直连可读** |
| Databricks Blog | `databricks.com/feed` | 200 | `application/xml` | 6 KB / 10 条 | **`*`** | ✅ **直连可读** |
| Hacker News（RSS） | `news.ycombinator.com/rss` | 200 | `application/rss+xml` | 11 KB / 30 条 | **无** | 可达但**读不到** |
| Hacker News（Algolia API） | `hn.algolia.com/api/v1/search?tags=front_page` | 200 | `application/json` | 27 KB / 20 条 | **回显来源** | ✅ **直连可读**（一个请求拿到标题+链接+分数） |
| Hugging Face Daily Papers | `huggingface.co/api/daily_papers` | 200 | `application/json` | 268 KB / 50 篇 | **回显来源** | ✅ **直连可读**，**摘要正文随响应一起回来** |
| Hugging Face 热门模型 | `huggingface.co/api/models?sort=trendingScore` | 200 | `application/json` | 10 KB / 20 个 | **回显来源** | ✅ **直连可读** |
| GitHub Releases（vLLM） | `api.github.com/repos/vllm-project/vllm/releases` | 200 | `application/json` | 397 KB | **`*`** | ✅ **直连可读**，**更新说明正文随响应回来** |
| GitHub 组织仓库（deepseek-ai） | `api.github.com/orgs/deepseek-ai/repos?sort=updated` | 200 | `application/json` | 126 KB | **`*`** | ✅ **直连可读** |
| KDnuggets | `kdnuggets.com/feed` | **429** | text/html | 1 KB | 无 | 被限流 + 读不到 |
| Towards Data Science | `towardsdatascience.com/feed` | 200 | `application/rss+xml` | 27 KB / 20 条 | **无** | 可达但**读不到** |
| 机器之心 | `jiqizhixin.com` | **000**（SSL 连接中断） | — | — | — | **本机网络不通**；`/rss` 只回 HTML 壳 |
| 量子位 | `qbitai.com/feed` | 200 | `application/rss+xml` | 7 KB / 10 条 | **无** | 可达但**读不到** |
| Papers With Code | `paperswithcode.com` | 200 | text/html | 1.5 MB | **无** | 已并入 Hugging Face，站点不是 feed ⇒ 用 **HF Daily Papers** 代替 |
| The Batch | `deeplearning.ai/the-batch` | 200 | text/html | 188 KB | **无** | 是网页不是 feed |
| Latent.space | `latent.space/feed` | 200 | `application/xml` | 1.4 MB / 20 条 | **无** | 可达但**读不到** |
| Semantic Scholar API | `api.semanticscholar.org/graph/v1/paper/search` | **429** | application/json | — | 无 | 被限流 + 读不到 |

一句话总结：**你给的 15 个源里，只有 4 个能在浏览器里直接读**（GitHub Blog、Databricks、
Lil'Log 的正确端点），外加 4 条**同样内容但开了 CORS 的 API 端点**（HN Algolia、HF Daily Papers、
HF 热门模型、GitHub Releases/组织仓库）。其余全是"可达但没有 CORS"或"连不上"。

## 3. 固化决策（默认来源库）

### 3.1 直连可读（默认进库，点了真的出内容）

| 名称 | 端点 | 覆盖 | 拿到的正文形态 |
|---|---|---|---|
| GitHub Blog | `github.blog/feed/` | 开源生态、新工具、工程实践 | RSS 摘要（需点进原文拿全文） |
| Databricks Blog | `databricks.com/feed` | 大数据、LLM 数据工程 | RSS 摘要 |
| Lil'Log（Lilian Weng） | `lilianweng.github.io/index.xml` | Agent / RAG / 大模型综述 | RSS 摘要 |
| Hacker News 头条 | `hn.algolia.com/api/v1/search?tags=front_page` | 开发者热点、项目首发 | 标题 + 链接 + 分数/评论数 |
| HF Daily Papers | `huggingface.co/api/daily_papers` | 论文源头 + 开源实现（Papers with Code 继任者） | **标题 + 摘要 1500–1900 字**（直接够生成卡） |
| HF 热门模型 | `huggingface.co/api/models?sort=trendingScore` | 开源模型、LoRA、微调、推理工程 | 模型名 + 任务 + 下载/点赞 |
| GitHub Releases · vLLM | `api.github.com/repos/vllm-project/vllm/releases` | 推理工程、新版本要点 | **更新说明正文（数万字，会分块）** |
| GitHub Releases · transformers | `api.github.com/repos/huggingface/transformers/releases` | 生态工具链 | 更新说明正文 |
| GitHub 组织 · deepseek-ai | `api.github.com/orgs/deepseek-ai/repos?sort=updated` | **DSH / DeepSeek 全系仓库动态** | 仓库名 + 描述 + ★ |

**关键设计点**：JSON 类源（HF 论文、GitHub Releases）**响应里就带着摘要/更新说明正文**，
所以根本不需要再抓页面 —— 绕开了 CORS 那堵墙（HF/GitHub 的网页本身也没有 ACAO，但 API 有）。
这些条目在屏上是"直接用这段文字生成卡"，而不是"再去抓一次链接"。

### 3.2 标注「需要读取服务」（保留，但不假装能读）

OpenAI News、HF Blog、DeepMind、arXiv cs.AI/cs.LG、HN RSS、Towards Data Science、量子位、
Latent.space：**放着，但行上打「需读取服务」的标**。点它时会得到一句实话：
"这个源没开 CORS，浏览器读不到 —— 要么在「设置 → AI → 读取服务」里配一个，要么点「打开原文去复制」。"
配了读取服务时它们才能用（读取服务是玩家自己填的第三方，见 D38/D48 的隐私口径）。

### 3.3 从默认库里剔除的

- **Papers With Code**：站点已并入 HF 且不是 feed ⇒ 用 HF Daily Papers 顶替（同样"论文 + 开源实现"）；
- **The Batch**：只有网页没有 feed ⇒ 不放进库里（免得做出一个点了就报错的入口）；
- **KDnuggets / Semantic Scholar**：实测 429 限流 ⇒ 放进库只会让玩家以为坏了；
- **机器之心**：本机 SSL 不通 ⇒ 同上（国内可达性会变，读者可自行添加）。

## 4. 领域与"用户自己维护"

- 内置**一个标准领域**：`AI / 机器学习前沿`（上表 3.1 + 3.2）。以后加领域 = 往
  `src/app/sourceLibrary.ts` 的 `BUILTIN_DOMAINS` 里追加一组 `{ id, name, sources[] }`
  （加之前**照第 2 节量一遍**：可达 + ACAO，两条都过才配 `direct: true`）；
- **玩家可以自己维护**：加源（名称 + 链接 + 类型）、删源（含内置的，删了记进"墓碑"，
  不会因为刷新又冒出来）、「恢复推荐来源」一键还原。玩家的库存在本机 `localStorage`
  （`zx-xia.sources.v1`，与待读清单同款待遇：**不进存档、不进备份**、损坏时静默回落内置库）。
- 加源时的**自动判别**：把链接抓一次，看响应头与内容 —— 是 feed 就按 RSS 解析，是 JSON 就按
  已知三种形状试解析，都没有 ACAO 就标上「需读取服务」。这条由 `feedFetch` 的 `probeKind` 兜底。
