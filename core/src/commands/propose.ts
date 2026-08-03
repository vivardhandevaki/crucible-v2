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

import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ResolveFn } from '../lint/traceability.js';
import type { AgentSubstrate } from '../substrate/types.js';
import { appendStateEvent, recordSnapshotType } from '../state/state.js';
import { renderReport, type VerifyReport } from '../verifyx/report.js';
import { dependencyOrder, gatherTypeFacts, judgeBundle } from './bundle.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { loadOracles } from '../artifacts/oracles.js';
import {
  assertTypeConformance,
  inferType,
  readChangeType,
  schemaForType,
  type ChangeType,
} from '../changetype/changetype.js';
import { serializeGeneration, stampGeneration } from '../artifacts/generation.js';
import { invalidInputError, preconditionError } from '../util/errors.js';

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
   * --schema <schema> --json`), pinning the given schema — the sibling bundle
   * for the change type (design phase-2.md §4). Injected because the real one
   * spawns the pinned OpenSpec CLI; the core verifies the dir exists afterwards
   * rather than trusting the scaffolder's silence (invariant 3). The `.openspec.yaml`
   * the scaffold writes carries the schema pin, which IS the recorded type.
   */
  scaffold: (change: string, schema: string) => Promise<void>;
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
  /** The distilled intent text handed to the propose session verbatim. In
   * `--revise` mode this is the revision instruction ("switch to token-bucket"). */
  intent: string;
  /** Model id for the session (convenience `models.propose`; opaque here). */
  model: string;
  /**
   * The change type (charter §Change Types). When omitted in create mode it is
   * INFERRED from the intent (`--type` on the CLI supplies it explicitly); it
   * selects the sibling schema the scaffold pins. Ignored in `--revise` mode,
   * where the type is already pinned in the existing `.openspec.yaml`.
   */
  type?: ChangeType;
  /**
   * `--revise`: regenerate an EXISTING, not-yet-approved bundle coherently
   * through the same propose-role path (charter §Editing Artifacts). Skips the
   * scaffold, requires the change dir to exist, and refuses once the bundle is
   * approved (post-approval fixes go through `crucible amend`). Default: create.
   */
  revise?: boolean;
}

/** propose outcome: the judgment report and where the session transcript went. */
export interface ProposeResult {
  /** The post-session judgment (`bundle` + `traceability` checks). */
  report: VerifyReport;
  /** Terminal rendering of the report (the CLI prints it). */
  render: string;
  /** Absolute path of the captured session transcript. */
  transcriptPath: string;
  /** The resolved change type (inferred, `--type`, or the pin in revise mode). */
  type: ChangeType;
}

/**
 * Run propose: validate inputs → scaffold → substrate session → judge the
 * authored bundle. Throws `CrucibleError` on pre-session failures (exit 2/3);
 * the post-session judgment is *returned* as a report — a red verdict is the
 * agent failing, not the tool (the CLI maps it to exit 1 via `CheckFailure`).
 */
export async function propose(options: ProposeOptions, deps: ProposeDeps): Promise<ProposeResult> {
  const { root, change, intent, model } = options;
  const revise = options.revise === true;
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
      revise
        ? 'The revision instruction is empty — `--revise` would have nothing to change.'
        : 'The intent text is empty — the propose session would have nothing to specify.',
      revise
        ? `Re-run \`crucible propose ${change} --revise "<what to change>"\`.`
        : `Re-run \`crucible propose ${change} "<what should change and why>"\`.`,
    );
  }

  if (revise) {
    // --revise regenerates an EXISTING, not-yet-approved bundle (charter §Editing
    // Artifacts). It must exist, and it must not yet be sealed — once approved,
    // the only coherent path is `crucible amend`, which re-seals the delta.
    if (!existsSync(changeDir)) {
      throw preconditionError(
        'NO_CHANGE',
        `No change bundle found at ${changeRel} to revise.`,
        `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
      );
    }
    if (existsSync(join(changeDir, 'approval.yaml'))) {
      throw preconditionError(
        'ALREADY_APPROVED',
        `Change ${change} is already approved — \`--revise\` only edits pre-approval bundles.`,
        `Post-approval spec fixes go through \`crucible amend ${change}\` (re-seals the delta).`,
      );
    }
  } else if (existsSync(changeDir)) {
    throw preconditionError(
      'CHANGE_EXISTS',
      `Change ${change} already exists at ${changeRel}.`,
      `Pre-approval, revise it coherently with \`crucible propose ${change} --revise "<fix>"\`. To re-propose from scratch, remove the change dir first.`,
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

  // The change type (charter §Change Types): inferred from the intent in create
  // mode (or `--type`), read from the existing `.openspec.yaml` pin in revise mode
  // (the type is fixed once scaffolded — revise regenerates content, not the type).
  const type: ChangeType = revise ? readChangeType(changeDir) : (options.type ?? inferType(intent));

  // Create mode scaffolds the OpenSpec change dir with the TYPE's schema pinned,
  // then verifies the scaffolder actually produced it — its silence is not success
  // (invariant 3). Revise mode operates on the bundle already on disk, so it skips
  // scaffolding entirely (the pin already exists).
  if (!revise) {
    await deps.scaffold(change, schemaForType(type));
    if (!existsSync(changeDir)) {
      throw invalidInputError(
        'SCAFFOLD_FAILED',
        `Scaffolding did not create ${changeRel} — the OpenSpec change was not made.`,
        'Check that this repo is OpenSpec-initialized with the crucible schema (openspec/config.yaml).',
      );
    }
  }

  // One fresh-context session (invariant 10). The transcript path is minted
  // here from the injected clock (architecture.md §6: caller-owned naming).
  const stamp = deps.now().replace(/[:.]/g, '-');
  const transcriptPath = join(
    root,
    '.crucible',
    'transcripts',
    change,
    `${revise ? 'revise' : 'propose'}-${stamp}.jsonl`,
  );
  await deps.substrate.run({
    role: 'propose',
    rolePromptPath,
    taskPayload: revise
      ? buildRevisePayload(change, changeRel, intent)
      : buildTaskPayload(change, changeRel, intent),
    cwd: root,
    model,
    transcriptPath,
  });
  // SubstrateResult carries nothing to trust (invariant 2) — judge the files.

  const report = await judgeBundle(
    change,
    changeDir,
    changeRel,
    deps.resolve,
    collectArchivedRequirementIds(root),
    type,
  );

  // Type conformance (charter §Change Types; design phase-2.md §4): once the
  // artifacts PARSE (the `bundle` check is green), revalidate the bundle's real
  // shape against its pinned type — a refactor that carries a spec delta or
  // oracles, or a bugfix with no reproduction oracle, fails closed at exit 3
  // regardless of the lint verdict (a refactor's spec delta is the ROOT cause of
  // any downstream coverage red, so it takes precedence). Gated on a parseable
  // bundle so a malformed artifact stays a red `bundle` finding (the propose
  // judgment boundary, invariant 2) rather than being reclassified as exit 3.
  const bundleParsed = report.checks.find((c) => c.name === 'bundle')?.status === 'pass';
  if (bundleParsed) {
    assertTypeConformance(
      type,
      gatherTypeFacts(changeDir, loadOracles(join(changeDir, 'oracles.md'))),
    );
  }

  // On a GREEN bundle, stamp the generation ledger (staleness tracking, charter
  // §Editing Artifacts): record each artifact's hash in dependency order so a
  // later hand-edit that breaks coherence is detectable at approve. Only a
  // coherent bundle has a meaningful lineage — a red bundle is skipped (approve
  // will not run on it anyway). Convenience-adjacent: it never gates propose.
  if (report.verdict === 'pass') {
    const generation = stampGeneration(changeDir, change, dependencyOrder(changeDir), deps.now());
    writeFileSync(join(changeDir, 'generation.yaml'), serializeGeneration(generation), 'utf8');
  }

  // Audit trail, written last and never read to gate (invariant 1). A red
  // judgment is still an event that happened.
  const cmd = revise ? 'revise' : 'propose';
  const statePath = join(changeDir, 'state.yaml');
  appendStateEvent(
    statePath,
    change,
    {
      at: deps.now(),
      cmd,
      summary: `bundle judged ${report.verdict} (${report.checks.length} check(s)) [type: ${type}]`,
      transcript: relative(root, transcriptPath),
      execution_mode: 'headless',
    },
    report.verdict === 'pass' ? (revise ? 'revised' : 'proposed') : 'propose-red',
  );
  // Record the type into the snapshot for `status` display (design §4). Best-effort
  // convenience (invariant 11) — the `.openspec.yaml` pin is the real record.
  recordSnapshotType(statePath, type);

  return { report, render: renderReport(report, 'propose'), transcriptPath, type };
}

/** The work order handed to the session: the specifics the role prompt doesn't know. */
function buildTaskPayload(change: string, changeRel: string, intent: string): string {
  return [`Change: ${change}`, `Bundle directory: ${changeRel}/`, 'Intent:', intent].join('\n');
}

/**
 * The revise work order (charter §Editing Artifacts): the bundle already exists;
 * apply the revision instruction and regenerate every DEPENDENT artifact so the
 * bundle stays coherent (that coherence is the whole point of the agent path).
 */
function buildRevisePayload(change: string, changeRel: string, instruction: string): string {
  return [
    `Change: ${change}`,
    `Bundle directory: ${changeRel}/`,
    'Revise the EXISTING bundle in place. Apply this change, then regenerate every',
    'dependent artifact (design → spec delta → oracles → bound tests) so the bundle',
    'stays internally consistent — a stale downstream artifact is a bug.',
    'Revision instruction:',
    instruction,
  ].join('\n');
}
