// CLI wiring for `crucible approve` — binds the deterministic core (`approve`)
// to the real, non-deterministic edges: the terminal review surface (pager,
// $EDITOR, the walk/diff prompts), the wall-clock, the git identity, the git
// diff-facts edge (for tier), the propose-role regeneration substrate, and the
// adapter resolver. The core stays testable and reproducible (invariant 12);
// this file is the thin shim that supplies live dependencies at invocation.
//
// This is a LOCAL human act, so — unlike verify's CI path — the enforcement
// config is read from the working tree (invariant 7 is about CI reading the
// target branch; approve never runs in CI). Tier is computed here because the
// critical tier's per-oracle acknowledgment gate depends on it (design §8).
//
// The binding resolver is still the one genuinely blocked edge: it must spawn the
// pinned adapter (P1-11 client, recorded by `crucible init` — P2-12). Until that
// lands, it fails closed (invariant 3) with a message naming the missing piece
// rather than pretending the gate ran. The `approve` core itself is complete and
// directly tested (approve.test.ts).

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
  approve,
  type ApproveDeps,
  type ApproveOptions,
  type DiffAction,
  type WalkAction,
  type WalkContext,
} from './approve.js';
import { computeDiffFacts } from './diff-facts.js';
import { loadConvenienceConfig } from '../config/convenience.js';
import {
  loadEnforcementConfig,
  resolveEnforcementRoot,
  type EnforcementConfig,
} from '../config/enforcement.js';
import { ClaudeCodeSubstrate } from '../substrate/claude-code.js';
import type { ResolveFn } from '../lint/traceability.js';
import { preconditionError } from '../util/errors.js';

/** Model used when convenience config routes nothing to `models.propose`. */
const DEFAULT_PROPOSE_MODEL = 'claude-opus-4-8';

/** Register the real `approve` subcommand on the program. */
export function registerApprove(program: Command): void {
  program
    .command('approve')
    .description('Review + seal an approved bundle by hashing its artifacts')
    .argument('<change>', 'the change name to approve (openspec/changes/<change>/)')
    .option('-y, --yes', 'skip the review walk + confirmation (non-critical tiers only)', false)
    .option(
      '--confirm-consistency',
      'seal despite a staleness warning (you have checked the hand-edits are coherent)',
      false,
    )
    .option(
      '--diff-base <ref>',
      'the git ref to diff against for tier computation ' +
        '(default: merge-base of HEAD and origin/HEAD)',
    )
    .action(
      async (
        change: string,
        opts: { yes?: boolean; confirmConsistency?: boolean; diffBase?: string },
      ) => {
        const root = process.cwd();

        // Tier is computed from the working-tree enforcement config (a local act,
        // not CI). Missing/malformed → exit 2/3 from the loader — approve is an
        // enforcement recomputation point and does not run tier without config.
        const configRoot = resolveEnforcementRoot(undefined, root);
        const config: EnforcementConfig = loadEnforcementConfig(configRoot);

        const options: ApproveOptions = {
          root,
          change,
          yes: opts.yes === true,
          confirmConsistency: opts.confirmConsistency === true,
          config,
          model: proposeModel(root),
          width: process.stdout.columns ?? 80,
          color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
        };

        const result = await approve(options, liveDeps(root, opts.diffBase));
        if (result.approved) {
          process.stdout.write(
            `Approved ${change}${result.tier ? ` (${result.tier})` : ''}: ` +
              `${result.sealedFiles?.length ?? 0} file(s) sealed.\n`,
          );
        } else {
          process.stdout.write(`Not approved: ${change} left unsealed.\n`);
        }
      },
    );
}

/** Model routing: convenience `models.propose`, else the default (invariant 11). */
function proposeModel(root: string): string {
  return loadConvenienceConfig(root).models['propose'] ?? DEFAULT_PROPOSE_MODEL;
}

/** The live dependencies for a real approve invocation. */
function liveDeps(root: string, diffBase: string | undefined): ApproveDeps {
  return {
    resolve: liveResolve,
    confirm: promptConfirm,
    now: () => new Date().toISOString(),
    approvedBy: () => process.env.GIT_AUTHOR_EMAIL ?? process.env.USER ?? 'unknown',
    diffFacts: () => computeDiffFacts(root, diffBase),
    substrate: new ClaudeCodeSubstrate(),
    pager: pageThrough,
    walk: promptWalk,
    openEditor: openInEditor,
    confirmDiff: promptDiff,
  };
}

/**
 * The binding resolver spawns the pinned adapter (P1-11 adapter client, recorded
 * by `crucible init` — P2-12). Until that pin exists, fail closed rather than run
 * the gate against no resolver.
 */
const liveResolve: ResolveFn = () => {
  throw preconditionError(
    'NO_ADAPTER_PIN',
    'The pinned adapter that resolves oracle bindings is not configured yet.',
    'Adapter pinning lands with `crucible init` (P2); until then approve runs only via its injectable core.',
  );
};

/**
 * Page a rendered surface through `$PAGER` (default `less -FRX` — `-F` lets short
 * panels flow straight through) when stdout is a TTY, else write it plainly.
 */
function pageThrough(text: string): void {
  if (process.stdout.isTTY !== true) {
    process.stdout.write(text + '\n');
    return;
  }
  const pager = process.env.PAGER ?? 'less -FRX';
  const [cmd, ...args] = pager.split(/\s+/);
  const result = spawnSync(cmd!, args, { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) process.stdout.write(text + '\n');
}

/** Open `$EDITOR` (fallback `vi`) at `oracles.md +<line>` for an inline edit. */
async function openInEditor(file: string, line: number): Promise<void> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const [cmd, ...args] = editor.split(/\s+/);
  spawnSync(cmd!, [...args, `+${line}`, file], { stdio: 'inherit' });
}

/** The per-oracle walk prompt (design §8, Stage 2). Unknown input → advance. */
async function promptWalk(context: WalkContext): Promise<WalkAction> {
  const ackHint = context.critical ? 'a acknowledge · ' : '';
  const answer = await ask(`[Enter] next · e edit scenario · ${ackHint}q quit `);
  const key = answer.trim().toLowerCase();
  if (key === 'e') return 'edit';
  if (key === 'q') return 'quit';
  if (key === 'a' && context.critical) return 'ack';
  return 'next';
}

/** The regeneration-diff prompt (design §8). Unknown / empty input → accept. */
async function promptDiff(): Promise<DiffAction> {
  const answer = await ask('[Enter] accept · e edit again · q abort ');
  const key = answer.trim().toLowerCase();
  if (key === 'e') return 'edit';
  if (key === 'q') return 'quit';
  return 'accept';
}

/** Interactive y/N confirmation on stdin/stdout. Empty / non-y → decline. */
async function promptConfirm(): Promise<boolean> {
  const answer = await ask('Seal this approval? [y/N] ');
  return /^y(es)?$/i.test(answer.trim());
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
