// Shared bundle helpers — the judgment + hash-scope logic that propose (P1-09),
// approve (P1-07) and amend (P2-05) all lean on (charter §The Workflow; design
// phase-0-1.md §6, phase-2.md §3).
//
// This module exists so the TCB-critical operations — judging an authored
// bundle, and computing the exact seal scope — live in ONE place rather than
// being copy-pasted across three commands (any drift between them would be a
// hashing / judgment bug, the worst kind). Nothing here is non-deterministic:
// the binding resolver is injected by the caller (invariant 12); no wall-clock,
// no adapter spawned directly.
//
//   - `judgeBundle`  — propose/amend semantics: the artifacts are the AGENT'S
//     PRODUCT under judgment, so a malformed one is a red `bundle` finding (exit
//     1 at the CLI), never a fail-closed exit 3 (that is approve/verify's stance
//     on its OWN input).
//   - `computeHashScope` + `loadAllRequirements` — approve/amend semantics: the
//     bundle is trusted input being sealed, so a defect here IS fail-closed.
//   - `dependencyOrder` — the upstream→downstream artifact order the generation
//     manifest (staleness tracking) is stamped in (charter §Editing Artifacts).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadProposal } from '../artifacts/proposal.js';
import { loadSpecDelta, type SpecRequirement } from '../artifacts/spec-delta.js';
import { ADAPTER_LOCK_RELPATH } from '../adapters/lockfile.js';
import { FRAMEWORK_PIN_RELPATH } from '../framework/pin.js';
import { lintTraceability, type ResolveFn } from '../lint/traceability.js';
import {
  assertTypeConformance,
  readChangeType,
  schemaForType,
  type ChangeType,
  type TypeFacts,
} from '../changetype/changetype.js';
import { loadSchemaBundle } from '../changetype/schema-bundle.js';
import {
  aggregate,
  traceabilityCheck,
  type CheckResult,
  type VerifyFinding,
  type VerifyReport,
} from '../verifyx/report.js';
import { isCrucibleError, preconditionError } from '../util/errors.js';

/** The core artifacts that always live directly in a change bundle dir. */
export const CORE_ARTIFACTS = ['proposal.md', 'design.md', 'oracles.md'] as const;

/** Deterministic result of judging an active-session proposal (P4R-03). */
export interface ProposalValidationResult {
  report: VerifyReport;
  phase: 'ready-for-approval' | 'revise';
  /** Exact schema-declared intent files plus grounded bound test files. */
  approvalCandidates: string[];
  /** Agent-facing next action. Never an authorization to choose a test path. */
  reviseInstruction: string;
}

