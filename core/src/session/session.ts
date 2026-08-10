// Deterministic session-native authoring lifecycle (architecture §10).  This is
// deliberately not an AgentSubstrate: an already-active host session writes the
// files, while this module owns every transition, checkpoint, and judgment.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { readRubric, rubricHash } from '../review/rubric.js';
import { evaluateVerdict } from '../review/verdict.js';
import { reviewCheck, type CheckResult } from '../verifyx/report.js';
import {
  amendApproval,
  loadApproval,
  serializeApproval,
  verifyApproval,
} from '../artifacts/approval.js';
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
import {
  computeHashScope,
  dependencyOrder,
  gatherTypeFacts,
  judgeBundle,
} from '../commands/bundle.js';
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
  role: z.enum(['propose', 'implement', 'review', 'amend']),
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
  stage: z.enum(['scaffolding', 'authoring', 'artifacts', 'oracle-tests', 'ready']),
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
  stage: z.enum([
    'tasks',
    'implementation',
    'review-pending',
    'review-authoring',
    'review-red',
    'reviewed',
  ]),
  input: z.strictObject({ approval_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
  review_work_order: z
    .strictObject({
      base: z.string().regex(/^[0-9a-f]{40,64}$/),
      head: z.string().regex(/^[0-9a-f]{40,64}$/),
      approval_hash: z.string().regex(/^[0-9a-f]{64}$/),
      rubric_hash: z.string().regex(/^[0-9a-f]{64}$/),
      verdict_path: z.string().min(1),
    })
    .optional(),
  review_failure: z.strictObject({ code: z.string().min(1), retryable: z.boolean() }).optional(),
  review_snapshot: z
    .strictObject({
      base: z.string().regex(/^[0-9a-f]{40,64}$/),
      head: z.string().regex(/^[0-9a-f]{40,64}$/),
      approval_hash: z.string().regex(/^[0-9a-f]{64}$/),
      rubric_hash: z.string().regex(/^[0-9a-f]{64}$/),
      verdict_hash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});

const amendCheckpointSchema = z.strictObject({
  version: z.literal(SESSION_VERSION),
  change: z.string().min(1),
  role: z.literal('amend'),
  stage: z.enum(['artifacts', 'oracle-tests', 'ready']),
  input: z.strictObject({
    resolution: z.string().min(1),
    approval_hash: z.string().regex(/^[0-9a-f]{64}$/),
    escalation_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    type: z.enum(['feature', 'bugfix', 'refactor']),
  }),
  input_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

type ProposeCheckpoint = z.infer<typeof proposeCheckpointSchema>;
type ImplementCheckpoint = z.infer<typeof implementCheckpointSchema>;
type AmendCheckpoint = z.infer<typeof amendCheckpointSchema>;

export interface SessionDeps {
  now: () => string;
  scaffold: (change: string, schema: string) => Promise<void>;
  /** Pinned OpenSpec instructions, returned as repo-relative write targets. */
  instructions: (change: string, mode: 'next' | 'all') => Promise<SessionInstruction[]>;
  resolve: ResolveFn;
  run: (oracles: readonly Oracle[]) => Promise<OracleResult[]>;
  /** Convenience-only local-review posture, resolved by the CLI. */
  localReviewMode?: 'required' | 'advisory' | 'off';
  /** CLI-owned snapshot edge; it never invokes an agent. */
  reviewSnapshot?: () => LocalReviewSnapshot;
  confirmAmend?: () => Promise<boolean>;
}

export interface LocalReviewSnapshot {
  base: string;
  head: string;
  untracked: string[];
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
  const complete = await completeScaffold(options.root, checkpoint, deps);
  return proposeHandoff(options.root, complete, 'start', []);
}

/** Return only OpenSpec's current ready artifact instructions. */
export async function proposeNext(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  let checkpoint = loadProposeCheckpoint(options.root, options.change);
  if (checkpoint.stage === 'scaffolding')
    checkpoint = await completeScaffold(options.root, checkpoint, deps);
  const instructions = proposalInstructions(
    options.root,
    options.change,
    await deps.instructions(options.change, 'next'),
  );
  if (instructions.length > 0) {
    const artifacts = { ...checkpoint, stage: 'artifacts' as const };
    writeCheckpoint(options.root, artifacts);
    return proposeHandoff(options.root, artifacts, 'next', instructions);
  }
  return oracleTestHandoff(options.root, checkpoint, deps, 'next');
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
    stage: 'artifacts',
    input: { intent: options.instruction, type },
    input_hash: hashInput({ intent: options.instruction, type }),
  };
  writeCheckpoint(options.root, checkpoint);
  const instructions = proposalInstructions(
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
  if (checkpoint.stage === 'scaffolding') {
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

export interface AmendStartOptions extends SessionOptions {
  resolution: string;
}

export interface AmendFinishResult {
  handoff: SessionHandoff;
  report: VerifyReport;
  render: string;
}

export async function amendStart(
  options: AmendStartOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  void deps;
  assertChangeAndIntent(options.change, options.resolution);
  const changeDir = changeDirFor(options.root, options.change);
  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel(options.change)}.`,
      `Run \`crucible session propose start ${options.change} "<intent>"\` first.`,
    );
  }
  if (existsSync(checkpointPath(options.root, options.change, 'amend'))) {
    throw preconditionError(
      'AMEND_ALREADY_ACTIVE',
      `An amendment session is already active for ${options.change}.`,
      `Run \`crucible session amend resume ${options.change}\` or finish the existing amendment.`,
    );
  }
  requireRolePrompt(options.root, 'propose');
  const approvalHash = validateAmendApproval(options.root, options.change);
  const escalationPath = join(changeDir, 'escalation.yaml');
  const escalationHash = existsSync(escalationPath)
    ? hashBytes(readFileSync(escalationPath))
    : undefined;
  readEscalationIfPresent(escalationPath);
  const type = readChangeType(changeDir);
  const input = {
    resolution: options.resolution.trim(),
    approval_hash: approvalHash,
    ...(escalationHash === undefined ? {} : { escalation_hash: escalationHash }),
    type,
  };
  const checkpoint: AmendCheckpoint = {
    version: SESSION_VERSION,
    change: options.change,
    role: 'amend',
    stage: 'artifacts',
    input,
    input_hash: hashInput(input),
  };
  writeCheckpoint(options.root, checkpoint);
  return amendHandoff(
    options.root,
    checkpoint,
    'start',
    [],
    `crucible session amend next ${options.change}`,
  );
}

export async function amendNext(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  const checkpoint = validateAmendCheckpoint(options.root, options.change);
  const instructions = proposalInstructions(
    options.root,
    options.change,
    await deps.instructions(options.change, 'next'),
  );
  if (instructions.length > 0) {
    const next: AmendCheckpoint = { ...checkpoint, stage: 'artifacts' };
    writeCheckpoint(options.root, next);
    return amendHandoff(
      options.root,
      next,
      'next',
      instructions,
      `crucible session amend finish ${options.change}`,
    );
  }
  return amendOracleTestHandoff(options.root, checkpoint, deps, 'next');
}

export async function amendResume(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  return amendNext(options, deps);
}

export async function amendFinish(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<AmendFinishResult> {
  const checkpoint = validateAmendCheckpoint(options.root, options.change);
  const changeDir = changeDirFor(options.root, options.change);
  const report = await judgeBundle(
    options.change,
    changeDir,
    changeRel(options.change),
    deps.resolve,
    collectArchivedRequirementIds(options.root),
    checkpoint.input.type,
    { allowPostApprovalTasks: true },
  );
  if (report.verdict === 'pass') {
    const next: AmendCheckpoint = { ...checkpoint, stage: 'ready' };
    writeCheckpoint(options.root, next);
    return {
      handoff: amendHandoff(
        options.root,
        next,
        'finish',
        [],
        `crucible session amend seal ${options.change}`,
      ),
      report,
      render: renderReport(report, 'session amend'),
    };
  }
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    options.change,
    {
      at: deps.now(),
      cmd: 'amend',
      summary: 'session-native regeneration judged fail — not re-sealed',
      execution_mode: 'session-native',
    },
    'amend-red',
  );
  return {
    handoff: amendHandoff(
      options.root,
      checkpoint,
      'finish',
      [],
      `crucible session amend resume ${options.change}`,
    ),
    report,
    render: renderReport(report, 'session amend'),
  };
}

export async function amendSeal(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  const checkpoint = validateAmendCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'ready') {
    throw preconditionError(
      'AMEND_NOT_READY',
      `Amendment ${options.change} is not ready for a human seal.`,
      `Run \`crucible session amend finish ${options.change}\` first.`,
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
    { allowPostApprovalTasks: true },
  );
  if (report.verdict !== 'pass') {
    return amendHandoff(
      options.root,
      checkpoint,
      'seal',
      [],
      `crucible session amend resume ${options.change}`,
    );
  }
  if (deps.confirmAmend === undefined) {
    throw invalidInputError(
      'AMEND_CONFIRM_UNAVAILABLE',
      'The human amendment confirmation edge is unavailable.',
      'Run the managed amend skill from an interactive terminal.',
    );
  }
  if (!(await deps.confirmAmend())) {
    return amendHandoff(
      options.root,
      checkpoint,
      'seal',
      [],
      `crucible session amend seal ${options.change}`,
    );
  }
  const approvalPath = join(changeDir, 'approval.yaml');
  const approval = loadApproval(approvalPath);
  const oracles = loadOracles(join(changeDir, 'oracles.md'));
  const relpaths = await computeHashScope(
    options.root,
    changeRel(options.change),
    changeDir,
    oracles,
    deps.resolve,
  );
  const amended = amendApproval(options.root, relpaths, deps.now(), approval);
  writeFileSync(approvalPath, serializeApproval(amended), 'utf8');
  writeFileSync(
    join(changeDir, 'generation.yaml'),
    serializeGeneration(
      stampGeneration(changeDir, options.change, dependencyOrder(changeDir), deps.now()),
    ),
    'utf8',
  );
  if (checkpoint.input.escalation_hash !== undefined)
    rmSync(join(changeDir, 'escalation.yaml'), { force: true });
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    options.change,
    {
      at: deps.now(),
      cmd: 'amend',
      summary: `session-native amendment re-sealed ${relpaths.length} file(s)`,
      execution_mode: 'session-native',
    },
    'amended',
  );
  removeCheckpoint(options.root, options.change, 'amend');
  removeCheckpoint(options.root, options.change, 'implement');
  return amendHandoff(
    options.root,
    checkpoint,
    'seal',
    [],
    `crucible session implement start ${options.change}`,
  );
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
  const requiresReview = deps.localReviewMode === 'required' && report.verdict === 'pass';
  const nextCheckpoint: ImplementCheckpoint = requiresReview
    ? {
        ...checkpoint,
        stage: 'review-pending',
        review_work_order: undefined,
        review_failure: undefined,
        review_snapshot: undefined,
      }
    : checkpoint;
  if (requiresReview) writeCheckpoint(options.root, nextCheckpoint);
  const handoff = implementHandoff(
    options.root,
    nextCheckpoint,
    'finish',
    requiresReview
      ? 'crucible session review start ' + options.change
      : report.verdict === 'pass'
        ? `crucible verify ${options.change}`
        : `crucible session implement resume ${options.change}`,
  );
  if (report.verdict === 'pass' && !requiresReview)
    removeCheckpoint(options.root, options.change, 'implement');
  return { handoff, report, render: renderReport(report, 'session implement') };
}

export interface SessionReviewResult {
  handoff: SessionHandoff;
  review: CheckResult;
}

export async function reviewStart(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'review-pending' || deps.localReviewMode !== 'required') {
    throw preconditionError(
      'LOCAL_REVIEW_NOT_PENDING',
      'A required local review is not pending for ' + options.change + '.',
      'Run crucible session implement finish ' +
        options.change +
        ' after implementation verifies green.',
    );
  }
  const approvalHash = validateImplementationPreconditions(
    options.root,
    options.change,
    checkpoint.input.approval_hash,
  );
  requireRolePrompt(options.root, 'review');
  const snapshot = requireReviewSnapshot(options, deps);
  const rubricPath = join(options.root, '.crucible', 'rubric.yaml');
  readRubric(rubricPath);
  const rubricHashValue = rubricHash(rubricPath);
  const verdictPath = reviewVerdictPath(options.root, options.change, deps.now());
  const verdictRel = relative(options.root, verdictPath);
  if (
    !isSafeReviewVerdictPath(options.root, options.change, verdictRel) ||
    existsSync(verdictPath)
  ) {
    throw invalidInputError(
      'LOCAL_REVIEW_VERDICT_PATH',
      'Could not mint a new contained verdict path for ' + options.change + '.',
      'Wait for the active review to finish, then run crucible session review start ' +
        options.change +
        '.',
    );
  }
  mkdirSync(join(options.root, '.crucible', 'verdicts', options.change), { recursive: true });
  const next: ImplementCheckpoint = {
    ...checkpoint,
    stage: 'review-authoring',
    review_failure: undefined,
    review_work_order: {
      base: snapshot.base,
      head: snapshot.head,
      approval_hash: approvalHash,
      rubric_hash: rubricHashValue,
      verdict_path: verdictRel,
    },
  };
  writeCheckpoint(options.root, next);
  return reviewHandoff(options.root, next, snapshot.untracked);
}

export async function reviewFinish(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionReviewResult> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'review-authoring' || deps.localReviewMode !== 'required') {
    throw preconditionError(
      'LOCAL_REVIEW_NOT_AUTHORING',
      'No fresh local review is awaiting verdict finalization for ' + options.change + '.',
      'Run crucible session review start ' + options.change + ' first.',
    );
  }
  const order = checkpoint.review_work_order;
  if (
    order === undefined ||
    !isSafeReviewVerdictPath(options.root, options.change, order.verdict_path)
  ) {
    return reviewRed(
      options.root,
      options.change,
      checkpoint,
      'VERDICT_PATH_INVALID',
      'review work order has an unsafe verdict path',
      false,
    );
  }
  const approvalHash = validateImplementationPreconditions(
    options.root,
    options.change,
    checkpoint.input.approval_hash,
  );
  const snapshot = requireReviewSnapshot(options, deps);
  const rubricPath = join(options.root, '.crucible', 'rubric.yaml');
  const rubric = readRubric(rubricPath);
  const currentRubricHash = rubricHash(rubricPath);
  if (
    snapshot.base !== order.base ||
    snapshot.head !== order.head ||
    approvalHash !== order.approval_hash ||
    currentRubricHash !== order.rubric_hash
  ) {
    return reviewRed(
      options.root,
      options.change,
      checkpoint,
      'REVIEW_SNAPSHOT_STALE',
      'review base, HEAD, approval, or rubric changed after the work order was minted',
      false,
    );
  }
  const verdictPath = join(options.root, order.verdict_path);
  let text: string | undefined;
  try {
    text = existsSync(verdictPath) ? readFileSync(verdictPath, 'utf8') : undefined;
  } catch {
    text = undefined;
  }
  const outcome = evaluateVerdict({ text, rubric, expectedRubricHash: order.rubric_hash });
  const check = reviewCheck(outcome);
  if (outcome.status !== 'pass') {
    return reviewRed(
      options.root,
      options.change,
      checkpoint,
      check.findings[0]!.id,
      check.findings[0]!.message,
      outcome.code === 'NO_VERDICT',
    );
  }
  if (outcome.verdict.change !== options.change || outcome.verdict.reviewed_sha !== order.head) {
    return reviewRed(
      options.root,
      options.change,
      checkpoint,
      'VERDICT_SNAPSHOT_MISMATCH',
      'verdict change or reviewed_sha does not match the minted work order',
      false,
    );
  }
  const next: ImplementCheckpoint = {
    ...checkpoint,
    review_work_order: undefined,
    review_failure: undefined,
    stage: 'reviewed',
    review_snapshot: {
      base: order.base,
      head: order.head,
      approval_hash: order.approval_hash,
      rubric_hash: order.rubric_hash,
      verdict_hash: hashBytes(readFileSync(verdictPath)),
    },
  };
  writeCheckpoint(options.root, next);
  return {
    handoff: implementHandoff(options.root, next, 'finish', 'crucible verify ' + options.change),
    review: check,
  };
}

