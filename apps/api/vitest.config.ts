import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Phase 14 E2E suites live in tests/e2e and run via their own config
    // (npm run test:e2e) - they share a BullMQ queue and need a real browser.
    // Phase 15B's gated REAL Greenhouse suite lives in tests/real and runs
    // ONLY via its own config (npm run test:greenhouse:real) - it can submit
    // a real application and must never run in a default test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/real/**'],
    // The suite mixes database integration with Playwright-backed provider
    // tests. Under full parallel load these exceed the 5s default, which
    // caused intermittent timeouts (and follow-on state flakes) - including
    // the known pre-existing provider re-inspection flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Bound parallelism: one worker per file each open a Prisma pool and the
    // provider suites launch browsers, which saturated 8-CPU machines.
    maxThreads: 4,
    minThreads: 1,
  },
});
