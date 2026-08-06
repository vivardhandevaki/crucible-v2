// Deterministic session-native authoring lifecycle (architecture §10).  This is
// deliberately not an AgentSubstrate: an already-active host session writes the
// files, while this module owns every transition, checkpoint, and judgment.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadApproval, verifyApproval } from '../artifacts/approval.js';
import { readEscalationIfPresent } from '../artifacts/escalation.js';
import { serializeGeneration, stampGeneration } from '../artifacts/generation.js';
import type { OracleResult } from '../adapters/types.js';
import {
  assertTypeConformance,
  readChangeType,
  schemaForType,
  type ChangeType,
} from '../changetype/changetype.js';
import type { ResolveFn } from '../lint/traceability.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { appendStateEvent } from '../state/state.js';
import { invalidInputError, preconditionError } from '../util/errors.js';
import { renderReport, type VerifyReport } from '../verifyx/report.js';
import { dependencyOrder, gatherTypeFacts, judgeBundle } from '../commands/bundle.js';
import { verify } from '../commands/verify.js';

const CHANGE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SESSION_VERSION = 1;

const instructionSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string().min(1),
});

export type SessionInstruction = z.infer<typeof instructionSchema>;

export const sessionHandoffSchema = z.strictObject({
  version: z.literal(1),
  change: z.string().min(1),
  role: z.enum(['propose', 'implement']),
  operation: z.string().min(1),
  stage: z.string().min(1),
  change_dir: z.string().min(1),
  role_prompt: z.string().min(1),
  instructions: z.array(instructionSchema),
  next_command: z.string().min(1),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type SessionHandoff = z.infer<typeof sessionHandoffSchema>;

const proposeCheckpointSchema = z.strictObject({
  version: z.literal(SESSION_VERSION),
  change: z.string().min(1),
  role: z.literal('propose'),
  stage: z.enum(['scaffolding', 'authoring']),
  input: z.strictObject({
    intent: z.string().min(1),
    type: z.enum(['feature', 'bugfix', 'refactor']),
  }),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const implementCheckpointSchema = z.strictObject({
  version: z.literal(SESSION_VERSION),
  change: z.string().min(1),
  role: z.literal('implement'),
  stage: z.enum(['tasks', 'implementation']),
  input: z.strictObject({ approval_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

type ProposeCheckpoint = z.infer<typeof proposeCheckpointSchema>;
type ImplementCheckpoint = z.infer<typeof implementCheckpointSchema>;

export interface SessionDeps {
  now: () => string;
  scaffold: (change: string, schema: string) => Promise<void>;
  /** Pinned OpenSpec instructions, returned as repo-relative write targets. */
  instructions: (change: string, mode: 'next' | 'all') => Promise<SessionInstruction[]>;
  resolve: ResolveFn;
  run: (oracles: readonly Oracle[]) => Promise<OracleResult[]>;
}

export interface SessionOptions {
  root: string;
  change: string;
}

export interface ProposeStartOptions extends SessionOptions {
  intent: string;
  type: ChangeType;
}

export interface ProposeFinishResult {
  handoff: SessionHandoff;
  report: VerifyReport;
  render: string;
}

export interface ImplementFinishResult {
  handoff: SessionHandoff;
  report: VerifyReport;
  render: string;
}

/** Start proposal scaffolding, recording restartable explicit input before I/O. */
export async function proposeStart(
  options: ProposeStartOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  assertChangeAndIntent(options.change, options.intent);
  const changeDir = changeDirFor(options.root, options.change);
  if (existsSync(changeDir)) {
    throw preconditionError(
      'CHANGE_EXISTS',
      `Change ${options.change} already exists at ${changeRel(options.change)}.`,
      `Use \`crucible session propose revise ${options.change} "<instruction>"\` before approval.`,
    );
  }
  requireRolePrompt(options.root, 'propose');
  const checkpoint: ProposeCheckpoint = {
    version: SESSION_VERSION,
    change: options.change,
    role: 'propose',
    stage: 'scaffolding',
    input: { intent: options.intent, type: options.type },
    input_hash: hashInput({ intent: options.intent, type: options.type }),
  };
  writeCheckpoint(options.root, checkpoint);
  await completeScaffold(options.root, checkpoint, deps);
  return proposeHandoff(options.root, checkpoint, 'start', []);
}

/** Return only OpenSpec's current ready artifact instructions. */
export async function proposeNext(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  let checkpoint = loadProposeCheckpoint(options.root, options.change);
  if (checkpoint.stage === 'scaffolding')
    checkpoint = await completeScaffold(options.root, checkpoint, deps);
  const instructions = validateInstructions(
    options.root,
    options.change,
    await deps.instructions(options.change, 'next'),
  );
  return proposeHandoff(options.root, checkpoint, 'next', instructions);
}

/** Resume is intentionally identical to next: it rederives, never trusts history. */
export async function proposeResume(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  return proposeNext(options, deps);
}

/** Record a pre-approval revision and return the complete dependency-ordered workset. */
export async function proposeRevise(
  options: SessionOptions & { instruction: string },
  deps: SessionDeps,
): Promise<SessionHandoff> {
  assertChangeAndIntent(options.change, options.instruction);
  const changeDir = changeDirFor(options.root, options.change);
  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel(options.change)} to revise.`,
      `Run \`crucible session propose start ${options.change} "<intent>"\` first.`,
    );
  }
  if (existsSync(join(changeDir, 'approval.yaml'))) {
    throw preconditionError(
      'ALREADY_APPROVED',
      `Change ${options.change} is already approved; session-native revise is pre-approval only.`,
      `Use \`crucible amend ${options.change}\` for an approved bundle.`,
    );
  }
  requireRolePrompt(options.root, 'propose');
  const type = readChangeType(changeDir);
  const checkpoint: ProposeCheckpoint = {
    version: SESSION_VERSION,
    change: options.change,
    role: 'propose',
    stage: 'authoring',
    input: { intent: options.instruction, type },
    input_hash: hashInput({ intent: options.instruction, type }),
  };
  writeCheckpoint(options.root, checkpoint);
  const instructions = validateInstructions(
    options.root,
    options.change,
    await deps.instructions(options.change, 'all'),
  );
  return proposeHandoff(options.root, checkpoint, 'revise', instructions);
}

/** Judge authored files; a red verdict retains the checkpoint for fix/retry. */
export async function proposeFinish(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<ProposeFinishResult> {
  const checkpoint = loadProposeCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'authoring') {
    throw preconditionError(
      'SESSION_NOT_READY',
      `Proposal ${options.change} is still scaffolding.`,
      `Run \`crucible session propose resume ${options.change}\` to complete the scaffold.`,
    );
  }
  const changeDir = changeDirFor(options.root, options.change);
  const report = await judgeBundle(
    options.change,
    changeDir,
    changeRel(options.change),
    deps.resolve,
    collectArchivedRequirementIds(options.root),
    checkpoint.input.type,
  );
  if (report.checks.find((check) => check.name === 'bundle')?.status === 'pass') {
    assertTypeConformance(
      checkpoint.input.type,
      gatherTypeFacts(changeDir, loadOracles(join(changeDir, 'oracles.md'))),
    );
  }
  if (report.verdict === 'pass') {
    writeFileSync(
      join(changeDir, 'generation.yaml'),
      serializeGeneration(
        stampGeneration(changeDir, options.change, dependencyOrder(changeDir), deps.now()),
      ),
      'utf8',
    );
  }
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    options.change,
    {
      at: deps.now(),
      cmd: 'propose',
      summary: `session-native bundle judged ${report.verdict} (${report.checks.length} check(s)) [type: ${checkpoint.input.type}]`,
      execution_mode: 'session-native',
    },
    report.verdict === 'pass' ? 'proposed' : 'propose-red',
  );
  const handoff = proposeHandoff(
    options.root,
    checkpoint,
    'finish',
    [],
    report.verdict === 'pass'
      ? `crucible approve ${options.change}`
      : `crucible session propose resume ${options.change}`,
  );
  if (report.verdict === 'pass') removeCheckpoint(options.root, options.change, 'propose');
  return { handoff, report, render: renderReport(report, 'session propose') };
}

/** Bind the implementation session to a valid, current approval file. */
export async function implementStart(options: SessionOptions): Promise<SessionHandoff> {
  const approvalHash = validateImplementationPreconditions(options.root, options.change);
  const checkpoint: ImplementCheckpoint = {
    version: SESSION_VERSION,
    change: options.change,
    role: 'implement',
    stage: 'tasks',
    input: { approval_hash: approvalHash },
    input_hash: hashInput({ approval_hash: approvalHash }),
  };
  writeCheckpoint(options.root, checkpoint);
  return implementHandoff(options.root, checkpoint, 'start');
}

/** Advance only when a non-empty tasks.md exists on disk. */
export async function implementTasksReady(options: SessionOptions): Promise<SessionHandoff> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  validateImplementationPreconditions(options.root, options.change, checkpoint.input.approval_hash);
  const tasksPath = join(changeDirFor(options.root, options.change), 'tasks.md');
  if (!existsSync(tasksPath) || statSync(tasksPath).size === 0) {
    throw preconditionError(
      'TASKS_NOT_READY',
      `No non-empty ${join(changeRel(options.change), 'tasks.md')} exists yet.`,
      `Write the tasks handoff, then run \`crucible session implement tasks-ready ${options.change}\`.`,
    );
  }
  const next: ImplementCheckpoint = { ...checkpoint, stage: 'implementation' };
  writeCheckpoint(options.root, next);
  return implementHandoff(options.root, next, 'tasks-ready');
}

/** Revalidate the approval and return only the persisted current stage. */
export async function implementResume(options: SessionOptions): Promise<SessionHandoff> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  validateImplementationPreconditions(options.root, options.change, checkpoint.input.approval_hash);
  if (checkpoint.stage === 'implementation') {
    const tasksPath = join(changeDirFor(options.root, options.change), 'tasks.md');
    if (!existsSync(tasksPath) || statSync(tasksPath).size === 0) {
      throw preconditionError(
        'TASKS_NOT_READY',
        `No non-empty ${join(changeRel(options.change), 'tasks.md')} exists for implementation.`,
        `Run \`crucible session implement tasks-ready ${options.change}\` after writing tasks.md.`,
      );
    }
  }
  return implementHandoff(options.root, checkpoint, 'resume');
}

/** Verify only from the implementation stage; red leaves the checkpoint resumable. */
export async function implementFinish(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<ImplementFinishResult> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'implementation') {
    throw preconditionError(
      'SESSION_NOT_READY',
      `Implementation ${options.change} has not completed the tasks stage.`,
      `Run \`crucible session implement tasks-ready ${options.change}\` first.`,
    );
  }
  validateImplementationPreconditions(options.root, options.change, checkpoint.input.approval_hash);
  const report = await verify(
    { root: options.root, change: options.change },
    { resolve: deps.resolve, run: deps.run },
  );
  appendStateEvent(
    join(changeDirFor(options.root, options.change), 'state.yaml'),
    options.change,
    {
      at: deps.now(),
      cmd: 'implement',
      summary: `session-native local verify ${report.verdict}`,
      execution_mode: 'session-native',
    },
    report.verdict === 'pass' ? 'implemented' : 'implement-red',
  );
  const handoff = implementHandoff(
    options.root,
    checkpoint,
    'finish',
    report.verdict === 'pass'
      ? `crucible verify ${options.change}`
      : `crucible session implement resume ${options.change}`,
  );
  if (report.verdict === 'pass') removeCheckpoint(options.root, options.change, 'implement');
  return { handoff, report, render: renderReport(report, 'session implement') };
}

function assertChangeAndIntent(change: string, intent: string): void {
  if (!CHANGE_NAME.test(change)) {
    throw invalidInputError(
      'INVALID_CHANGE_NAME',
      `Invalid change name \`${change}\`: must be lowercase kebab-case and not start with a digit.`,
      'Pick a name like `add-rate-limit` and re-run the session command.',
    );
  }
  if (intent.trim().length === 0) {
    throw invalidInputError(
      'EMPTY_INTENT',
      'The session instruction is empty.',
      'Provide a non-empty intent or revision instruction.',
    );
  }
}

async function completeScaffold(
  root: string,
  checkpoint: ProposeCheckpoint,
  deps: SessionDeps,
): Promise<ProposeCheckpoint> {
  await deps.scaffold(checkpoint.change, schemaForType(checkpoint.input.type));
  if (!existsSync(changeDirFor(root, checkpoint.change))) {
    throw invalidInputError(
      'SCAFFOLD_FAILED',
      `Scaffolding did not create ${changeRel(checkpoint.change)}.`,
      `Run \`crucible session propose resume ${checkpoint.change}\` after fixing the pinned OpenSpec runtime.`,
    );
  }
  const complete: ProposeCheckpoint = { ...checkpoint, stage: 'authoring' };
  writeCheckpoint(root, complete);
  return complete;
}

function validateImplementationPreconditions(
  root: string,
  change: string,
  expectedApprovalHash?: string,
): string {
  const changeDir = changeDirFor(root, change);
  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel(change)}.`,
      `Run \`crucible session propose start ${change} "<intent>"\` first.`,
    );
  }
  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'NO_APPROVAL',
      `Cannot implement ${change}: approval.yaml is missing.`,
      `Run \`crucible approve ${change}\` to seal the reviewed bundle first.`,
    );
  }
  const approval = loadApproval(approvalPath);
  const verification = verifyApproval(root, approval);
  if (!verification.valid) {
    throw preconditionError(
      'APPROVAL_VOID',
      `Cannot implement ${change}: approval is void (${verification.mismatches.join(', ')}).`,
      `Re-review and run \`crucible approve ${change}\` before restarting implementation.`,
    );
  }
  requireRolePrompt(root, 'implement');
  if (readEscalationIfPresent(join(changeDir, 'escalation.yaml')) !== undefined) {
    throw preconditionError(
      'ESCALATION_PENDING',
      `Cannot implement ${change}: an unresolved escalation is pending.`,
      `Resolve it with \`crucible amend ${change}\`, then restart implementation.`,
    );
  }
  const approvalHash = hashBytes(readFileSync(approvalPath));
  if (expectedApprovalHash !== undefined && expectedApprovalHash !== approvalHash) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Implementation checkpoint for ${change} is bound to different approval.yaml bytes.`,
      `Run \`crucible session implement start ${change}\` to restart from the current approval.`,
    );
  }
  return approvalHash;
}

