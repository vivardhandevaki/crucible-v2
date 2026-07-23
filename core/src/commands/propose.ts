// `crucible propose` — an agent authors the bundle; Crucible judges it (charter
// §The Workflow; design phase-0-1.md §6).
//
// propose is the one P1 command that *creates* a change: it validates its
// inputs (change name per the OpenSpec rule spike D6, non-empty intent),
// scaffolds the OpenSpec change dir (spike-determined mechanism, injected),
// runs one fresh-context substrate session (role=propose, invariant 10) — and
// then judges the session's output with our own parsers + traceability lint.
// The substrate's exit code is deliberately ignored (invariant 2: agent
// self-report is worth zero; the result carries nothing else to trust).
//
// The judgment boundary is the design's central nuance: during propose the
// bundle artifacts are the AGENT'S PRODUCT under judgment, not our input — so a
// malformed artifact here becomes a red `bundle` finding in the report (exit 1
// at the CLI), where the same defect in approve/verify is fail-closed exit 3.
// Fail-closed still owns everything upstream of the session: bad change name,
// existing change dir, missing role prompt, a scaffolder that produced nothing.
//
// Determinism (invariant 12): substrate, scaffolder, resolver, and clock are
// injected (`ProposeDeps`); the core mints the transcript path from the
// injected clock (architecture.md §6: the caller owns transcript naming) and
// touches no wall-clock or randomness itself.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadProposal } from '../artifacts/proposal.js';
import { loadSpecDelta, type SpecRequirement } from '../artifacts/spec-delta.js';
import { lintTraceability, type ResolveFn } from '../lint/traceability.js';
import type { AgentSubstrate } from '../substrate/types.js';
import { appendStateEvent } from '../state/state.js';
import {
  aggregate,
  renderReport,
  traceabilityCheck,
  type CheckResult,
  type VerifyFinding,
  type VerifyReport,
} from '../verifyx/report.js';
import { invalidInputError, isCrucibleError, preconditionError } from '../util/errors.js';

// Change names follow OpenSpec's rule (spike D6): lowercase kebab-case, no
// leading digit, no leading/trailing/double hyphen. propose enforces the same
// rule so a name OpenSpec would reject never reaches the scaffolder.
const CHANGE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Injected non-deterministic edges — so the command's core stays reproducible. */
export interface ProposeDeps {
  /** The agent session runner (architecture.md §6). The CLI wires ClaudeCode. */
  substrate: AgentSubstrate;
  /**
   * Scaffold the OpenSpec change dir (spike: `openspec new change <name>
   * --schema crucible --json`). Injected because the real one spawns the
   * pinned OpenSpec CLI; the core verifies the dir exists afterwards rather
   * than trusting the scaffolder's silence (invariant 3).
   */
  scaffold: (change: string) => Promise<void>;
  /**
   * Batch dry-run resolver (charter §Bindings & the Adapter Protocol) — powers
   * the traceability lint. Injected because the real one spawns the adapter
   * (P1-11 client); tests pass a pure function.
   */
  resolve: ResolveFn;
  /** ISO 8601 clock — transcript naming + state event. No wall-clock in core. */
  now: () => string;
}

/** propose invocation options. `root` is the target repo root. */
export interface ProposeOptions {
  /** Repo root the session runs in; all bundle paths are relative to it. */
  root: string;
  /** The change name to create (lowercase kebab-case, no leading digit). */
  change: string;
  /** The distilled intent text handed to the propose session verbatim. */
  intent: string;
  /** Model id for the session (convenience `models.propose`; opaque here). */
  model: string;
}

/** propose outcome: the judgment report and where the session transcript went. */
export interface ProposeResult {
  /** The post-session judgment (`bundle` + `traceability` checks). */
  report: VerifyReport;
  /** Terminal rendering of the report (the CLI prints it). */
  render: string;
  /** Absolute path of the captured session transcript. */
  transcriptPath: string;
}

/**
 * Run propose: validate inputs → scaffold → substrate session → judge the
 * authored bundle. Throws `CrucibleError` on pre-session failures (exit 2/3);
 * the post-session judgment is *returned* as a report — a red verdict is the
 * agent failing, not the tool (the CLI maps it to exit 1 via `CheckFailure`).
 */
