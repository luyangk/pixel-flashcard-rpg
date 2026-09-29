# 知识侠客 · Plan 8：练功模块（看旧卡增补 + 采新卡/摄入管线）实施计划

> **For agentic workers:** 由本会话按 executing-plans 逐任务实现（checkbox 追踪）；最后统一终审。

**Goal:** 把「练功」补成一个完整的知识准备入口：**看旧卡**能就地改内容（补上"卡只能删、不能改"的缺口）；**采新卡**能拿玩家给的链接/分享/粘贴正文去网页取内容（尽力直读 → **进入一层**选条目 → 抽正文），交给玩家自带的 LLM 改写成候选闪卡，由玩家**逐条勾选、选目标领域**后入库；抓不到的链接进本机**待读清单**；全程受**200 张/天**合并额度约束。

**Architecture:** 新能力全落在既有四层，战斗与 SRS 一行不改：
- `src/platform/pageFetch.ts`（唯一网页网络出口，含玩家可选的"读取服务"）与 `src/platform/htmlDigest.ts`（`DOMParser` 抽正文与条目 —— 因需 DOM 所以属平台层）。
- `src/platform/inboxStore.ts`（第二个 `localStorage` 归属：待读清单；**绝不存 Key**）。
- `src/app/ingestFlow.ts`（直读/进一层/被拒 三分支）、`src/app/knowledgeFlow.ts`（分块 + 去重 + 扣额度）、`src/app/shareIntake.ts`（分享参数解析，纯函数）。额度模块已由 Plan 6 · Task 4 交付（`app/quota`）。
- `src/ui/practice*.ts` 扩屏；写口全部注入（`ingestUrl` / `collectCards` / `inbox` / `updateCard` / `addCard` / `addDeck`）。

**Spec:** `docs/PRD.md` §4.2（摄入管线 + CORS 事实表）、§4.5（练功模块）、§6.2（`Card.choices`/`Card.source.url`）、§6.6（额度）、§9（练功屏）、§11 D43/D45/D47、D09（收窄）、D38（Key 纪律）。

## Global Constraints

- **不做爬虫**：一次只处理玩家主动递进来的一份内容；不提供批量/定时/榜单；不绕过任何反爬或 CORS（失败就给人话理由）。正文只用于本次生成，**不落盘存档**（卡上只留来源链接）。
- **抓不到是常态路径**：公众号/知乎/腾讯新闻/澎湃实测无 CORS 头。失败时必须给出**当时真正可用**的下一步（粘贴正文 / 进待读清单），不许只报错。
- **额度是承诺**：200 张/天（与 AI 辅建卡**合并记账**）、单次 ≤20、长文自动分块一次掘完（屏上申报"本次发了 N 次请求"）；到顶**明确拒绝**，绝不静默截断。
- **产出不可信 + 人审闸门**：候选一律经 `core/llmParse.parseCards` 严格解析；采新卡候选**默认全不勾**（另给「全选」）；逐条写 `addCard`，来源标 `{type:'hotspot', url?}`（链接来）或 `{type:'llm'}`（纯文本来）。
- **Key 纪律不破**：`localStorage` 只有两个归属（`llmConfig.ts` 的 Key、`inboxStore.ts` 的清单）；清单里**绝不出现** Key；读取服务的 Key 与 LLM Key 同样只存 `localStorage`、掩码显示、不进备份。
- 分层守卫全绿；门禁五段全绿才 commit。

## Review Focus

1. **抓取失败的各种形状**：CORS 拒绝、离线/DNS、超时 20s、403/404/5xx、PDF/图片、1.5MB 以上大页、`data:`/`javascript:` 伪链接（→ 任务 1/3）。
2. **页面解析退化**：正文为空、全是导航、相对链接、`<article>` 缺失、超长截断（→ 任务 2/3）。
3. **额度边界**：剩 0、剩 3 要 20、跨天、同文重复生成、分块中途中止（→ 任务 4）。
4. **清单卫生**：坏 JSON、超 30 条、单条正文超 4000 码点、`localStorage` 写失败、清单里混进 Key（→ 任务 5）。
5. **"进入一层"的可达性**：给栏目页但直读被拒时，玩家仍有路可走（入箱 → 读完粘贴），不是撞墙（→ 任务 3/5/6）。

---

### Task 1: `platform/pageFetch` —— 唯一网页出口（含可选读取服务）

