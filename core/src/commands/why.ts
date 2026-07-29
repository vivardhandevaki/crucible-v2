// `crucible why <id>` — the trace tool (charter §"Why did this happen?"; design
// phase-2.md §8 L108). It answers ONE question: given a verify verdict, WHY is a
// particular subject red (or green), and WHERE in the tree does its truth live?
//
// It walks the exact chain the design names — report → oracle → binding → adapter
// result → raw tool output path — and, for a reviewer finding, prints the rubric
// line it cites plus the evidence + remediation. Every step names a source with a
// FILE PATH so the operator can open the thing at fault, not guess.
//
// Mechanism (invariant 12 — deterministic core): `why` re-runs the real `verify`
// core through capturing wrappers on the injected `resolve`/`run` edges, so one
// pass yields BOTH the authoritative report (what is red, and the exact subject
// ids) AND the adapter intermediates (each target's resolved file + raw run
// result) that the flattened report drops. It then re-parses the bundle for
// source line numbers and walks the requested id back to its origin. It spawns
// nothing itself — the CLI wires the live adapter edges, exactly as verify does.
//
// Fail-closed (invariant 3): an id that names no addressable subject is exit 2
// with the list of ids that DO exist — never a silent empty trace. A malformed
// artifact or missing bundle bubbles from the verify pass (exit 2/3) unchanged.

import { createHash, type BinaryLike } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadSpecDelta } from '../artifacts/spec-delta.js';
import { markdownFilesUnder } from './bundle.js';
import { loadApproval, type Approval } from '../artifacts/approval.js';
import { readRubric, type Rubric } from '../review/rubric.js';
import type { TargetResolution } from '../lint/traceability.js';
import type { OracleResult } from '../adapters/types.js';
import {
  CHECK_NAMES,
  type CheckName,
  type VerifyFinding,
  type VerifyReport,
} from '../verifyx/report.js';
import { verify, type VerifyDeps, type VerifyOptions } from './verify.js';
import { preconditionError } from '../util/errors.js';

/** The injected edges `why` needs — identical to verify's (it re-runs the core). */
export type WhyDeps = VerifyDeps;

/** why invocation options: a verify invocation plus the id to trace. */
export interface WhyOptions extends VerifyOptions {
  /** The subject to trace: a check name, an ORC/REQ id, a rubric line id, or a
   * sealed relpath. Matched against the addressable universe; unknown → exit 2. */
  id: string;
}

/** One link in the trace. `source` is a repo-relative `path` or `path:line`. */
export interface WhyStep {
  /** A short tag naming the link kind: `check`, `oracle`, `binding`, `adapter`, … */
  label: string;
  /** The human line for this link. */
  text: string;
  /** Where this link's truth lives — a file path (with a line when known). */
  source?: string;
}

/** What kind of subject the id resolved to (drives the render + the chain shape). */
export type WhyKind = 'check' | 'oracle' | 'requirement' | 'rubric' | 'seal';

/** The full trace for one id: the ordered chain back to source. */
export interface WhyTrace {
  change: string;
  /** The id as queried, echoed back. */
  query: string;
  kind: WhyKind;
  /** Is this subject red in the current verdict? */
  status: 'pass' | 'fail';
  /** The chain, top (the check) → bottom (the source). */
  steps: WhyStep[];
}

/** The gathered material a trace is walked over — one verify pass + the bundle. */
interface TraceContext {
  root: string;
  changeRel: string;
  oraclesRel: string;
  rubricRel: string;
  report: VerifyReport;
  /** Bundle oracles by id (source lines + bindings). */
  oraclesById: Map<string, Oracle>;
  /** REQ id → its source file (repo-relative) + heading line. */
  reqSource: Map<string, { rel: string; line: number }>;
  /** Captured dry-run resolutions by target (the file each check lives in). */
  resolveByTarget: Map<string, TargetResolution>;
  /** Captured oracle run results by oracle id (statuses + raw output locations). */
  runByOracle: Map<string, OracleResult>;
  /** The seal, when the bundle is approved (for the hash-void trace). */
  approval?: Approval;
  /** The reviewer's law, when installed (for the rubric-line trace). */
  rubric?: Rubric;
  /** Rubric line id → its 1-based source line in rubric.yaml. */
  rubricLineNo: Map<string, number>;
  /** Whether the report carries a review check (a review actually ran). */
  reviewRan: boolean;
}

