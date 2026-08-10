// Public CLI for the session-native lifecycle. It supplies only live edges
// (pinned OpenSpec runtime + adapter); all state transitions stay in session/.

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { relative } from 'node:path';
import { z } from 'zod';
import { loadPinnedAdapterClient } from '../adapters/runtime.js';
import { parseTypeName } from '../changetype/changetype.js';
import { loadConvenienceConfig, localReviewMode } from '../config/convenience.js';
import { openspecExecutable } from './openspec-runner.js';
import { gitHead, mergeBase } from './review.cli.js';
import {
  amendFinish,
  amendNext,
  amendResume,
  amendSeal,
  amendStart,
  implementFinish,
  implementReviewRetry,
  implementReviewAddress,
  reviewFinish,
  reviewStart,
  implementResume,
  implementStart,
  implementTasksReady,
  proposeFinish,
  proposeNext,
  proposeResume,
  proposeRevise,
  proposeStart,
  type SessionDeps,
  type SessionHandoff,
  type SessionInstruction,
} from '../session/session.js';
import { CheckFailure, invalidInputError } from '../util/errors.js';

const openSpecStatusSchema = z.object({
  artifacts: z.array(
    z.object({ id: z.string().min(1), status: z.enum(['done', 'ready', 'blocked']) }),
  ),
});
const openSpecInstructionsSchema = z.object({
  artifactId: z.string().min(1),
  resolvedOutputPath: z.string().min(1),
  instruction: z.string().optional(),
  template: z.string().optional(),
});

export function registerSession(program: Command): void {
  const session = program
    .command('session')
    .description('Run deterministic handoffs for an active local authoring session');
  session
    .command('status')
    .description('Show the artifact-derived session-native next action')
    .argument('<change>')
    .action((change: string) => {
      // The normal status command is the artifact authority. This thin alias is
      // intentionally not state/checkpoint-driven, so a forged checkpoint cannot
      // make the hub advertise an enforcement action.
      const next = `crucible status ${change}`;
      write(program, { version: 1, change, next_commands: [next] });
    });

  const propose = session.command('propose').description('Session-native proposal authoring');
  propose
    .command('start')
    .argument('<change>')
    .argument('<intent>')
    .option('--type <type>', 'feature | bugfix | refactor', 'feature')
    .action(async (change: string, intent: string, opts: { type: string }) => {
      write(
        program,
        await proposeStart(
          { root: process.cwd(), change, intent, type: parseTypeName(opts.type) },
          liveDeps(process.cwd()),
        ),
      );
    });
  propose
    .command('next')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await proposeNext({ root: process.cwd(), change }, liveDeps(process.cwd())));
    });
  propose
    .command('resume')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await proposeResume({ root: process.cwd(), change }, liveDeps(process.cwd())));
    });
  propose
    .command('revise')
    .argument('<change>')
    .argument('<instruction>')
    .action(async (change: string, instruction: string) => {
      write(
        program,
        await proposeRevise({ root: process.cwd(), change, instruction }, liveDeps(process.cwd())),
      );
    });
  propose
    .command('finish')
    .argument('<change>')
    .action(async (change: string) => {
      const result = await proposeFinish({ root: process.cwd(), change }, liveDeps(process.cwd()));
      if (result.report.verdict === 'fail') {
        write(program, result.report);
        throw new CheckFailure();
      }
      write(program, result.handoff);
    });

  const implement = session
    .command('implement')
    .description('Session-native implementation authoring');
  implement
    .command('start')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await implementStart({ root: process.cwd(), change }));
    });
  implement
    .command('tasks-ready')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await implementTasksReady({ root: process.cwd(), change }));
    });
  implement
    .command('resume')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await implementResume({ root: process.cwd(), change }));
    });
  implement
    .command('finish')
    .argument('<change>')
    .action(async (change: string) => {
      const result = await implementFinish(
        { root: process.cwd(), change },
        liveDeps(process.cwd()),
      );
      if (result.report.verdict === 'fail') {
        write(program, result.report);
        throw new CheckFailure();
      }
      write(program, result.handoff);
    });
  implement
    .command('review-retry')
    .argument('<change>')
    .action(async (change: string) => {
      write(
        program,
        await implementReviewRetry({ root: process.cwd(), change }, liveDeps(process.cwd())),
      );
    });
  implement
    .command('review-address')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await implementReviewAddress({ root: process.cwd(), change }));
    });

  const amendSession = session
    .command('amend')
    .description('Session-native post-approval amendment');
  amendSession
    .command('start')
    .argument('<change>')
    .argument('<resolution>')
    .action(async (change: string, resolution: string) => {
      write(
        program,
        await amendStart({ root: process.cwd(), change, resolution }, liveDeps(process.cwd())),
      );
    });
  amendSession
    .command('next')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await amendNext({ root: process.cwd(), change }, liveDeps(process.cwd())));
    });
  amendSession
    .command('resume')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await amendResume({ root: process.cwd(), change }, liveDeps(process.cwd())));
    });
  amendSession
    .command('finish')
    .argument('<change>')
    .action(async (change: string) => {
      const result = await amendFinish({ root: process.cwd(), change }, liveDeps(process.cwd()));
      if (result.report.verdict === 'fail') {
        write(program, result.report);
        throw new CheckFailure();
      }
      write(program, result.handoff);
    });
  amendSession
    .command('seal')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await amendSeal({ root: process.cwd(), change }, liveDeps(process.cwd())));
    });

  const reviewSession = session.command('review').description('Fresh session-native local review');
  reviewSession
    .command('start')
    .argument('<change>')
    .action(async (change: string) => {
      write(program, await reviewStart({ root: process.cwd(), change }, liveDeps(process.cwd())));
    });
  reviewSession
    .command('finish')
    .argument('<change>')
    .action(async (change: string) => {
      const result = await reviewFinish({ root: process.cwd(), change }, liveDeps(process.cwd()));
      write(program, { ...result.handoff, review: result.review });
      if (result.review.status === 'fail') throw new CheckFailure();
    });
}

