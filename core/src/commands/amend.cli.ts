// CLI wiring for `crucible amend` — binds the deterministic core (`amend`) to
// its non-deterministic edges: the ClaudeCode substrate, the adapter resolver,
// the terminal confirm, the wall-clock, the git identity, and the notify
// dispatcher. The core stays testable and reproducible (invariant 12); this shim
// supplies live dependencies at invocation time and maps the verdict to the exit
// code.
//
// A red regeneration is signaled with `CheckFailure` (exit 1) AFTER the report
// renders — the agent's regenerated bundle failed, the tool worked (same pattern
// as verify.cli / propose.cli). Genuine precondition failures (no change, no
// approval, empty resolution, missing role prompt) throw `CrucibleError`.
//
// One edge is still stubbed, exactly as in approve.cli / escalate.cli: the binding
// resolver fails closed until the adapter pin lands (P1-11/P2 init). The notify
// dispatcher is now the config-driven P2-15 dispatcher — fire-and-forget, and not
// load-bearing: the re-seal on disk is the outcome, not the announcement
// (invariant 11).

import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { amend, type AmendDeps } from './amend.js';
import { loadConvenienceConfig } from '../config/convenience.js';
import { createLiveNotifier } from '../notify/live.js';
import { ClaudeCodeSubstrate } from '../substrate/claude-code.js';
import type { ResolveFn } from '../lint/traceability.js';
import { CheckFailure, preconditionError } from '../util/errors.js';

/** Model used when convenience config routes nothing to `models.propose`
 * (amend regenerates through the propose role). */
const DEFAULT_PROPOSE_MODEL = 'claude-opus-4-8';

/** Register the real `amend` subcommand on the program. */
export function registerAmend(program: Command): void {
  program
    .command('amend')
    .description('Resolve an escalation or fix an approved spec: regenerate + re-seal the delta')
    .argument('<change>', 'the change to amend (openspec/changes/<change>/)')
    .argument('<resolution>', 'the escalation option to take, or the spec fix to apply')
    .option('-y, --yes', 'skip the confirmation prompt', false)
    .action(async (change: string, resolution: string, opts: { yes?: boolean }) => {
      const root = process.cwd();
      const result = await amend(
        { root, change, resolution, model: amendModel(root), yes: opts.yes === true },
        liveDeps(root),
      );

      const json = program.opts().json === true;
      if (json) {
        process.stdout.write(JSON.stringify(result.report) + '\n');
      } else {
        process.stdout.write(result.render + '\n');
        if (result.amended) {
          process.stdout.write(
            `Amended ${change}: re-sealed ${result.sealedFiles?.length ?? 0} file(s).\n`,
          );
        } else if (result.report.verdict === 'pass') {
          process.stdout.write(`Not amended: ${change} left as it was.\n`);
        }
        process.stdout.write(`Transcript: ${result.transcriptPath}\n`);
      }

      // A red regeneration exits 1 (architecture.md §2) — a verdict, not an error.
      if (result.report.verdict === 'fail') {
        throw new CheckFailure();
      }
    });
}

/** Model routing: convenience `models.propose`, else the default (invariant 11). */
function amendModel(root: string): string {
  return loadConvenienceConfig(root).models['propose'] ?? DEFAULT_PROPOSE_MODEL;
}

/** The live dependencies for a real amend invocation. */
function liveDeps(root: string): AmendDeps {
  return {
    substrate: new ClaudeCodeSubstrate(),
    resolve: liveResolveUnavailable,
    confirm: promptConfirm,
    now: () => new Date().toISOString(),
    amendedBy: () => process.env.GIT_AUTHOR_EMAIL ?? process.env.USER ?? 'unknown',
    // Convenience notify (invariant 11): the config-driven dispatcher (P2-15). The
    // re-seal already written is the outcome; a broken hook is swallowed by the
    // core and cannot stop the amend.
    notify: createLiveNotifier(root),
  };
}

/**
 * The binding resolver spawns the pinned adapter (P1-11 client), recorded by
 * `crucible init` (P2). Until that pin exists, fail closed rather than re-judge
 * against no resolver (invariant 3).
 */
const liveResolveUnavailable: ResolveFn = () => {
  throw preconditionError(
    'NO_ADAPTER_PIN',
    'The pinned adapter that resolves oracle bindings is not configured yet.',
    'Adapter pinning lands with `crucible init` (P2); until then amend runs only via its injectable core.',
  );
};

/** Interactive y/N confirmation on stdin/stdout. Empty / non-y → decline. */
async function promptConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Re-seal this amendment? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
