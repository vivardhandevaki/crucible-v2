// `crucible approve` — the one human gate (charter §The Core Inversion, §The
// Workflow, §Approval, Amend, Override, §The Approve Session; design phase-0-1.md
// §6, phase-2.md §8).
//
// approve is where a human seals a reviewed bundle. It is a precondition-gated
// command (invariant 5): it refuses to run — exit 2, naming the exact next
// command — unless the bundle's artifacts exist, parse, and pass the
// traceability lint. Only then does it render the review surface, ask for
// confirmation, and (on yes) write approval.yaml, sealing every bundle artifact
// + bound test file by sha256 (invariant 6, via hash/ + artifacts/approval). It
// finally appends a state event (design §3) — a derived audit trail, never read
// for an enforcement decision (invariant 1).
//
// The P2-14 review surface (design §8) makes this the "one rich gate": approve
// recomputes the tier (an enforcement recomputation point — the per-oracle ack
// obligation depends on it), renders the proposal's honesty sections + each
// oracle's scenario beside its bound test source, and drives an inline
// edit→revalidate→regenerate loop. The critical tier requires an explicit ack per
// oracle before the seal confirm; `--yes` is refused there.
//
// Determinism (invariant 12): every non-deterministic edge — the confirm prompt,
// the clock, the approver identity, the binding resolver, the git diff facts, the
// regeneration substrate, and the terminal interaction (pager / editor / walk /
// diff-confirm) — is injected (`ApproveDeps`). The core touches no wall-clock, no
// randomness, no real terminal, and never spawns a real adapter or editor; the
// CLI layer wires the live edges in.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadProposal } from '../artifacts/proposal.js';
import { lintTraceability, type ResolveFn } from '../lint/traceability.js';
import { collectArchivedRequirementIds } from '../regression/regression.js';
import { sealBundle, serializeApproval, type Ack } from '../artifacts/approval.js';
import {
  checkStaleness,
  readGenerationIfPresent,
  serializeGeneration,
  stampGeneration,
} from '../artifacts/generation.js';
import {
  computeHashScope,
  dedupeTargets,
  dependencyOrder,
  gatherTypeFacts,
  judgeBundle,
  loadRequirementsForType,
  schemaPreApprovalPaths,
} from './bundle.js';
import { assertTypeConformance, readChangeType, schemaForType } from '../changetype/changetype.js';
import { loadSchemaBundle } from '../changetype/schema-bundle.js';
import { computeTier, type TierDecision, type TierName } from '../tier/tier.js';
import type { EnforcementConfig } from '../config/enforcement.js';
import type { AgentSubstrate } from '../substrate/types.js';
import type { DiffFacts } from './verify.js';
import { renderReport, type VerifyFinding } from '../verifyx/report.js';
import { appendStateEvent, recordSnapshotTier, recordSnapshotType } from '../state/state.js';
import {
  PLAIN_STYLE,
  renderFindings,
  renderOverview,
  renderPanel,
  renderTestDiff,
  type OracleSource,
  type SurfaceStyle,
  type TestDiffFile,
} from './approve-surface.js';
import { isCrucibleError, preconditionError } from '../util/errors.js';

/** The P1 approval.yaml schema version (design §3). */
const APPROVAL_VERSION = 1;

/** The regeneration session's default model when the caller names none (opaque). */
const DEFAULT_REGEN_MODEL = 'claude-opus-4-8';

/** The action a human takes at one oracle panel in the walk (design §8, Stage 2). */
export type WalkAction = 'next' | 'edit' | 'ack' | 'quit';

/** The action a human takes after seeing a regeneration's test diff (design §8). */
export type DiffAction = 'accept' | 'edit' | 'quit';

/** The panel prompt's context: whether critical acks are in force + this oracle's state. */
export interface WalkContext {
  critical: boolean;
  acknowledged: boolean;
}

