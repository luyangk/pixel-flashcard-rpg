/**
 * 存储抽象层 —— 纯本地架构（PRD §6.1）的落点。
 *
 * GameStorage 是存档读写的唯一门面；idbStore / memoryStore 是其两个实现，
 * 行为由同一套契约测试约束（tests/platform/storageContract.ts）。
 *
 * 降级策略（Review Focus #3）：IndexedDB 不可用——全局缺失、open() 同步抛错
 * （部分隐私模式）、或请求 onerror（权限/版本冲突）——一律回落 memoryStore。
 * 调用方通过 kind 字段判别当前存储形态并决定 UI 警告文案
 * （PRD 功能文案大白话："当前浏览器无法保存进度，关闭页面会丢失"），
 * 绝不静默假装已持久化。
 */

import type { SaveFile } from '@core/types';
import { createMemoryStorage } from './memoryStore';
import { openIdbStorage } from './idbStore';

/** 存档存储门面。load 无档时返回 null；save/clear 幂等。 */
export interface GameStorage {
  load(): Promise<SaveFile | null>;
  save(f: SaveFile): Promise<void>;
  clear(): Promise<void>;
  /** 可判别字段：'idb' = 已持久化；'memory' = 仅本页生命周期内有效。 */
  readonly kind: 'idb' | 'memory';
}

/**
 * 探测并打开存储：优先 IndexedDB（库名 dbName，单 store `saves`，键 `'current'`），
 * 任一环节失败则降级 memoryStore。本函数自身永不 reject。
 */
export async function openStorage(dbName?: string): Promise<GameStorage> {
  try {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      return createMemoryStorage();
    }
    return await openIdbStorage(dbName);
  } catch {
    // open 抛错 / onerror / blocked 均落入此处——显式降级，由 kind 供上层判别
    return createMemoryStorage();
  }
}
