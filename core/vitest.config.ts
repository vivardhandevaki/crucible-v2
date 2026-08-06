import { defineConfig } from 'vitest/config';

// Unit tests are colocated as `src/**/*.test.ts` (architecture.md §9).
// Integration tests against fixtures/toy-repo land in `test/` from P1 onward.
export default defineConfig({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Core's JVM flow files run long synchronous Maven/Java subprocesses. Keep
    // those files out of parallel workers so Vitest's worker RPC heartbeat
    // cannot time out on a busy CI runner.
    fileParallelism: false,
  },
});