**Files:** Create `src/platform/pageFetch.ts`；Test `tests/platform/pageFetch.test.ts`

**Interfaces:**
```ts
export const PAGE_TIMEOUT_MS = 20_000;
export const PAGE_MAX_BYTES = 1_500_000;
export type PageFetchResult =
  | { readonly ok: true; readonly text: string; readonly contentType: string; readonly finalUrl: string; readonly via: 'direct' | 'reader' }
  | { readonly ok: false; readonly reason: string; readonly blocked: boolean };
export function fetchPage(url: string, opts?: {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly reader?: { readonly url: string; readonly key: string };
}): Promise<PageFetchResult>;
```
**口径：** 非 `http(s):` ⇒ 拒（`'只支持 http/https 链接。'`，`blocked:false`）；超时 20s ⇒ `'等太久了（20 秒没响应）。'`；403/404/5xx 各一句人话；`content-type` 非 `text/html`/`text/plain` ⇒ `'这不是一个网页。'`；超 `PAGE_MAX_BYTES` ⇒ 拒。`fetch` 抛 `TypeError` ⇒ **最可能是 CORS/网络拦截** ⇒ `blocked:true` + `'这个站点不允许网页直读（跨域限制）。'`。`reader` 在场时**只在直读 blocked 后**兜底：`GET ${reader.url}${encodeURIComponent(url)}`，仅在 `key` 非空时带 `Authorization`，成功 ⇒ `via:'reader'`（返回按纯文本处理）。不重试、不吞异常、**任何错误文案都不含 Key**。
- [ ] Step 1 失败测试：PF#1 正常 html ⇒ ok/direct；PF#2 抛 TypeError ⇒ blocked:true 且人话；PF#3 超时 ⇒ abort 真被调用（假 fetch 取证）；PF#4 403/404/500 各一句；PF#5 `application/pdf` ⇒ 拒；PF#6 `data:`/`file:`/`javascript:` ⇒ 拒且不调 fetch；PF#7 blocked ⇒ reader 兜底且 `via:'reader'`，请求头带的是 readerKey 而非 LLM Key；PF#8 reader 也失败 ⇒ 说明两条路都失败；PF#9 所有 reason 都不含 key 特征串
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(platform): fetchPage（唯一网页出口 + 可选读取服务）`

### Task 2: `platform/htmlDigest` —— HTML → 正文 + 条目

**Files:** Create `src/platform/htmlDigest.ts`；Test `tests/platform/htmlDigest.test.ts`

**Interfaces:**
```ts
export const ARTICLE_MAX_CHARS = 12_000;
export const LINKS_MAX = 40;
export interface PageLink { readonly title: string; readonly url: string }
export interface PageDigest { readonly title: string; readonly text: string; readonly links: readonly PageLink[] }
export function digestHtml(html: string, baseUrl: string): PageDigest;
```
**口径：** `DOMParser` 解析；删 `script/style/noscript/iframe/svg/nav/footer/header/aside/form`；正文容器优先 `article` → `main` → `[role="main"]` → `body`；空白折叠（段落间留 `\n`）；**按码点**截 `ARTICLE_MAX_CHARS`；`title` 取 `<title>` 或首个 `<h1>`（≤120 码点、剥控制字符）；`links` = `a[href]` 绝对化、只留 http(s)、按 url 去重、空标题跳过、**同源优先**、上限 40。**永不抛**。
- [ ] Step 1 失败测试：HD#1 剥脚本样式；HD#2 `article` 优先于 `body`；HD#3 相对链接绝对化；HD#4 非 http(s) 与空标题被过滤；HD#5 同 url 只留一条；HD#6 超长按码点截断（不切代理对）；HD#7 畸形 HTML 不抛；HD#8 同源链接在前
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(platform): htmlDigest（正文与条目抽取）`

### Task 3: `app/ingestFlow` —— 直读 / 进一层 / 被拒

**Files:** Create `src/app/ingestFlow.ts`；Test `tests/app/ingestFlow.test.ts`

