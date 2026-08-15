import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OracleResult } from '../adapters/types.js';
import { verifyCiArchiveRegression } from './ci-archive-regression.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const ORACLES = `# Oracles

## ORC-archive-001: preserves the archived promise
**Given** an archived promise
**When** regression runs
**Then** it passes

\`\`\`yaml crucible-binding
requirement: REQ-archive-1
kind: unit
runner: stub
target: archive::passes
\`\`\`
`;
const SPEC = `# archive

### Requirement: Archive promise [REQ-archive-1]

The system SHALL preserve the archived promise.

#### Scenario: regression

- **WHEN** regression runs
- **THEN** it passes
`;

describe('verifyCiArchiveRegression', () => {
  it('resolves and runs every registered archived oracle', async () => {
    root = mkdtempSync(join(tmpdir(), 'crucible-ci-archive-'));
    const archive = join(root, 'openspec', 'changes', 'archive', '2026-08-15-archive');
    mkdirSync(join(archive, 'specs', 'archive'), { recursive: true });
    writeFileSync(join(archive, 'oracles.md'), ORACLES);
    writeFileSync(join(archive, 'specs', 'archive', 'spec.md'), SPEC);
    const seen: string[] = [];
    const report = await verifyCiArchiveRegression(root, {
      resolve: async (targets) =>
        targets.map((target) => ({ target, status: 'found' as const, targetFile: 'test.ts' })),
      run: async (oracles) => {
        seen.push(...oracles.map((oracle) => oracle.id));
        return oracles.map((oracle): OracleResult => ({
          oracleId: oracle.id,
          requirement: oracle.binding.requirement,
          status: 'pass',
          targets: oracle.binding.targets.map((target) => ({ target, status: 'pass' as const })),
        }));
      },
    });
    expect(report.verdict).toBe('pass');
    expect(report.checks.map((check) => check.name)).toEqual(['traceability', 'regression']);
    expect(seen).toEqual(['ORC-archive-001']);
  });
});
