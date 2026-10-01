import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // Browser tests share state (launched browser, mock server) - keep them sequential
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