**Interfaces:**
```ts
export const ARTICLE_MIN_CHARS = 200;
export type IngestResult =
  | { readonly kind: 'article'; readonly title: string; readonly text: string; readonly url: string; readonly via: 'direct' | 'reader' }
  | { readonly kind: 'links'; readonly title: string; readonly url: string; readonly links: readonly PageLink[] }
  | { readonly kind: 'blocked'; readonly url: string; readonly reason: string; readonly blocked: boolean };
export function ingestUrl(deps: {
  readonly fetchPage: (url: string) => Promise<PageFetchResult>;
  readonly digestHtml: (html: string, baseUrl: string) => PageDigest;
}, url: string): Promise<IngestResult>;
```
**口径：** fetch 失败 ⇒ 原样透传 `blocked`（含 `blocked` 标志供 UI 选文案）；`via==='reader'` ⇒ 直接 `article`（不喂 digest）；`via==='direct'` ⇒ digest 后 `text.length >= ARTICLE_MIN_CHARS` ⇒ `article`，否则 `links.length > 0` ⇒ `links`（**"进入一层"的落点**），再否则 `blocked` + `'这个页面里没找到正文，也没有可点的条目。'`。**永不抛**（digest 抛错也收敛成 blocked）。
- [ ] Step 1 失败测试：IG#1 正常文章；IG#2 reader 直通；IG#3 栏目页 ⇒ links（顺序保持）；IG#4 正文短又有条目 ⇒ links；IG#5 短且无条目 ⇒ blocked:false + 人话；IG#6 CORS 拦截 ⇒ blocked:true 透传；IG#7 digest 抛错 ⇒ 收敛成 blocked；IG#8 同 URL 两次调用结果一致
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(app): ingestFlow（直读/进一层/被拒）`

### Task 4: `app/knowledgeFlow` —— 分块生成 + 去重 + 扣额度

**Files:** Create `src/app/knowledgeFlow.ts`；Test `tests/app/knowledgeFlow.test.ts`

**Interfaces:**
```ts
export function chunkText(text: string, max?: number): readonly string[];   // 默认 4000，优先按段落切，按码点
export type CollectResult =
  | { readonly ok: true; readonly candidates: readonly CardCandidate[]; readonly quota: LlmQuota;
      readonly requests: number; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string };
export async function collectCards(deps: { readonly chat: ChatFn }, input: {
  readonly text: string; readonly deckName: string;
  readonly quota: LlmQuota | undefined; readonly want?: number;
  readonly nowMs: number; readonly tzOffsetMin: number;
}): Promise<CollectResult>;
```
**口径：** 先 `planCharge`；`granted === 0` ⇒ `{ok:false, reason:'今天的新知识额度用完了（200 张/天），明天再来。'}`；逐块 `suggestCards({chat}, {text: chunk, deckName, max: 剩余})`，**逐块扣减**并计数 `requests`；任一块失败 ⇒ 有产出则 `ok:true` + `truncated:true`（如实申报），无产出则 `ok:false`；合并后按 `front`（trim+小写）去重、总数封顶 `granted`；返回**尚未落盘的** `quota`（由宿主写回）。**不写存档、不 import persist**。`CardCandidate.choices`（Plan 6 已带）原样透传给候选列表。
- [ ] Step 1 失败测试：KF#1 短文本单块 `requests:1`；KF#2 9000 字符 ⇒ 3 块且不切坏代理对；KF#3 额度 0 ⇒ 一次 chat 都没调（假 chat 计数）；KF#4 剩 3 ⇒ `max` 传 3、产出 ≤3、`quota.cards` 精确 +3；KF#5 两块同 `front` ⇒ 去重后一条；KF#6 第二块失败但第一块有产出 ⇒ `ok:true`+`truncated:true`；KF#7 模型回垃圾 ⇒ 失败分支且 reason 人话；KF#8 `want>20` ⇒ 夹 20；KF#9 候选带 `choices`（透传不丢）；KF#10 `quota.cards` 与去重前生成数一致
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(app): knowledgeFlow（分块生成 + 去重 + 额度扣减）`

### Task 5: `platform/inboxStore` —— 待读清单（第二个 localStorage 归属）

**Files:** Create `src/platform/inboxStore.ts`；Modify `tests/tooling/llmSafety.test.ts`（LS#3 白名单 + 新判据）；Test `tests/platform/inboxStore.test.ts`

