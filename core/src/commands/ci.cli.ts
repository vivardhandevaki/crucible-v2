import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CheckFailure } from '../util/errors.js';
import { renderReport } from '../verifyx/report.js';
import { parseCiAuthorityManifest, serializeCiAuthorityManifest } from './ci-authority-manifest.js';
import { assertCiVerificationAuthority } from './ci-enforcement.js';
import { liveDeps } from './verify.cli.js';
import { verify } from './verify.js';
import { loadEnforcementConfig, resolveEnforcementRoot } from '../config/enforcement.js';
import { invalidInputError } from '../util/errors.js';
import { classifyCiAuthority } from './ci-authority.js';

/** Register CI-only authority classification. It is intentionally separate from
 * local verify/route so CI cannot inherit their pre-approval convenience path. */
export function registerCi(program: Command): void {
  const ci = program.command('ci').description('CI-only fail-closed enforcement entry points');
  ci.command('authority')
    .description('Classify a NUL-delimited base-to-head path manifest before CI enforcement')
    .requiredOption(
      '--changed-paths <file>',
      'NUL-delimited changed paths produced by the workflow',
    )
    .requiredOption('--base-sha <sha>', 'exact event base commit SHA')
    .requiredOption('--head-sha <sha>', 'exact event head commit SHA')
    .requiredOption('--snapshot-hash <sha256>', 'sha256 of the target snapshot bytes')
    .requiredOption('--manifest-out <file>', 'caller-minted authority manifest output path')
    .action(
      (opts: {
        changedPaths: string;
        baseSha: string;
        headSha: string;
        snapshotHash: string;
        manifestOut: string;
      }) => {
        const headRoot = process.cwd();
        const baseRoot = resolveEnforcementRoot(program.opts().configFrom, headRoot);
        const result = classifyCiAuthority({
          baseRoot,
          headRoot,
          config: loadEnforcementConfig(baseRoot),
          changedPaths: readChangedPaths(opts.changedPaths),
        });
        const manifest = {
          version: 1 as const,
          lane: result.lane,
          changes: result.changes,
          base_sha: opts.baseSha,
          head_sha: opts.headSha,
          snapshot_hash: opts.snapshotHash,
        };
        writeFileSync(opts.manifestOut, serializeCiAuthorityManifest(manifest), 'utf8');
        process.stdout.write(
          program.opts().json === true ? JSON.stringify(manifest) + '\n' : manifest.lane + '\n',
        );
      },
    );

  ci.command('verify')
    .description('Verify a manifest-authorized governed change in CI')
    .argument('<change>', 'manifest-authorized change name')
    .requiredOption('--manifest <file>', 'strict authority manifest minted by ci authority')
    .action(async (change: string, opts: { manifest: string }) => {
      const root = process.cwd();
      const configRoot = resolveEnforcementRoot(program.opts().configFrom, root);
      const manifest = parseCiAuthorityManifest(readFileSync(opts.manifest, 'utf8'), opts.manifest);
      assertCiVerificationAuthority(root, manifest, change);
      const report = await verify(
        { root, change, config: loadEnforcementConfig(configRoot) },
        liveDeps(root, manifest.base_sha, { change, withReview: false }),
      );
      assertCiVerificationAuthority(root, manifest, change);
      process.stdout.write(
        program.opts().json === true ? JSON.stringify(report) + '\n' : renderReport(report) + '\n',
      );
      if (report.verdict === 'fail') throw new CheckFailure();
    });
}

/** Strict NUL-only transport: newline splitting silently corrupts legal Git paths. */
export function readChangedPaths(path: string): string[] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (cause) {
    throw invalidInputError(
      'CI_CHANGED_PATHS_UNREADABLE',
      'Could not read the CI changed-path manifest: ' + messageOf(cause),
      'Ensure the authority workflow writes and passes its NUL-delimited manifest.',
    );
  }
  if (raw.length === 0 || raw[raw.length - 1] !== 0) {
    throw invalidInputError(
      'CI_CHANGED_PATHS_MALFORMED',
      'The CI changed-path manifest must be non-empty and NUL terminated.',
      'Ensure the authority workflow uses git diff --name-only -z.',
    );
  }
  return raw.subarray(0, -1).toString('utf8').split('\0');
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