function proposeHandoff(
  root: string,
  checkpoint: ProposeCheckpoint,
  operation: string,
  instructions: SessionInstruction[],
  next = operation === 'start'
    ? `crucible session propose next ${checkpoint.change}`
    : `crucible session propose finish ${checkpoint.change}`,
): SessionHandoff {
  return makeHandoff(
    root,
    checkpoint.change,
    'propose',
    operation,
    checkpoint.stage,
    instructions,
    next,
    checkpoint.input_hash,
  );
}

function implementHandoff(
  root: string,
  checkpoint: ImplementCheckpoint,
  operation: string,
  nextOverride?: string,
): SessionHandoff {
  const tasks = checkpoint.stage === 'tasks';
  const instructions: SessionInstruction[] = tasks
    ? [
        {
          path: join(changeRel(checkpoint.change), 'tasks.md'),
          content:
            'Read the approved bundle and write a non-empty implementation checklist. Do not implement code yet or edit sealed files.',
        },
      ]
    : [
        {
          path: '.',
          content:
            'Implement only what the approved bundle and tasks.md require. Do not edit any sealed artifact or bound test file.',
        },
      ];
  const next =
    nextOverride ??
    (tasks
      ? `crucible session implement tasks-ready ${checkpoint.change}`
      : `crucible session implement finish ${checkpoint.change}`);
  return makeHandoff(
    root,
    checkpoint.change,
    'implement',
    operation,
    checkpoint.stage,
    instructions,
    next,
    checkpoint.input_hash,
  );
}