export async function implementReviewRetry(
  options: SessionOptions,
  deps: SessionDeps,
): Promise<SessionHandoff> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'review-red' || deps.localReviewMode !== 'required') {
    throw preconditionError(
      'LOCAL_REVIEW_NOT_RED',
      'No red local review is awaiting retry for ' + options.change + '.',
      'Run crucible session review finish ' + options.change + ' first.',
    );
  }
  if (checkpoint.review_failure?.retryable === false) {
    throw preconditionError(
      'LOCAL_REVIEW_RETRY_FORBIDDEN',
      'This local review red requires review-address before implementation changes.',
      'Read the findings, then run crucible session implement review-address ' +
        options.change +
        '.',
    );
  }
  const order = checkpoint.review_work_order;
  const snapshot = requireReviewSnapshot(options, deps);
  if (order !== undefined && (snapshot.base !== order.base || snapshot.head !== order.head)) {
    throw preconditionError(
      'REVIEW_SNAPSHOT_STALE',
      'The committed snapshot changed after the red local review.',
      'Run crucible session implement review-address ' +
        options.change +
        ', then re-verify and start a fresh review.',
    );
  }
  validateImplementationPreconditions(options.root, options.change, checkpoint.input.approval_hash);
  const next: ImplementCheckpoint = {
    version: checkpoint.version,
    change: checkpoint.change,
    role: checkpoint.role,
    stage: 'review-pending',
    input: checkpoint.input,
    input_hash: checkpoint.input_hash,
  };
  writeCheckpoint(options.root, next);
  return implementHandoff(
    options.root,
    next,
    'review-retry',
    'crucible session review start ' + options.change,
  );
}

