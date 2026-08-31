// `crucible archive <change>` — the P4R transaction that promotes a finished
// change into permanent regression input. Unlike the retired P2 command, this
// boundary validates the schema-complete approval scope and re-runs deterministic
// verification before one OpenSpec sync-and-move operation. It snapshots the
// affected filesystem roots first, so a failed sync, collision, or incomplete
// move is restored rather than leaving a half-archived promise behind.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { readChangeType, schemaForType } from '../changetype/changetype.js';
import { loadSchemaBundle } from '../changetype/schema-bundle.js';
import type { ResolveFn } from '../lint/traceability.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { isCrucibleError, invalidInputError, preconditionError } from '../util/errors.js';
import { validateProposalBundle } from './bundle.js';

/** Parsed `openspec validate --strict --json` verdict. */
export interface OpenSpecValidation {
  valid: boolean;
  issues: string[];
}

/** The only part of final verification archive needs to trust. */
export interface ArchiveVerification {
  verdict: 'pass' | 'fail';
}

/** Injected process/time edges; the filesystem transaction stays local and testable. */
export interface ArchiveDeps {
  /** Timestamp used solely to derive OpenSpec's canonical dated destination. */
  now: () => string;
  /** Strict OpenSpec delta validation. */
  validate: (change: string) => Promise<OpenSpecValidation>;
  /** Adapter resolution used to revalidate every bound oracle target. */
  resolve: ResolveFn;
  /** A fresh deterministic verification result — cached/self-reported green is never accepted. */
  verify: (change: string) => Promise<ArchiveVerification>;
  /**
   * Exactly one supported-OpenSpec operation that syncs specs and moves the
   * complete change directory. The core supplies rollback around this edge.
   */
  syncAndArchive: (change: string) => Promise<void>;
}

export interface ArchiveOptions {
  root: string;
  change: string;
}

export interface ArchiveResult {
  archivedRel: string;
  render: string;
}

interface Snapshot {
  path: string;
  existed: boolean;
  backup?: string;
}

/**
 * Revalidate and archive an approved implementation. The sealed bytes and all
 * unknown change-directory files are moved verbatim; archive never appends an
 * audit file because that would violate the byte-preserving contract.
 */
export async function archive(options: ArchiveOptions, deps: ArchiveDeps): Promise<ArchiveResult> {
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

  // `validateProposalBundle` is the schema/bindings judge shared by propose and
  // amend. It checks every schema extension artifact and every grounded target,
  // while allowing the post-approval tasks.md that implementation authored.
  const proposal = await validateProposalBundle(
    {
      root,
      change,
      allowPostApprovalArtifacts: true,
      archivedRequirementIds: collectArchivedRequirementIds(root),
    },
    { resolve: deps.resolve },
  );
  if (proposal.phase !== 'ready-for-approval') {
    throw preconditionError(
      'BUNDLE_INVALID',
      `Cannot archive ${change}: the current schema-complete bundle or its bindings are invalid.`,
      `Revise the reported artifacts, run \`crucible amend ${change}\` if sealed intent changed, then re-run \`crucible verify ${change}\`.`,
    );
  }

  const type = readChangeType(changeDir);
  const schema = loadSchemaBundle(
    join(root, 'openspec', 'schemas', schemaForType(type), 'schema.yaml'),
  );
  const tasks = schema.apply?.tracks;
  if (
    tasks &&
    (!existsSync(join(changeDir, tasks)) || statSync(join(changeDir, tasks)).size === 0)
  ) {
    throw preconditionError(
      'TASKS_MISSING',
      `Cannot archive ${change}: post-approval artifact ${join(changeRel, tasks)} is missing or empty.`,
      `Run \`crucible implement ${change}\` in the active session to author the implementation work breakdown, then verify again.`,
    );
  }

  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'NOT_APPROVED',
      `Change ${change} is not approved — only a sealed change can join the regression archive.`,
      `Run \`crucible approve ${change}\` in a human terminal first.`,
    );
  }
  const approval = loadApproval(approvalPath);
  const seal = verifyApproval(root, approval);
  if (!seal.valid) {
    throw preconditionError(
      'SEAL_VOID',
      `The approval for ${change} is void — sealed files changed: ${seal.mismatches.join(', ')}.`,
      `Run \`crucible amend ${change}\` and ask a human to re-seal, then verify again.`,
    );
  }

  // A valid hash map alone is insufficient: a newly introduced custom schema
  // artifact could be omitted from an old seal. Every current schema-declared
  // pre-approval artifact and every grounded oracle test must be covered.
  const unsealed = proposal.approvalCandidates.filter((path) => !(path in approval.files));
  if (unsealed.length > 0) {
    throw preconditionError(
      'SCHEMA_ARTIFACT_UNSEALED',
      `Cannot archive ${change}: required approval inputs are absent from approval.yaml: ${unsealed.join(', ')}.`,
      `Run \`crucible amend ${change}\` and ask a human to run \`crucible approve --amend ${change}\`.`,
    );
  }

  const validation = await deps.validate(change);
  if (!validation.valid) {
    const detail = validation.issues.length > 0 ? ` — ${validation.issues.join('; ')}` : '';
    throw invalidInputError(
      'OPENSPEC_INVALID',
      `OpenSpec rejects ${change}: strict validation is invalid${detail}.`,
      'Fix the spec delta against OpenSpec grammar, then re-run deterministic verification.',
    );
  }

  // This is deliberately a fresh call immediately before mutation. There is no
  // report file or agent claim that can substitute for deterministic evidence.
  const verification = await deps.verify(change);
  if (verification.verdict !== 'pass') {
    throw preconditionError(
      'VERIFY_RED',
      `Cannot archive ${change}: final deterministic verification is red.`,
      `Fix the reported implementation or test failure, then re-run \`crucible verify ${change}\`.`,
    );
  }

  const archivedName = `${archiveDate(deps.now())}-${change}`;
  const archivedRel = join('openspec', 'changes', 'archive', archivedName);
  const archivedDir = join(root, archivedRel);
  if (existsSync(archivedDir)) {
    throw preconditionError(
      'ARCHIVE_COLLISION',
      `Cannot archive ${change}: canonical destination ${archivedRel} already exists.`,
      'Choose a new change name; never overwrite an archived promise.',
    );
  }

  await runTransaction(
    root,
    changeDir,
    join(root, 'openspec', 'specs'),
    join(root, 'openspec', 'changes', 'archive'),
    async () => {
      await deps.syncAndArchive(change);
      if (
        existsSync(changeDir) ||
        !existsSync(archivedDir) ||
        !statSync(archivedDir).isDirectory()
      ) {
        throw invalidInputError(
          'ARCHIVE_INCOMPLETE',
          `OpenSpec archive did not atomically move ${changeRel} to ${archivedRel}.`,
          'No partial archive was retained; inspect the OpenSpec output and retry after fixing the filesystem issue.',
        );
      }
    },
  );

  return {
    archivedRel,
    render: `Archived ${change} → ${archivedRel}. Its bound oracle tests remain permanent regression input.`,
  };
}

