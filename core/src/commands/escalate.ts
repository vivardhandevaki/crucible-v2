// `crucible escalate` — the agent's "stop on ambiguity" command (charter
// §Escalation — Three Enforcement Layers, layer 2; charter §Loop Mechanics:
// "ambiguity is a spec bug, fixed upstream at propose, never improvised at
// implement"; design phase-2.md §3).
//
// The implement agent runs this the moment it hits a decision that is not
// derivable from the approved spec. It writes a committed escalation.yaml into the
// change bundle — whose presence HALTS the current implement run and refuses every
// resume until `crucible amend` clears it (the structural teeth live in
// commands/implement.ts; this command's job is to record the ambiguity HONESTLY
// and announce it). Resolution flows through `amend` (spec patch + delta-approval).
//
// It is precondition-gated (invariant 5): it refuses — exit 2, naming the fix —
// unless the change bundle exists, a non-empty question was asked, and at least one
// actionable option was offered (an un-actionable escalation cannot be resolved).
//
// Notify (charter §Notify Hooks): after the artifact is on disk it fires the
// injected notify dispatcher so unattended runs surface. Hooks are convenience,
// never enforcement (invariant 11): a throwing / rejecting hook is swallowed — the
// blocker is the artifact, and a broken webhook must never change the outcome.
//
// Determinism (invariant 12): the clock, the operator identity, and the notify
// dispatcher are injected (`EscalateDeps`); the core holds no wall-clock and no
// randomness. It appends a state event last — a derived audit trail, never read to
// gate (invariant 1).

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ESCALATION_VERSION,
  buildEscalation,
  serializeEscalation,
} from '../artifacts/escalation.js';
import { appendStateEvent } from '../state/state.js';
import type { NotifyFn } from '../notify/types.js';
import { preconditionError } from '../util/errors.js';

/** Injected non-deterministic edges — so the command's core stays reproducible. */
export interface EscalateDeps {
  /** The escalation timestamp (ISO 8601). Injected — no wall-clock in the core. */
  now: () => string;
  /** Who is escalating (e.g. the implement role / git user). Injected. */
  filedBy: () => string;
  /** Convenience notify dispatcher (invariant 11) — fire-and-forget, may throw. */
  notify: NotifyFn;
}

/** escalate invocation options. `root` is the repo root the bundle lives under. */
export interface EscalateOptions {
  /** Repo root: escalation.yaml is written under openspec/changes/<change>/. */
  root: string;
  /** The change name (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /** What is underspecified — required, non-empty (missing → exit 2). */
  question: string;
  /** Candidate resolutions; blanks are dropped, ≥1 must remain (else exit 2). */
  options: string[];
  /** The oracle the ambiguity concerns, when it maps to one (optional). */
  oracle?: string;
}

/** escalate outcome: the path written + the recorded question (for the CLI render). */
export interface EscalateResult {
  /** Repo-relative path of the escalation.yaml written. */
  path: string;
  /** The recorded question (trimmed). */
  question: string;
}

/**
 * File an escalation. Throws `CrucibleError` (exit 2) if a precondition is unmet —
 * the change bundle is absent, the question is missing/blank, or no actionable
 * option was offered — naming the fix. On success it writes escalation.yaml + a
 * state event, fires the notify hooks (failures swallowed, invariant 11), and
 * returns the written path. Re-running overwrites with a fresh escalation.
 */
export async function escalate(
  options: EscalateOptions,
  deps: EscalateDeps,
): Promise<EscalateResult> {
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

  // A reasonless escalation cannot be resolved — refuse it (exit 2). This also
  // catches an empty question that slips past the CLI's required option.
  const question = options.question.trim();
  if (question.length === 0) {
    throw preconditionError(
      'NO_QUESTION',
      'An escalation must state the ambiguity — the question the human must resolve.',
      `Run \`crucible escalate ${change} --question "<what is underspecified>" --option "<a>" --option "<b>"\`.`,
    );
  }

  // Drop blank options; at least one actionable resolution must remain, or the
  // escalation is un-resolvable (amend needs something to pick).
  const optionList = options.options.map((o) => o.trim()).filter((o) => o.length > 0);
  if (optionList.length === 0) {
    throw preconditionError(
      'NO_OPTIONS',
      'An escalation must offer at least one candidate resolution (--option).',
      `Run \`crucible escalate ${change} --question "..." --option "<a>" --option "<b>"\`.`,
    );
  }

  const oracle = options.oracle?.trim();
  const artifact = buildEscalation({
    version: ESCALATION_VERSION,
    change,
    ...(oracle !== undefined && oracle.length > 0 ? { oracle } : {}),
    question,
    options: optionList,
    filed_by: deps.filedBy(),
    filed_at: deps.now(),
  });
  const escalationRel = join(changeRel, 'escalation.yaml');
  writeFileSync(join(root, escalationRel), serializeEscalation(artifact), 'utf8');

  // Append the audit event (design §3 / invariant 1 — never read to gate).
  const summary = oracle ? `${oracle}: ${question}` : question;
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    { at: deps.now(), cmd: 'escalate', summary: `escalation filed — ${summary}` },
    'escalated',
  );

  // Announce (charter §Notify Hooks). Fire-and-forget: a throwing or rejecting
  // hook is swallowed here (invariant 11) — the escalation.yaml on disk is the
  // blocker, never the notification. The concrete dispatcher (P2-15) logs its own
  // hook failures; the artifact is already committed by this point.
  try {
    await deps.notify({ kind: 'escalation', change, summary: `ESCALATION: ${summary}` });
  } catch {
    /* convenience-never-enforcement: a broken hook cannot fail an escalation. */
  }

  return { path: escalationRel, question };
}
