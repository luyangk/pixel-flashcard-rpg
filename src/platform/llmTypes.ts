/**
 * llmTypes.ts —— Plan 5 · T2：LLM 面的**共享类型**（单独成文件，避免循环依赖）。
 *
 * `llmConfig` 要返回 `LlmConfig`、`llmHttp` 要消费它，而 `app/llmFlow` 只依赖 `ChatResult`
 * 与消息形状。类型集中在此后，三个模块之间只有单向的类型边（config → types ← http），
 * 运行期零耦合（`verbatimModuleSyntax` 下 type-only import 编译后完全消失）。
 */

/** 一份 LLM 配置。`apiKey` 为空串 = 未设置。 */
export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** 一条对话消息（只用到 system/user 两种角色——本作不做多轮）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/**
 * 一次调用的结果面。`reason` 是**可直接上屏的大白话**，且**绝不含 Key**。
 */
export type ChatResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };
