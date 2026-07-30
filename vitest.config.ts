import { defineConfig } from 'vitest/config';

// Root config aggregates every workspace as a vitest project, so `npm test`
// from the repo root runs all suites while each workspace keeps its own config
// for `npm test -w <workspace>`. Testing contract: architecture.md §9.
export default defineConfig({
  test: {
    projects: ['core', 'adapters/stub', 'adapters/java-junit', 'fixtures', 'ci-templates'],
  },
});
