// P4R-10 target-owned CI orchestration. The trusted workflow validates exact
// B/H identities first, then calls this module with the resulting partition.
// Base-owned config, framework, adapter bytes, and historical oracles come from
// B; candidate code, tests, and the newly archived approved bundle come from H.

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';
import { loadApproval } from '../artifacts/approval.js';
import { loadOracles } from '../artifacts/oracles.js';
import type { CiTrustPartition } from '../ci/trust.js';
import { readChangeType, schemaForType } from '../changetype/changetype.js';
import { loadSchemaBundle } from '../changetype/schema-bundle.js';
import { loadEnforcementConfig } from '../config/enforcement.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { invalidInputError } from '../util/errors.js';
import type { VerifyReport } from '../verifyx/report.js';
import { judgeBundle, schemaPreApprovalPaths } from './bundle.js';
import { verify } from './verify.js';
import { liveVerifyDeps } from './verify.cli.js';

const ARCHIVE_REL = join('openspec', 'changes', 'archive');
const ARCHIVE_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface CandidateArchive {
  entry: string;
  change: string;
  dir: string;
  rel: string;
  sealedRel: string;
}

export interface CiArchiveVerificationContext {
  baseRoot: string;
  candidateRoot: string;
  baseSha: string;
  candidateSha: string;
}

export interface CiVerificationDeps {
  discoverArchives: (baseRoot: string, candidateRoot: string) => CandidateArchive[];
  verifyArchive: (
    archive: CandidateArchive,
    context: CiArchiveVerificationContext,
  ) => Promise<VerifyReport>;
}

export interface CiVerificationReport {
  version: 1;
  event: 'pull_request' | 'merge_group';
  repository: string;
  base_sha: string;
  candidate_sha: string;
  verdict: 'pass' | 'fail';
  changes: { entry: string; change: string; report: VerifyReport }[];
}

/** Compare directory identities at B and H; branch names and candidate manifests are irrelevant. */
export function discoverCandidateArchives(
  baseRoot: string,
  candidateRoot: string,
): CandidateArchive[] {
  const baseEntries = new Set(archiveEntries(join(baseRoot, ARCHIVE_REL), false));
  const candidateArchiveRoot = join(candidateRoot, ARCHIVE_REL);
  const entries = archiveEntries(candidateArchiveRoot, true).filter(
    (entry) => !baseEntries.has(entry),
  );
  const found: CandidateArchive[] = [];

  for (const entry of entries) {
    const matched = ARCHIVE_NAME.exec(entry);
    if (!matched?.[2]) {
      fail(
        'CI_ARCHIVE_NAME_INVALID',
        `Candidate archive entry ${JSON.stringify(entry)} is not canonical.`,
      );
    }
    const change = matched[2];
    const rel = join(ARCHIVE_REL, entry);
    const dir = join(candidateRoot, rel);
    if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory()) {
      fail('CI_ARCHIVE_PATH_INVALID', `Candidate archive ${rel} is not a real directory in H.`);
    }
    found.push({
      entry,
      change,
      dir,
      rel,
      sealedRel: join('openspec', 'changes', change),
    });
  }
  return found;
}

/** Aggregate every newly archived candidate change; missing evidence is never a successful no-op. */
export async function runCiVerification(
  partition: CiTrustPartition,
  deps: CiVerificationDeps,
): Promise<CiVerificationReport> {
  const archives = deps.discoverArchives(partition.base.root, partition.candidate.root);
  if (archives.length === 0) {
    fail('CI_CHANGE_MISSING', 'Candidate H contains no newly archived, approved change to verify.');
  }

  const context: CiArchiveVerificationContext = {
    baseRoot: partition.base.root,
    candidateRoot: partition.candidate.root,
    baseSha: partition.base.sha,
    candidateSha: partition.candidate.sha,
  };
  const changes: CiVerificationReport['changes'] = [];
  for (const archive of archives) {
    changes.push({
      entry: archive.entry,
      change: archive.change,
      report: await deps.verifyArchive(archive, context),
    });
  }

  return {
    version: 1,
    event: partition.event,
    repository: partition.repository,
    base_sha: partition.base.sha,
    candidate_sha: partition.candidate.sha,
    verdict: changes.every((item) => item.report.verdict === 'pass') ? 'pass' : 'fail',
    changes,
  };
}

/** Live boundary used only after establishCiTrustPartition returned successfully. */
export async function runLiveCiVerification(
  partition: CiTrustPartition,
): Promise<CiVerificationReport> {
  const adapter = loadPinnedAdapterClient(partition.base.root, partition.candidate.root);
  const config = loadEnforcementConfig(partition.base.root);
  return runCiVerification(partition, {
    discoverArchives: discoverCandidateArchives,
    verifyArchive: async (archive, context) => {
      await assertCandidateArchive(archive, context, (targets) => adapter.resolve(targets));
      return verify(
        {
          root: context.candidateRoot,
          trustRoot: context.baseRoot,
          change: archive.change,
          changeLocation: {
            dir: archive.dir,
            rel: archive.rel,
            sealedRel: archive.sealedRel,
          },
          config,
        },
        liveVerifyDeps(context.candidateRoot, context.baseSha, context.baseRoot),
      );
    },
  });
}

