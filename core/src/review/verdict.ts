// The adversarial reviewer's verdict + the fail-closed evaluator (charter
// §"Verdict Schema & the Enumerated-Blocking Rule"; design phase-2.md §5).
//
// The reviewer is the framework's ONE nondeterministic gate. To keep merge
// outcomes from drifting with model versions, what-can-block is a fixed,
// human-owned list: the reviewer may block ONLY on rubric lines (invariant 9,
// enumerated-blocking). This module is the deterministic decision that gate
// stands on — it takes the verdict text + the pinned rubric and returns pass/fail.
//
// The defining subtlety (design §54, "fail-closed enforcement in core, not
// prompt"): a MALFORMED verdict is a reviewer BLOCK, not an exit-3 tool error.
// So `evaluateVerdict` NEVER throws `invalidInputError` — it returns a `fail`
// outcome (charter §528: "malformed JSON → fail"). Enforcement lives here, in
// code, never in the reviewer's prompt where the untrusted agent could evade it.
//
// Scope (P2-09): the schema + evaluator only. Minting the verdict path, running
// the substrate, and wiring this into the verify report + PR comment are P2-10.

import { z } from 'zod';
import { rubricSeveritySchema, rubricIds, type Rubric } from './rubric.js';

/** One finding: a rubric line the reviewer judged violated, with evidence. */
export const findingSchema = z.strictObject({
  rubric: z.string().min(1),
  severity: rubricSeveritySchema,
  evidence: z.strictObject({
    file: z.string().min(1),
    line: z.number().int(),
    excerpt: z.string(),
  }),
  explanation: z.string().min(1),
  remediation: z.string().min(1),
});
export type Finding = z.infer<typeof findingSchema>;

/** One observation: something the reviewer noticed that is NOT a rubric line. */
export const observationSchema = z.strictObject({ note: z.string().min(1) });
export type Observation = z.infer<typeof observationSchema>;

/** The verdict JSON (charter §508). Strict — an unknown key fails closed. */
export const verdictSchema = z.strictObject({
  change: z.string().min(1),
  reviewed_sha: z.string().min(1),
  rubric_hash: z.string().min(1),
  model: z.string().min(1),
  verdict: z.enum(['pass', 'fail']),
  findings: z.array(findingSchema),
  observations: z.array(observationSchema),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** The evaluator's decision. A `fail` always carries a machine code + reason. */
export type VerdictOutcome =
  | { status: 'pass'; verdict: Verdict; observations: Observation[] }
  | {
      status: 'fail';
      code: VerdictFailCode;
      reason: string;
      blockingFindings: Finding[];
      observations: Observation[];
      verdict?: Verdict;
    };

export type VerdictFailCode =
  | 'NO_VERDICT'
  | 'MALFORMED_VERDICT'
  | 'UNKNOWN_RUBRIC_ID'
  | 'INCONSISTENT_VERDICT'
  | 'RUBRIC_HASH_MISMATCH'
  | 'REVIEWER_BLOCK';

export interface EvaluateVerdictInput {
  /** The verdict file's text, or `undefined` when the file is missing. */
  text: string | undefined;
  /** The pinned rubric the verdict is judged against. */
  rubric: Rubric;
  /**
   * The hash the verdict's `rubric_hash` must equal, when the caller can supply
   * it (P2-10). Omitted → the mismatch rule is not checked (the pure evaluator
   * has no file to hash); the schema still requires a non-empty `rubric_hash`.
   */
  expectedRubricHash?: string;
}

/**
 * Decide pass/fail from a verdict + the pinned rubric. Fail-closed throughout:
 * every uncertainty resolves to `fail` (a reviewer block), never a throw and
 * never a skip. Rules run in order; the first that trips wins.
 */
export function evaluateVerdict(input: EvaluateVerdictInput): VerdictOutcome {
  const { text, rubric, expectedRubricHash } = input;

  // 1. Missing file — a missing verdict is just another malformed verdict (§53).
  if (text === undefined) {
    return fail('NO_VERDICT', 'no verdict file was produced');
  }

  // 2. Not valid JSON.
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    return fail('MALFORMED_VERDICT', `verdict is not valid JSON — ${messageOf(cause)}`);
  }

  // 3. Schema-invalid (strict — unknown keys, wrong types, missing fields).
  const parsed = verdictSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return fail('MALFORMED_VERDICT', `verdict invalid — ${where}: ${issue.message}`);
  }
  const verdict = parsed.data;

  // 4. Unknown rubric id — the reviewer may not invent rules (invariant 9).
  const known = rubricIds(rubric);
  const invented = verdict.findings.find((f) => !known.has(f.rubric));
  if (invented) {
    return fail(
      'UNKNOWN_RUBRIC_ID',
      `finding cites rubric id ${invented.rubric}, which is not in the pinned rubric`,
      verdict,
    );
  }

  // Enumerated-blocking: a finding blocks ONLY when it is block-severity AND the
  // rubric line it cites is itself block-severity (the line's policy is human-
  // owned and wins). Everything else the reviewer noticed is harvested as an
  // observation, not discarded (charter §530).
  const lineSeverity = new Map(rubric.lines.map((l) => [l.id, l.severity] as const));
  const blockingFindings: Finding[] = [];
  const derivedObservations: Observation[] = [];
  for (const f of verdict.findings) {
    if (f.severity === 'block' && lineSeverity.get(f.rubric) === 'block') {
      blockingFindings.push(f);
    } else {
      derivedObservations.push({
        note: `${f.rubric} [${lineSeverity.get(f.rubric)}] ${f.explanation} — ${f.evidence.file}:${f.evidence.line}`,
      });
    }
  }
  const observations = [...verdict.observations, ...derivedObservations];
  const hasBlock = blockingFindings.length > 0;

  // 5/6. Consistency between the declared verdict and the blocking findings.
  if (verdict.verdict === 'fail' && !hasBlock) {
    return fail(
      'INCONSISTENT_VERDICT',
      'verdict is fail but no finding blocks on a block-severity rubric line',
      verdict,
      blockingFindings,
      observations,
    );
  }
  if (verdict.verdict === 'pass' && hasBlock) {
    return fail(
      'INCONSISTENT_VERDICT',
      'verdict is pass but carries a blocking finding',
      verdict,
      blockingFindings,
      observations,
    );
  }

  // 7. Rubric-hash pin — the verdict must have been reviewed against THIS law.
  if (expectedRubricHash !== undefined && verdict.rubric_hash !== expectedRubricHash) {
    return fail(
      'RUBRIC_HASH_MISMATCH',
      `verdict pins rubric_hash ${verdict.rubric_hash}, expected ${expectedRubricHash}`,
      verdict,
      blockingFindings,
      observations,
    );
  }

  // Consistent verdict. A `fail` here is a legitimate reviewer block.
  if (verdict.verdict === 'fail') {
    return {
      status: 'fail',
      code: 'REVIEWER_BLOCK',
      reason: `reviewer blocked on ${blockingFindings.map((f) => f.rubric).join(', ')}`,
      blockingFindings,
      observations,
      verdict,
    };
  }
  return { status: 'pass', verdict, observations };

  function fail(
    code: VerdictFailCode,
    reason: string,
    v?: Verdict,
    blocking: Finding[] = [],
    obs: Observation[] = [],
  ): VerdictOutcome {
    return {
      status: 'fail',
      code,
      reason,
      blockingFindings: blocking,
      observations: obs,
      ...(v !== undefined ? { verdict: v } : {}),
    };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
