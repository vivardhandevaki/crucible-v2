// `crucible override <change> "<reason>"` — the 2am escape hatch (charter
// §Approval, Amend, Override; charter §What Survives From V1 row 5; design
// phase-2.md §3).
//
// override writes a committed override.yaml into the change bundle. Its presence
// PERMITS a gate bypass: verify (in CI and locally) then forces its verdict green-
// with-`override`, forces routing → human regardless of tier, and emits the
// ratchet-issue payload CI files. The teeth are elsewhere (verify + the CI
// template); this command's whole job is to record the bypass HONESTLY —
// "instant to use, impossible to use quietly" (charter row 5).
//
// It is precondition-gated (invariant 5): it refuses — exit 2, naming the fix —
// unless the change bundle exists and a non-empty reason was given (a silent /
// reasonless override would defeat the loudness contract). It writes nothing else
// and resolves nothing through an adapter.
//
// Determinism (invariant 12): the clock and the operator identity are injected
// (`OverrideDeps`); the core holds no wall-clock and no randomness. It appends a
// state event last — a derived audit trail, never read to gate (invariant 1).

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERRIDE_VERSION, buildOverride, serializeOverride } from '../artifacts/override.js';
import { appendStateEvent } from '../state/state.js';
import { preconditionError } from '../util/errors.js';

/** Injected non-deterministic edges — so the command's core stays reproducible. */
export interface OverrideDeps {
  /** The override timestamp (ISO 8601). Injected — no wall-clock in the core. */
  now: () => string;
  /** Who is overriding (e.g. git user email). Injected for determinism. */
  overriddenBy: () => string;
}

/** override invocation options. `root` is the repo root the bundle lives under. */
export interface OverrideOptions {
  /** Repo root: override.yaml is written under openspec/changes/<change>/. */
  root: string;
  /** The change name (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /** Why the gate is being bypassed — required, non-empty (missing → exit 2). */
  reason: string;
}

/** override outcome: the path written + the recorded reason (for the CLI render). */
export interface OverrideResult {
  /** Repo-relative path of the override.yaml written. */
  path: string;
  /** The recorded reason (trimmed). */
  reason: string;
}

/**
 * Record a gate bypass. Throws `CrucibleError` (exit 2) if a precondition is
 * unmet — the change bundle is absent, or the reason is missing/blank — naming
 * the fix. On success it writes override.yaml + a state event and returns the
 * written path. Idempotent-ish: re-running overwrites with a fresh timestamp.
 */
export function override(options: OverrideOptions, deps: OverrideDeps): OverrideResult {
  const { root, change } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // A reasonless override would defeat the loudness contract — refuse it (exit 2).
  // This also catches an empty-string reason that slips past the CLI's required arg.
  const reason = options.reason.trim();
  if (reason.length === 0) {
    throw preconditionError(
      'NO_REASON',
      'An override must state a reason — it is recorded and files a ratchet issue.',
      `Run \`crucible override ${change} "<reason>"\` with a non-empty reason.`,
    );
  }

  const artifact = buildOverride({
    version: OVERRIDE_VERSION,
    change,
    reason,
    created_by: deps.overriddenBy(),
    created_at: deps.now(),
  });
  const overrideRel = join(changeRel, 'override.yaml');
  writeFileSync(join(root, overrideRel), serializeOverride(artifact), 'utf8');

  // Append the audit event last (design §3 / invariant 1 — never read to gate).
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    { at: deps.now(), cmd: 'override', summary: `gate bypass recorded: ${reason}` },
    'overridden',
  );

  return { path: overrideRel, reason };
}
