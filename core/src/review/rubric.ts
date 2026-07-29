// .crucible/rubric.yaml — the reviewer's law (charter §".crucible/rubric.yaml —
// The Reviewer's Law"; design phase-2.md §5).
//
// The rubric is the human-owned, versioned list of what the adversarial reviewer
// may block on. It is TCB: hash-pinned (verdicts pin `rubric_hash`), immutable to
// the implement agent, grown only by the ratchet. It is NOT in approval-hash scope
// — it is repo-global, protected by risk globs + the target-branch rule, not by
// per-change hashing (design §5).
//
// This module is the schema + loader + the `rubric_hash` primitive. It resolves
// nothing through an adapter and holds no wall-clock (invariant 12). Like every
// Crucible artifact parser it fails closed at exit 3 (invariant 3): a rubric we
// cannot parse is a law we cannot adjudicate, so it halts rather than being
// silently skipped. The enumerated-blocking *decision* lives in ./verdict.ts;
// this module only defines and loads the law it is judged against.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { hashFile } from '../hash/hash.js';
import { invalidInputError } from '../util/errors.js';

/** The current rubric.yaml schema version. */
export const RUBRIC_VERSION = 1;

/** A rubric line's policy severity. `block` may stop a merge; `advise` only surfaces. */
export const rubricSeveritySchema = z.enum(['block', 'advise']);
export type RubricSeverity = z.infer<typeof rubricSeveritySchema>;

/**
 * One rubric line. `criterion` names the tenet; `evidence` names the observable
 * signal that constitutes a finding — non-empty is load-bearing (charter §466: a
 * line with no evidence cannot be adjudicated and becomes a vibes-veto). `id` is
 * non-empty and unique but deliberately carries NO format regex — the ratchet
 * adds project-specific lines and an over-tight `R-\d{3}` would fail-close on
 * legitimate ids.
 */
export const rubricLineSchema = z.strictObject({
  id: z.string().min(1),
  severity: rubricSeveritySchema,
  criterion: z.string().min(1),
  evidence: z.string().min(1),
});
export type RubricLine = z.infer<typeof rubricLineSchema>;

/** A whole rubric.yaml. Strict — an unknown key fails closed at exit 3. */
export const rubricSchema = z
  .strictObject({
    version: z.number().int().positive(),
    lines: z.array(rubricLineSchema).min(1),
  })
  .superRefine((rubric, ctx) => {
    const seen = new Set<string>();
    for (const line of rubric.lines) {
      if (seen.has(line.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate line id ${line.id}`, path: ['lines'] });
      }
      seen.add(line.id);
    }
  });
export type Rubric = z.infer<typeof rubricSchema>;

const HINT = 'The rubric is TCB; fix .crucible/rubric.yaml (charter §The Reviewer’s Law).';

/** Parse + strict-validate rubric.yaml text. Any defect → exit 3 (fail-closed). */
export function parseRubric(text: string, source: string): Rubric {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_RUBRIC',
      `${source}: not valid YAML — ${messageOf(cause)}`,
      HINT,
    );
  }
  const result = rubricSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw invalidInputError(
      'INVALID_RUBRIC',
      `${source}: invalid — ${where}: ${issue.message}`,
      HINT,
    );
  }
  return result.data;
}

/**
 * Read + parse rubric.yaml. A missing/unreadable file fails closed at exit 3: the
 * reviewer's law must exist for any review to be adjudicated (invariant 3).
 */
export function readRubric(path: string): Rubric {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw invalidInputError(
      'INVALID_RUBRIC',
      `${path}: could not be read — ${messageOf(cause)}`,
      HINT,
    );
  }
  return parseRubric(text, path);
}

// dist/review/rubric.js (or src/review/rubric.ts) → core/ root → assets/.
// The asset lives OUTSIDE src/ so tsc leaves it untouched; the ../../ walk is
// uniform across the source tree and the built tree (rootDir: src, outDir: dist).
const assetsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

/** Absolute path to the framework-shipped default rubric. */
export function defaultRubricPath(): string {
  return join(assetsRoot, 'rubric.default.yaml');
}

/** Load + validate the framework-shipped default rubric (a TCB build asset). */
export function loadDefaultRubric(): Rubric {
  return readRubric(defaultRubricPath());
}

/** The set of line ids in a rubric — the authority for "is this a known rule?". */
export function rubricIds(rubric: Rubric): Set<string> {
  return new Set(rubric.lines.map((l) => l.id));
}

/** Lowercase sha256 of a rubric file's raw bytes — the value verdicts pin. */
export function rubricHash(path: string): string {
  return hashFile(path);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