function reviewRed(
  root: string,
  change: string,
  checkpoint: ImplementCheckpoint,
  id: string,
  message: string,
  retryable: boolean,
): SessionReviewResult {
  const next: ImplementCheckpoint = {
    ...checkpoint,
    stage: 'review-red',
    review_failure: { code: id, retryable },
  };
  writeCheckpoint(root, next);
  const review: CheckResult = {
    name: 'review',
    status: 'fail',
    findings: [{ check: 'review', id, message }],
  };
  return {
    handoff: implementHandoff(
      root,
      next,
      'finish',
      retryable
        ? 'crucible session implement review-retry ' + change
        : 'crucible session implement review-address ' + change,
    ),
    review,
  };
}

function requireReviewSnapshot(options: SessionOptions, deps: SessionDeps): LocalReviewSnapshot {
  if (deps.reviewSnapshot === undefined) {
    throw invalidInputError(
      'LOCAL_REVIEW_UNAVAILABLE',
      'The local review snapshot could not be computed.',
      'Restore the managed review skill with crucible init and retry.',
    );
  }
  const parsed = z
    .strictObject({
      base: z.string().regex(/^[0-9a-f]{40,64}$/),
      head: z.string().regex(/^[0-9a-f]{40,64}$/),
      untracked: z.array(z.string().min(1)),
    })
    .safeParse(deps.reviewSnapshot());
  if (!parsed.success) {
    throw invalidInputError(
      'LOCAL_REVIEW_SNAPSHOT_INVALID',
      'The local review snapshot is malformed.',
      'Commit or revert tracked changes, then run crucible session review start ' +
        options.change +
        '.',
    );
  }
  return parsed.data;
}