/** Active-session proposal validator: the CLI judges files, it never authors them. */
export async function validateProposalBundle(
  options: { root: string; change: string; allowPostApprovalArtifacts?: boolean },
  deps: { resolve: ResolveFn },
): Promise<ProposalValidationResult> {
  const changeRel = join('openspec', 'changes', options.change);
  const changeDir = join(options.root, changeRel);
  if (!existsSync(changeDir) || !existsSync(join(changeDir, '.openspec.yaml'))) {
    throw preconditionError(
      'NO_PROPOSAL_BUNDLE',
      `No OpenSpec proposal bundle found at ${changeRel}.`,
      `Create it with the packaged OpenSpec workflow, author its artifacts in this active session, then re-run \`crucible propose ${options.change}\`.`,
    );
  }

  // The schema pin is the type contract. Reading it here also rejects unknown/
  // malformed pins before a bundle could be called ready.
  const type = readChangeTypeForValidation(changeDir);
  const bundle = loadSchemaBundle(
    join(options.root, 'openspec', 'schemas', schemaForType(type), 'schema.yaml'),
  );
  const report = await judgeBundle(
    options.change,
    changeDir,
    changeRel,
    deps.resolve,
    new Set(),
    type,
  );
  const findings: VerifyFinding[] = [];
  const preApproval = schemaPreApprovalPaths(changeDir, bundle);
  for (const path of preApproval) {
    if (!existsSync(join(changeDir, path)) || statSync(join(changeDir, path)).size === 0) {
      findings.push({
        check: 'bundle',
        id: path,
        message: `${join(changeRel, path)} is required by the pinned schema before approval but is missing or empty`,
      });
    }
  }

  const postApprovalPath = bundle.apply?.tracks;
  if (
    postApprovalPath &&
    existsSync(join(changeDir, postApprovalPath)) &&
    options.allowPostApprovalArtifacts !== true
  ) {
    findings.push({
      check: 'bundle',
      id: postApprovalPath,
      message: `${join(changeRel, postApprovalPath)} is post-approval work breakdown and must not exist before approval`,
    });
  }

  const oracles = tryLoadOracles(changeDir);
  if (report.checks.find((check) => check.name === 'bundle')?.status === 'pass' && oracles) {
    assertTypeConformance(type, gatherTypeFacts(changeDir, oracles));
  }
  const candidates = new Set(preApproval.map((path) => join(changeRel, path)));
  if (oracles !== undefined) {
    const resolutions = await deps.resolve(dedupeTargets(oracles));
    const byTarget = new Map(
      resolutions.map((resolution) => [resolution.target, resolution] as const),
    );
    for (const target of dedupeTargets(oracles)) {
      const resolution = byTarget.get(target);
      const targetFile = resolution?.targetFile;
      if (
        resolution?.status !== 'found' ||
        !targetFile ||
        !isContainedFile(options.root, targetFile)
      ) {
        findings.push({
          check: 'bundle',
          id: target,
          message: `bound target ${target} must resolve as found to a contained test file; revise the oracle binding or test`,
        });
      } else {
        candidates.add(targetFile);
      }
    }
  }

  // Keep schema completeness inside the established `bundle` check: reports are
  // a frozen machine contract, and a custom artifact is part of the bundle, not
  // a new kind of verifier.
  const finalReport = aggregate(
    options.change,
    report.checks.map((check) =>
      check.name === 'bundle' && findings.length > 0
        ? { ...check, status: 'fail' as const, findings: [...check.findings, ...findings] }
        : check,
    ),
  );
  const phase = finalReport.verdict === 'pass' ? 'ready-for-approval' : 'revise';
  return {
    report: finalReport,
    phase,
    approvalCandidates: [...candidates].sort(),
    reviseInstruction:
      phase === 'ready-for-approval'
        ? `Proposal is ready for human approval: run \`crucible approve ${options.change}\` outside the agent session.`
        : `Revise ${firstFailure(finalReport)} in this active session, then re-run \`crucible propose ${options.change}\`.`,
  };
}

function firstFailure(report: VerifyReport): string {
  for (const check of report.checks) {
    const finding = check.findings[0];
    if (finding) return `${finding.id}: ${finding.message}`;
  }
  return 'the reported proposal failure';
}

function readChangeTypeForValidation(changeDir: string): ChangeType {
  // Lazy import avoidance is not required; this small wrapper makes the pin
  // validation explicit at the P4R proposal boundary.
  return readChangeType(changeDir);
}

