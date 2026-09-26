/** memoryStore 跑共享契约套件（与 idbStore 同一套断言）。 */

import type { GameStorage } from '@platform/storage';
import { createMemoryStorage } from '@platform/memoryStore';
import { runStorageContractSuite } from './storageContract';

runStorageContractSuite('memoryStore', async () => {
  return async (): Promise<GameStorage> => createMemoryStorage();
});