/** Injected non-deterministic edges — so the command's core stays reproducible. */
export interface ApproveDeps {
  /**
   * Batch dry-run resolver (charter §Bindings & the Adapter Protocol). Powers
   * the traceability lint, supplies each bound target's file for the hash scope,
   * AND supplies the bound-test source shown in each oracle panel. Injected
   * because the real one spawns the adapter process (P1-11 client); tests pass a
   * pure function.
   */
  resolve: ResolveFn;
  /** Ask the human to confirm the seal. Skipped entirely when `--yes`. */
  confirm: () => Promise<boolean>;
  /** The approval timestamp (ISO 8601). Injected — no wall-clock in the core. */
  now: () => string;
  /** Who is approving (e.g. git user email). Injected for determinism. */
  approvedBy: () => string;
  /**
   * Assemble the diff facts (touched paths + changed lines) — the git edge for
   * tier recomputation (design §2/§8). Supplied together with `options.config` on
   * the authoritative CLI path; an uncomputable diff throws exit 3 there (never
   * "assume trivial"). Omitted → no tier is computed (a test / minimal run), so
   * the critical ack regime is off.
   */
  diffFacts?: () => DiffFacts;
  /**
   * The propose-role regeneration substrate for the edit loop (design §8): when a
   * human edits a scenario, its bound tests are regenerated through the same
   * fresh-context propose path amend/`--revise` use (invariant 10). Injected
   * because it spawns an agent; needed only if an edit actually happens.
   */
  substrate?: AgentSubstrate;
  /** Display a rendered surface (the pager). Injected; the core never writes to a
   * real terminal. Absent → a no-op (a non-interactive minimal run). */
  pager?: (text: string) => void | Promise<void>;
  /** Prompt for the action at one oracle panel (design §8, Stage 2). */
  walk?: (context: WalkContext) => Promise<WalkAction>;
  /** Open `$EDITOR` at `oracles.md +<line>` for an inline scenario edit. */
  openEditor?: (file: string, line: number) => Promise<void>;
  /** Prompt to accept / re-edit / abort a regeneration's test diff (design §8). */
  confirmDiff?: () => Promise<DiffAction>;
}

/** approve invocation options. `root` is the repo root the seal is relative to. */
export interface ApproveOptions {
  /** Repo root: the hash scope is expressed relative to this (design §4). */
  root: string;
  /** The change name (its bundle lives at openspec/changes/<change>/). */
  change: string;
  /** Skip the interactive walk + confirm (`--yes`). Refused for critical tier. */
  yes: boolean;
  /** Require the installed schema-complete P4R approval boundary. */
  requireSchema?: boolean;
  /**
   * `--confirm-consistency`: proceed past a staleness refusal (charter §Editing
   * Artifacts). When an upstream artifact was hand-edited after a downstream one
   * was generated, approve refuses by default; this flag asserts the human has
   * checked the edits are coherent, re-stamping the generation ledger to the
   * current bytes and sealing. The alternative is `crucible propose --revise`.
   */
  confirmConsistency?: boolean;
  /**
   * Enforcement config the tier is computed against (risk globs + diff caps).
   * Supplied with `deps.diffFacts` to enable tier recomputation (design §8);
   * omitted → no tier, and the critical ack regime is off.
   */
  config?: EnforcementConfig;
  /** Model id for the regeneration session (convenience; opaque here). */
  model?: string;
  /** Render width (design §8: the CLI passes `process.stdout.columns`). Default 80. */
  width?: number;
  /** Emit ANSI color in the render? Default false (stable bytes for tests). */
  color?: boolean;
}

/** approve outcome: `approved` is false only when the human declined/aborted. */
export interface ApproveResult {
  approved: boolean;
  /** The rendered overview surface (returned so the CLI can print/log it). */
  render: string;
  /** Relative paths sealed (present only when `approved`). */
  sealedFiles?: string[];
  /** The computed tier, when config + diff facts were supplied. */
  tier?: TierName;
}

