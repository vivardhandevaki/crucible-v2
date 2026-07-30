import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fixtures',
    include: ['src/**/*.test.ts'],
    // JVM conformance scripts intentionally target shared fixture paths; serialize files.
    fileParallelism: false,
  },
});