function reviewVerdictPath(root: string, change: string, now: string): string {
  return join(
    root,
    '.crucible',
    'verdicts',
    change,
    'review-' + now.replace(/[:.]/g, '-') + '.json',
  );
}

function isSafeReviewVerdictPath(root: string, change: string, verdictPath: string): boolean {
  const expected = join('.crucible', 'verdicts', change);
  if (verdictPath.length === 0 || verdictPath.includes('\0')) return false;
  const absolute = resolve(root, verdictPath);
  const rel = relative(root, absolute);
  return rel.startsWith(expected + '/') && !isAbsolute(rel) && !rel.startsWith('../');
}

/** A human explicitly accepts responsibility for returning reviewer-red work to implementation. */
export async function implementReviewAddress(options: SessionOptions): Promise<SessionHandoff> {
  const checkpoint = loadImplementCheckpoint(options.root, options.change);
  if (checkpoint.stage !== 'review-red') {
    throw preconditionError(
      'LOCAL_REVIEW_NOT_RED',
      `No red local review is awaiting an implementation decision for ${options.change}.`,
      `Run \`crucible session implement review ${options.change}\` first.`,
    );
  }
  validateImplementationPreconditions(options.root, options.change, checkpoint.input.approval_hash);
  const next: ImplementCheckpoint = {
    ...checkpoint,
    stage: 'implementation',
    review_work_order: undefined,
    review_failure: undefined,
    review_snapshot: undefined,
  };
  writeCheckpoint(options.root, next);
  return implementHandoff(
    options.root,
    next,
    'review-address',
    `crucible session implement finish ${options.change}`,
  );
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
  const complete: ProposeCheckpoint = { ...checkpoint, stage: 'artifacts' };
  writeCheckpoint(root, complete);
  return complete;
}