**Interfaces:**
```ts
export const INBOX_STORAGE_KEY = 'zx-xia.inbox.v1';
export const INBOX_MAX = 30;
export const INBOX_TEXT_MAX = 4000;
export interface InboxItem { readonly id: string; readonly title: string; readonly url?: string; readonly text?: string; readonly addedAt: number }
export function loadInbox(): readonly InboxItem[];                 // 坏值 ⇒ []（永不抛）
export function saveInbox(items: readonly InboxItem[]): boolean;   // 写失败 ⇒ false
export function clearInbox(): void;
```
**口径：** 入参逐条净化（`id`/`title` 非空、`url` 只留 http(s)、`text` 按码点截 4000、`addedAt` 非有限 ⇒ 0），超 30 条丢最旧；`saveInbox` 如实返回是否写入。**绝不存 Key**（新判据：本文件不得出现 `zx-xia.llm` / `apiKey` / `Authorization`）。
- [ ] Step 1 失败测试：IN#1 存取往返；IN#2 坏 JSON ⇒ []；IN#3 坏形状逐条剔除；IN#4 31 条 ⇒ 留 30 丢最旧；IN#5 `text` 超长按码点截；IN#6 `url:'javascript:…'` 该字段剔除；IN#7 假 storage 抛错 ⇒ load []/save false 且不抛；LS#3 白名单更新后其它文件出现 `localStorage` 必红；LS#3b `inboxStore.ts` 出现 `apiKey`/`zx-xia.llm` 必红（变异实测）
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(platform): inboxStore（待读清单，第二个 localStorage 归属）`

### Task 6: `ui/practiceCollect` —— 采新卡（链接/分享/粘贴 → 候选 → 选领域 → 入库）

**Files:** Modify `src/ui/practice.ts`（加第三个 tab「采新卡」）；Create `src/ui/practiceCollect.ts`；Test `tests/ui/practice.collect.test.ts`

**Interfaces（`PracticeDeps` 追加）:**
```ts
readonly ingestUrl?: (url: string) => Promise<IngestResult>;
readonly collectCards?: (input: { text: string; deckName: string; want?: number }) => Promise<CollectResult>;
readonly inbox?: { readonly load: () => readonly InboxItem[]; readonly save: (items: readonly InboxItem[]) => boolean; readonly clear: () => void };
readonly addCard?: (input: { front: string; back: string; deckId: string; id: string;
  sourceType?: 'llm' | 'hotspot'; url?: string; choices?: readonly string[] }) => Promise<LibraryResult<Card>>;
readonly addDeck?: (input: { name: string; id: string }) => Promise<LibraryResult<Deck>>;
readonly newId?: () => string;
readonly sharedInput?: { readonly url?: string; readonly text?: string; readonly title?: string } | null;   // Task 8 预填
```
**口径（DOM）：** `[data-ui="source-url"]` + `[data-ui="source-go"]`、`[data-ui="source-text"]`（`maxlength` 12000）+ `[data-ui="source-paste-go"]`、`[data-ui="ingest-status"]`、`[data-ui="ingest-links"]`（`button[data-ingest-link]` = **进入一层**）、`[data-ui="inbox-list"]`（`[data-inbox-item]` / `[data-inbox-use]` / `[data-inbox-drop]` + `[data-ui="inbox-clear"]`）、`[data-ui="cand-list"]`（`[data-candidate-check]`、正/背输入框）、`[data-ui="cand-select-all"]`、`[data-ui="cand-deck"]`、`[data-ui="cand-new-deck"]`、`[data-ui="cand-save"]`。
**行为：** `article` ⇒ 直接生成；`links` ⇒ 列条目等玩家点（点了抓第二条 = 进入一层）；`blocked` ⇒ 状态文案 + 该链接**自动存进清单**并提示"去读完回来粘贴"；生成后候选**默认全不勾** + 「全选」；「存入卡库」只存勾选的，`sourceType`/`url`/`choices` 正确；`collectCards` 失败或额度用尽 ⇒ 如实上屏、不动卡库。
- [ ] Step 1 失败测试：PC#1 article ⇒ 出候选；PC#2 links ⇒ 列条目且点条目触发第二次抓取（假 ingest 计数）；PC#3 blocked ⇒ 状态文案 + 清单多一条；PC#4 候选默认全不勾、只存勾选的；PC#5 入库 `sourceType`/`url`/`choices` 正确；PC#6 新建领域再入库、重名如实报错；PC#7 `collectCards` 失败 ⇒ 文案上屏且卡库不变；PC#8 额度文案随生成更新；PC#9「全选」按钮勾满；PC#10 DOM 全树不出现 `sk-` 形状明文
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(ui): 采新卡（摄入 → 候选 → 选领域 → 入库）`