function makeHandoff(
  _root: string,
  change: string,
  role: 'propose' | 'implement',
  operation: string,
  stage: string,
  instructions: SessionInstruction[],
  nextCommand: string,
  inputHash: string,
): SessionHandoff {
  return sessionHandoffSchema.parse({
    version: 1,
    change,
    role,
    operation,
    stage,
    change_dir: changeRel(change),
    role_prompt: join('.crucible', 'context', `${role}.md`),
    instructions,
    next_command: nextCommand,
    input_hash: inputHash,
  });
}

function validateInstructions(
  root: string,
  change: string,
  instructions: SessionInstruction[],
): SessionInstruction[] {
  const parsed = z.array(instructionSchema).safeParse(instructions);
  if (!parsed.success) {
    throw invalidInputError(
      'INVALID_OPENSPEC_INSTRUCTIONS',
      `Pinned OpenSpec instructions for ${change} are malformed: ${parsed.error.issues[0]?.message ?? 'unknown error'}.`,
      'Re-run `crucible init` to restore the pinned framework launcher.',
    );
  }
  const rootRelative = relative(root, changeDirFor(root, change));
  for (const item of parsed.data) {
    if (item.path !== rootRelative && !item.path.startsWith(`${rootRelative}/`)) {
      throw invalidInputError(
        'INVALID_OPENSPEC_INSTRUCTIONS',
        `Pinned OpenSpec returned a write path outside ${rootRelative}: ${item.path}.`,
        'Re-run `crucible init` to restore the pinned framework launcher.',
      );
    }
  }
  return parsed.data;
}

