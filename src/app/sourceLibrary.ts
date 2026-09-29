/**
 * sourceLibrary.ts —— 采新卡的**内置来源库**与合并规则（D53）。
 *
 * ## 这个库是怎么来的（不是拍脑袋列出来的）
 * 每一条都按 `docs/SOURCES.md` 的实测表过筛：**网络可达** + **响应里有 ACAO** 两条都过，
 * 才配 `direct: true` 进"直连可读"那一档。剩下那些"可达但没有 CORS"的（OpenAI News、
 * DeepMind、arXiv、量子位…）**照样留着**，但标 `direct: false` —— 界面会如实写"需读取服务"，
 * 而不是做出一个点了必然报错的入口。
 *
 * ## 为什么内置库要有"标准领域"这个概念
 * 用户要的是"先固化一个标准领域，以后能加别的领域"。所以数据形状是
 * `SourceDomain[]`，`BUILTIN_DOMAINS` 现在是**一个**领域（`ai-ml`：AI / 机器学习前沿），
 * 以后加领域就是往这个数组里再加一组 —— 不需要动任何逻辑。
 *
 * ## 玩家自己维护
 * 合并规则（纯函数，可测）：
 * - 内置领域中，被玩家删掉的源按 `removed` 墓碑过滤（删了就不会因为刷新又冒出来）；
 * - 玩家加的源进一个「我的来源」领域（`mine`），按链接去重（重复加同一个链接只留一条）；
 * - 内置源与玩家源同名同链接不冲突（id 前缀不同）。
 */

import { itemKeyOf, type SourceDef, type SourceDomain, type SourceKind } from '@core/sourceItem';

/** 玩家自定义那一组的固定 id 与名字。 */
export const MY_DOMAIN_ID = 'mine';
export const MY_DOMAIN_NAME = '我的来源';

/**
 * 内置领域：AI / 机器学习前沿。
 *
 * `note` 写的是"这个源能给你什么卡"，不是站点的自我介绍 —— 玩家选源的时候只关心这个。
 */
export const BUILTIN_DOMAINS: readonly SourceDomain[] = [
  {
    id: 'ai-ml',
    name: 'AI / 机器学习前沿',
    sources: [
      /* ---- 直连可读（实测有 ACAO）：点了真的出内容 ---- */
      {
        id: 'hf-papers',
        name: 'HF Daily Papers',
        url: 'https://huggingface.co/api/daily_papers',
        kind: 'hf-papers',
        direct: true,
        note: '每天的热门论文（Papers with Code 的继任者）：标题 + 摘要随响应一起回来，直接能生成卡',
      },
      {
        id: 'gh-vllm',
        name: 'vLLM 版本发布',
        url: 'https://api.github.com/repos/vllm-project/vllm/releases?per_page=10',
        kind: 'gh-releases',
        direct: true,
        note: '推理工程：每个版本的高亮与改动（更新说明正文很全，长文会自动分块）',
      },
      {
        id: 'gh-transformers',
        name: 'transformers 版本发布',
        url: 'https://api.github.com/repos/huggingface/transformers/releases?per_page=10',
        kind: 'gh-releases',
        direct: true,
        note: '生态工具链的版本要点',
      },
      {
        id: 'gh-deepseek',
        name: 'DeepSeek 仓库动态',
        url: 'https://api.github.com/orgs/deepseek-ai/repos?sort=updated&per_page=20',
        kind: 'gh-org-repos',
        direct: true,
        note: 'DSH / DeepSeek 全系仓库（含 deepseek-harness）最近更新了哪些',
      },
      {
        id: 'hf-models',
        name: 'HF 热门模型',
        url: 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=20',
        kind: 'hf-models',
        direct: true,
        note: '开源模型、LoRA、微调、量化：最近大家在跑什么',
      },
      {
        id: 'hn-front',
        name: 'Hacker News 头条',
        url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20',
        kind: 'hn',
        direct: true,
        note: '全球开发者当天在讨论什么（含分数与评论数；正文要去原文看）',
      },
      {
        id: 'github-blog',
        name: 'GitHub Blog',
        url: 'https://github.blog/feed/',
        kind: 'rss',
        direct: true,
        note: '开源生态、新工具、工程最佳实践',
      },
      {
        id: 'lilianweng',
        name: "Lil'Log（Lilian Weng）",
        url: 'https://lilianweng.github.io/index.xml',
        kind: 'rss',
        direct: true,
        note: 'Agent / RAG / 大模型综述，篇篇值得做成卡（注意：/feed.xml 是 404，正确端点是 /index.xml）',
      },
      {
        id: 'databricks',
        name: 'Databricks Blog',
        url: 'https://databricks.com/feed',
        kind: 'rss',
        direct: true,
        note: '大数据与 LLM 数据工程',
      },

      /* ---- 可达但**没有 CORS**（实测）：标「需读取服务」，界面说实话，不假装能读 ---- */
      {
        id: 'openai-news',
        name: 'OpenAI 官方新闻',
        url: 'https://openai.com/news/rss.xml',
        kind: 'rss',
        direct: false,
        note: '模型 / Agent SDK / 产品公告（实测无 ACAO ⇒ 需读取服务或复制原文）',
      },
      {
        id: 'hf-blog',
        name: 'Hugging Face Blog',
        url: 'https://huggingface.co/blog/feed.xml',
        kind: 'rss',
        direct: false,
        note: '开源模型、微调、推理工程（实测无 ACAO）',
      },
      {
        id: 'deepmind',
        name: 'Google DeepMind',
        url: 'https://deepmind.google/blog/feed/basic/',
        kind: 'rss',
        direct: false,
        note: 'Gemini、多模态、智能体研究（实测无 ACAO）',
      },
      {
        id: 'arxiv-cs-ai',
        name: 'arXiv cs.AI',
        url: 'https://rss.arxiv.org/rss/cs.AI',
        kind: 'rss',
        direct: false,
        note: 'AI 论文每日更新（实测无 ACAO；每天 300+ 条，用读取服务时建议先缩小范围）',
      },
      {
        id: 'arxiv-cs-lg',
        name: 'arXiv cs.LG',
        url: 'https://rss.arxiv.org/rss/cs.LG',
        kind: 'rss',
        direct: false,
        note: '机器学习论文每日更新（实测无 ACAO）',
      },
      {
        id: 'tds',
        name: 'Towards Data Science',
        url: 'https://towardsdatascience.com/feed',
        kind: 'rss',
        direct: false,
        note: '实战教程、时序、因果推断、Uplift（实测无 ACAO）',
      },
      {
        id: 'latent-space',
        name: 'Latent Space',
        url: 'https://www.latent.space/feed',
        kind: 'rss',
        direct: false,
        note: 'Agent 工程访谈（实测无 ACAO）',
      },
      {
        id: 'qbitai',
        name: '量子位',
        url: 'https://www.qbitai.com/feed',
        kind: 'rss',
        direct: false,
        note: '国内 AI 资讯（可达但实测无 ACAO）',
      },
    ],
  },
];