/**
 * Run the approve gate. Throws `CrucibleError` (exit 2) if a precondition is
 * unmet — missing artifact, a red lint, a staleness refusal, or `--yes` on the
 * critical tier — naming what to run instead; exit 3 bubbles up from the parsers
 * on a malformed artifact (fail-closed input). On a clean bundle it recomputes
 * the tier, renders the review surface, drives the walk (unless `--yes`
 * non-critical), confirms, and on confirmation writes approval.yaml + a state
 * event. Declined/aborted → no writes.
 */
export async function approve(options: ApproveOptions, deps: ApproveDeps): Promise<ApproveResult> {
  const { root, change, yes } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  if (!existsSync(changeDir)) {
    throw preconditionError(
      'NO_CHANGE',
      `No change bundle found at ${changeRel}.`,
      `Run \`crucible propose ${change} "<intent>"\` to scaffold the bundle first.`,
    );
  }

  // Parse the bundle. Missing artifact → exit 2 (loaders); malformed → exit 3.
  // The proposal's Unspecified/Seams are surfaced prominently in the overview.
  const proposal = loadProposal(join(changeDir, 'proposal.md'));
  // The pinned change type (charter §Change Types): a FEATURE requires a spec
  // delta; a refactor/bugfix may carry none. Revalidated below (design §4).
  const type = readChangeType(changeDir);
  if (options.requireSchema === true) {
    const schema = loadSchemaBundle(
      join(root, 'openspec', 'schemas', schemaForType(type), 'schema.yaml'),
    );
    for (const artifact of schemaPreApprovalPaths(changeDir, schema)) {
      const path = join(changeDir, artifact);
      if (!existsSync(path) || readFileSync(path).length === 0) {
        throw preconditionError(
          'SCHEMA_ARTIFACT_MISSING',
          `Cannot approve ${change}: schema-declared artifact ${join(changeRel, artifact)} is missing or empty.`,
          `Revise the complete proposal in the active session, then re-run \`crucible propose ${change}\`.`,
        );
      }
    }
    if (schema.apply?.tracks && existsSync(join(changeDir, schema.apply.tracks))) {
      throw preconditionError(
        'POST_APPROVAL_ARTIFACT_PRESENT',
        `Cannot approve ${change}: ${join(changeRel, schema.apply.tracks)} is post-approval work and must not exist yet.`,
        `Remove ${schema.apply.tracks}, revise the proposal if needed, then re-run \`crucible propose ${change}\`.`,
      );
    }
  }
  const requirements = loadRequirementsForType(changeDir, changeRel, type);
  let oracles = loadOracles(join(changeDir, 'oracles.md'));

  // Revalidate the type before sealing (invariant 5 / design §4): a refactor
  // carrying a spec delta or oracles, or a bugfix with no reproduction oracle,
  // is exit 3 here.
  assertTypeConformance(type, gatherTypeFacts(changeDir, oracles));

  // Precondition: the traceability lint must be green (invariant 5). The
  // archived-REQ index lets a bugfix/ratchet oracle legally bind an OLD
  // requirement id from the archived spec (design phase-2.md §1).
  const archivedReqIds = collectArchivedRequirementIds(root);
  const lint = await lintTraceability(requirements, oracles, deps.resolve, archivedReqIds);
  if (!lint.ok) {
    const detail = lint.findings.map((f) => `  ✗ ${f.message}`).join('\n');
    throw preconditionError(
      'LINT_RED',
      `Cannot approve ${change}: traceability lint failed —\n${detail}`,
      `Fix the bundle and re-run \`crucible propose ${change} --revise "<fix>"\`, then \`crucible approve ${change}\`.`,
    );
  }

  // Staleness gate (charter §Editing Artifacts / invariant 5): an UPSTREAM
  // hand-edit after a DOWNSTREAM generation may leave the downstream stale —
  // refuse until `--revise` regenerates or the human asserts consistency. No
  // ledger (P1-era / hand-authored) → nothing to check; the seal is the hard guard.
  const generationPath = join(changeDir, 'generation.yaml');
  const generation = readGenerationIfPresent(generationPath);
  let restampLedger = false;
  if (generation !== undefined) {
    const staleness = checkStaleness(changeDir, generation);
    if (staleness.stale) {
      if (options.confirmConsistency !== true) {
        const leaf = staleness.downstream[staleness.downstream.length - 1] ?? '(downstream)';
        throw preconditionError(
          'BUNDLE_STALE',
          `Cannot approve ${change}: ${staleness.editedPath} was edited after ${leaf} was generated — the downstream artifacts may be stale.`,
          `Regenerate coherently with \`crucible propose ${change} --revise "<fix>"\`, or re-run \`crucible approve ${change} --confirm-consistency\` if you have checked the edits are consistent.`,
        );
      }
      // The human asserts consistency: defer the re-stamp to the seal step so a
      // declined confirm writes nothing.
      restampLedger = true;
    }
  }

  // Tier recomputation (design §8): approve is an enforcement recomputation point
  // because the per-oracle ack obligation depends on the tier. Computed only when
  // the caller supplied enforcement config AND the diff-facts edge; the pure
  // `tier/` module runs after the injected git edge already assembled the facts
  // (an uncomputable diff has already thrown exit 3 there).
  let decision: TierDecision | undefined;
  if (options.config && deps.diffFacts) {
    const facts = deps.diffFacts();
    decision = computeTier(
      {
        specDelta: requirements.length > 0,
        touchedPaths: facts.touchedPaths,
        diffLines: facts.diffLines,
      },
      options.config,
    );
  }
  const critical = decision?.tier === 'critical';

  // `--yes` is non-critical only (design §8): the critical gate's whole point is
  // the deliberate per-oracle acknowledgment, which a batch flag would skip.
  if (yes && critical) {
    throw preconditionError(
      'CRITICAL_NEEDS_GATE',
      `Cannot approve ${change} with --yes: the critical tier requires the interactive per-oracle acknowledgment gate.`,
      `Re-run \`crucible approve ${change}\` without --yes and acknowledge each oracle.`,
    );
  }

  const style: SurfaceStyle = {
    width: options.width ?? PLAIN_STYLE.width,
    color: options.color ?? PLAIN_STYLE.color,
  };
  const relpaths = await computeHashScope(root, changeRel, changeDir, oracles, deps.resolve);
  const reviewedFiles = relpaths.map((relpath) => ({
    relpath,
    content: readFileSync(join(root, relpath), 'utf8'),
  }));
  const overview = renderOverview(
    { change, type, decision, proposal, requirements, oracles, relpaths, reviewedFiles },
    style,
  );

  // ── The seal, factored so both the --yes fast path and the interactive path
  // end here. `acks` is present only on a critical seal; the ledger re-stamps on
  // an asserted-consistency edit OR an in-gate regeneration (both stamping points).
  const acked = new Map<string, string>();
  let regenerated = false;
  const oraclesPath = join(changeDir, 'oracles.md');
  const statePath = join(changeDir, 'state.yaml');

  const doSeal = async (): Promise<ApproveResult> => {
    if (restampLedger || regenerated) {
      const restamped = stampGeneration(changeDir, change, dependencyOrder(changeDir), deps.now());
      writeFileSync(generationPath, serializeGeneration(restamped), 'utf8');
    }
    // A regeneration may have changed the bound-test set, so recompute the scope.
    const finalRelpaths = regenerated
      ? await computeHashScope(root, changeRel, changeDir, oracles, deps.resolve)
      : relpaths;
    const acks: Ack[] | undefined = critical
      ? [...acked.entries()].map(([oracle, at]) => ({ oracle, at }))
      : undefined;

    const approval = sealBundle(root, finalRelpaths, {
      version: APPROVAL_VERSION,
      change,
      approved_by: deps.approvedBy(),
      approved_at: deps.now(),
      ...(acks ? { acks } : {}),
    });
    writeFileSync(join(changeDir, 'approval.yaml'), serializeApproval(approval), 'utf8');

    // Audit event last (design §3 / invariant 1 — never read to gate).
    appendStateEvent(
      statePath,
      change,
      { at: deps.now(), cmd: 'approve', summary: `sealed ${finalRelpaths.length} file(s)` },
      'approved',
    );
    recordSnapshotType(statePath, type);
    // Best-effort tier snapshot for `status` display (invariant 1 — CI recomputes).
    if (decision) {
      try {
        recordSnapshotTier(statePath, decision);
      } catch {
        /* convenience-never-enforcement: a failed cache write is silent. */
      }
    }

    return {
      approved: true,
      render: overview,
      sealedFiles: finalRelpaths,
      ...(decision ? { tier: decision.tier } : {}),
    };
  };

  const declined = (): ApproveResult => ({
    approved: false,
    render: overview,
    ...(decision ? { tier: decision.tier } : {}),
  });

  // ── Fast path: --yes on a non-critical tier skips the walk + confirm (charter
  // §Tier Definitions, the ~1-minute trivial/standard sitting).
  if (yes) {
    return doSeal();
  }

  // ── Interactive path. Show the overview, then walk the oracles, then confirm.
  const pager = deps.pager ?? ((): void => {});
  const walkPrompt = requireEdge(deps.walk, 'walk');
  await pager(overview);

  // Per-oracle bound-test sources for the right pane, re-resolved after any regen.
  let sourcesByOracle = await resolveSources(root, oracles, deps.resolve);

  // Handle one oracle panel: display, prompt, and (on `edit`) run the edit loop,
  // re-displaying the possibly-updated panel until the human advances or quits.
  const handleOracle = async (id: string): Promise<'next' | 'quit'> => {
    for (;;) {
      const oracle = oracles.find((o) => o.id === id);
      if (oracle === undefined) return 'next'; // an edit removed it — skip.
      const context: WalkContext = { critical, acknowledged: acked.has(id) };
      await pager(renderPanel(oracle, sourcesByOracle.get(id) ?? [], context, style));
      const action = await walkPrompt(context);
      if (action === 'quit') return 'quit';
      if (action === 'next') return 'next';
      if (action === 'ack') {
        if (critical) acked.set(id, deps.now());
        return 'next';
      }
      // action === 'edit'
      const outcome = await runEditLoop(id);
      if (outcome === 'quit') return 'quit';
      // 'done' → loop to re-display the (updated) panel so a critical ack applies
      // to the sharpened scenario.
    }
  };

  // The edit loop (charter §Approve Session; design §8): $EDITOR → revalidate →
  // (on a material scenario change) regenerate the bound tests → confirm the diff.
  const runEditLoop = async (id: string): Promise<'done' | 'quit'> => {
    const openEditor = requireEdge(deps.openEditor, 'openEditor');
    const confirmDiff = requireEdge(deps.confirmDiff, 'confirmDiff');
    for (;;) {
      const oracle = oracles.find((o) => o.id === id);
      if (oracle === undefined) return 'done';
      const beforeSig = signatures(oracles);
      const beforeTests = flattenSources(sourcesByOracle);

      await openEditor(oraclesPath, oracle.line);

      // Re-run the full bundle validation (parsers + type conformance + lint),
      // non-throwing: a red bundle is never sealable (invariant 3), but in the
      // edit loop we surface findings and let the human re-edit rather than crash.
      const reval = await revalidate();
      if (!reval.ok) {
        await pager(renderFindings(reval.findings, style));
        const retry = await walkPrompt({ critical, acknowledged: false });
        if (retry === 'quit') return 'quit';
        continue; // any other action → re-open the editor.
      }

      const changed = changedOracleIds(beforeSig, reval.oracles);
      if (changed.length === 0) {
        // No material scenario change (whitespace only): accept, refresh, done.
        oracles = reval.oracles;
        sourcesByOracle = await resolveSources(root, oracles, deps.resolve);
        return 'done';
      }

      // A scenario changed after its test was authored → regenerate its bound
      // tests through the propose role, then re-judge (the agent is judged, not
      // trusted — invariant 2). A red regeneration re-seals nothing.
      const report = await regenerate(changed);
      if (report.verdict !== 'pass') {
        await pager(renderReport(report, 'approve'));
        const retry = await walkPrompt({ critical, acknowledged: false });
        if (retry === 'quit') return 'quit';
        continue;
      }

      oracles = loadOracles(oraclesPath);
      sourcesByOracle = await resolveSources(root, oracles, deps.resolve);
      const afterTests = flattenSources(sourcesByOracle);
      await pager(renderTestDiff(buildTestDiff(beforeTests, afterTests), style));

      const decisionOnDiff = await confirmDiff();
      if (decisionOnDiff === 'quit') return 'quit';
      if (decisionOnDiff === 'edit') continue; // re-open the editor.
      // 'accept'
      regenerated = true;
      for (const cid of changed) acked.delete(cid); // an edit voids that oracle's ack.
      return 'done';
    }
  };

  // Re-validate the bundle after an edit without throwing (judge semantics).
  const revalidate = async (): Promise<{
    ok: boolean;
    findings: VerifyFinding[];
    oracles: Oracle[];
  }> => {
    const report = await judgeBundle(
      change,
      changeDir,
      changeRel,
      deps.resolve,
      archivedReqIds,
      type,
    );
    if (report.verdict !== 'pass') {
      return { ok: false, findings: report.checks.flatMap((c) => c.findings), oracles: [] };
    }
    const reOracles = loadOracles(oraclesPath);
    try {
      assertTypeConformance(type, gatherTypeFacts(changeDir, reOracles));
    } catch (err) {
      if (isCrucibleError(err)) {
        return {
          ok: false,
          findings: [{ check: 'bundle', id: 'type', message: err.message }],
          oracles: [],
        };
      }
      throw err;
    }
    return { ok: true, findings: [], oracles: reOracles };
  };

  // Run the propose-role regeneration for the changed oracles' bound tests.
  const regenerate = async (changedIds: string[]): ReturnType<typeof judgeBundle> => {
    const substrate = requireEdge(deps.substrate, 'substrate');
    const rolePromptPath = join(root, '.crucible', 'context', 'propose.md');
    if (!existsSync(rolePromptPath)) {
      throw preconditionError(
        'MISSING_ROLE_PROMPT',
        `The propose role prompt is missing at ${join('.crucible', 'context', 'propose.md')}.`,
        'Restore .crucible/context/propose.md (installed by `crucible init` from P2).',
      );
    }
    const transcriptPath = join(
      root,
      '.crucible',
      'transcripts',
      change,
      `approve-regen-${deps.now().replace(/[:.]/g, '-')}.jsonl`,
    );
    await substrate.run({
      role: 'propose',
      rolePromptPath,
      taskPayload: buildRegenPayload(change, changeRel, changedIds),
      cwd: root,
      model: options.model ?? DEFAULT_REGEN_MODEL,
      transcriptPath,
    });
    // SubstrateResult carries nothing to trust (invariant 2) — judge the files.
    return judgeBundle(change, changeDir, changeRel, deps.resolve, archivedReqIds, type);
  };

  // Stage 2 — the initial walk over every oracle.
  for (const oracle of oracles) {
    const outcome = await handleOracle(oracle.id);
    if (outcome === 'quit') return declined();
  }

  // Stage 3 — the critical ack gate: while any oracle is unacked, refuse the seal
  // confirm and re-enter the walk at the first unacked oracle (design §8).
  if (critical) {
    for (;;) {
      const unacked = oracles.filter((o) => !acked.has(o.id));
      if (unacked.length === 0) break;
      await pager(renderUnacked(unacked, style));
      for (const oracle of unacked) {
        const outcome = await handleOracle(oracle.id);
        if (outcome === 'quit') return declined();
      }
    }
  }

  // Stage 3 — the seal confirm. Declining writes nothing.
  const confirmed = await deps.confirm();
  if (!confirmed) return declined();

  return doSeal();
}