function tryLoadOracles(changeDir: string): Oracle[] | undefined {
  try {
    return loadOracles(join(changeDir, 'oracles.md'));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the schema-declared review artifacts for a change.  This is the sole
 * source of truth for approval membership: a schema extension is trusted only
 * when it is present here, never because a command recognizes its filename.
 */
export function schemaPreApprovalPaths(
  changeDir: string,
  bundle: ReturnType<typeof loadSchemaBundle>,
): string[] {
  const postApproval = bundle.apply?.tracks;
  return bundle.artifacts
    .filter((artifact) => artifact.generates !== postApproval)
    .flatMap((artifact) => expandGeneratedPath(changeDir, artifact.generates));
}

function expandGeneratedPath(changeDir: string, pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const pivot = pattern.indexOf('**');
  if (pivot < 0) return [];
  const base = pattern.slice(0, pivot).replace(/\/$/, '');
  const suffix = pattern
    .slice(pivot + 2)
    .replace(/^\//, '')
    .replace('*', '');
  const matches = markdownFilesUnder(join(changeDir, base))
    .filter((file) => suffix.length === 0 || file.endsWith(suffix))
    .map((file) => relative(changeDir, file));
  // A declared generated glob is still a required artifact. Preserve the
  // pattern as a failing candidate when it matches nothing rather than silently
  // treating an empty custom artifact directory as complete.
  return matches.length > 0 ? matches : [pattern];
}

function isContainedFile(root: string, path: string): boolean {
  if (isAbsolute(path)) return false;
  const absolute = join(root, path);
  const rel = relative(root, absolute);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !isAbsolute(rel) &&
    existsSync(absolute) &&
    statSync(absolute).isFile()
  );
}

/**
 * Judge an authored bundle (propose/amend): the `bundle` check parses every
 * required artifact, folding each parser's `CrucibleError` into a red finding
 * (the agent is judged on its output, never trusted about it — invariant 2); the
 * `traceability` check runs only on a green bundle — linting unparseable
 * artifacts is meaningless. Returns an aggregated report; a red verdict is the
 * agent failing, not the tool (the CLI maps it to exit 1).
 *
 * `archivedRequirementIds` (default empty) is the archived-REQ index the lint
 * consults so a bugfix/ratchet oracle may bind an OLD requirement id living only
 * in the archived spec (design phase-2.md §1); propose/amend pass the real index.
 */
export async function judgeBundle(
  change: string,
  changeDir: string,
  changeRel: string,
  resolve: ResolveFn,
  archivedRequirementIds: ReadonlySet<string> = new Set(),
  type: ChangeType = 'feature',
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

  // Spec deltas: at least one specs/** markdown, each parsing clean. Only a
  // FEATURE requires one — a refactor promises nothing new and a bugfix pins an
  // archived promise (charter §Change Types), so for those an absent spec delta
  // is EXPECTED, not a red finding (type conformance handles the inverse: a
  // refactor that *carries* a spec delta is caught by assertTypeConformance).
  const specFiles = markdownFilesUnder(join(changeDir, 'specs')).sort();
  let requirements: SpecRequirement[] | undefined = [];
  if (specFiles.length === 0) {
    if (requiresSpecDelta(type)) {
      findings.push({
        check: 'bundle',
        id: 'specs/',
        message: `${join(changeRel, 'specs')}: no spec delta authored — a ${type} change with no spec delta promises nothing`,
      });
      requirements = undefined;
    }
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
    const lint = await lintTraceability(requirements, oracles, resolve, archivedRequirementIds);
    checks.push(traceabilityCheck(lint));
  }

  return aggregate(change, checks);
}

/** Does a change of this type require a spec delta? Only feature (charter §Change
 * Types): a refactor permits none and a bugfix pins an archived promise. */
export function requiresSpecDelta(type: ChangeType): boolean {
  return type === 'feature';
}

/**
 * Parse every spec-delta markdown under the change's `specs/**` into one ordered
 * requirement list, honoring the change type. A FEATURE with no spec delta is a
 * precondition failure (exit 2) — it promises nothing to gate; a bugfix/refactor
 * with none returns `[]` (expected — charter §Change Types). Order is
 * deterministic: files sorted by relative path, requirements in source order.
 */
export function loadRequirementsForType(
  changeDir: string,
  changeRel: string,
  type: ChangeType,
): SpecRequirement[] {
  const specsDir = join(changeDir, 'specs');
  const specFiles = existsSync(specsDir) ? markdownFilesUnder(specsDir).sort() : [];
  if (specFiles.length === 0) {
    if (requiresSpecDelta(type)) {
      throw preconditionError(
        'NO_SPEC_DELTA',
        `No spec delta found under ${join(changeRel, 'specs')}.`,
        'Run `crucible propose` to scaffold the change bundle with a spec delta.',
      );
    }
    return [];
  }
  return specFiles.flatMap((file) => loadSpecDelta(file));
}

/** Back-compat feature-typed loader (unchanged behavior: exit 2 if no spec delta). */
export function loadAllRequirements(changeDir: string, changeRel: string): SpecRequirement[] {
  return loadRequirementsForType(changeDir, changeRel, 'feature');
}

/**
 * Assemble the type-conformance facts from the bundle on disk (design phase-2.md
 * §4): is a spec delta present (any specs/** markdown), how many oracles, and how
 * many are reproduction oracles. A deterministic filesystem read; `oracles` is the
 * already-parsed list so this never re-parses (and never double-reports a parse
 * error the caller already handled).
 */
export function gatherTypeFacts(changeDir: string, oracles: readonly Oracle[]): TypeFacts {
  return {
    specDelta: markdownFilesUnder(join(changeDir, 'specs')).length > 0,
    oracleCount: oracles.length,
    reproductionOracleCount: oracles.filter((o) => o.binding.reproduces === true).length,
  };
}

/**
 * The sealed relpaths (design §4), relative to `root`, deterministically sorted:
 *   proposal.md, design.md, oracles.md, every specs/** markdown, every bound
 *   test file. Bound test files come from the resolver's `targetFile` — the core
 *   never parses the opaque `target` syntax (charter §Bindings). A `found`
 *   target that reports no `targetFile` is a fail-closed precondition (exit 2):
 *   we cannot seal a check whose file we cannot locate.
 */
export async function computeHashScope(
  root: string,
  changeRel: string,
  changeDir: string,
  oracles: readonly Oracle[],
  resolve: ResolveFn,
): Promise<string[]> {
  const covered = new Set<string>();

  const type = readChangeType(changeDir);
  const schemaPath = join(root, 'openspec', 'schemas', schemaForType(type), 'schema.yaml');
  if (existsSync(schemaPath)) {
    const schema = loadSchemaBundle(schemaPath);
    for (const artifact of schemaPreApprovalPaths(changeDir, schema)) {
      covered.add(join(changeRel, artifact));
    }
  } else {
    // Compatibility for the retired P1/P2 direct command cores.  P4R terminal
    // approval independently requires the resolved schema before it calls this
    // helper, so this fallback can never mint a new P4R seal.
    for (const artifact of CORE_ARTIFACTS) covered.add(join(changeRel, artifact));
  }
  for (const abs of markdownFilesUnder(join(changeDir, 'specs'))) {
    covered.add(relative(root, abs));
  }

  const targets = dedupeTargets(oracles);
  if (targets.length > 0) {
    const resolutions = await resolve(targets);
    const byTarget = new Map(resolutions.map((r) => [r.target, r] as const));
    for (const target of targets) {
      const resolution = byTarget.get(target);
      if (resolution === undefined || resolution.status !== 'found' || !resolution.targetFile) {
        throw preconditionError(
          'UNRESOLVED_TARGET_FILE',
          `Cannot seal: bound target ${target} did not resolve to a file to seal.`,
          'Re-run `crucible propose --revise` so every oracle binds an addressable test.',
        );
      }
      covered.add(resolution.targetFile);
    }
  }

  if (existsSync(join(root, ADAPTER_LOCK_RELPATH))) covered.add(ADAPTER_LOCK_RELPATH);
  if (existsSync(join(root, FRAMEWORK_PIN_RELPATH))) covered.add(FRAMEWORK_PIN_RELPATH);

  return [...covered].sort();
}

/**
 * The bundle's artifacts in dependency order, upstream → downstream (charter
 * §Editing Artifacts): proposal → design → specs/** (sorted) → oracles. Paths
 * are relative to the change dir. Only existing files are included. This is the
 * order the generation manifest is stamped in and the order staleness reads:
 * a hand-edit to any but the LAST artifact desyncs everything downstream of it.
 */
export function dependencyOrder(changeDir: string): string[] {
  const order: string[] = [];
  if (existsSync(join(changeDir, 'proposal.md'))) order.push('proposal.md');
  if (existsSync(join(changeDir, 'design.md'))) order.push('design.md');
  for (const abs of markdownFilesUnder(join(changeDir, 'specs')).sort()) {
    order.push(relative(changeDir, abs));
  }
  if (existsSync(join(changeDir, 'oracles.md'))) order.push('oracles.md');
  return order;
}

/** Distinct oracle targets in first-appearance order (matches lint dedupe). */
export function dedupeTargets(oracles: readonly Oracle[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const oracle of oracles) {
    for (const target of oracle.binding.targets) {
      if (!seen.has(target)) {
        seen.add(target);
        ordered.push(target);
      }
    }
  }
  return ordered;
}

/** All `.md` files under `dir` (recursive), absolute paths. Empty if absent. */
export function markdownFilesUnder(dir: string): string[] {
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