/** 玩家自己维护的那部分（存本机 localStorage，见 `platform/sourceStore`）。 */
export interface UserLibrary {
  /** 玩家加的源。 */
  readonly added: readonly SourceDef[];
  /** 被玩家删掉的内置源 id（墓碑：删了不许再冒出来）。 */
  readonly removed: readonly string[];
}

export const EMPTY_USER_LIBRARY: UserLibrary = { added: [], removed: [] };

/** 内置库里全部源的 id（"恢复推荐来源"要按它清墓碑）。 */
export function builtinSourceIds(): string[] {
  return BUILTIN_DOMAINS.flatMap((d) => d.sources.map((s) => s.id));
}

/** 玩家源去重（同链接只留一条；后者覆盖前者，方便"改了名字再存一次"）。 */
function dedupeAdded(added: readonly SourceDef[]): SourceDef[] {
  const byKey = new Map<string, SourceDef>();
  for (const s of Array.isArray(added) ? added : []) {
    if (!s || typeof s.url !== 'string' || typeof s.id !== 'string') continue;
    byKey.set(itemKeyOf(s), s);
  }
  return [...byKey.values()];
}

/**
 * 合并出屏上要显示的领域列表：内置（去掉墓碑）+「我的来源」（有货才出现）。
 *
 * 纯函数：给同样的 (内置, 玩家) 一定得到同样的结果 —— 玩家那份从 localStorage 读，
 * 损坏时调用方传 `EMPTY_USER_LIBRARY`（读存储的地方永不抛，见 platform/sourceStore）。
 */
export function mergeLibrary(user: UserLibrary = EMPTY_USER_LIBRARY): SourceDomain[] {
  const removed = new Set((Array.isArray(user?.removed) ? user.removed : []).map((x) => String(x)));
  const domains: SourceDomain[] = BUILTIN_DOMAINS.map((d) => ({
    id: d.id,
    name: d.name,
    sources: d.sources.filter((s) => !removed.has(s.id)),
  }));
  const added = dedupeAdded(user?.added ?? []);
  if (added.length > 0) {
    domains.push({ id: MY_DOMAIN_ID, name: MY_DOMAIN_NAME, sources: added });
  }
  return domains;
}

/** 加一个源（不可变返回：UI 只负责把结果交给存储）。 */
export function addSource(user: UserLibrary, source: SourceDef): UserLibrary {
  const added = dedupeAdded([...(user?.added ?? []), source]);
  // 玩家加回了一个曾经删掉的内置源？把墓碑撤掉（他的意图是"我要它"）
  const removed = (user?.removed ?? []).filter((id) => id !== source.id);
  return { added, removed };
}

/**
 * 删一个源。内置源记墓碑（下次合并时过滤掉），玩家源直接移出 `added`。
 * 返回的 `UserLibrary` 里**不会**同时出现"墓碑 + 同名源"。
 */
export function removeSource(user: UserLibrary, sourceId: string): UserLibrary {
  const added = (user?.added ?? []).filter((s) => s.id !== sourceId);
  const isBuiltin = builtinSourceIds().includes(sourceId);
  const removed = isBuiltin
    ? [...new Set([...(user?.removed ?? []), sourceId])]
    : (user?.removed ?? []).filter((id) => id !== sourceId);
  return { added, removed };
}

/** 「恢复推荐来源」：清掉全部墓碑（玩家自己加的保留）。 */
export function restoreBuiltins(user: UserLibrary): UserLibrary {
  return { added: dedupeAdded(user?.added ?? []), removed: [] };
}

/** 这个源是不是内置的（UI 用它决定文案"移出推荐"还是"删除"）。 */
export function isBuiltinSource(sourceId: string): boolean {
  return builtinSourceIds().includes(sourceId);
}

/** 给"加源"表单用的类型选项（顺序固定，UI 直接遍历）。 */
export const KIND_OPTIONS: readonly SourceKind[] = ['rss', 'hf-papers', 'gh-releases', 'gh-org-repos', 'hf-models', 'hn'];