function validateAmendApproval(root: string, change: string, expected?: string): string {
  const changeDir = changeDirFor(root, change);
  const approvalPath = join(changeDir, 'approval.yaml');
  if (!existsSync(approvalPath)) {
    throw preconditionError(
      'NO_APPROVAL',
      `Cannot amend ${change}: approval.yaml is missing.`,
      `Run \`crucible approve ${change}\` first.`,
    );
  }
  const approval = loadApproval(approvalPath);
  const verification = verifyApproval(root, approval);
  if (!verification.valid) {
    throw preconditionError(
      'APPROVAL_VOID',
      `Cannot amend ${change}: approval is void (${verification.mismatches.join(', ')}).`,
      'Restore the sealed bundle before starting a new amendment.',
    );
  }
  const hash = hashBytes(readFileSync(approvalPath));
  if (expected !== undefined && hash !== expected) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Amendment checkpoint for ${change} is bound to different approval.yaml bytes.`,
      `Run \`crucible session amend start ${change} "<resolution>"\` again.`,
    );
  }
  return hash;
}

function validateAmendCheckpoint(root: string, change: string): AmendCheckpoint {
  const checkpoint = parseCheckpoint(checkpointPath(root, change, 'amend'), amendCheckpointSchema);
  if (checkpoint.change !== change || checkpoint.input_hash !== hashInput(checkpoint.input)) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Amendment checkpoint for ${change} has stale or forged inputs.`,
      `Run \`crucible session amend start ${change} "<resolution>"\` again.`,
    );
  }
  requireRolePrompt(root, 'propose');
  const approvalPath = join(changeDirFor(root, change), 'approval.yaml');
  const approvalHash = existsSync(approvalPath) ? hashBytes(readFileSync(approvalPath)) : undefined;
  if (approvalHash !== checkpoint.input.approval_hash) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Amendment checkpoint for ${change} is bound to different approval.yaml bytes.`,
      `Run \`crucible session amend start ${change} "<resolution>"\` again.`,
    );
  }
  loadApproval(approvalPath);
  const escalationPath = join(changeDirFor(root, change), 'escalation.yaml');
  const actual = existsSync(escalationPath) ? hashBytes(readFileSync(escalationPath)) : undefined;
  if (actual !== checkpoint.input.escalation_hash) {
    throw preconditionError(
      'SESSION_INPUT_STALE',
      `Amendment checkpoint for ${change} is bound to different escalation bytes.`,
      `Run \`crucible session amend start ${change} "<resolution>"\` again.`,
    );
  }
  readEscalationIfPresent(escalationPath);
  return checkpoint;
}

