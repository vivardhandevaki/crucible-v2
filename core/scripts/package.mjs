// Create the self-contained project-local Crucible release directory. The
// inputs are built workspace JavaScript; TypeScript/source-only trees are
// intentionally rejected by packageFrameworkDistribution.

import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { packageFrameworkDistribution } from '../dist/framework/distribution.js';

const coreRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(coreRoot);
const prepared = mkdtempSync(join(tmpdir(), 'crucible-framework-release-'));

try {
  mkdirSync(join(prepared, 'dist', 'cli'), { recursive: true });
  await build({
    entryPoints: [join(coreRoot, 'dist', 'cli', 'bin.js')],
    outfile: join(prepared, 'dist', 'cli', 'bin.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    sourcemap: false,
    banner: {
      js: 'import { createRequire as __crucibleCreateRequire } from "node:module"; const require = __crucibleCreateRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: [
      join(repositoryRoot, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'),
    ],
    outfile: join(prepared, 'openspec.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    legalComments: 'none',
    sourcemap: false,
  });
  cpSync(join(coreRoot, 'assets'), join(prepared, 'assets'), { recursive: true });
  cpSync(join(repositoryRoot, 'schemas'), join(prepared, 'assets', 'schemas'), {
    recursive: true,
    filter: (path) =>
      !path.includes('/dist') && !path.endsWith('.ts') && !path.endsWith('vitest.config.ts'),
  });
  mkdirSync(join(prepared, 'assets', 'ci-templates'), { recursive: true });
  for (const name of ['crucible.yml', 'crucible-java-junit.yml']) {
    copyFileSync(
      join(repositoryRoot, 'ci-templates', name),
      join(prepared, 'assets', 'ci-templates', name),
    );
  }
  cpSync(
    join(repositoryRoot, 'adapters', 'java-junit', 'package'),
    join(prepared, 'adapters', 'java-junit'),
    {
      recursive: true,
    },
  );
  cpSync(join(coreRoot, 'package.json'), join(prepared, 'package.json'));
  packageFrameworkDistribution({ source: prepared, output: join(coreRoot, 'package') });
} finally {
  rmSync(prepared, { recursive: true, force: true });
}
