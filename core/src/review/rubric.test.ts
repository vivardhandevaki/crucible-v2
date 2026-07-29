import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCrucibleError, type CrucibleError } from '../util/errors.js';
import {
  RUBRIC_VERSION,
  defaultRubricPath,
  loadDefaultRubric,
  parseRubric,
  readRubric,
  rubricHash,
  rubricIds,
} from './rubric.js';

// .crucible/rubric.yaml is the reviewer's law (charter §".crucible/rubric.yaml —
// The Reviewer's Law"; design phase-2.md §5). It is TCB: hash-pinned, immutable to
// the implement agent, and — like every Crucible artifact — strict and fail-closed
// (invariant 3). A rubric we cannot parse is a law we cannot adjudicate, so it
// halts at exit 3 rather than being silently skipped.

function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

/** A minimal well-formed rubric (block style, two lines) for mutation. */
const MINIMAL = `version: 1
lines:
  - id: R-001
    severity: block
    criterion: A criterion
    evidence: what observable evidence constitutes a finding
`;

describe('rubric — the shipped default (P2-09 acceptance)', () => {
  it('the charter 12-line default validates', () => {
    const rubric = loadDefaultRubric();
    expect(rubric.version).toBe(RUBRIC_VERSION);
    expect(rubric.lines).toHaveLength(12);
  });

  it('carries ids R-001..R-012 with R-010 the lone advise line', () => {
    const rubric = loadDefaultRubric();
    expect(rubric.lines.map((l) => l.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `R-${String(i + 1).padStart(3, '0')}`),
    );
    const advise = rubric.lines.filter((l) => l.severity === 'advise').map((l) => l.id);
    expect(advise).toEqual(['R-010']);
  });

  it('every line defines observable evidence (the anti-vibes-veto discipline)', () => {
    for (const line of loadDefaultRubric().lines) {
      expect(line.evidence.length).toBeGreaterThan(0);
      expect(line.criterion.length).toBeGreaterThan(0);
    }
  });

  it('defaultRubricPath points at the shipped asset', () => {
    expect(defaultRubricPath()).toMatch(/assets[\\/]rubric\.default\.yaml$/);
  });
});

describe('rubric — parse + helpers', () => {
  it('rubricIds returns the set of line ids', () => {
    const ids = rubricIds(parseRubric(MINIMAL, 'rubric.yaml'));
    expect(ids.has('R-001')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('rubricHash is deterministic on the same bytes and differs on a change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rubric-'));
    const a = join(dir, 'a.yaml');
    const b = join(dir, 'b.yaml');
    writeFileSync(a, MINIMAL);
    writeFileSync(b, MINIMAL);
    expect(rubricHash(a)).toBe(rubricHash(b));
    writeFileSync(b, MINIMAL.replace('block', 'advise'));
    expect(rubricHash(a)).not.toBe(rubricHash(b));
  });
});

describe('rubric — fail-closed parsing (invariant 3, exit 3)', () => {
  it('rejects non-YAML text', () => {
    expect(catchCrucible(() => parseRubric(':\n  - [unbalanced', 'rubric.yaml')).exit).toBe(3);
  });

  it('rejects an unknown key (strict schema)', () => {
    expect(catchCrucible(() => parseRubric(MINIMAL + 'sneaky: true\n', 'rubric.yaml')).exit).toBe(
      3,
    );
  });

  it('rejects an empty lines list (a law with no rules)', () => {
    expect(catchCrucible(() => parseRubric('version: 1\nlines: []\n', 'rubric.yaml')).exit).toBe(3);
  });

  it('rejects a duplicate line id', () => {
    const dup = MINIMAL + `  - id: R-001\n    severity: block\n    criterion: c\n    evidence: e\n`;
    expect(catchCrucible(() => parseRubric(dup, 'rubric.yaml')).exit).toBe(3);
  });

  it('rejects a line with empty evidence (a vibes-veto)', () => {
    const bad = MINIMAL.replace('what observable evidence constitutes a finding', '');
    expect(catchCrucible(() => parseRubric(bad, 'rubric.yaml')).exit).toBe(3);
  });

  it('rejects an unknown severity', () => {
    const bad = MINIMAL.replace('severity: block', 'severity: nuke');
    expect(catchCrucible(() => parseRubric(bad, 'rubric.yaml')).exit).toBe(3);
  });

  it('rejects a non-positive version', () => {
    expect(
      catchCrucible(() => parseRubric(MINIMAL.replace('version: 1', 'version: 0'), 'rubric.yaml'))
        .exit,
    ).toBe(3);
  });

  it('readRubric on a missing file fails closed at exit 3 (the law must exist)', () => {
    expect(catchCrucible(() => readRubric(join(tmpdir(), 'does-not-exist-rubric.yaml'))).exit).toBe(
      3,
    );
  });
});
