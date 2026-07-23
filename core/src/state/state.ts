// state.yaml — the derived audit trail (charter §State & Audit; design
// phase-0-1.md §3).
//
// **Artifacts are the truth; state.yaml is a derived cache and audit trail**
// (invariant 1): NOTHING here is ever read to make an enforcement decision.
// Every command writes it as its last step — this module gives them the minimal
// append primitive: read the current log (or start a fresh one), push one event,
// serialize deterministically, write. `status` (P1-14) will add the
// reconcile-from-artifacts pass on top of this; P1-07 needs only the writer.
//
// Deterministic (invariant 12): the caller supplies the timestamp (no wall-clock
// here); events are appended in call order; serialization is stable. A malformed
// state.yaml on disk fails closed at exit 3 like every other artifact parser —
// a corrupt audit log is never silently discarded here (P1-14's status is the
// place that *reconciles* it back from the artifacts).

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

/** One append-only audit event: when, which command, a one-line summary. */
const stateEventSchema = z.strictObject({
  at: z.string().min(1),
  cmd: z.string().min(1),
  summary: z.string(),
});

/** The current derived snapshot (grows across phases; P1 tracks phase only). */
const snapshotSchema = z.strictObject({
  phase: z.string().min(1),
  last_verify: z.string().optional(),
});

/** state.yaml (design §3), strict — an unknown key fails closed at exit 3. */
export const stateSchema = z.strictObject({
  change: z.string().min(1),
  events: z.array(stateEventSchema),
  snapshot: snapshotSchema,
});

export type StateEvent = z.infer<typeof stateEventSchema>;
export type State = z.infer<typeof stateSchema>;

/** Serialize state to canonical state.yaml text (deterministic, invariant 12). */
export function serializeState(state: State): string {
  return stringifyYaml(state, { sortMapEntries: false });
}

/** Parse + strict-validate state.yaml text. Any defect → exit 3 (fail-closed). */
export function parseState(text: string, source: string): State {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_STATE',
      `${source}: state.yaml is not valid YAML — ${messageOf(cause)}`,
      'state.yaml is a derived audit trail; run `crucible status` to reconcile it from the artifacts.',
    );
  }
  const result = stateSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw invalidInputError(
      'INVALID_STATE',
      `${source}: state.yaml invalid — ${where}: ${issue.message}`,
      'state.yaml is a derived audit trail; run `crucible status` to reconcile it from the artifacts.',
    );
  }
  return result.data;
}

/**
 * Append one event to the state log at `path`, writing it back. If no state.yaml
 * exists yet, a fresh log is started for `change`. The `snapshot.phase` is
 * advanced to the appending command's phase. Never reads the log to decide
 * anything (invariant 1) — it only accumulates the audit trail.
 */
export function appendStateEvent(
  path: string,
  change: string,
  event: StateEvent,
  phase: string,
): void {
  const state = readState(path) ?? { change, events: [], snapshot: { phase } };
  state.events.push(event);
  state.snapshot.phase = phase;
  writeFileSync(path, serializeState(state), 'utf8');
}

/** Read + parse state.yaml, or `undefined` if it does not exist yet. */
function readState(path: string): State | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw invalidInputError(
      'INVALID_STATE',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on state.yaml.',
    );
  }
  return parseState(text, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
