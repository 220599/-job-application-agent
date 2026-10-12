import { defineConfig } from 'vitest/config';

/**
 * Phase 15B - GATED controlled real Greenhouse submission suite.
 *
 * This config is used ONLY by `npm run test:greenhouse:real`. It is
 * deliberately separate from vitest.config.ts (unit/DB tests) and
 * vitest.e2e.config.ts (Phase 14/15A mock E2E suites) so the one suite that
 * can submit a REAL application can never run inside `npm test` or
 * `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/real/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A live submission against a real Greenhouse form is slow: page load,
    // fill, submit, and the full confirmation-observation window.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One live submission at a time, never in parallel with anything else.
    fileParallelism: false,
    poolOptions: {
      threads: { maxThreads: 1, minThreads: 1 },
    },
  },
});
