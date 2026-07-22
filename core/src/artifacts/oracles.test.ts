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
