import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 与 tsconfig.json 的 paths 保持一致：@core/* → src/core/*，@platform/* → src/platform/*
export default defineConfig({
  resolve: {
    alias: {
      '@core/': fileURLToPath(new URL('./src/core/', import.meta.url)),
      '@platform/': fileURLToPath(new URL('./src/platform/', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Task 1 阶段仓库尚无测试文件；后续任务补齐用例后此行可移除
    passWithNoTests: true,
  }
});
