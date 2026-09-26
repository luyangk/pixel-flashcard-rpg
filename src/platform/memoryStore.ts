/**
 * memoryStore —— GameStorage 的内存实现，也是 IndexedDB 不可用时的降级路径。
 *
 * 与 idbStore 遵守完全相同的契约（含 save 深拷贝隔离外部 mutate），
 * 差别仅在生命周期：随 JS 堆一起蒸发。故 kind='memory'，调用方须提示用户。
 */

import type { SaveFile } from '@core/types';
import type { GameStorage } from './storage';

/** 创建一个全新的空内存存储（每个实例自持一份状态，互不可见）。 */
export function createMemoryStorage(): GameStorage {
  let current: SaveFile | null = null;
  return {
    kind: 'memory',
    async load(): Promise<SaveFile | null> {
      // 读出侧同样深拷贝：调用方改动返回值不得污染存储本体
      return current === null ? null : structuredClone(current);
    },
    async save(f: SaveFile): Promise<void> {
      current = structuredClone(f);
    },
    async clear(): Promise<void> {
      current = null;
    },
  };
}