function amendHandoff(
  root: string,
  checkpoint: AmendCheckpoint,
  operation: string,
  instructions: SessionInstruction[],
  next: string,
): SessionHandoff {
  return makeHandoff(
    root,
    checkpoint.change,
    'amend',
    operation,
    checkpoint.stage,
    instructions,
    next,
    checkpoint.input_hash,
  );
}

async function amendOracleTestHandoff(
  root: string,
  checkpoint: AmendCheckpoint,
  deps: SessionDeps,
  operation: string,
): Promise<SessionHandoff> {
  const oracles = loadOracles(join(changeDirFor(root, checkpoint.change), 'oracles.md'));
  const targets = [...new Set(oracles.flatMap((oracle) => oracle.binding.targets))];
  const results = await deps.resolve(targets);
  const byTarget = new Map(results.map((result) => [result.target, result] as const));
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    const result = byTarget.get(target);
    if (result?.status === 'found') continue;
    if (result?.candidateFile === undefined || !isSafeCandidatePath(root, result.candidateFile)) {
      throw preconditionError(
        'SESSION_TARGET_UNLOCATABLE',
        `Cannot amend ${checkpoint.change}: adapter could not map ${target} to a safe test file.`,
        `Revise the artifact, then run \`crucible session amend resume ${checkpoint.change}\`.`,
      );
    }
    const group = groups.get(result.candidateFile) ?? [];
    group.push(target);
    groups.set(result.candidateFile, group);
  }
  if (groups.size === 0) {
    const ready: AmendCheckpoint = { ...checkpoint, stage: 'ready' };
    writeCheckpoint(root, ready);
    return amendHandoff(
      root,
      ready,
      operation,
      [],
      `crucible session amend finish ${checkpoint.change}`,
    );
  }
  const next: AmendCheckpoint = { ...checkpoint, stage: 'oracle-tests' };
  writeCheckpoint(root, next);
  return amendHandoff(
    root,
    next,
    operation,
    [...groups.entries()].map(([path, targetsForFile]) => ({
      path,
      content: `Write or update this bound oracle test file. It must declare and collect: ${targetsForFile.join(', ')}. Do not write implementation code or tasks.md.`,
    })),
    `crucible session amend next ${checkpoint.change}`,
  );
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
    : checkpoint.stage === 'review-pending'
      ? [
          {
            path: '.',
            content:
              'Commit the intended verified implementation diff, then run the fresh local reviewer. Do not edit sealed artifacts or bound tests.',
          },
        ]
      : checkpoint.stage === 'review-red'
        ? [
            {
              path: '.',
              content:
                'Read the fresh reviewer findings with the human, then use review-address before changing only tasks.md and unsealed implementation files.',
            },
          ]
        : checkpoint.stage === 'reviewed'
          ? []
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
      : checkpoint.stage === 'review-pending'
        ? 'crucible session review start ' + checkpoint.change
        : checkpoint.stage === 'review-red'
          ? `crucible session implement review-address ${checkpoint.change}`
          : checkpoint.stage === 'reviewed'
            ? `crucible verify ${checkpoint.change}`
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