/** Date portion of an injected ISO timestamp; malformed clock data fails closed. */
function archiveDate(now: string): string {
  const matched = /^(\d{4}-\d{2}-\d{2})T/.exec(now);
  if (!matched) {
    throw invalidInputError(
      'INVALID_ARCHIVE_TIME',
      `Archive timestamp ${JSON.stringify(now)} is not an ISO timestamp.`,
      'Repair the archive clock edge before retrying; destination names must be deterministic.',
    );
  }
  return matched[1]!;
}

/** Snapshot the only roots OpenSpec may change, then restore them on any failure. */
async function runTransaction(
  root: string,
  changeDir: string,
  specsDir: string,
  archiveDir: string,
  action: () => Promise<void>,
): Promise<void> {
  let staging: string;
  let snapshots: Snapshot[];
  try {
    staging = mkdtempSync(join(root, '.crucible-archive-'));
    snapshots = [changeDir, specsDir, archiveDir].map((path, index) =>
      snapshot(path, staging, index),
    );
  } catch (cause) {
    throw invalidInputError(
      'ARCHIVE_STAGING_FAILED',
      `Cannot stage an atomic archive transaction: ${messageOf(cause)}.`,
      'Check filesystem permissions and free space; no archive was attempted.',
    );
  }

  try {
    await action();
  } catch (cause) {
    try {
      restore(snapshots);
    } catch (rollbackCause) {
      throw invalidInputError(
        'ARCHIVE_ROLLBACK_FAILED',
        `Archive failed (${messageOf(cause)}) and rollback also failed: ${messageOf(rollbackCause)}.`,
        'Repair filesystem permissions immediately; the archive state may need manual recovery.',
      );
    } finally {
      removeStaging(staging);
    }
    if (isCrucibleError(cause)) throw cause;
    throw invalidInputError(
      'ARCHIVE_FAILED',
      `OpenSpec sync/archive failed: ${messageOf(cause)}. The original change and specs were restored.`,
      'Fix the reported OpenSpec or filesystem failure, then retry archive.',
    );
  }
  removeStaging(staging);
}

function snapshot(path: string, staging: string, index: number): Snapshot {
  const existed = existsSync(path);
  if (!existed) return { path, existed };
  const backup = join(staging, String(index));
  cpSync(path, backup, { recursive: true, preserveTimestamps: true });
  return { path, existed, backup };
}

function restore(snapshots: readonly Snapshot[]): void {
  // Remove current roots first, then recreate the original three roots from the
  // snapshots. This includes any partial spec sync and partial archive entry.
  for (const snapshot of snapshots) rmSync(snapshot.path, { recursive: true, force: true });
  for (const snapshot of snapshots) {
    if (!snapshot.existed || !snapshot.backup) continue;
    mkdirSync(join(snapshot.path, '..'), { recursive: true });
    cpSync(snapshot.backup, snapshot.path, { recursive: true, preserveTimestamps: true });
  }
}

function removeStaging(staging: string): void {
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    // The completed archive is authoritative; a disposable staging directory is
    // never an enforcement input and cannot turn a success into a failure.
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
