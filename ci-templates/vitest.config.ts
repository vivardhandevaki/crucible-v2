import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ci-templates',
    include: ['src/**/*.test.ts'],
  },
});