function reviewHandoff(
  root: string,
  checkpoint: ImplementCheckpoint,
  untracked: string[],
): SessionHandoff {
  const order = checkpoint.review_work_order;
  if (order === undefined) throw new Error('missing review work order');
  const excluded =
    untracked.length === 0
      ? 'No untracked files are excluded.'
      : 'Excluded untracked files: ' + untracked.join(', ') + '.';
  return makeHandoff(
    root,
    checkpoint.change,
    'review',
    'start',
    checkpoint.stage,
    [
      {
        path: order.verdict_path,
        content:
          'Open a fresh Codex conversation before reviewing. Read .crucible/context/review.md, the approved bundle, .crucible/rubric.yaml, and git diff ' +
          order.base +
          ' ' +
          order.head +
          '. Write exactly one strict verdict JSON to this caller-minted path. ' +
          excluded,
      },
    ],
    'crucible session review finish ' + checkpoint.change,
    checkpoint.input_hash,
  );
}
function makeHandoff(
  _root: string,
  change: string,
  role: 'propose' | 'implement' | 'review' | 'amend',
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
    role_prompt: join('.crucible', 'context', `${role === 'amend' ? 'propose' : role}.md`),
    instructions,
    next_command: nextCommand,
    input_hash: inputHash,
  });
}

