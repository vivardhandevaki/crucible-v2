import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPENSPEC_COMPATIBLE_RANGE, OPENSPEC_TESTED_VERSION } from './openspec-support.js';

// The shipped OpenSpec support window is a mirror of the authoritative `openspec`
// block in the monorepo root package.json (the spike pinned it — spike-notes
// §Repro). These constants ship inside the published `core` package (which does
// not carry the root package.json), so this test guards them from drifting out
// of sync with the authority — the same "docs never drift from code" discipline
// applied to a cross-package constant.

describe('openspec-support — stays in sync with the root package.json authority', () => {
  it('mirrors the root openspec block', () => {
    // src/commands/openspec-support.test.ts → core/ → repo root.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      openspec: { testedVersion: string; expectedCompatibleRange: string };
    };
    expect(OPENSPEC_TESTED_VERSION).toBe(pkg.openspec.testedVersion);
    expect(OPENSPEC_COMPATIBLE_RANGE).toBe(pkg.openspec.expectedCompatibleRange);
  });
});
