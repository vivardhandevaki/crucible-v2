import { join } from 'node:path';
import { loadExpectedErrors, TOY_REPO_ROOT, VALID_BUNDLE_DIR } from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { loadOracles, parseOracles } from './oracles.js';

// TCB: the oracle parser is the gate's structural check. Every grammar
// violation must fail closed at exit 3 (invariant 3) and name the heading +
// line so a human can find it (charter §Oracle File Syntax). Coverage here is
// deliberately thorough including malformed-input cases (CLAUDE.md test-first
// rule: correctness-critical modules require malformed-input coverage).

const VALID_ORACLES = join(VALID_BUNDLE_DIR, 'oracles.md');

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

describe('parseOracles — valid fixture', () => {
  it('parses the toy bundle into two typed oracles', () => {
    const oracles = loadOracles(VALID_ORACLES);
    expect(oracles).toHaveLength(2);

    expect(oracles[0]).toMatchObject({
      id: 'ORC-greeting-001',
      title: 'Greeting names the person',
      line: 3,
      binding: {
        requirement: 'REQ-greeting-basic-1',
        kind: 'unit',
        runner: 'stub',
        targets: ['greeting::returns_hello_for_a_name'],
      },
    });
    expect(oracles[0]?.heading).toBe('## ORC-greeting-001: Greeting names the person');

    expect(oracles[1]).toMatchObject({
      id: 'ORC-greeting-002',
      binding: {
        requirement: 'REQ-greeting-default-2',
        targets: ['greeting::defaults_to_world_when_empty'],
      },
    });
  });

  it('exposes each oracle scenario prose + section span (design phase-2.md §8)', () => {
    const oracles = loadOracles(VALID_ORACLES);
    // The section span [line, sectionEnd] runs from the heading to its closing fence.
    expect(oracles[0]).toMatchObject({ line: 3, sectionEnd: 13 });
    expect(oracles[1]).toMatchObject({ line: 15, sectionEnd: 25 });
    // Prose is the raw slice from the heading through the line before the fence,
    // with the fenced binding excluded and trailing blanks trimmed.
    expect(oracles[0]?.prose).toBe(
      [
        '## ORC-greeting-001: Greeting names the person',
        '**Given** a non-empty name',
        '**When** `greet(name)` is called',
        '**Then** the result is `Hello, <name>!`',
      ].join('\n'),
    );
    expect(oracles[0]?.prose).not.toContain('crucible-binding');
  });

  it('normalises a single `target` into a one-element targets list', () => {
    const [oracle] = parseOracles(
      [
        '## ORC-x-001: Single target',
        '**Then** it passes',
        '',
        '```yaml crucible-binding',
        'requirement: REQ-x-1',
        'kind: unit',
        'runner: stub',
        'target: x::t',
        '```',
      ].join('\n'),
      'inline.md',
    );
    expect(oracle?.binding.targets).toEqual(['x::t']);
  });

  it('supports the `targets:` list form (all must pass)', () => {
    const [oracle] = parseOracles(
      [
        '## ORC-multi-001: Multiple targets',
        '**Then** all of them pass',
        '',
        '```yaml crucible-binding',
        'requirement: REQ-multi-1',
        'kind: integration',
        'runner: stub',
        'targets:',
        '  - a::t1',
        '  - b::t2',
        '```',
      ].join('\n'),
      'inline.md',
    );
    expect(oracle?.binding.targets).toEqual(['a::t1', 'b::t2']);
    expect(oracle?.binding.kind).toBe('integration');
  });

  it('parses `reproduces: true` on a bugfix reproduction oracle (P2-07)', () => {
    const [oracle] = parseOracles(
      [
        '## ORC-fix-001: Reproduces the crash',
        '**Then** it no longer crashes',
        '',
        '```yaml crucible-binding',
        'requirement: REQ-fix-1',
        'kind: unit',
        'runner: stub',
        'target: fix::t',
        'reproduces: true',
        '```',
      ].join('\n'),
      'inline.md',
    );
    expect(oracle?.binding.reproduces).toBe(true);
  });

  it('leaves `reproduces` undefined on an ordinary oracle', () => {
    const [oracle] = parseOracles(
      [
        '## ORC-x-001: Ordinary',
        '**Then** it passes',
        '',
        '```yaml crucible-binding',
        'requirement: REQ-x-1',
        'kind: unit',
        'runner: stub',
        'target: x::t',
        '```',
      ].join('\n'),
      'inline.md',
    );
    expect(oracle?.binding.reproduces).toBeUndefined();
  });

  it('rejects a non-boolean `reproduces` at exit 3 (strict schema)', () => {
    try {
      parseOracles(
        [
          '## ORC-x-001: Bad reproduces',
          '**Then** it passes',
          '',
          '```yaml crucible-binding',
          'requirement: REQ-x-1',
          'kind: unit',
          'runner: stub',
          'target: x::t',
          'reproduces: yes-please',
          '```',
        ].join('\n'),
        'inline.md',
      );
      expect.unreachable('non-boolean reproduces must throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });
});

describe('parseOracles — invalid fixtures (exit 3, heading + line named)', () => {
  // Drive every assertion off the machine-readable catalogue so the parser is
  // checked against the *documented* heading, line, and offending-line locator.
  const oracleDefects = loadExpectedErrors().then((errors) =>
    errors.filter((e) => e.artifact === 'oracles'),
  );

  it('the catalogue lists the five oracle defects P1-03 must reject', async () => {
    const ids = (await oracleDefects).map((e) => e.id).sort();
    expect(ids).toEqual([
      'oracle-bad-id',
      'oracle-bad-kind',
      'oracle-missing-fence',
      'oracle-no-requirement',
      'oracle-two-fences',
    ]);
  });

  it('rejects each defect at exit 3, naming its heading and line', async () => {
    for (const defect of await oracleDefects) {
      const file = join(TOY_REPO_ROOT, defect.path);
      const err = catchCrucible(() => loadOracles(file));

      expect(err.exit, `${defect.id}: exit code`).toBe(3);
      expect(err.message, `${defect.id}: names the heading`).toContain(defect.heading);
      expect(err.message, `${defect.id}: names the line`).toContain(`:${defect.line}:`);
      // The offending-line locator is the drift guard — it must surface too.
      expect(err.message, `${defect.id}: names the offending line`).toContain(defect.locator);
    }
  });
});

describe('parseOracles — additional fail-closed cases', () => {
  it('rejects a `## ` heading that is not an ORC id', () => {
    const err = catchCrucible(() => parseOracles('## Not an oracle heading', 'inline.md'));
    expect(err.exit).toBe(3);
  });

  it('rejects an unterminated binding fence', () => {
    const err = catchCrucible(() =>
      parseOracles(
        [
          '## ORC-x-001: Unterminated fence',
          '```yaml crucible-binding',
          'requirement: REQ-x-1',
          'kind: unit',
          'runner: stub',
          'target: x::t',
        ].join('\n'),
        'inline.md',
      ),
    );
    expect(err.exit).toBe(3);
    expect(err.message).toContain('unterminated');
  });

  it('rejects a binding that is not valid YAML', () => {
    const err = catchCrucible(() =>
      parseOracles(
        [
          '## ORC-x-001: Bad YAML',
          '```yaml crucible-binding',
          'requirement: "unterminated',
          '```',
        ].join('\n'),
        'inline.md',
      ),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects a binding with an unknown key (strict schema)', () => {
    const err = catchCrucible(() =>
      parseOracles(
        [
          '## ORC-x-001: Unknown key',
          '```yaml crucible-binding',
          'requirement: REQ-x-1',
          'kind: unit',
          'runner: stub',
          'target: x::t',
          'bogus: nope',
          '```',
        ].join('\n'),
        'inline.md',
      ),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects a binding setting both `target` and `targets`', () => {
    const err = catchCrucible(() =>
      parseOracles(
        [
          '## ORC-x-001: Both target forms',
          '```yaml crucible-binding',
          'requirement: REQ-x-1',
          'kind: unit',
          'runner: stub',
          'target: x::t',
          'targets: [x::t2]',
          '```',
        ].join('\n'),
        'inline.md',
      ),
    );
    expect(err.exit).toBe(3);
  });

  it('reports a missing oracles.md as a precondition (exit 2)', () => {
    const err = catchCrucible(() => loadOracles(join(TOY_REPO_ROOT, 'does-not-exist.md')));
    expect(err.exit).toBe(2);
  });
});