### Task 7: 看旧卡就地编辑（`updateCard` 写口 + 行内编辑）

**Files:** Modify `src/app/library.ts`（`updateCard`）、`src/ui/practice.ts`/`practiceBrowse`、`src/ui/hostTypes.ts`、`src/ui/hostAdapters.ts`、`src/ui/host.ts`；Test `tests/app/libraryManage.test.ts`、`tests/ui/practice.test.ts`、`tests/ui/host.test.ts`

**Interfaces:**
```ts
export function updateCard(coord: Coordinator, input: { readonly cardId: string; readonly front: string; readonly back: string }): Promise<LibraryResult<Card>>;
```
**口径：** 与 `addCard` 同一套闸门（正/背非空、只读态拒绝、卡不存在 ⇒ 可上屏 reason），同值不重写（写放大纪律）；`choices` **不因改正/背而失效**——但若新 `back` 与某条 `choices` 相同 ⇒ **剔除该条**（避免出现"干扰项就是正确答案"）；UI：卡行 `[data-ui="card-edit"]` → 行内两个输入框 + `[data-ui="card-edit-save"]` / `[data-ui="card-edit-cancel"]`，保存失败如实 toast 并保留输入。
- [ ] Step 1 失败测试：LM#? 改内容成功且落盘、同值零写入、空值拒绝、只读态拒绝、卡不存在拒绝；LM#? 新 back 命中某条 choices ⇒ 该条被剔除，其余保留且 ≤5；PR#? 行内编辑保存后列表刷新为新值、取消不改动、失败保留输入
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(ui,app): 看旧卡就地编辑（updateCard）`

### Task 8: 分享进来（share_target + 预填）

**Files:** Create `src/app/shareIntake.ts`；Modify `manifest.webmanifest`、`src/main.ts`、`src/ui/host.ts`（预填透传）、`src/ui/practiceCollect.ts`；Test `tests/app/shareIntake.test.ts`、`tests/tooling/pwa.test.ts`

**Interfaces:**
```ts
export interface SharedInput { readonly url?: string; readonly text?: string; readonly title?: string }
export function parseShareQuery(search: string): SharedInput | null;
```
**口径：** 读 `share_url` / `share_text` / `share_title`；各自 trim、`text` 按码点截 1500、`url` 只接受 http(s)、三者皆空 ⇒ `null`。`manifest.webmanifest` 加 `share_target`（`method:'GET'`、`action:'./'`、`params` 名与解析器逐字一致）；`main.ts` boot 解析一次，有值 ⇒ 初始路由 `practice` 且采新卡预填（URL 直接开抓、text 填进粘贴框）。**只在装到主屏的 Android Chrome 有效**（README 如实写）。
- [ ] Step 1 失败测试：ST#1 三参数解析；ST#2 无参数 ⇒ null；ST#3 `javascript:` 丢弃；ST#4 超长按码点截 1500；ST#5 仅 title ⇒ 非 null；PWA#? manifest 的 `share_target.action`/`params` 与 `parseShareQuery` 键名逐字一致（改任一侧必红）
- [ ] Step 2 红 → Step 3 实现 → Step 4 绿 → Step 5 Commit `feat(pwa): 分享进来（share_target + 预填采新卡）`

### Task 9: 宿主接线 + 设置页（读取服务、额度显示）

**Files:** Modify `src/ui/hostTypes.ts`、`src/ui/hostAdapters.ts`、`src/ui/host.ts`、`src/platform/llmConfig.ts`（`readerUrl`/`readerKey`）、`src/ui/settings.ts`、`src/app/settingsFlow.ts`（复用 Plan 6 的 `setLlmQuota`）；Test `tests/ui/hostAdapters.test.ts`、`tests/ui/host.test.ts`、`tests/ui/settings.test.ts`、`tests/platform/llmConfig.test.ts`

**口径：** 装配层造并**显式透传**：`ingestUrl`（接 `fetchPage` + 现读配置里的 `reader`）、`collectCards`（`boundChat()` + 生成前读 `llmQuota`、生成后 `setLlmQuota` 写回）、`inbox`（`loadInbox/saveInbox/clearInbox`）、`updateCard`、`addCard`（扩展 `sourceType:'hotspot'` 与 `url` → `SourceInfo.url`）、`onDrill`（Plan 7 已接）。设置页 AI 分组追加：「读取服务 URL / Key」（掩码、说明"打开后你给的链接会经它转一手"）与「今日：生成剩 N / 200 · 判定剩 M / 300」。`LlmConfig` 的两个新字段同样**只存 localStorage、不进备份**。
- [ ] Step 1 失败测试：HS#? 真 `mountHost` 下练功屏拿到 `ingestUrl/collectCards/inbox/updateCard/addCard`（漏透传必红）；HS#? 分享预填时初始路由是 practice 且输入框有值；AD#? 生成后额度**真的写回**（`coord.snapshot().settings.llmQuota.cards` 增加，第二次生成用新额度）；AD#? `addCard` 带 `url` ⇒ 落 `source.url`，`sourceType:'hotspot'` ⇒ `{type:'hotspot'}`；ST#? 读取服务留空 ⇒ `fetchPage` 不带 reader，填了 ⇒ 带上且掩码显示；SL#? 设置页仍不回显任何明文 Key（既有判据不破）
- [ ] Step 2 红 → Step 3 实现 → Step 4 `npm run verify` 五段全绿 → Step 5 Commit `feat(ui,app): 练功宿主接线 + 读取服务与额度显示`

### Task 10: 真产物冒烟 + 文档

**Files:** Modify `tests/e2e/dist.boot.test.ts`（DB#8）、`README.md`

**口径：** DB#8 在**真产物**里：菜单点「练功」→ 屏上有额度条与三个 tab → 切到采新卡 → 断言"额度 0 时明确拒绝"这一路（先把 `llmQuota.cards` 写到 200 再点生成 ⇒ 屏上出现"额度用完"人话）。README 增「练功：看旧卡 / 采新卡」小节：CORS 事实表（哪些站能直读、哪些不行）、待读清单与分享用法（"只在 Android Chrome 装到主屏后可用"）、200 张/天合并额度、以及"不做爬虫"的边界。
- [ ] Step 1 写 DB#8（先红）→ Step 2 补齐 → Step 3 `npm run verify` 全绿 → Step 4 README 定稿 → Step 5 Commit + 推送 → 确认 CI/Deploy 双绿

---

**执行顺序：** 1 → 2 → 3（抓取三件套）→ 4（生成与额度）→ 5（清单）→ 6 → 7（屏）→ 8（分享）→ 9（接线）→ 10（产物与文档）。
**可裁项**：Task 9 里"读取服务"三处（`LlmConfig` 两字段、设置页两行、`fetchPage` 的 `reader` 入参）是**可选功能**（默认关）；若想先只上"粘贴 + 分享 + 少数可直读站点"，删掉这三处即可，其余任务不受影响。

---

### Task 11: 现场反馈修正 —— 体积上限与"读不到时的下一步"（D48）

**Files:** Modify `src/platform/pageFetch.ts`、`src/ui/practiceCollect.ts`、`src/ui/styles.css`；Test `tests/platform/pageFetch.test.ts`、`tests/ui/practice.collect.test.ts`

**背景（用户拿真实链接试出来的）**：`https://mp.weixin.qq.com/s/WeCvRp1bx6JeeI7bycVPQQ`
提示"这个站点不允许网页直读（跨域限制）"。核实：该响应 200、`content-type: text/html`、
**无任何 CORS 头** ⇒ 提示是实话，浏览器确实读不到。但两处该改：① 实测该页原始 HTML **3.63MB**，
而抓取层上限只有 1.5MB（解析实测 90ms 能抽出 4245 字干净正文）⇒ 旧上限把"读取服务返回原始 HTML"
这条兜底路也堵死了；② 读不到时界面只给原因，没把下一步递到玩家手里。

