import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { rubricHash } from '../review/rubric.js';
import { FakeSubstrate, type FakeScript } from '../substrate/fake.js';
import type { SubstrateRequest } from '../substrate/types.js';
import { review, type ReviewDeps, type ReviewOptions } from './review.js';

// `crucible review` — the framework's ONE nondeterministic gate (charter
// §Adversarial Reviewer; design phase-2.md §5). These tests drive the P2-10
// acceptance with FakeSubstrate canned verdicts: a clean pass, a legitimate
// block-finding, and every malformed shape failing CLOSED — plus the structural
// guarantees: the command MINTS the verdict path and names it in the taskPayload
// (P2-00 addendum: caller-minted paths; the substrate result is never parsed),
// and the verdict must pin the rubric_hash of THIS repo's rubric (acceptance:
// "rubric_hash pinned in verdict").

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const FROZEN_NOW = '2026-07-27T00:00:00Z';
const BASE = 'origin/main';
const HEAD = '9f3ab21';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-review-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** The toy repo's pinned rubric hash — what a well-formed verdict must carry. */
function toyRubricHash(): string {
  return rubricHash(join(scratch, '.crucible', 'rubric.yaml'));
}

/** A canned verdict body; override any field to drive a failure shape. */
function cannedVerdict(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    change: CHANGE,
    reviewed_sha: HEAD,
    rubric_hash: toyRubricHash(),
    model: 'claude-haiku-4-5-20251001',
    verdict: 'pass',
    findings: [],
    observations: [],
    ...overrides,
  });
}

/** A block-severity finding citing a real default-rubric line (R-002). */
function blockFinding(): Record<string, unknown> {
  return {
    rubric: 'R-002',
    severity: 'block',
    evidence: { file: 'src/greeting.ts', line: 14, excerpt: 'if (name.length >= 0)' },
    explanation: 'Condition loosened in a path ORC-greeting-001 measures.',
    remediation: 'Restore the emptiness check per design.md.',
  };
}

/**
 * A substrate whose review session writes `verdictText` to the EXACT path the
 * work order names — extracted from the taskPayload, which is itself the proof
 * that the command mints the path and tells the reviewer (never vice versa).
 * `verdictText: undefined` scripts a session that writes no verdict at all.
 */
function reviewerSubstrate(verdictText: string | undefined): FakeSubstrate {
  return new FakeSubstrate((req: SubstrateRequest): FakeScript => {
    if (verdictText === undefined) return {};
    const path = verdictPathFromPayload(req.taskPayload);
    return { files: { [path]: verdictText } };
  });
}

/** The verdict path the work order names (fails the test if it names none). */
function verdictPathFromPayload(payload: string): string {
  const match = payload.match(/(\.crucible\/verdicts\/\S+\.json)/);
  expect(match, 'taskPayload names the minted verdict path').toBeTruthy();
  return match![1]!;
}

function options(): ReviewOptions {
  return {
    root: scratch,
    change: CHANGE,
    model: 'claude-haiku-4-5-20251001',
    base: BASE,
    head: HEAD,
  };
}

function deps(substrate: FakeSubstrate): ReviewDeps {
  return { substrate, now: () => FROZEN_NOW };
}

describe('review — canned verdict flows (P2-10 acceptance)', () => {
  it('a well-formed pass verdict → outcome pass, check green, observations carried', async () => {
    const substrate = reviewerSubstrate(
      cannedVerdict({ observations: [{ note: 'Retry-path idempotency is untested.' }] }),
    );
    const result = await review(options(), deps(substrate));

    expect(result.outcome.status).toBe('pass');
    expect(result.check).toEqual({ name: 'review', status: 'pass', findings: [] });
    // Observations survive a PASS — the harvest channel (charter §530).
    expect(result.review.observations).toEqual([{ note: 'Retry-path idempotency is untested.' }]);
    // The report extras pin the rubric hash + the verdict's model (audit drift guard).
    expect(result.review.rubric_hash).toBe(toyRubricHash());
    expect(result.review.model).toBe('claude-haiku-4-5-20251001');
  });

  it('a legitimate block-finding → outcome fail (REVIEWER_BLOCK), finding renders rubric id + file:line + remediation', async () => {
    const substrate = reviewerSubstrate(
      cannedVerdict({ verdict: 'fail', findings: [blockFinding()] }),
    );
    const result = await review(options(), deps(substrate));

    expect(result.outcome.status).toBe('fail');
    if (result.outcome.status === 'fail') expect(result.outcome.code).toBe('REVIEWER_BLOCK');
    expect(result.check.status).toBe('fail');
    const finding = result.check.findings[0]!;
    // The `why` trail (P2-16): rubric line → evidence path → remediation, all in
    // the one finding — id is the rubric line, message carries file:line + fix.
    expect(finding.check).toBe('review');
    expect(finding.id).toBe('R-002');
    expect(finding.message).toContain('src/greeting.ts:14');
    expect(finding.message).toContain('Restore the emptiness check per design.md.');
  });

  it('malformed JSON → fail closed (MALFORMED_VERDICT), never a throw', async () => {
    const substrate = reviewerSubstrate('{ this is not JSON');
    const result = await review(options(), deps(substrate));

    expect(result.outcome.status).toBe('fail');
    if (result.outcome.status === 'fail') expect(result.outcome.code).toBe('MALFORMED_VERDICT');
    expect(result.check.status).toBe('fail');
    expect(result.check.findings[0]!.id).toBe('MALFORMED_VERDICT');
  });

  it('a session that writes NO verdict file → fail closed (NO_VERDICT)', async () => {
    const substrate = reviewerSubstrate(undefined);
    const result = await review(options(), deps(substrate));

    expect(result.outcome.status).toBe('fail');
    if (result.outcome.status === 'fail') expect(result.outcome.code).toBe('NO_VERDICT');
  });

  it('a verdict pinning the WRONG rubric_hash → fail closed (acceptance: rubric_hash pinned)', async () => {
    const substrate = reviewerSubstrate(cannedVerdict({ rubric_hash: 'deadbeef' }));
    const result = await review(options(), deps(substrate));

    expect(result.outcome.status).toBe('fail');
    if (result.outcome.status === 'fail') expect(result.outcome.code).toBe('RUBRIC_HASH_MISMATCH');
  });

  it('a finding citing a rubric id NOT in the pinned rubric → fail closed (no invented rules)', async () => {
    const substrate = reviewerSubstrate(
      cannedVerdict({
        verdict: 'fail',
        findings: [{ ...blockFinding(), rubric: 'R-999' }],
      }),
    );
    const result = await review(options(), deps(substrate));

    expect(result.outcome.status).toBe('fail');
    if (result.outcome.status === 'fail') expect(result.outcome.code).toBe('UNKNOWN_RUBRIC_ID');
  });
});

