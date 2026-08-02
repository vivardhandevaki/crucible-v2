// CLI wiring for `crucible archive` — binds the deterministic core (`archive`) to
// its two real, non-deterministic edges: the pinned OpenSpec CLI's `validate` and
// `archive` verbs. The core stays testable and reproducible (invariant 12); this
// file is the thin shim that spawns OpenSpec and maps its output back.
//
// The `validate` edge is the one place spike D4 bites: `openspec validate --json`
// exits 0 EVEN WHEN INVALID, so this parses the JSON `items[0].valid` verdict and
// never trusts the exit code (fail-closed, invariant 3). A JSON shape we cannot
// read is treated as invalid — the safe direction.
//
// A precondition failure (unapproved, void seal, malformed bundle, OpenSpec-
// invalid) throws a `CrucibleError` (exit 2/3) from the core BEFORE anything is
// moved; the runner formats it. On success the one-line confirmation is printed.

import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { archive, type ArchiveDeps, type OpenSpecValidation } from './archive.js';
import { invalidInputError } from '../util/errors.js';

import { openspecExecutable } from './openspec-runner.js';
/** Register the real `archive` subcommand on the program. */
export function registerArchive(program: Command): void {
  program
    .command('archive')
    .description('Retire an approved change into the regression set (archiving is registration)')
    .argument('<change>', 'the approved change to archive (openspec/changes/<change>/)')
    .action(async (change: string) => {
      const root = process.cwd();
      const result = await archive({ root, change }, liveDeps(root));
      process.stdout.write(result.render + '\n');
    });
}

/** The live dependencies for a real archive invocation. */
function liveDeps(root: string): ArchiveDeps {
  return {
    now: () => new Date().toISOString(),
    validate: (change) => validateViaOpenSpec(root, change),
    archive: (change) => archiveViaOpenSpec(root, change),
  };
}

/**
 * Run `openspec validate <change> --strict --json` and parse the JSON verdict.
 * Spike D4: the exit code is 0 even when invalid, so we read `items[0].valid`
 * from the structured report. A missing/unparseable report → invalid (fail-closed).
 */
function validateViaOpenSpec(root: string, change: string): Promise<OpenSpecValidation> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [openspecExecutable(), 'validate', change, '--strict', '--json'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (cause) =>
      reject(
        invalidInputError(
          'OPENSPEC_UNAVAILABLE',
          `Could not spawn the OpenSpec CLI to validate ${change}: ${cause.message}`,
          'Rebuild or reinstall this Crucible checkout before running archive.',
        ),
      ),
    );
    child.on('close', () => resolvePromise(parseValidation(stdout, stderr)));
  });
}

/** Parse `openspec validate --json` output into the verdict the core consumes. */
function parseValidation(stdout: string, stderr: string): OpenSpecValidation {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    // No parseable JSON verdict → invalid (fail-closed). Surface any stderr.
    return { valid: false, issues: [stderr.trim() || 'openspec produced no JSON verdict'] };
  }
  const obj = data as {
    items?: { valid?: boolean; issues?: { message?: string }[] }[];
    status?: { message?: string }[];
  };
  const item = obj.items?.[0];
  if (item === undefined) {
    // e.g. `{ status: [{ severity, code, message }] }` for an unknown item.
    const issues = (obj.status ?? []).map((s) => s.message ?? String(s));
    return {
      valid: false,
      issues: issues.length > 0 ? issues : ['openspec could not validate the change'],
    };
  }
  const issues = (item.issues ?? []).map((i) => i.message ?? String(i));
  return { valid: item.valid === true, issues };
}

/**
 * Run `openspec archive <change> --yes`. A non-zero exit fails closed (invariant
 * 3); the core additionally verifies the change dir actually moved afterward.
 */
function archiveViaOpenSpec(root: string, change: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [openspecExecutable(), 'archive', change, '--yes'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (cause) =>
      reject(
        invalidInputError(
          'OPENSPEC_UNAVAILABLE',
          `Could not spawn the OpenSpec CLI to archive ${change}: ${cause.message}`,
          'Rebuild or reinstall this Crucible checkout before running archive.',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          invalidInputError(
            'ARCHIVE_FAILED',
            `\`openspec archive ${change} --yes\` exited ${code ?? 'by signal'}${stderr ? ` — ${stderr.trim()}` : ''}.`,
            'Check the OpenSpec CLI output; the change was not archived.',
          ),
        );
    });
  });
}