**口径：**
- `PAGE_MAX_BYTES` 1.5MB → **4MB**（覆盖公众号单篇 1–4MB 的实际体量），错误文案里的数字从常量取；
- `article` 之外的分支（`blocked`）追加：`[data-ui="ingest-open"]`「打开原文去复制」（打开该链接）、
  自动聚焦粘贴框、以及一行指向"粘贴正文 / 可选读取服务"的提示；
- 「打开原文」走注入的 `openUrl`（缺省 `window.open(url, '_blank', 'noopener')`），以便测试取证。

- [x] Step 1 失败测试：PF#5c 4MB 以内接受、4MB 以上拒绝（文案含"太大"）；PC#11 被拦后出现「打开原文去复制」且点了真的打开该链接、粘贴框自动获得焦点
- [x] Step 2 红 → Step 3 实现 → Step 4 `npm run verify` 五段全绿 → Step 5 Commit（`1652fe0`）+ 推送 → CI/Deploy 双绿，线上产物已核对含「打开原文去复制」「粘到下面的框里」

---

### Task 12: 卡组页也开一个「采新卡」入口（D49）

**Files:** Modify `src/ui/decks.ts`、`src/ui/host.ts`、`tests/ui/decks.test.ts`（或 `decks.author.test.ts`）、`tests/ui/host.test.ts`；`README.md`

