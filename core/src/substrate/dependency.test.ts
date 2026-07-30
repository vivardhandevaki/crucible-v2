import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Structural invariant (architecture.md §1, §6; task P1-08 acceptance): the
// `claude` and `codex` binaries are referenced NOWHERE outside `substrate/`.
// Nothing else in core may spawn an agent. This is a dependency test, not a
// unit test — it fails the moment someone reaches around the boundary.

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // …/core/src
const SUBSTRATE_DIR = join(SRC_ROOT, 'substrate');

// The bare agent executables as a spawn target: a straight-quoted 'claude' /
// "claude" literal. Deliberately NOT matched: model ids like 'claude-opus-4-8'
// (a char follows `claude`), or prose/comments mentioning "Claude Code".
const AGENT_EXECUTABLE_REFERENCE =
  /(?:\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*|_BIN\s*=\s*)['"](?:claude|codex)['"]/;

function tsFilesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('substrate boundary — nothing outside substrate/ references the agent binaries', () => {
  it('has no bare agent binary literal anywhere outside core/src/substrate', () => {
    const offenders = tsFilesUnder(SRC_ROOT)
      .filter((f) => !f.startsWith(SUBSTRATE_DIR + '/') && f !== SUBSTRATE_DIR)
      .filter((f) => AGENT_EXECUTABLE_REFERENCE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the substrate directory references both binaries (guards against a false-green test)', () => {
    const source = tsFilesUnder(SUBSTRATE_DIR)
      .filter((f) => !f.endsWith('.test.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(source).toMatch(/CLAUDE_BIN\s*=\s*['"]claude['"]/);
    expect(source).toMatch(/CODEX_BIN\s*=\s*['"]codex['"]/);
  });
});