export async function propose(options: ProposeOptions, deps: ProposeDeps): Promise<ProposeResult> {
  const { root, change, intent, model } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!CHANGE_NAME.test(change)) {
    throw invalidInputError(
      'INVALID_CHANGE_NAME',
      `Invalid change name \`${change}\`: must be lowercase kebab-case and not start with a digit (OpenSpec rule).`,
      'Pick a name like `add-rate-limit` and re-run `crucible propose`.',
    );
  }
  if (intent.trim().length === 0) {
    throw invalidInputError(
      'EMPTY_INTENT',
      'The intent text is empty — the propose session would have nothing to specify.',
      `Re-run \`crucible propose ${change} "<what should change and why>"\`.`,
    );
  }
  if (existsSync(changeDir)) {
    throw preconditionError(
      'CHANGE_EXISTS',
      `Change ${change} already exists at ${changeRel}.`,
      'Pre-approval artifacts are freely editable in place (charter §Editing Artifacts); `crucible propose --revise` lands in P2. To re-propose from scratch, remove the change dir first.',
    );
  }

  // The role prompt is a per-project TCB file (architecture §Static Context
  // Surfaces). The substrate would also refuse to start without it (exit 3);
  // checking here first turns that into a teaching precondition.
  const rolePromptPath = join(root, '.crucible', 'context', 'propose.md');
  if (!existsSync(rolePromptPath)) {
    throw preconditionError(
      'MISSING_ROLE_PROMPT',
      `The propose role prompt is missing at ${join('.crucible', 'context', 'propose.md')}.`,
      'Restore .crucible/context/propose.md (installed by `crucible init` from P2; until then check it into the repo).',
    );
  }

  // Scaffold, then verify the scaffolder actually produced the change dir —
  // its silence is not success (invariant 3).
  await deps.scaffold(change);
  if (!existsSync(changeDir)) {
    throw invalidInputError(
      'SCAFFOLD_FAILED',
      `Scaffolding did not create ${changeRel} — the OpenSpec change was not made.`,
      'Check that this repo is OpenSpec-initialized with the crucible schema (openspec/config.yaml).',
    );
  }

  // One fresh-context session (invariant 10). The transcript path is minted
  // here from the injected clock (architecture.md §6: caller-owned naming).
  const transcriptPath = join(
    root,
    '.crucible',
    'transcripts',
    change,
    `propose-${deps.now().replace(/[:.]/g, '-')}.jsonl`,
  );
  await deps.substrate.run({
    role: 'propose',
    rolePromptPath,
    taskPayload: buildTaskPayload(change, changeRel, intent),
    cwd: root,
    model,
    transcriptPath,
  });
  // SubstrateResult carries nothing to trust (invariant 2) — judge the files.

  const report = await judgeBundle(change, changeDir, changeRel, deps.resolve);

  // Audit trail, written last and never read to gate (invariant 1). A red
  // judgment is still an event that happened.
  appendStateEvent(
    join(changeDir, 'state.yaml'),
    change,
    {
      at: deps.now(),
      cmd: 'propose',
      summary: `bundle judged ${report.verdict} (${report.checks.length} check(s))`,
    },
    report.verdict === 'pass' ? 'proposed' : 'propose-red',
  );

  return { report, render: renderReport(report, 'propose'), transcriptPath };
}

/** The work order handed to the session: the specifics the role prompt doesn't know. */
function buildTaskPayload(change: string, changeRel: string, intent: string): string {
  return [`Change: ${change}`, `Bundle directory: ${changeRel}/`, 'Intent:', intent].join('\n');
}

/**
 * Judge the authored bundle: the `bundle` check parses every required artifact,
 * folding each parser's `CrucibleError` into a red finding (the agent is judged
 * on its output, never trusted about it); the `traceability` check runs only on
 * a green bundle — linting unparseable artifacts is meaningless.
 */
async function judgeBundle(
  change: string,
  changeDir: string,
  changeRel: string,
  resolve: ResolveFn,
): Promise<VerifyReport> {
  const findings: VerifyFinding[] = [];
  const judged = <T>(artifactRel: string, load: () => T): T | undefined => {
    try {
      return load();
    } catch (err) {
      if (isCrucibleError(err)) {
        findings.push({ check: 'bundle', id: artifactRel, message: err.message });
        return undefined;
      }
      throw err;
    }
  };

  judged('proposal.md', () => loadProposal(join(changeDir, 'proposal.md')));

  // design.md carries no Crucible grammar (P1): required present + non-empty.
  const designPath = join(changeDir, 'design.md');
  const designOk = existsSync(designPath) && statSync(designPath).size > 0;
  if (!designOk) {
    findings.push({
      check: 'bundle',
      id: 'design.md',
      message: `${join(changeRel, 'design.md')}: missing or empty — the propose session must author the design`,
    });
  }

  // Spec deltas: at least one specs/** markdown, each parsing clean.
  const specFiles = markdownFilesUnder(join(changeDir, 'specs')).sort();
  let requirements: SpecRequirement[] | undefined = [];
  if (specFiles.length === 0) {
    findings.push({
      check: 'bundle',
      id: 'specs/',
      message: `${join(changeRel, 'specs')}: no spec delta authored — a change with no spec delta promises nothing`,
    });
    requirements = undefined;
  } else {
    for (const file of specFiles) {
      const rel = relative(changeDir, file);
      const reqs = judged(rel, () => loadSpecDelta(file));
      if (reqs === undefined) requirements = undefined;
      else requirements?.push(...reqs);
    }
  }

  const oracles: Oracle[] | undefined = judged('oracles.md', () =>
    loadOracles(join(changeDir, 'oracles.md')),
  );

  const bundle: CheckResult = {
    name: 'bundle',
    status: findings.length === 0 ? 'pass' : 'fail',
    findings,
  };
  const checks: CheckResult[] = [bundle];

  if (bundle.status === 'pass' && requirements !== undefined && oracles !== undefined) {
    const lint = await lintTraceability(requirements, oracles, resolve);
    checks.push(traceabilityCheck(lint));
  }

  return aggregate(change, checks);
}

/** All `.md` files under `dir` (recursive), absolute paths. Empty if absent. */
function markdownFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...markdownFilesUnder(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}