**口径：**
- 卡组页在「AI 辅建卡」下方并排一块 `[data-ui="collect-entry"]`：一句话（"给链接或粘正文；
  抓不到会给你下一步；和上面的 AI 辅建卡共用每日额度"）+ 按钮 `[data-ui="collect-open"]`
  「去练功 → 采新卡」；
- 只在**宿主给了 `onCollect`** 时显示（缺省不显示点了没反应的入口，与全仓其它入口同款纪律）；
- 宿主：`onCollect` = 切到 `practice` 路由并让练功屏**直接开在采新卡分区**（不是落在首页让人自己找）；
  从菜单进练功屏时仍默认落在「看旧卡」；
- 不复制任何生成逻辑：第二个入口只是**导航 + 落地分区**。

- [x] Step 1 失败测试：**DC#E1** 注入 `onCollect` ⇒ 入口可见、文案齐全、点击真的调它；**DC#E2** 缺省 ⇒ 收起；**HS#E2** 从卡组页点入口 ⇒ 落在练功屏且**采新卡分区已打开**（`practice-collect` 存在）、随后从菜单进练功屏 ⇒ 仍落在「看旧卡」（落点记忆不残留）；**HS#E3** 没接采集口 ⇒ 卡组页入口收起、接上就露出
- [x] Step 2 红 → Step 3 实现 → Step 4 `npm run verify` 五段全绿 → Step 5 Commit + 推送 → 确认 CI/Deploy 双绿
- [x] 变异自检（每条都真的会红）：① `hidden: false` 写死 ⇒ DC#E2/HS#E3 红；② 入口只切路由不切分区 ⇒ HS#E2 红；③ 从菜单进练功屏沿用上次落点 ⇒ HS#E2 红；④ 宿主无条件透传 `onCollect` ⇒ HS#E3 红
- [x] 真产物兜底：**DB#9** 在 `dist/` 里从菜单进卡组 → 入口可见 → 点进去 `tab-collect` 已按下且 `practice-collect` 挂上（`main.ts` 漏传采集口 ⇒ 红）

---

### Task 13: 练功屏 —— 显式「换领域」+ 多领域合练（D50）

**Files:** Modify `src/ui/practice.ts`、`src/ui/styles.css`；Test `tests/ui/practice.test.ts`、`tests/e2e/dist.boot.test.ts`；`README.md`、`docs/PRD.md`

**现场反馈（原话）：**「看旧卡选择领域后找不到后退的按钮，不知道怎么选其他领域，并且，希望练功时领域也可以多选，不然部分领域卡数不够」

**口径（PRD D50，逐条钉住）：**
- 卡列表顶部加显式 `[data-ui="deck-switch"]`「← 换领域」+ 当前领域名 `[data-ui="deck-view-title"]`；
  屏顶「返回」的两段式语义不变（卡列表 → 领域列表 → 菜单），换领域**不清勾选**；
- 本次练功可纳入**多个领域**：`openedDeckIds`（已纳入）+ `picked`（显式勾）+ `dropped`（显式取消）；
- 选择模型（每次渲染**派生**，不缓存）：卡池 = 已纳入领域的卡；`shouldPickByDefault` 且未被 `dropped`
  的卡自动补齐；**显式勾的优先占位**；上限**合计** 25；超出部分如实计 `cappedOut`；
- 领域行显示「本次已选 N 张」，已纳入的行多一个 `[data-deck-remove]`「移出本次」（该领域整块退出，
  它的勾选一并清掉）；底部 `[data-ui="drill-bar"]` 常驻「本次已选 N / 25 · 来自 M 个领域」+
  `[data-ui="picks-clear"]`「清空勾选」+ `[data-ui="drill-start"]`「开始练功」——**领域列表上也能直接开练**；
