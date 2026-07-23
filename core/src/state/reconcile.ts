// state.yaml reconciliation — the ONE place a corrupt or diverged derived audit
// trail is repaired (charter §State & Audit: "status recomputes state from the
// artifacts + hashes and rewrites the file if reality diverges"; design §9).
//
// Everywhere else, a malformed state.yaml fails closed at exit 3 (state.ts's
// parseState). `status` is the exception by design: state.yaml is a *derived*
// cache (invariant 1 — nothing reads it to make an enforcement decision), so the
// tool whose job is to recompute it must tolerate a corrupt one and rewrite it
// rather than crash. That tolerance lives here, isolated from the strict parser,
// so no enforcement path can accidentally accept a broken log.
//
// Reconciliation is conservative. `status` derives only a COARSE phase from the
// artifacts (it runs no oracles — see status.ts), so it must not clobber the
// finer red/green labels the commands record (`implement-red`, `propose-red`):
// those carry a verify verdict status cannot recompute. The caller supplies a
// `consistent` predicate; the file is rewritten only when it is missing, corrupt,
// or its recorded phase is provably inconsistent with the derived one. On a
// consistent match the file (and its event history) is left byte-for-byte alone.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseState, serializeState, type State } from './state.js';

/** The outcome of a reconcile pass: the current state + whether it was rewritten. */
export interface ReconcileResult {
  /** The state.yaml that now exists on disk (derived phase when rewritten). */
  state: State;
  /** True iff this pass wrote state.yaml (missing, corrupt, or diverged). */
  rewritten: boolean;
}

/**
 * Read + strict-parse state.yaml, returning `undefined` if it is missing OR
 * corrupt (unparseable / schema-invalid). Unlike the strict reader in state.ts,
 * this never throws — `status` needs a corrupt log to reduce to "rebuild", not to
 * an exit-3. It is deliberately NOT exported for general use: only reconciliation
 * may treat a malformed audit trail as absent.
 */
function readStateTolerant(path: string): State | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined; // missing (or unreadable) → rebuild from the derived phase
  }
  try {
    return parseState(text, path);
  } catch {
    return undefined; // corrupt → rebuild; status is the repair tool (design §9)
  }
}

/**
 * Reconcile the derived-audit-trail file at `path` against the phase `status`
 * derived from the artifacts:
 *
 *   - missing / corrupt          → rebuild a fresh log at `derivedPhase` (the
 *                                  event history is unrecoverable from artifacts,
 *                                  so it starts empty — the file is a cache).
 *   - recorded phase inconsistent → rewrite `snapshot.phase` to `derivedPhase`,
 *                                  PRESERVING the event log + `last_verify` (only
 *                                  the reality-diverged field is corrected).
 *   - recorded phase consistent   → no write; return the file untouched so finer
 *                                  labels (`implement-red`) and event history are
 *                                  preserved (status runs no oracles to regrade).
 *
 * `consistent(recorded, derived)` encodes the phase semantics (status.ts) — kept
 * out of here so this module stays pure file mechanics.
 */
export function reconcileState(
  path: string,
  change: string,
  derivedPhase: string,
  consistent: (recordedPhase: string, derivedPhase: string) => boolean,
): ReconcileResult {
  const existing = readStateTolerant(path);

  if (existing === undefined) {
    const rebuilt: State = { change, events: [], snapshot: { phase: derivedPhase } };
    writeFileSync(path, serializeState(rebuilt), 'utf8');
    return { state: rebuilt, rewritten: true };
  }

  if (consistent(existing.snapshot.phase, derivedPhase)) {
    return { state: existing, rewritten: false };
  }

  // Diverged: correct the phase in place, keep the audit history + last_verify.
  existing.snapshot.phase = derivedPhase;
  writeFileSync(path, serializeState(existing), 'utf8');
  return { state: existing, rewritten: true };
}