async function oracleTestHandoff(
  root: string,
  checkpoint: ProposeCheckpoint,
  deps: SessionDeps,
  operation: string,
): Promise<SessionHandoff> {
  const oracles = loadOracles(join(changeDirFor(root, checkpoint.change), 'oracles.md'));
  const targetToOracle = new Map<string, string>();
  for (const oracle of oracles)
    for (const target of oracle.binding.targets) {
      if (!targetToOracle.has(target)) targetToOracle.set(target, oracle.id);
    }
  const targets = [...targetToOracle.keys()];
  const results = await deps.resolve(targets);
  const byTarget = new Map(results.map((result) => [result.target, result] as const));
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    const result = byTarget.get(target);
    if (result?.status === 'found') continue;
    const candidate = result?.candidateFile;
    if (candidate === undefined || !isSafeCandidatePath(root, candidate)) {
      throw preconditionError(
        'SESSION_TARGET_UNLOCATABLE',
        'Cannot author oracle ' +
          (targetToOracle.get(target) ?? target) +
          ': adapter could not map ' +
          target +
          ' to a safe test file.',
        'Run session propose revise with an addressable target binding.',
      );
    }
    const group = groups.get(candidate) ?? [];
    group.push(target);
    groups.set(candidate, group);
  }
  if (groups.size === 0) {
    const ready = { ...checkpoint, stage: 'ready' as const };
    writeCheckpoint(root, ready);
    return proposeHandoff(root, ready, operation, []);
  }
  const oracleTests = { ...checkpoint, stage: 'oracle-tests' as const };
  writeCheckpoint(root, oracleTests);
  const instructions = [...groups.entries()].map(([path, targetsForFile]) => ({
    path,
    content:
      'Write or update this bound oracle test file. It must declare and collect: ' +
      targetsForFile.join(', ') +
      '. Do not write implementation code or tasks.md.',
  }));
  return proposeHandoff(
    root,
    oracleTests,
    operation,
    instructions,
    'crucible session propose next ' + checkpoint.change,
  );
}

function isSafeCandidatePath(root: string, candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes('\0')) return false;
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  return rel.length > 0 && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
function proposalInstructions(
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
  const tasksPath = join(rootRelative, 'tasks.md');
  const specsPrefix = join(rootRelative, 'specs');
  return parsed.data.filter((item) => {
    if (item.path === tasksPath) return false;
    if (
      item.path === join(rootRelative, 'proposal.md') ||
      item.path === join(rootRelative, 'design.md') ||
      item.path === join(rootRelative, 'oracles.md') ||
      item.path.startsWith(specsPrefix + '/')
    )
      return true;
    throw invalidInputError(
      'INVALID_OPENSPEC_INSTRUCTIONS',
      'Pinned OpenSpec returned an unsupported proposal path: ' + item.path + '.',
      'Re-run crucible init to restore the pinned framework launcher.',
    );
  });
}

function requireRolePrompt(root: string, role: 'propose' | 'implement' | 'review' | 'amend'): void {
  const path = join(root, '.crucible', 'context', `${role === 'amend' ? 'propose' : role}.md`);
  if (!existsSync(path)) {
    throw preconditionError(
      'MISSING_ROLE_PROMPT',
      `The ${role} role prompt is missing at ${join('.crucible', 'context', `${role === 'amend' ? 'propose' : role}.md`)}.`,
      'Re-run `crucible init` to restore the managed role prompt.',
    );
  }
}

function loadProposeCheckpoint(root: string, change: string): ProposeCheckpoint {
  const parsed = parseCheckpoint(checkpointPath(root, change, 'propose'), proposeCheckpointSchema);
  const checkpoint =
    parsed.stage === 'authoring' ? { ...parsed, stage: 'artifacts' as const } : parsed;
  if (parsed.stage === 'authoring') writeCheckpoint(root, checkpoint);
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

function writeCheckpoint(
  root: string,
  checkpoint: ProposeCheckpoint | ImplementCheckpoint | AmendCheckpoint,
): void {
  const path = checkpointPath(root, checkpoint.change, checkpoint.role);
  mkdirSync(join(root, '.crucible', 'sessions', checkpoint.change), { recursive: true });
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

function removeCheckpoint(
  root: string,
  change: string,
  role: 'propose' | 'implement' | 'review' | 'amend',
): void {
  rmSync(checkpointPath(root, change, role), { force: true });
}

function checkpointPath(
  root: string,
  change: string,
  role: 'propose' | 'implement' | 'review' | 'amend',
): string {
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
