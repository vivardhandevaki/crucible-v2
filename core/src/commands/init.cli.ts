// CLI wiring for `crucible init` — resolves the interactive parts (adapter
// detection, the unit-test command, the y/N overwrite prompts) into the
// `answers` + `confirmOverwrite` the deterministic core (`init`) consumes, then
// prints a file-by-file report of what changed. The core stays reproducible
// (invariant 12); this shim owns every non-deterministic edge: the filesystem
// probe that guesses the adapter, readline, and `--yes`.
//
// `--yes` makes init non-interactive: it takes the DETECTED defaults and
// auto-confirms overwrites. That is not a "silent" overwrite (design §7) — the
// operator explicitly opted out of the prompts by passing the flag; without it,
// every conflicting file is shown and confirmed one at a time.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { parseFrameworkSource, type FrameworkPin } from '../framework/pin.js';
import { invalidInputError, preconditionError } from '../util/errors.js';
import {
  init,
  type AdapterPackageSource,
  type ConfirmOverwrite,
  type InitAnswers,
} from './init.js';

const require = createRequire(import.meta.url);

/** Register the real `init` subcommand on the program. */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description(
      'Install a complete Crucible setup into this repo (idempotent; re-run = diff-and-confirm)',
    )
    .option(
      '-y, --yes',
      'take detected defaults and auto-confirm overwrites (non-interactive)',
      false,
    )
    .option(
      '--framework-source <owner/repository@commit>',
      'validation-only framework source pin (defaults to this Crucible checkout)',
    )
    .action(async (opts: { yes?: boolean; frameworkSource?: string }) => {
      const root = process.cwd();
      const yes = opts.yes === true;

      const detected = detectAnswers(root);
      const answers = yes ? detected : await confirmAnswers(detected);
      const frameworkPin =
        opts.frameworkSource === undefined
          ? detectFrameworkPin()
          : parseFrameworkSource(opts.frameworkSource);

      const adapterPackage = shippedAdapterPackage(answers.adapter);
      const report = await init(
        { root, answers, frameworkPin, ...(adapterPackage ? { adapterPackage } : {}) },
        { confirmOverwrite: confirmOverwriteEdge(yes) },
      );

      // File-by-file summary — created / updated / skipped surfaced, unchanged
      // rolled up so a clean re-run reads as a single reassuring line.
      const byKind = (kind: string): string[] =>
        report.actions.filter((a) => a.kind === kind).map((a) => a.relpath);
      for (const rel of byKind('created')) process.stdout.write(`  created  ${rel}\n`);
      for (const rel of byKind('updated')) process.stdout.write(`  updated  ${rel}\n`);
      for (const rel of byKind('skipped'))
        process.stdout.write(`  skipped  ${rel} (kept your version)\n`);
      const unchanged = byKind('unchanged').length;
      if (unchanged > 0) process.stdout.write(`  unchanged ${unchanged} file(s)\n`);
      process.stdout.write(
        `\nCrucible is set up. Next: \`crucible propose <change> "<intent>"\`.\n`,
      );
    });
}

/**
 * Detect the shipped project adapter + unit-test command from disk (design §7).
 * P3-08 retires the stub from init: it remains a conformance/test instrument,
 * never a judge installed into an unrecognized real project. No match therefore
 * fails with an actionable precondition instead of creating a false setup.
 */
export function detectAnswers(root: string): InitAnswers {
  const has = (name: string): boolean => existsSync(join(root, name));
  const hasGlob = (prefix: string): boolean => {
    try {
      return readdirSync(root).some((f) => f.startsWith(prefix));
    } catch {
      return false;
    }
  };
  if (has('pom.xml')) {
    return {
      adapter: 'java-junit',
      runners: ['junit'],
      paths: ['**/*.java'],
      unitCommand: 'mvn test',
    };
  }
  if (hasGlob('build.gradle')) {
    return {
      adapter: 'java-junit',
      runners: ['junit'],
      paths: ['**/*.java'],
      unitCommand: 'gradle test',
    };
  }
  throw preconditionError(
    'NO_ADAPTER_DETECTED',
    'No supported first-party adapter was detected (expected pom.xml or build.gradle[.kts]).',
    'Add a supported build file, or install a certified adapter explicitly with `crucible adapter add`.',
  );
}

/** Locate first-party packaged bytes without importing adapter implementation code. */
export function shippedAdapterPackage(name: string): AdapterPackageSource | undefined {
  if (name !== 'java-junit') return undefined;
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve('@crucible/adapter-java-junit/package.json'));
  } catch (error) {
    throw invalidInputError(
      'ADAPTER_PACKAGE_UNAVAILABLE',
      `The shipped java-junit package could not be resolved — ${String(error)}`,
      'Reinstall Crucible with its first-party adapter packages.',
    );
  }
  return {
    manifestPath: join(packageRoot, 'package', 'crucible-adapter.yaml'),
    executablePath: join(packageRoot, 'package', 'java-junit.mjs'),
  };
}

/**
 * Pin this source checkout for the Phase-4 validation workflow. A packaged
 * release will replace this source-bootstrap path once distribution is in
 * scope; until then, refusing an unpinned framework is safer than a CI job
 * silently running whatever `npx` resolves that day.
 */
export function detectFrameworkPin(): FrameworkPin {
  const checkout = frameworkCheckoutRoot();
  let remote: string;
  let commit: string;
  try {
    remote = execFileSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim();
    commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    throw preconditionError(
      'FRAMEWORK_SOURCE_UNRESOLVABLE',
      `Could not determine the Crucible source checkout pin — ${String(error)}.`,
      'Run `crucible init --framework-source owner/repository@<40-character-commit-sha>`.',
    );
  }
  const repository = githubRepository(remote);
  if (repository === undefined) {
    throw preconditionError(
      'FRAMEWORK_SOURCE_UNRESOLVABLE',
      `Crucible source remote ${JSON.stringify(remote)} is not a GitHub repository.`,
      'Run `crucible init --framework-source owner/repository@<40-character-commit-sha>`.',
    );
  }
  return parseFrameworkSource(`${repository}@${commit}`);
}

function frameworkCheckoutRoot(): string {
  // core/src/commands or core/dist/commands → monorepo root.
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function githubRepository(remote: string): string | undefined {
  const match = /github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(remote);
  return match?.[1];
}

/** Let the operator confirm / override the detected adapter + unit command. */
async function confirmAnswers(detected: InitAnswers): Promise<InitAnswers> {
  process.stdout.write(
    `Detected adapter: ${detected.adapter} (runners: ${detected.runners.join(', ')})\n`,
  );
  const adapter = (await ask(`Adapter name [${detected.adapter}]: `)).trim() || detected.adapter;
  const unitCommand =
    (await ask(`Unit-test command [${detected.unitCommand}]: `)).trim() || detected.unitCommand;
  return { ...detected, adapter, unitCommand };
}

/**
 * The overwrite decision edge. Under `--yes`, auto-confirm (opted-out of
 * prompts). Otherwise show the conflict and read y/N — a declined file is kept
 * as-is (`skipped`), never silently clobbered (design §7).
 */
function confirmOverwriteEdge(yes: boolean): ConfirmOverwrite {
  if (yes) return () => true;
  return async (relpath, currentText, desiredText) => {
    process.stdout.write(
      `\n⚠ ${relpath} exists and differs from the shipped version ` +
        `(${lineCount(currentText)} → ${lineCount(desiredText)} lines).\n`,
    );
    const answer = await ask(`Overwrite ${relpath}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

/** One-shot readline question, opening + closing an interface per prompt. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