/** A subject's chain BELOW the check header (built by the per-kind tracers). */
interface SubTrace {
  status: 'pass' | 'fail';
  steps: WhyStep[];
}

/**
 * Trace why `options.id` is red/green in the current verify verdict. Runs the
 * real verify core (capturing the adapter intermediates), then walks the id back
 * to its source. Throws exit 2 for an unknown id (with the available ids) or
 * bubbles verify's exit 2/3 for a missing/malformed bundle.
 */
export async function why(options: WhyOptions, deps: WhyDeps): Promise<WhyTrace> {
  const { root, change, id } = options;
  const changeRel = join('openspec', 'changes', change);
  const changeDir = join(root, changeRel);

  // Capture the adapter intermediates the report flattens away: the resolved file
  // for each target (lint's dry-run) and the raw run result for each oracle.
  const resolveByTarget = new Map<string, TargetResolution>();
  const runByOracle = new Map<string, OracleResult>();
  const capturing: WhyDeps = {
    ...deps,
    resolve: async (targets) => {
      const results = await deps.resolve(targets);
      for (const r of results) if (!resolveByTarget.has(r.target)) resolveByTarget.set(r.target, r);
      return results;
    },
    run: async (oracles) => {
      const results = await deps.run(oracles);
      for (const r of results) if (!runByOracle.has(r.oracleId)) runByOracle.set(r.oracleId, r);
      return results;
    },
  };

  // The authoritative report. A missing bundle / malformed artifact throws here
  // (exit 2/3) exactly as `verify` would — `why` never masks a broken bundle.
  const report = await verify(
    { root, change, ...(options.config ? { config: options.config } : {}) },
    capturing,
  );

  // Re-parse the bundle for source line numbers. verify already validated these
  // (it would have thrown above otherwise), so the reads are safe.
  const oracles = loadOracles(join(changeDir, 'oracles.md'));
  const reqSource = collectRequirementSources(root, changeDir);
  const rubricRel = join('.crucible', 'rubric.yaml');
  const rubricPath = join(root, rubricRel);
  const rubric = existsSync(rubricPath) ? readRubric(rubricPath) : undefined;

  const approvalPath = join(changeDir, 'approval.yaml');
  const approval = existsSync(approvalPath) ? loadApproval(approvalPath) : undefined;

  const ctx: TraceContext = {
    root,
    changeRel,
    oraclesRel: join(changeRel, 'oracles.md'),
    rubricRel,
    report,
    oraclesById: new Map(oracles.map((o) => [o.id, o] as const)),
    reqSource,
    resolveByTarget,
    runByOracle,
    ...(approval ? { approval } : {}),
    ...(rubric ? { rubric } : {}),
    rubricLineNo: rubric ? rubricLineNumbers(rubricPath) : new Map(),
    reviewRan: report.review !== undefined || report.checks.some((c) => c.name === 'review'),
  };

  // A whole check → its status + a sub-trace per finding (the design's
  // "check → oracle → …" fan-out addressed by check name).
  if ((CHECK_NAMES as readonly string[]).includes(id)) {
    return traceWholeCheck(ctx, id as CheckName);
  }

  const resolved = resolveSubject(ctx, id);
  if (resolved === undefined) {
    throw unknownId(ctx, change, id);
  }

  const { kind, owningCheck, sub } = resolved;
  const actualCheck = findingCheck(report, id) ?? owningCheck;
  const header: WhyStep = {
    label: 'check',
    text: `${actualCheck} check — this subject is ${
      sub.status === 'fail' ? 'RED (a reason the verdict is fail)' : 'not a red source'
    }`,
  };
  return { change, query: id, kind, status: sub.status, steps: [header, ...sub.steps] };
}

