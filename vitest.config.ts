import { defineConfig } from 'vitest/config';

// 测试一律放在各包的 tests/ 目录（AGENTS.md §4.2、§7），src 下不放测试。
export default defineConfig({
  test: {
    include: ['apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/generated/**'],
    },
  },
});