/** Fail-closed guard for an interactive edge a direct core call forgot to wire. */
function requireEdge<T>(edge: T | undefined, name: string): T {
  if (edge === undefined) {
    throw preconditionError(
      'APPROVE_EDGE_MISSING',
      `The interactive approve gate needs the \`${name}\` edge, which was not supplied.`,
      'This edge is wired by approve.cli; a direct core call must inject it (or pass --yes on a non-critical tier).',
    );
  }
  return edge;
}

/** Resolve each oracle's bound targets to source files for the right pane. */
async function resolveSources(
  root: string,
  oracles: readonly Oracle[],
  resolve: ResolveFn,
): Promise<Map<string, OracleSource[]>> {
  const targets = dedupeTargets(oracles);
  const byTarget = new Map<string, string>();
  if (targets.length > 0) {
    for (const r of await resolve(targets)) {
      if (r.status === 'found' && r.targetFile) byTarget.set(r.target, r.targetFile);
    }
  }
  const map = new Map<string, OracleSource[]>();
  for (const oracle of oracles) {
    const sources: OracleSource[] = [];
    const seen = new Set<string>();
    for (const target of oracle.binding.targets) {
      const rel = byTarget.get(target);
      if (rel !== undefined && !seen.has(rel)) {
        seen.add(rel);
        sources.push({ relpath: rel, content: readFileSafe(join(root, rel)) });
      }
    }
    map.set(oracle.id, sources);
  }
  return map;
}

