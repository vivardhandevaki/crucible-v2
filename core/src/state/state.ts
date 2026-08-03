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
import { tierDecisionSchema } from '../tier/tier.js';
import { CHANGE_TYPES } from '../changetype/changetype.js';

/** One append-only audit event: when, which command, a one-line summary, and —
 * for an event produced by an agent session (P2-11 trajectory indexing) — the
 * repo-relative path of that session's transcript. `transcript` is OPTIONAL: a
 * P1-era event, or any event not tied to a session (a local-verify verdict, an
 * archive), simply omits it. Like every derived field it is never read to gate
 * (invariant 1) — it indexes the captured trajectory for later inspection. */
const stateEventSchema = z.strictObject({
  at: z.string().min(1),
  execution_mode: z.enum(['headless', 'session-native']).optional(),
  cmd: z.string().min(1),
  summary: z.string(),
  transcript: z.string().min(1).optional(),
});

/**
 * The current derived snapshot (grows across phases). `tier` is the recomputed
 * tier decision with the facts it rests on (charter §State & Audit: "computed
 * tier with its inputs"), recorded by the recomputation points (approve /
 * implement / CI verify — design phase-2.md §2) and displayed by `status`. It is
 * optional: a P1-era state.yaml, or a change not yet tier-computed, simply omits
 * it. Like every derived field it is never read to make an enforcement decision
 * (invariant 1) — CI recomputes the authoritative tier.
 */
const snapshotSchema = z.strictObject({
  phase: z.string().min(1),
  last_verify: z.string().optional(),
  tier: tierDecisionSchema.optional(),
  /** The change type recorded from the `.openspec.yaml` schema pin (design
   * phase-2.md §4), set at propose and displayed by `status`. Optional: a P1-era
   * state.yaml omits it. Like every derived field it is never read to make an
   * enforcement decision (invariant 1) — verify re-reads the pin and revalidates. */
  change_type: z.enum(CHANGE_TYPES).optional(),
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

/**
 * Best-effort (invariant 11): record a recomputed tier decision into
 * `snapshot.tier` so `status` can display it (design phase-2.md §2 — the
 * populator P2-02 deferred to "the diff edge in P2-03"). Convenience only: it
 * NEVER creates a state.yaml (an absent file is left absent), never advances the
 * phase, and is never read to make an enforcement decision (invariant 1 — CI
 * recomputes the authoritative tier). A parse/write failure is swallowed by the
 * caller: a display cache must never block the verdict. Returns whether it wrote.
 */
export function recordSnapshotTier(path: string, tier: State['snapshot']['tier']): boolean {
  const state = readState(path);
  if (state === undefined) return false;
  state.snapshot.tier = tier;
  writeFileSync(path, serializeState(state), 'utf8');
  return true;
}

/**
 * Record the change type into `snapshot.change_type` so `status` can display it
 * (design phase-2.md §4). Best-effort convenience (invariant 11), like
 * `recordSnapshotTier`: it NEVER creates a state.yaml (absent → left absent),
 * never advances the phase, and is never read to make an enforcement decision
 * (invariant 1 — verify re-reads the `.openspec.yaml` pin). Returns whether it wrote.
 */
export function recordSnapshotType(
  path: string,
  changeType: State['snapshot']['change_type'],
): boolean {
  const state = readState(path);
  if (state === undefined) return false;
  state.snapshot.change_type = changeType;
  writeFileSync(path, serializeState(state), 'utf8');
  return true;
}

/**
 * The summary prefix `implement` writes for its local-verify step (design §6).
 * A single stable constant so the WRITER (implement's final audit event) and the
 * READER (the P2-11 trajectory stamp below) never drift apart on a magic string.
 */
export const LOCAL_VERIFY_SUMMARY_PREFIX = 'local verify';

/**
 * Was a local verify recorded in this change's state.yaml before this run? — the
 * P2-11 trajectory stamp (design phase-2.md §6; charter §278 "was local verify
 * actually run before push?"). CI reads this to SURFACE an advise-level finding,
 * never to gate.
 *
 * BEST-EFFORT by construction (invariant 11): it feeds a NON-BLOCKING advisory (a
 * parked trajectory check — capture now, judge later), so an absent OR malformed
 * state.yaml is treated as "not run" rather than thrown. This deliberately does
 * NOT fail closed: it is never read to make an enforcement decision (invariant 1),
 * and the authoritative fail-closed on a corrupt audit log stays `status`'s job
 * (which reconciles it from the artifacts). A verify VERDICT must never move on a
 * display-trail read. The signal is `implement`'s local-verify event: CI runs
 * `verify`, not `implement`, so this never sees its own run (no self-stamping).
 */
export function localVerifyRecorded(statePath: string): boolean {
  let text: string;
  try {
    text = readFileSync(statePath, 'utf8');
  } catch {
    return false;
  }
  let state: State;
  try {
    state = parseState(text, statePath);
  } catch {
    return false;
  }
  return state.events.some((e) => e.summary.startsWith(LOCAL_VERIFY_SUMMARY_PREFIX));
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
