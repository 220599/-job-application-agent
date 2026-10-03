import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