/** Resolve an id to its subject kind + owning check + sub-trace. Namespaced —
 * ORC-/REQ-/R- ids and sealed relpaths do not collide, so first match wins. */
function resolveSubject(
  ctx: TraceContext,
  id: string,
): { kind: WhyKind; owningCheck: CheckName; sub: SubTrace } | undefined {
  const oracle = ctx.oraclesById.get(id);
  if (oracle) return { kind: 'oracle', owningCheck: 'oracles', sub: traceOracle(ctx, oracle) };

  if (ctx.reqSource.has(id) || isReportRequirement(ctx.report, id)) {
    return { kind: 'requirement', owningCheck: 'traceability', sub: traceRequirement(ctx, id) };
  }

  if (ctx.rubric?.lines.some((l) => l.id === id)) {
    return { kind: 'rubric', owningCheck: 'review', sub: traceRubric(ctx, id) };
  }

  if (ctx.approval && Object.prototype.hasOwnProperty.call(ctx.approval.files, id)) {
    return { kind: 'seal', owningCheck: 'approval', sub: traceSeal(ctx, id) };
  }

  return undefined;
}

/** report → oracle → binding → adapter result → raw tool output path. */
function traceOracle(ctx: TraceContext, oracle: Oracle): SubTrace {
  const flagged = findingCheck(ctx.report, oracle.id) !== undefined;
  const steps: WhyStep[] = [];

  steps.push({
    label: 'oracle',
    text: `${oracle.id}: ${oracle.title}`,
    source: `${ctx.oraclesRel}:${oracle.line}`,
  });

  const req = oracle.binding.requirement;
  const reqSrc = ctx.reqSource.get(req);
  steps.push({
    label: 'requirement',
    text: `judges ${req}${reqSrc ? '' : ' (from the archived spec — no delta this change)'}`,
    ...(reqSrc ? { source: `${reqSrc.rel}:${reqSrc.line}` } : {}),
  });

  steps.push({
    label: 'binding',
    text: `runner ${oracle.binding.runner}; ${oracle.binding.targets.length} target(s)`,
    source: `${ctx.oraclesRel}:${oracle.line}`,
  });

  const result = ctx.runByOracle.get(oracle.id);
  for (const target of oracle.binding.targets) {
    const resolution = ctx.resolveByTarget.get(target);
    const targetResult = result?.targets.find((t) => t.target === target);
    let text = `target ${target}`;
    if (resolution?.status === 'found' && resolution.targetFile) {
      text += ` → resolves to ${resolution.targetFile}`;
    } else {
      text += ` → UNRESOLVED (the adapter could not collect it)`;
    }
    if (targetResult) {
      text += `; adapter ran → ${targetResult.status}`;
      if (targetResult.message) text += ` (${targetResult.message})`;
    } else if (!result) {
      text += `; not run (the oracle run is gated on a green traceability lint)`;
    }
    // The raw tool output path (RunResult.location) is the deepest link; fall
    // back to the resolved test file when the runner reports no finer location.
    const source = targetResult?.location ?? resolution?.targetFile;
    steps.push({ label: 'adapter', text, ...(source ? { source } : {}) });
  }

  if (result) {
    if (result.status === 'fail') {
      const skips = result.targets.filter((t) => t.status === 'skip').map((t) => t.target);
      const note =
        skips.length > 0
          ? `a skipped oracle target is a fail-closed event (invariant 4): ${skips.join(', ')}=skip`
          : `a bound target did not pass`;
      steps.push({ label: 'result', text: `oracle FAILED — ${note}` });
    } else {
      steps.push({ label: 'result', text: `oracle passed — every bound target ran green` });
    }
  } else {
    steps.push({
      label: 'result',
      text: `oracle not executed (${flagged ? 'see the check above' : 'the lint gate short-circuited the run'})`,
    });
  }

  return { status: flagged ? 'fail' : 'pass', steps };
}

