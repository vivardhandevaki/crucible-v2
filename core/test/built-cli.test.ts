import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Phase-4 consumer workflow runs the built CLI with plain Node after
// `npm ci && npm run build`. This is intentionally not a source-mode import:
// every workspace dependency reached from core/dist must be executable JavaScript.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const builtCli = join(repoRoot, 'core', 'dist', 'cli', 'bin.js');

describe('built CLI consumer surface (P4-13)', () => {
  it('uses source declarations before build and built JavaScript at runtime', () => {
    for (const workspace of ['ci-templates', 'schemas']) {
      const packageJson = JSON.parse(
        readFileSync(join(repoRoot, workspace, 'package.json'), 'utf8'),
      ) as {
        main: string;
        types: string;
        exports: { '.': { default: string; types: string } };
      };

      expect(packageJson.main).toBe('dist/index.js');
      expect(packageJson.exports['.'].default).toBe('./dist/index.js');
      expect(packageJson.types).toBe('src/index.ts');
      expect(packageJson.exports['.'].types).toBe('./src/index.ts');
    }
  });

  it('loads with plain Node after the workspace build', () => {
    expect(existsSync(builtCli), 'run npm run build before this consumer-surface test').toBe(true);

    // Node 22 can strip erasable TypeScript by default, but the pinned consumer
    // workflow uses Node 20. Disable that local convenience when available so
    // this test exercises the same plain-JavaScript contract everywhere.
    const nodeArgs =
      Number.parseInt(process.versions.node.split('.')[0]!, 10) >= 22
        ? ['--no-experimental-strip-types', builtCli, '--help']
        : [builtCli, '--help'];
    const output = execFileSync(process.execPath, nodeArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('Crucible');
    expect(output).toContain('verify');
  });
});
