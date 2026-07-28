// `crucible archive <change>` — retire a shipped change into the regression set
// (charter §The Regression Suite: "archiving is registration"; design phase-2.md
// §1).
//
// Archiving is the moment a change's oracles STOP being "the current change under
// review" and BECOME a permanent past promise every future `verify` must honor.
// There is no separate registry: the archive dir on disk IS the regression suite
// (regression/regression.ts derives it). So this command's whole job is to move a
// finished change into the archive SAFELY — and it refuses to move anything it is
// not certain about (invariant 3, fail-closed):
//
//   Preconditions (all fail-closed, checked before any move):
//     1. the change bundle exists                              (exit 2)
//     2. it is approved — an unsealed change has nothing to register (exit 2)
//     3. the bundle parses under Crucible's OWN parsers        (exit 3)
//     4. the seal is still valid — no post-approval drift      (exit 2)
//     5. `openspec validate --strict --json` reports `valid`   (exit 3)
//        — parsed from the JSON verdict, NEVER the exit code (spike D4).
//
// Only then does it shell out (injected) to `openspec archive <change> --yes`,
// which moves the whole change dir — Crucible-owned approval.yaml/state.yaml
// included — to `openspec/changes/archive/YYYY-MM-DD-<name>/` and merges the spec
// deltas into `openspec/specs/<capability>/spec.md` with the `[REQ-*]` bracketed
// headings preserved (spike §Repro). The command does NOT trust the archiver's
// silence: it verifies afterward that the source dir is gone and an archive entry
// appeared (invariant 3), exactly as `propose` re-checks its scaffolder.
//
// Determinism (invariant 12): the clock and the two OpenSpec edges (validate,
// archive) are injected (`ArchiveDeps`); the core holds no wall-clock and spawns
// nothing. The audit event is appended into the MOVED state.yaml as a best-effort
// last step — the archive already happened and is irreversible, so a corrupt
// audit log must not fail a completed archival (invariant 1: state never gates).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { loadOracles } from '../artifacts/oracles.js';
import { loadProposal } from '../artifacts/proposal.js';
import { loadAllRequirements } from './bundle.js';
import { appendStateEvent } from '../state/state.js';
import { invalidInputError, preconditionError } from '../util/errors.js';

/** The parsed `openspec validate --strict --json` verdict (spike D4: verdict, not exit code). */
export interface OpenSpecValidation {
  /** Whether OpenSpec's own delta-grammar validation passed. */
  valid: boolean;
  /** Human-readable issue lines, surfaced in the fail-closed error when invalid. */
  issues: string[];
}

/** Injected non-deterministic edges — so the command's core stays reproducible. */
export interface ArchiveDeps {
  /** The archival timestamp (ISO 8601). Injected — no wall-clock in the core. */
  now: () => string;
  /**
   * Run `openspec validate <change> --strict --json` and return the PARSED
   * verdict (spike D4: `validate --json` exits 0 even when invalid, so the caller
   * MUST parse the JSON `valid` field, never trust the exit code). The CLI wires
   * the real spawn; tests pass a pure function.
   */
  validate: (change: string) => Promise<OpenSpecValidation>;
  /**
   * Run `openspec archive <change> --yes`, moving the change dir into the archive
   * and merging its deltas into `openspec/specs/`. Injected because the real one
   * spawns the pinned OpenSpec CLI; the core verifies the move afterward rather
   * than trusting the archiver's silence (invariant 3).
   */
  archive: (change: string) => Promise<void>;
}

/** archive invocation options. `root` is the repo root the bundle lives under. */
export interface ArchiveOptions {
  /** Repo root: the change lives at openspec/changes/<change>/. */
  root: string;
  /** The change to archive (must be approved + valid). */
  change: string;
}

/** archive outcome: where the change was moved + a one-line render for the CLI. */
export interface ArchiveResult {
  /** Repo-relative path of the archive directory the change was moved into. */
  archivedRel: string;
  /** One-line human confirmation the CLI prints. */
  render: string;
}