/** Read a bound-test file for display; a read failure becomes a visible marker. */
function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '(bound test file could not be read)';
  }
}

/** A per-oracle change signature: prose + serialized binding (design §8). */
function signatures(oracles: readonly Oracle[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const oracle of oracles) {
    map.set(oracle.id, `${oracle.prose} ${JSON.stringify(oracle.binding)}`);
  }
  return map;
}

/** Oracle ids whose scenario/binding changed, or that are newly present, after an edit. */
function changedOracleIds(before: Map<string, string>, after: readonly Oracle[]): string[] {
  const now = signatures(after);
  const changed: string[] = [];
  for (const [id, sig] of now) {
    if (before.get(id) !== sig) changed.push(id);
  }
  return changed;
}

/** Flatten the per-oracle sources into one relpath→content map (deduped). */
function flattenSources(byOracle: Map<string, OracleSource[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const sources of byOracle.values()) {
    for (const source of sources) out.set(source.relpath, source.content);
  }
  return out;
}

/** The changed bound-test files (before vs after a regeneration) for the diff. */
function buildTestDiff(before: Map<string, string>, after: Map<string, string>): TestDiffFile[] {
  const files: TestDiffFile[] = [];
  for (const [relpath, afterContent] of after) {
    const beforeContent = before.get(relpath) ?? '';
    if (beforeContent !== afterContent) {
      files.push({ relpath, before: beforeContent, after: afterContent });
    }
  }
  return files.sort((a, b) => a.relpath.localeCompare(b.relpath));
}

/** The "still need acknowledgment" notice shown before re-entering the walk. */
function renderUnacked(unacked: readonly Oracle[], style: SurfaceStyle): string {
  const ids = unacked.map((o) => o.id).join(', ');
  const header = `Critical tier: ${unacked.length} oracle(s) still need acknowledgment before sealing.`;
  return style.color ? `[1m${header}[0m\n  ${ids}` : `${header}\n  ${ids}`;
}

/** The regeneration work order: regenerate ONLY the edited oracles' bound tests. */
function buildRegenPayload(change: string, changeRel: string, changedIds: string[]): string {
  return [
    `Change: ${change}`,
    `Bundle directory: ${changeRel}/`,
    'The human edited these oracle scenarios during the approve review:',
    ...changedIds.map((id) => `  - ${id}`),
    'Regenerate ONLY those oracles’ bound test files so each test matches its edited',
    'scenario. Do not touch other artifacts or other oracles’ tests — a stale bound',
    'test is a bug.',
  ].join('\n');
}
