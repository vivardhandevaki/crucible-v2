import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapter-java-junit',
    include: ['src/**/*.test.ts'],
    // The resolve conformance test builds a Maven jar and compiles the JVM
    // fixtures; give it room beyond vitest's default per-test timeout.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
