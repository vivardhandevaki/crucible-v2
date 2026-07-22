import { join } from 'node:path';
import { loadExpectedErrors, TOY_REPO_ROOT, VALID_BUNDLE_DIR } from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { loadSpecDelta, parseSpecDelta } from './spec-delta.js';

// TCB: the spec-delta extractor supplies the REQ-id universe the traceability
// linter matches against. A `### Requirement:` heading with a missing or
// malformed bracket id, or a reused id, must fail closed at exit 3 (invariant 3)
// naming the heading + line so a human can find it (charter §Requirement IDs in
// the Spec Delta). Coverage here is deliberately thorough including
// malformed-input cases (CLAUDE.md test-first rule: correctness-critical
// modules require malformed-input coverage).

const VALID_DELTA = join(VALID_BUNDLE_DIR, 'specs', 'greeting', 'spec.md');

/** Capture the CrucibleError a call throws, or fail the test loudly. */
function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

describe('parseSpecDelta — valid fixture', () => {
  it('extracts the toy delta REQ ids in document order', () => {
    const reqs = loadSpecDelta(VALID_DELTA);
    expect(reqs).toEqual([
      { id: 'REQ-greeting-basic-1', title: 'Greeting a named user', line: 5 },
      { id: 'REQ-greeting-default-2', title: 'Default greeting', line: 14 },
    ]);
  });

  it('preserves document order even when ids sort differently', () => {
    const reqs = parseSpecDelta(
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Zebra [REQ-z-9]',
        '### Requirement: Alpha [REQ-a-1]',
      ].join('\n'),
      'inline.md',
    );
    expect(reqs.map((r) => r.id)).toEqual(['REQ-z-9', 'REQ-a-1']);
  });
});

describe('parseSpecDelta — invalid fixtures (exit 3, heading + line named)', () => {
  // Drive assertions off the machine-readable catalogue so the extractor is
  // checked against the *documented* heading, line, and offending-line locator.
  const specDefects = loadExpectedErrors().then((errors) =>
    errors.filter((e) => e.artifact === 'spec-delta' && e.consumers.includes('P1-04')),
  );

  it('the catalogue lists the two spec-delta defects P1-04 must reject', async () => {
    const ids = (await specDefects).map((e) => e.id).sort();
    expect(ids).toEqual(['spec-duplicate-req-id', 'spec-malformed-bracket-id']);
  });

  it('rejects each defect at exit 3, naming its heading, line, and offending line', async () => {
    for (const defect of await specDefects) {
      const file = join(TOY_REPO_ROOT, defect.path);
      const err = catchCrucible(() => loadSpecDelta(file));

      expect(err.exit, `${defect.id}: exit code`).toBe(3);
      expect(err.message, `${defect.id}: names the heading`).toContain(defect.heading);
      expect(err.message, `${defect.id}: names the line`).toContain(`:${defect.line}:`);
      // The offending-line locator is the drift guard — it must surface too.
      expect(err.message, `${defect.id}: names the offending line`).toContain(defect.locator);
    }
  });

  it('rejects the malformed bracket id at line 5', async () => {
    const defect = (await specDefects).find((e) => e.id === 'spec-malformed-bracket-id')!;
    const err = catchCrucible(() => loadSpecDelta(join(TOY_REPO_ROOT, defect.path)));
    expect(err.exit).toBe(3);
    expect(err.message).toContain(':5:');
  });

  it('rejects the duplicate req id at line 14', async () => {
    const defect = (await specDefects).find((e) => e.id === 'spec-duplicate-req-id')!;
    const err = catchCrucible(() => loadSpecDelta(join(TOY_REPO_ROOT, defect.path)));
    expect(err.exit).toBe(3);
    expect(err.message).toContain(':14:');
  });
});

describe('parseSpecDelta — additional fail-closed cases', () => {
  it('rejects a `### Requirement:` heading with no brackets at all', () => {
    const err = catchCrucible(() =>
      parseSpecDelta('### Requirement: Naked heading with no id', 'inline.md'),
    );
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Naked heading with no id');
  });

  it('rejects a bracket that is present but not in REQ form', () => {
    const err = catchCrucible(() =>
      parseSpecDelta('### Requirement: Wrong tag [ID-greeting-1]', 'inline.md'),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects a REQ bracket missing the trailing numeric sequence', () => {
    const err = catchCrucible(() =>
      parseSpecDelta('### Requirement: No sequence [REQ-greeting-basic]', 'inline.md'),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects a REQ bracket with a non-numeric sequence', () => {
    const err = catchCrucible(() =>
      parseSpecDelta('### Requirement: Bad sequence [REQ-greeting-basic-x]', 'inline.md'),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects an uppercase domain/slug (grammar is [a-z0-9-])', () => {
    const err = catchCrucible(() =>
      parseSpecDelta('### Requirement: Upper [REQ-Greeting-1]', 'inline.md'),
    );
    expect(err.exit).toBe(3);
  });

  it('ignores non-requirement headings and prose that merely mentions Requirement:', () => {
    const reqs = parseSpecDelta(
      [
        '# greeting',
        '',
        '## ADDED Requirements',
        '',
        '### Requirement: Real one [REQ-greeting-basic-1]',
        '',
        'Some prose that mentions Requirement: but is not a heading.',
        '',
        '#### Scenario: A name is provided',
        '',
        '- **WHEN** greet is called',
      ].join('\n'),
      'inline.md',
    );
    expect(reqs).toEqual([{ id: 'REQ-greeting-basic-1', title: 'Real one', line: 5 }]);
  });

  it('extracts an empty list when the delta has no requirement headings', () => {
    const reqs = parseSpecDelta('# greeting\n\n## ADDED Requirements\n', 'inline.md');
    expect(reqs).toEqual([]);
  });

  it('reports a missing spec delta as a precondition (exit 2)', () => {
    const err = catchCrucible(() => loadSpecDelta(join(TOY_REPO_ROOT, 'does-not-exist.md')));
    expect(err.exit).toBe(2);
  });
});
