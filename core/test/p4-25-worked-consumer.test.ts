import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import { detectAnswers } from '../src/commands/init.cli.js';

const coreRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monorepo = dirname(coreRoot);
const javaAdapterRoot = join(monorepo, 'adapters', 'java-junit', 'package');
const stubAdapterRoot = join(monorepo, 'adapters', 'stub');
let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('P4-25 worked initialized consumers', () => {
  it('generates the target-owned authority workflow for generic and Spring/JUnit consumers', async () => {
    for (const fixture of ['toy-repo', 'spring-hello-world']) {
      const root = mkdtempSync(join(tmpdir(), 'crucible-p4-25-consumer-'));
      roots.push(root);
      cpSync(join(monorepo, 'fixtures', fixture), root, { recursive: true });
      await init(
        {
          root,
          answers:
            fixture === 'toy-repo'
              ? { adapter: 'stub', runners: ['stub'], paths: ['**/*.ts'], unitCommand: 'npm test' }
              : detectAnswers(root),
          adapterPackage:
            fixture === 'toy-repo'
              ? {
                  manifestPath: join(stubAdapterRoot, 'crucible-adapter.yaml'),
                  executablePath: join(stubAdapterRoot, 'dist', 'cli.js'),
                }
              : {
                  manifestPath: join(javaAdapterRoot, 'crucible-adapter.yaml'),
                  executablePath: join(javaAdapterRoot, 'java-junit.mjs'),
                },
        },
        { confirmOverwrite: () => true },
      );
      const workflow = parseYaml(
        readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8'),
      ) as { jobs?: Record<string, unknown> };
      expect(workflow.jobs?.authority, fixture).toBeDefined();
      expect(workflow.jobs?.verify, fixture).toBeDefined();
    }
  });
});