/** report → requirement → the oracle(s) that cover it (or the coverage gap). */
function traceRequirement(ctx: TraceContext, reqId: string): SubTrace {
  const flagged = findingCheck(ctx.report, reqId) !== undefined;
  const steps: WhyStep[] = [];
  const src = ctx.reqSource.get(reqId);

  steps.push({
    label: 'requirement',
    text: reqId,
    ...(src ? { source: `${src.rel}:${src.line}` } : {}),
  });

  const covering = [...ctx.oraclesById.values()].filter((o) => o.binding.requirement === reqId);
  if (covering.length === 0) {
    steps.push({
      label: 'result',
      text: `no oracle covers ${reqId} — a requirement without an oracle is a wish, not a spec`,
    });
  } else {
    for (const oracle of covering) {
      steps.push({
        label: 'oracle',
        text: `covered by ${oracle.id}: ${oracle.title}`,
        source: `${ctx.oraclesRel}:${oracle.line}`,
      });
    }
  }

  return { status: flagged ? 'fail' : 'pass', steps };
}

/** report → sealed file → the recorded hash → the current hash (void or intact). */
function traceSeal(ctx: TraceContext, relId: string): SubTrace {
  const approval = ctx.approval!;
  const sealed = approval.files[relId]!;
  const current = safeHash(join(ctx.root, relId));
  const differs = current !== sealed;

  const steps: WhyStep[] = [
    {
      label: 'seal',
      text: `sealed by ${approval.approved_by} at ${approval.approved_at}`,
      source: join(ctx.changeRel, 'approval.yaml'),
    },
    { label: 'file', text: `sealed sha256 ${short(sealed)}`, source: relId },
    {
      label: 'result',
      text: differs
        ? `current ${current ? short(current) : 'MISSING'} — the file changed or is missing ` +
          `since approval; the hash mismatch voids the approval (invariant 6)`
        : `current hash matches the seal — approval intact`,
    },
  ];

  return { status: differs ? 'fail' : 'pass', steps };
}

/** rubric line → its criterion + evidence → the reviewer finding that cited it. */
function traceRubric(ctx: TraceContext, rid: string): SubTrace {
  const line = ctx.rubric!.lines.find((l) => l.id === rid)!;
  const lineNo = ctx.rubricLineNo.get(rid);
  const steps: WhyStep[] = [
    {
      label: 'rubric',
      text: `${rid} [${line.severity}] ${line.criterion}`,
      source: lineNo ? `${ctx.rubricRel}:${lineNo}` : ctx.rubricRel,
    },
    { label: 'evidence', text: `signal to look for: ${line.evidence}` },
  ];

  // The finding render IS the trail (design §5 / report.ts): the review finding's
  // message already carries `explanation — file:line; fix: remediation`.
  const finding = reviewFinding(ctx.report, rid);
  if (finding) {
    steps.push({ label: 'finding', text: finding.message });
  } else {
    steps.push({
      label: 'finding',
      text: ctx.reviewRan
        ? `the last review did not block on this line`
        : `no review has run — this line is the law, not a live finding`,
    });
  }

  return { status: finding ? 'fail' : 'pass', steps };
}

/** A whole check by name: its status + each finding's sub-trace, in report order. */
function traceWholeCheck(ctx: TraceContext, name: CheckName): WhyTrace {
  const check = ctx.report.checks.find((c) => c.name === name);
  const status = check?.status ?? 'pass';
  const steps: WhyStep[] = [
    {
      label: 'check',
      text: check
        ? `${name} check — ${status.toUpperCase()} (${check.findings.length} finding(s))`
        : `${name} check — did not run this verify`,
    },
  ];
  for (const finding of check?.findings ?? []) {
    const resolved = resolveSubject(ctx, finding.id);
    steps.push({ label: 'finding', text: `${finding.id}: ${finding.message}` });
    if (resolved) steps.push(...resolved.sub.steps);
  }
  return { change: ctx.report.change, query: name, kind: 'check', status, steps };
}