// The archive dir OpenSpec creates: `YYYY-MM-DD-<change>`. The date is
// OpenSpec-owned and opaque to us (design §1); we only use this to CONFIRM the
// move landed, never to parse the date.
const archiveEntryFor = (change: string): RegExp =>
  new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(change)}$`);

/**
 * Archive an approved change into the regression set. Throws `CrucibleError` on
 * any unmet precondition (exit 2/3), naming the fix, BEFORE any irreversible
 * move. On success the change dir has moved under openspec/changes/archive/ and
 * its bindings are now part of the regression suite every future verify re-runs.
 */
export async function archive(options: ArchiveOptions, deps: ArchiveDeps): Promise<ArchiveResult> {
  const { root, change } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  // 1. The bundle must exist.
  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // 2. It must be approved — an unsealed change has nothing to register, and its
  // oracles were never sealed as trustworthy (charter: archiving registers an
  // APPROVED change's bindings).
  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'NOT_APPROVED',
      `Change ${change} is not approved — only an approved, sealed change can be archived into the regression set.`,
      `Run \`crucible approve ${change}\` to seal the reviewed bundle first.`,
    );
  }

  // 3. The bundle must parse under Crucible's OWN parsers (fail-closed exit 3):
  // proposal grammar, every spec delta, oracles + bindings. A malformed artifact
  // must never enter the regression suite (a corrupt past promise judges forever).
  loadProposal(join(changeDir, 'proposal.md'));
  loadAllRequirements(changeDir, changeRel);
  loadOracles(join(changeDir, 'oracles.md'));

  // 4. The seal must still be valid — no file drifted since approval (invariant 6).
  // Archiving a voided approval would register bindings the human never sealed.
  const approval = loadApproval(approvalPath);
  const seal = verifyApproval(root, approval);
  if (!seal.valid) {
    throw preconditionError(
      'SEAL_VOID',
      `The approval for ${change} is void — these sealed files changed since approval: ${seal.mismatches.join(', ')}.`,
      `Re-review and re-seal with \`crucible approve ${change}\` (or revert the edits), then archive.`,
    );
  }

  // 5. OpenSpec's own delta-grammar validation must pass — `archive` merges the
  // deltas into the living spec set, and a delta OpenSpec rejects would corrupt
  // that merge. Parse the JSON verdict, NEVER the exit code (spike D4).
  const validation = await deps.validate(change);
  if (!validation.valid) {
    const detail = validation.issues.length > 0 ? ` — ${validation.issues.join('; ')}` : '';
    throw invalidInputError(
      'OPENSPEC_INVALID',
      `OpenSpec rejects ${change}: \`openspec validate --strict\` reports invalid${detail}.`,
      'Fix the spec delta against OpenSpec’s grammar (operation headers + a `#### Scenario:` per requirement), then archive.',
    );
  }

  // Preconditions all green → perform the (irreversible) archive.
  await deps.archive(change);

  // Do NOT trust the archiver's silence (invariant 3): confirm the source dir is
  // gone and an archive entry appeared, or fail closed.
  if (existsSync(changeDir)) {
    throw invalidInputError(
      'ARCHIVE_INCOMPLETE',
      `\`openspec archive ${change}\` returned but ${changeRel} still exists — the change was not moved.`,
      'Check the OpenSpec CLI output; the archive did not complete. Do not hand-move the dir.',
    );
  }
  const archivedName = findArchiveEntry(root, change);
  if (archivedName === undefined) {
    throw invalidInputError(
      'ARCHIVE_INCOMPLETE',
      `\`openspec archive ${change}\` returned but no openspec/changes/archive/*-${change} entry was created.`,
      'Check the OpenSpec CLI output; the archive did not complete.',
    );
  }
  const archivedRel = join('openspec', 'changes', 'archive', archivedName);

  // Audit trail, best-effort (invariant 1: state is derived, never gates). The
  // archive already happened and cannot be undone, so a corrupt/absent moved
  // state.yaml must not fail a completed archival.
  try {
    appendStateEvent(
      join(root, archivedRel, 'state.yaml'),
      change,
      {
        at: deps.now(),
        cmd: 'archive',
        summary: `archived to ${archivedRel} — bindings registered in the regression set`,
      },
      'archived',
    );
  } catch {
    /* the archive succeeded; a derived audit-log write must not fail it. */
  }

  return {
    archivedRel,
    render: `Archived ${change} → ${archivedRel}. Its oracles now run as regression on every verify.`,
  };
}

/** The archive entry name matching this change, or undefined if none exists. */
function findArchiveEntry(root: string, change: string): string | undefined {
  const archiveDir = join(root, 'openspec', 'changes', 'archive');
  if (!existsSync(archiveDir)) return undefined;
  const pattern = archiveEntryFor(change);
  // Newest (lexicographically greatest — the date prefix sorts chronologically)
  // wins if a same-named change was archived before, so the fresh entry is chosen.
  const matches = readdirSync(archiveDir)
    .filter((entry) => pattern.test(entry) && statSync(join(archiveDir, entry)).isDirectory())
    .sort();
  return matches.length > 0 ? matches[matches.length - 1] : undefined;
}

/** Escape a change name for safe embedding in a RegExp (names are kebab-case, but be safe). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