function write(program: Command, value: SessionHandoff | Record<string, unknown>): void {
  if (program.opts().json === true) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function liveDeps(root: string): SessionDeps {
  const adapter = loadPinnedAdapterClient(root);
  return {
    now: () => new Date().toISOString(),
    scaffold: (change, schema) =>
      runOpenSpec(root, ['new', 'change', change, '--schema', schema, '--json']).then(
        () => undefined,
      ),
    instructions: async (change, mode) => openSpecInstructions(root, change, mode),
    resolve: (targets) => adapter.resolve(targets),
    run: (oracles) => adapter.run(oracles),
    localReviewMode: localReviewMode(loadConvenienceConfig(root)),
    reviewSnapshot: () => localReviewSnapshot(root),
    confirmAmend: promptAmendSeal,
  };
}

/** The local reviewer must see a committed snapshot; untracked scratch files are excluded. */
function requireCleanCommittedSnapshot(root: string): void {
  try {
    execFileSync('git', ['diff', '--quiet'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: root, stdio: 'ignore' });
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (status.split('\n').some((line) => line.length > 0 && !line.startsWith('?? ')))
      throw new Error();
  } catch {
    throw invalidInputError(
      'LOCAL_REVIEW_SNAPSHOT_DIRTY',
      'Required local review needs a committed, tracked-clean implementation snapshot.',
      'Commit or revert tracked changes, then re-run `crucible session implement review <change>`; untracked files are excluded.',
    );
  }
}

function localReviewSnapshot(root: string): { base: string; head: string; untracked: string[] } {
  requireCleanCommittedSnapshot(root);
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const untracked = status
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3));
  return { base: mergeBase(root), head: gitHead(root), untracked };
}
async function openSpecInstructions(
  root: string,
  change: string,
  mode: 'next' | 'all',
): Promise<SessionInstruction[]> {
  const statusRaw = await runOpenSpec(root, ['status', '--change', change, '--json']);
  const status = parseOpenSpec(openSpecStatusSchema, statusRaw, 'status');
  const artifacts = status.artifacts.filter(
    (artifact) => mode === 'all' || artifact.status === 'ready',
  );
  const result: SessionInstruction[] = [];
  for (const artifact of artifacts) {
    if (artifact.status === 'done' && mode !== 'all') continue;
    const raw = await runOpenSpec(root, [
      'instructions',
      artifact.id,
      '--change',
      change,
      '--json',
    ]);
    const instruction = parseOpenSpec(
      openSpecInstructionsSchema,
      raw,
      `instructions ${artifact.id}`,
    );
    const path = relativePath(root, instruction.resolvedOutputPath);
    result.push({
      path,
      content:
        [
          instruction.instruction,
          instruction.template ? `Template:\n${instruction.template}` : undefined,
        ]
          .filter((part): part is string => part !== undefined && part.trim().length > 0)
          .join('\n\n') || `Write ${instruction.artifactId}.`,
    });
  }
  return result;
}

function relativePath(root: string, output: string): string {
  const path = relative(root, output);
  if (path.startsWith('../') || path === '..') {
    throw invalidInputError(
      'INVALID_OPENSPEC_INSTRUCTIONS',
      `Pinned OpenSpec returned an output path outside the repository: ${output}.`,
      'Re-run `crucible init` to restore the pinned framework launcher.',
    );
  }
  return path;
}

function parseOpenSpec<T>(schema: z.ZodType<T>, raw: string, operation: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidInputError(
      'INVALID_OPENSPEC_OUTPUT',
      `Pinned OpenSpec ${operation} emitted malformed JSON.`,
      'Re-run `crucible init` to restore the pinned framework launcher.',
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidInputError(
      'INVALID_OPENSPEC_OUTPUT',
      `Pinned OpenSpec ${operation} emitted an unexpected JSON shape.`,
      'Re-run `crucible init` to restore the pinned framework launcher.',
    );
  }
  return parsed.data;
}

function runOpenSpec(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [openspecExecutable(), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) =>
      reject(
        invalidInputError(
          'OPENSPEC_RUNTIME_FAILED',
          `Could not start pinned OpenSpec: ${error.message}`,
          'Re-run `crucible init` to restore the pinned framework launcher.',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          invalidInputError(
            'OPENSPEC_RUNTIME_FAILED',
            `Pinned OpenSpec ${args[0]} failed (${code ?? 'signal'}): ${stderr.trim()}`,
            'Re-run `crucible init` to restore the pinned framework launcher.',
          ),
        );
    });
  });
}

async function promptAmendSeal(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Seal this amendment? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
