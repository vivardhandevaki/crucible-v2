import { defineConfig } from 'vitest/config';

// Unit tests are colocated as `src/**/*.test.ts` (architecture.md §9).
// Integration tests against fixtures/toy-repo land in `test/` from P1 onward.
export default defineConfig({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
