// `crucible review` — the adversarial reviewer, the framework's ONE
// nondeterministic gate (charter §Adversarial Reviewer — Design; design
// phase-2.md §5).
//
// The command runs one fresh-context substrate session (role=review, invariant
// 10) over the change's diff + bundle + the pinned rubric, then judges the
// session STRUCTURALLY (invariant 2 — the substrate result carries nothing to
// trust):
//
//   1. It MINTS the verdict path — `.crucible/verdicts/<change>/review-<ts>.json`
//      — and names it in the work order (architecture.md §6, P2-00 addendum:
//      the caller-minted-path rule; the substrate never invents paths). The
//      frozen `{exitCode, transcriptPath}` result is never parsed for content.
//   2. After the run, core loads that file and hands it to the P2-09 fail-closed
//      evaluator with the EXPECTED rubric hash (computed here from
//      .crucible/rubric.yaml, never taken from the verdict). Missing file,
//      malformed JSON, invented rubric ids, an unpinned/wrong rubric_hash — all
//      resolve to a reviewer FAIL, never a throw and never a skip (charter §528;
//      enforcement in core, not prompt).
//
// The outcome feeds `verify` as its `review` check (CI always, `--review`
// locally); observations ride the report to the PR (charter §530 — harvested,
// never blocking). Determinism (invariant 12): the substrate and clock are
// injected; everything else is file reads + the pure evaluator. The command
// writes NO state — review is an input to verify's read-only judgment; the CLI
// layer may append audit events best-effort (invariant 1).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSubstrate } from '../substrate/types.js';
import { readRubric, rubricHash } from '../review/rubric.js';
import { evaluateVerdict, type VerdictOutcome } from '../review/verdict.js';
import { reviewCheck, type CheckResult, type ReviewReport } from '../verifyx/report.js';
import { preconditionError } from '../util/errors.js';

/** Injected non-deterministic edges — so review's core stays reproducible. */
export interface ReviewDeps {
  /** The agent session runner (architecture.md §6). The CLI wires ClaudeCode. */
  substrate: AgentSubstrate;
  /** ISO 8601 clock — verdict/transcript naming. No wall-clock in core. */
  now: () => string;
}

/** review invocation options. `root` is the target repo root. */
export interface ReviewOptions {
  /** Repo root the session runs in; rubric + verdict paths are relative to it. */
  root: string;
  /** The change under review (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /** Model id for the session (convenience `models.review`; opaque here). */
  model: string;
  /** The diff base the reviewer judges against (CI: origin/<base_ref>). */
  base: string;
  /** The reviewed head — recorded by the reviewer as `reviewed_sha` (audit). */
  head: string;
}

/** review outcome: the evaluator's decision + everything the report needs. */
export interface ReviewRun {
  /** The fail-closed evaluator's decision (P2-09). */
  outcome: VerdictOutcome;
  /** sha256 of the pinned rubric — the hash the verdict had to carry. */
  rubricHash: string;
  /** The `review` check for the verify report. */
  check: CheckResult;
  /** The report extras: pinned hash, reviewer model (audit), observations. */
  review: ReviewReport;
  /** Absolute path the verdict was required at (whether or not it appeared). */
  verdictPath: string;
  /** Absolute transcript path for the session. */
  transcriptPath: string;
}

/**
 * Run one adversarial review: load the pinned rubric (fail-closed, exit 3) →
 * mint the verdict path → run the fresh-context session → evaluate the verdict
 * file. Throws `CrucibleError` only on preconditions (exit 2: no bundle, no
 * role prompt) or an unusable rubric (exit 3 — a law we cannot parse cannot be
 * adjudicated). EVERY defect in what the session produced is a returned `fail`
 * outcome, never a throw (charter §528: malformed = fail).
 */
