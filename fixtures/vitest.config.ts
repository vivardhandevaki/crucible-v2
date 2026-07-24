import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fixtures',
    include: ['src/**/*.test.ts'],
  },
});
