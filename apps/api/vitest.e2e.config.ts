import { defineConfig } from 'vitest/config';

/**
 * Phase 14 end-to-end suites (tests/e2e). Run via `npm run test:e2e`.
 *
 * Deliberately separate from vitest.config.ts (unit/integration):
 *  - the suites exercise the real browser and the real BullMQ retry backoff
 *    (5s, up to 3 attempts), so they need long timeouts;
 *  - they share one PostgreSQL database and one BullMQ queue, so test FILES
 *    must never run in parallel.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Strictly one test FILE at a time: the suites share one BullMQ queue
    // (and drain it for isolation), so parallel files would eat each other's
    // jobs and cause waitFor timeouts.
    fileParallelism: false,
    poolOptions: { threads: { singleThread: true } },
    maxThreads: 1,
    minThreads: 1,
  },
});