- 不动 core/app：`startFight` 的 `cardIds` 分支本来就"原样成池、保序"，跨领域卡池天然支持。

- [x] Step 1 失败测试：PR#17 换领域入口 + 勾选保留；PR#18 两域合练交给 `onDrill` 的是并集且文案报"来自 2 个领域"；PR#19 「移出本次」只移该域；PR#20 上限是**跨域合计**且如实报"还有 N 张没进池"；PR#21 领域列表上就能开练；PR#22 清空勾选归零；PR#23 显式取消的卡不被自动补齐重新勾上
- [x] Step 2 红 → Step 3 实现（先把底部条改成常驻 + 派生式 `selection()`）→ Step 4 `npm run verify` 五段全绿 → Step 5 Commit + 推送 → 确认 CI/Deploy 双绿
- [x] 变异自检（6 条**全部**会红）：① 换领域时清空勾选；② 上限按**每个领域**各算 25；③ 移除领域时不清该域勾选记录；④ `dropped` 不生效（取消的又被自动补齐）；⑤ 底部条只在卡列表里显示；⑥ 卡列表里没有「换领域」入口
- [x] 真产物扩展：**DB#7** 改成「打开 A → 换领域 → 打开 B → 手动勾一张 → 底部条报『来自 2 个领域』→ 开练」

---

### Task 14: 装到主屏真的能装成应用（D51）

**现场问题（用户原话）：**「装到主屏这事如何操作？」——查这一步时量出两处硬伤。

**量到的事实（都是线上实测，不是推断）：**
- 线上清单地址是 `…/bundle/manifest-JjRQfse6.webmanifest`（Vite 把仓库根的清单当资源改名塞进 `bundle/`），
  而清单里 `start_url` / `scope` / `share_target.action` 都是 `./`、图标是 `./assets/sprites/hero.png`
  ⇒ 按 manifest 自身位置解析：`…/bundle/assets/sprites/hero.png` **404**、`…/bundle/` **404**；
  真实素材 `…/assets/sprites/hero.png` 是 **200**；
- 清单只声明 32×32 / 64×64 图标 ⇒ 低于 Chrome 的安装判据（Lighthouse 192 / Chromium 内部 144px），
  只会得到**书签快捷方式**，而 `share_target`（D47 承诺的「分享进来」）**只在 WebAPK 上存在**。

**口径与改动：**
- 清单搬到 `public/manifest.webmanifest`（构建后落在站点根，相对 URL 才指向真正的入口与素材）；
- 图标三张：`assets/icons/icon-192.png`、`icon-512.png`、`icon-maskable-512.png`，
  由 `pixel-art/app-icon/build.py` 从 64×64 像素原画整数放大生成（`--check` 幂等）；
- 清单 `icons[]` 换成上面三张（`purpose` 分 any / maskable）。

**Files:** Add `public/manifest.webmanifest`、`pixel-art/app-icon/build.py`、`assets/icons/*.png`；
Modify `tests/tooling/pwa.test.ts`、`assets/README.md`、`README.md`、`docs/PRD.md`

- [x] Step 1 失败测试：PW#2 声明尺寸必须等于 PNG 真实像素；PW#2b 至少一张 ≥192 的 any + 一张 maskable；
      PW#2c 清单必须在 `public/`、仓库根不许有第二份
- [x] Step 2 红 → Step 3 实现 → Step 4 `npm run verify` 五段全绿 → Step 5 Commit + 推送 → 确认 CI/Deploy 双绿
- [x] 变异自检（5 条全部会红）：① 只声明 64×64 图标；② `sizes` 与真实像素不符；③ 去掉 maskable；
      ④ 清单搬回仓库根；⑤ 两份清单并存（index.html 又会指向被改名的 bundle 那份）
- [ ] 真机验收（**需要玩家本人**）：手机上按 README「装到主屏」四步走一遍，确认①菜单里出现带"安装"字样的项、
      ②主屏出现闪卡图标、③分享面板里出现「知识侠客」。我没有屏幕读取权限（设备回"你拒绝了这次屏幕读取"），
      这三条不能由我代劳，也不在 CI 覆盖面内 —— 如实登记为"未经目视核对"。