function requireRolePrompt(root: string, role: 'propose' | 'implement'): void {
  const path = join(root, '.crucible', 'context', `${role}.md`);
  if (!existsSync(path)) {
    throw preconditionError(
      'MISSING_ROLE_PROMPT',
      `The ${role} role prompt is missing at ${join('.crucible', 'context', `${role}.md`)}.`,
      'Re-run `crucible init` to restore the managed role prompt.',
    );
  }
}

function loadProposeCheckpoint(root: string, change: string): ProposeCheckpoint {
  const checkpoint = parseCheckpoint(
    checkpointPath(root, change, 'propose'),
    proposeCheckpointSchema,
  );
  if (checkpoint.change !== change || checkpoint.input_hash !== hashInput(checkpoint.input)) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Proposal checkpoint for ${change} has stale or forged inputs.`,
      `Run \`crucible session propose start ${change} "<intent>"\` to restart.`,
    );
  }
  requireRolePrompt(root, 'propose');
  return checkpoint;
}

function loadImplementCheckpoint(root: string, change: string): ImplementCheckpoint {
  const checkpoint = parseCheckpoint(
    checkpointPath(root, change, 'implement'),
    implementCheckpointSchema,
  );
  if (checkpoint.change !== change || checkpoint.input_hash !== hashInput(checkpoint.input)) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Implementation checkpoint for ${change} has stale or forged inputs.`,
      `Run \`crucible session implement start ${change}\` to restart.`,
    );
  }
  return checkpoint;
}