export async function review(options: ReviewOptions, deps: ReviewDeps): Promise<ReviewRun> {
  const { root, change, model, base, head } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // The role prompt is a per-project TCB file (architecture §Static Context
  // Surfaces). The substrate would also refuse without it (exit 3); checking
  // here first turns that into a teaching precondition (implement precedent).
  const rolePromptPath = join(root, '.crucible', 'context', 'review.md');
  if (!existsSync(rolePromptPath)) {
    throw preconditionError(
      'MISSING_ROLE_PROMPT',
      `The review role prompt is missing at ${join('.crucible', 'context', 'review.md')}.`,
      'Restore .crucible/context/review.md (installed by `crucible init` from P2; until then check it into the repo).',
    );
  }

  // The reviewer's law — TCB, fail-closed BEFORE any session runs (invariant 3):
  // a rubric we cannot parse is a law we cannot adjudicate, so no agent is spent
  // on it. The hash computed HERE is the pin the verdict must carry — core owns
  // the expected value; the verdict merely has to match it (acceptance:
  // "rubric_hash pinned in verdict").
  const rubricPath = join(root, '.crucible', 'rubric.yaml');
  const rubric = readRubric(rubricPath);
  const pinnedHash = rubricHash(rubricPath);

  // Caller-minted paths (architecture.md §6): the command owns the naming
  // convention for both the transcript and the verdict target; the stamp comes
  // from the injected clock (no wall-clock in core).
  const stamp = deps.now().replace(/[:.]/g, '-');
  const verdictRel = join('.crucible', 'verdicts', change, `review-${stamp}.json`);
  const verdictPath = join(root, verdictRel);
  const transcriptPath = join(root, '.crucible', 'transcripts', change, `review-${stamp}.jsonl`);

  await deps.substrate.run({
    role: 'review',
    rolePromptPath,
    taskPayload: buildReviewPayload({ change, changeRel, base, head, pinnedHash, verdictRel }),
    cwd: root,
    model,
    transcriptPath,
  });
  // SubstrateResult carries nothing to trust (invariant 2) — judge the verdict
  // FILE. A session that "succeeded" but wrote nothing is a NO_VERDICT fail; a
  // session that died but left a valid verdict is judged on that verdict.

  const text = existsSync(verdictPath) ? readFileSync(verdictPath, 'utf8') : undefined;
  const outcome = evaluateVerdict({ text, rubric, expectedRubricHash: pinnedHash });

  // The reviewer-model identity is audit-grade (charter: v2.0-light drift guard,
  // pinned in the verdict + flagged by the digest — not enforcement), so it is
  // surfaced when a verdict parsed and simply absent when none did.
  const parsedModel = outcomeVerdictModel(outcome);
  const reviewReport: ReviewReport = {
    rubric_hash: pinnedHash,
    ...(parsedModel !== undefined ? { model: parsedModel } : {}),
    // Both outcome variants carry observations — the harvest survives pass AND fail.
    observations: outcome.observations,
  };

  return {
    outcome,
    rubricHash: pinnedHash,
    check: reviewCheck(outcome),
    review: reviewReport,
    verdictPath,
    transcriptPath,
  };
}

/** The reviewing model a parsed verdict declared, if any (audit, invariant 2-safe). */
function outcomeVerdictModel(outcome: VerdictOutcome): string | undefined {
  return outcome.verdict?.model;
}

/**
 * The work order — the change-specific DYNAMIC context (charter: progressive
 * disclosure; the static rules live in .crucible/context/review.md). It names
 * the exact verdict path (caller-minted), the diff endpoints, and the rubric
 * hash the verdict must pin. It deliberately does NOT restate the rubric lines
 * — the rubric file is the law and the reviewer reads it from disk, so a stale
 * work order can never shadow the pinned rubric.
 */
function buildReviewPayload(input: {
  change: string;
  changeRel: string;
  base: string;
  head: string;
  pinnedHash: string;
  verdictRel: string;
}): string {
  const { change, changeRel, base, head, pinnedHash, verdictRel } = input;
  return [
    `Change: ${change}`,
    `Bundle directory: ${changeRel}/`,
    `Review the implementation diff from ${base} to ${head} (\`git diff ${base} ${head}\`)`,
    `against the approved bundle (spec deltas, design, oracles) in ${changeRel}/.`,
    '',
    'The rubric — the ONLY rules you may block on — is .crucible/rubric.yaml.',
    `Its sha256 is ${pinnedHash}; set "rubric_hash" to exactly that value.`,
    `Set "change" to "${change}", "reviewed_sha" to "${head}", and "model" to your model id.`,
    '',
    `Write your verdict JSON to exactly this path: ${verdictRel.split('\\').join('/')}`,
    'No other output counts. A missing, malformed, or off-schema verdict file is',
    'an automatic FAIL, as is any finding citing a rubric id not in the rubric.',
  ].join('\n');
}