type ResolveTargets = ReturnType<typeof loadPinnedAdapterClient>['resolve'];

/** Revalidate the H bundle against B's schema and adapter before any suite executes. */
async function assertCandidateArchive(
  archive: CandidateArchive,
  context: CiArchiveVerificationContext,
  resolveTargets: ResolveTargets,
): Promise<void> {
  if (!existsSync(join(archive.dir, '.openspec.yaml'))) {
    fail('CI_ARCHIVE_INCOMPLETE', `${archive.rel} has no .openspec.yaml metadata.`);
  }

  const type = readChangeType(archive.dir);
  const schema = loadSchemaBundle(
    join(context.baseRoot, 'openspec', 'schemas', schemaForType(type), 'schema.yaml'),
  );
  const judged = await judgeBundle(
    archive.change,
    archive.dir,
    archive.rel,
    resolveTargets,
    collectArchivedRequirementIds(context.baseRoot),
    type,
  );
  if (judged.verdict !== 'pass') {
    fail('CI_CANDIDATE_BUNDLE_INVALID', `${archive.rel} fails base-owned bundle validation.`);
  }

  const artifacts = schemaPreApprovalPaths(archive.dir, schema);
  for (const artifact of artifacts) {
    const path = join(archive.dir, artifact);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      fail('CI_ARCHIVE_INCOMPLETE', `${archive.rel} is missing base-schema artifact ${artifact}.`);
    }
  }
  if (schema.apply?.tracks) {
    const path = join(archive.dir, schema.apply.tracks);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      fail(
        'CI_ARCHIVE_INCOMPLETE',
        `${archive.rel} is missing post-approval artifact ${schema.apply.tracks}.`,
      );
    }
  }

  const approval = loadApproval(join(archive.dir, 'approval.yaml'));
  if (approval.change !== archive.change) {
    fail(
      'CI_APPROVAL_CHANGE_MISMATCH',
      `${archive.rel}/approval.yaml seals ${approval.change}, not ${archive.change}.`,
    );
  }

  for (const relpath of Object.keys(approval.files)) assertSafeCandidatePath(relpath);
  const required = new Set(artifacts.map((artifact) => join(archive.sealedRel, artifact)));
  const oracles = loadOracles(join(archive.dir, 'oracles.md'));
  const targets = [...new Set(oracles.flatMap((oracle) => oracle.binding.targets))];
  const resolved = await resolveTargets(targets);
  const byTarget = new Map(resolved.map((item) => [item.target, item] as const));
  for (const target of targets) {
    const result = byTarget.get(target);
    if (result?.status !== 'found' || !result.targetFile) {
      fail('CI_ORACLE_TARGET_MISSING', `Candidate oracle target ${target} is not grounded in H.`);
    }
    assertContainedCandidateFile(context.candidateRoot, result.targetFile);
    required.add(result.targetFile);
  }

  const missing = [...required].filter((relpath) => approval.files[relpath] === undefined).sort();
  if (missing.length > 0) {
    fail(
      'CI_APPROVAL_SCOPE_INCOMPLETE',
      `Candidate approval omits base-schema or grounded oracle inputs: ${missing.join(', ')}.`,
    );
  }
}

function archiveEntries(root: string, rejectNonDirectories: boolean): string[] {
  if (!existsSync(root)) return [];
  const entries: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      if (rejectNonDirectories) {
        fail(
          'CI_ARCHIVE_PATH_INVALID',
          `Candidate archive entry ${entry} is not a real directory.`,
        );
      }
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function assertSafeCandidatePath(relpath: string): void {
  if (
    relpath.length === 0 ||
    isAbsolute(relpath) ||
    relpath.includes('\\') ||
    relpath.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    fail('CI_APPROVAL_PATH_INVALID', `Approval contains unsafe path ${JSON.stringify(relpath)}.`);
  }
}

function assertContainedCandidateFile(root: string, relpath: string): void {
  assertSafeCandidatePath(relpath);
  const path = join(root, relpath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail('CI_ORACLE_TARGET_FILE_INVALID', `Grounded oracle file ${relpath} is absent from H.`);
  }
  const realRoot = realpathSync(root);
  const realFile = realpathSync(path);
  const inside = relative(realRoot, realFile);
  if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
    fail(
      'CI_ORACLE_TARGET_FILE_INVALID',
      `Grounded oracle file ${relpath} resolves outside candidate H.`,
    );
  }
}

function fail(code: string, message: string): never {
  throw invalidInputError(
    code,
    message,
    'Repair and re-archive the candidate change, then trigger a fresh trusted workflow run.',
  );
}