/** Build the exit-2 error for an unknown id, naming every addressable subject. */
function unknownId(ctx: TraceContext, change: string, id: string) {
  const groups: string[] = [];
  const checks = ctx.report.checks.map((c) => c.name);
  if (checks.length > 0) groups.push(`checks: ${checks.join(', ')}`);
  const orcs = [...ctx.oraclesById.keys()];
  if (orcs.length > 0) groups.push(`oracles: ${orcs.join(', ')}`);
  const reqs = [...ctx.reqSource.keys()];
  if (reqs.length > 0) groups.push(`requirements: ${reqs.join(', ')}`);
  if (ctx.approval) {
    const sealed = Object.keys(ctx.approval.files);
    if (sealed.length > 0) groups.push(`sealed files: ${sealed.join(', ')}`);
  }
  if (ctx.rubric) {
    groups.push(`rubric lines: ${ctx.rubric.lines.map((l) => l.id).join(', ')}`);
  }
  return preconditionError(
    'UNKNOWN_TRACE_ID',
    `No traceable subject '${id}' in change ${change}.`,
    `Available ids — ${groups.join('; ')}.`,
  );
}

// ─── source-index helpers ────────────────────────────────────────────────────

/** REQ id → its source spec file (repo-relative) + heading line, across the delta. */
function collectRequirementSources(
  root: string,
  changeDir: string,
): Map<string, { rel: string; line: number }> {
  const sources = new Map<string, { rel: string; line: number }>();
  for (const abs of markdownFilesUnder(join(changeDir, 'specs'))) {
    const rel = relative(root, abs);
    for (const req of loadSpecDelta(abs)) {
      if (!sources.has(req.id)) sources.set(req.id, { rel, line: req.line });
    }
  }
  return sources;
}

/** Rubric line id → its 1-based line in rubric.yaml (best-effort, for display). */
function rubricLineNumbers(rubricPath: string): Map<string, number> {
  const map = new Map<string, number>();
  const lines = readFileSync(rubricPath, 'utf8').split(/\r?\n/);
  const ID = /(?:^|\s)id:\s*(\S+)\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = ID.exec(lines[i]!);
    if (match && !map.has(match[1]!)) map.set(match[1]!, i + 1);
  }
  return map;
}

// ─── report lookups ──────────────────────────────────────────────────────────

/** The name of the check whose findings name `id`, or undefined if none do. */
function findingCheck(report: VerifyReport, id: string): CheckName | undefined {
  for (const check of report.checks) {
    if (check.findings.some((f) => f.id === id)) return check.name;
  }
  return undefined;
}

/** The review-check finding citing rubric id `rid`, if the review flagged it. */
function reviewFinding(report: VerifyReport, rid: string): VerifyFinding | undefined {
  const review = report.checks.find((c) => c.name === 'review');
  return review?.findings.find((f) => f.id === rid);
}

/** Is `id` a requirement the traceability check flagged (coverage miss)? A
 * flagged coverage id is always a real requirement even if the delta re-parse
 * missed it, so it stays addressable. */
function isReportRequirement(report: VerifyReport, id: string): boolean {
  const trace = report.checks.find((c) => c.name === 'traceability');
  return trace?.findings.some((f) => f.id === id) ?? false;
}

// ─── small utilities ─────────────────────────────────────────────────────────

/** Current sha256 of a file, or undefined if missing/unreadable (a void signal). */
function safeHash(path: string): string | undefined {
  try {
    return createHash('sha256')
      .update(readFileSync(path) as BinaryLike)
      .digest('hex');
  } catch {
    return undefined;
  }
}

/** First 12 hex chars of a digest with an ellipsis, for compact display. */
function short(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

/**
 * Plain terminal render (matches renderReport's altitude). Header line with the
 * verdict for this subject, then one indented line per link with its source
 * beneath it — the chain reads top (the check) → bottom (the source file).
 */
export function renderWhy(trace: WhyTrace): string {
  const lines: string[] = [];
  lines.push(`why ${trace.query} (${trace.change}): ${trace.status.toUpperCase()}`);
  lines.push(`  kind: ${trace.kind}`);
  for (const step of trace.steps) {
    lines.push(`  ${step.label}: ${step.text}`);
    if (step.source) lines.push(`      ↳ ${step.source}`);
  }
  return lines.join('\n');
}
