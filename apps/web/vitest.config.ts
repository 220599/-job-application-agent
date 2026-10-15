import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // Next's tsconfig uses `jsx: preserve`; vitest must apply the transform.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': src },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx'],
  },
});