function parseCheckpoint<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const code = isNotFound(error) ? 'MISSING_SESSION_CHECKPOINT' : 'INVALID_SESSION_CHECKPOINT';
    const hint =
      code === 'MISSING_SESSION_CHECKPOINT'
        ? 'Restart the session-native stage with its `start` command.'
        : 'Delete the malformed local checkpoint and restart the session-native stage.';
    const maker = code === 'MISSING_SESSION_CHECKPOINT' ? preconditionError : invalidInputError;
    throw maker(code, `${path}: session checkpoint could not be read or parsed.`, hint);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalidInputError(
      'INVALID_SESSION_CHECKPOINT',
      `${path}: session checkpoint is invalid — ${parsed.error.issues[0]?.message ?? 'unknown error'}.`,
      'Delete the malformed local checkpoint and restart the session-native stage.',
    );
  }
  return parsed.data;
}

function writeCheckpoint(root: string, checkpoint: ProposeCheckpoint | ImplementCheckpoint): void {
  const path = checkpointPath(root, checkpoint.change, checkpoint.role);
  mkdirSync(join(root, '.crucible', 'sessions', checkpoint.change), { recursive: true });
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

function removeCheckpoint(root: string, change: string, role: 'propose' | 'implement'): void {
  rmSync(checkpointPath(root, change, role), { force: true });
}

function checkpointPath(root: string, change: string, role: 'propose' | 'implement'): string {
  return join(root, '.crucible', 'sessions', change, `${role}.json`);
}

function changeRel(change: string): string {
  return join('openspec', 'changes', change);
}

function changeDirFor(root: string, change: string): string {
  return join(root, changeRel(change));
}

function hashInput(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(value)));
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