describe('review — the caller-minted verdict path (P2-00 addendum)', () => {
  it('mints .crucible/verdicts/<change>/review-<ts>.json, names it in the taskPayload, and reads THAT file', async () => {
    const substrate = reviewerSubstrate(cannedVerdict());
    const result = await review(options(), deps(substrate));

    const req = substrate.calls[0]!;
    expect(req.role).toBe('review');
    expect(req.model).toBe('claude-haiku-4-5-20251001');
    expect(req.cwd).toBe(scratch);
    expect(req.rolePromptPath).toBe(join(scratch, '.crucible', 'context', 'review.md'));

    // The minted path: under .crucible/verdicts/<change>/, stamped from the
    // injected clock, and named VERBATIM in the work order.
    const relPath = verdictPathFromPayload(req.taskPayload);
    expect(relPath).toContain(`.crucible/verdicts/${CHANGE}/review-`);
    expect(result.verdictPath).toBe(join(scratch, relPath));
    expect(existsSync(result.verdictPath)).toBe(true);

    // The work order carries the pinned rubric hash + the diff endpoints — the
    // change-specific dynamic context (charter: progressive disclosure).
    expect(req.taskPayload).toContain(toyRubricHash());
    expect(req.taskPayload).toContain(BASE);
    expect(req.taskPayload).toContain(HEAD);

    // Transcript path follows the command-owned convention, same stamp rule.
    expect(req.transcriptPath).toContain(join('.crucible', 'transcripts', CHANGE));
    expect(result.transcriptPath).toBe(req.transcriptPath);
  });

  it('the substrate exit code is worth zero — a clean exit with no verdict is still a fail (invariant 2)', async () => {
    const substrate = new FakeSubstrate({ exitCode: 0 }); // writes nothing
    const result = await review(options(), deps(substrate));
    expect(result.outcome.status).toBe('fail');
  });

  it('a nonzero exit code with a VALID verdict on disk still judges the verdict, not the exit', async () => {
    const substrate = new FakeSubstrate((req: SubstrateRequest): FakeScript => {
      return { files: { [verdictPathFromPayload(req.taskPayload)]: cannedVerdict() }, exitCode: 1 };
    });
    const result = await review(options(), deps(substrate));
    expect(result.outcome.status).toBe('pass');
  });
});

async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('review — fail-closed preconditions', () => {
  it('missing change bundle → exit 2 teaching propose', async () => {
    rmSync(join(scratch, CHANGE_REL), { recursive: true, force: true });
    const err = await catchCrucible(() =>
      review(options(), deps(reviewerSubstrate(cannedVerdict()))),
    );
    expect(err.exit).toBe(2);
    expect(err.code).toBe('NO_CHANGE');
  });

  it('missing role prompt → exit 2 naming .crucible/context/review.md', async () => {
    rmSync(join(scratch, '.crucible', 'context', 'review.md'));
    const err = await catchCrucible(() =>
      review(options(), deps(reviewerSubstrate(cannedVerdict()))),
    );
    expect(err.exit).toBe(2);
    expect(err.code).toBe('MISSING_ROLE_PROMPT');
  });

  it('missing rubric.yaml → exit 3 (the law must exist to adjudicate)', async () => {
    rmSync(join(scratch, '.crucible', 'rubric.yaml'));
    const err = await catchCrucible(() => review(options(), deps(reviewerSubstrate('{}'))));
    expect(err.exit).toBe(3);
    expect(err.code).toBe('INVALID_RUBRIC');
  });

  it('a malformed rubric.yaml → exit 3, never a review against a law we cannot parse', async () => {
    const path = join(scratch, '.crucible', 'rubric.yaml');
    const substrate = reviewerSubstrate(cannedVerdict());
    rmSync(path);
    cpSync(join(scratch, 'crucible.yaml'), path); // valid YAML, not a rubric
    const err = await catchCrucible(() => review(options(), deps(substrate)));
    expect(err.exit).toBe(3);
    expect(err.code).toBe('INVALID_RUBRIC');
    // Fail-closed BEFORE the session: no substrate run against an unparseable law.
    expect(substrate.calls).toHaveLength(0);
  });
});

describe('review — transcript is evidence, not input', () => {
  it('leaves the transcript at the minted path on every outcome', async () => {
    const substrate = reviewerSubstrate('{ malformed');
    const result = await review(options(), deps(substrate));
    expect(existsSync(result.transcriptPath)).toBe(true);
    expect(readFileSync(result.transcriptPath, 'utf8').length).toBeGreaterThan(0);
  });
});
