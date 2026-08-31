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

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { invalidInputError, preconditionError } from '../util/errors.js';
import {
  init,
  type AdapterPackageSource,
  type ConfirmOverwrite,
  type InitAnswers,
} from './init.js';

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
    .action(async (opts: { yes?: boolean }) => {
      const root = process.cwd();
      const yes = opts.yes === true;

      const detected = detectAnswers(root);
      const answers = yes ? detected : await confirmAnswers(detected);
      const adapterPackage = shippedAdapterPackage(answers.adapter);
      const report = await init(
        {
          root,
          answers,
          frameworkPackage: { root: shippedFrameworkPackage() },
          ...(adapterPackage ? { adapterPackage } : {}),
        },
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
  const packageRoot = join(shippedFrameworkPackage(), 'adapters', 'java-junit');
  if (!existsSync(join(packageRoot, 'crucible-adapter.yaml'))) {
    throw invalidInputError(
      'ADAPTER_PACKAGE_UNAVAILABLE',
      `The packaged java-junit adapter is missing at ${packageRoot}.`,
      'Reinstall Crucible with its first-party adapter packages.',
    );
  }
  return {
    manifestPath: join(packageRoot, 'crucible-adapter.yaml'),
    executablePath: join(packageRoot, 'java-junit.mjs'),
  };
}

/** Locate the release package beside built CLI code; never query npm, npx, or PATH. */
export function shippedFrameworkPackage(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [moduleDir, join(moduleDir, '..', '..', 'package')];
  const packageRoot = candidates.find((candidate) =>
    existsSync(join(candidate, 'framework-manifest.json')),
  );
  if (packageRoot === undefined) {
    throw preconditionError(
      'FRAMEWORK_DISTRIBUTION_UNAVAILABLE',
      'This Crucible executable has no packaged local framework distribution.',
      'Install a complete built Crucible release; source TypeScript is not executable.',
    );
  }
  return packageRoot;
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
