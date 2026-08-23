// `crucible doctor` — the maintenance surface that keeps a project's installed
// Crucible TCB current and intact (charter §Upgrade procedure; design phase-2.md
// §7). Where `init` (P2-12) WRITES the trusted-computing-base files from shipped
// sources of truth, `doctor` CHECKS a project's copies against those same
// sources and reports drift — a tampered schema bundle, a stale CI workflow, an
// out-of-range OpenSpec pin, or a bad adapter hash — plus offers new upstream
// rubric lines the framework has learned since install.
//
// Two properties are load-bearing:
//
//   1. It checks against the SAME shipped sources init installs from — the schema
//      bundles from `@crucible/schemas`, the CI workflow from `@crucible/ci-templates`,
//      the default rubric from `core/assets/`, and the OpenSpec support window
//      (openspec-support.ts). init and doctor share one notion of "the shipped
//      version", so a clean `init` is always a clean `doctor`.
//
//   2. It NEVER writes silently (design §7 "offers fixes as diffs, never silent
//      writes" — TCB respect). doctor is read-only by default: every fix is
//      routed through the injected `confirmFix` edge (the CLI renders the diff and
//      reads y/N, tests script it). Upstream rubric lines are offered one at a
//      time and merged only on an explicit yes — never silently (charter §499:
//      "your law, your TCB").
//
// Determinism (invariant 12): given the same repo state + confirm decisions,
// doctor produces the same findings and the same writes. The one non-deterministic
// edge (the y/N prompt) is injected; the core touches no terminal and no clock.
//
// SCOPE (P2-13 + P3-09): the registry covers every installed artifact doctor can
// maintain, including the adapter lockfile hash check added after P3-06 minted
// the strict version+content-hash pin flow.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ciTemplatePathForAdapter } from '@crucible/ci-templates';
import { SCHEMA_BUNDLE_NAMES, schemaBundleDir } from '@crucible/schemas';
import {
  ADAPTER_LOCK_RELPATH,
  hashAdapterPackage,
  loadAdapterLock,
  serializeAdapterLock,
} from '../adapters/lockfile.js';
import { preconditionError } from '../util/errors.js';
import { loadEnforcementConfig } from '../config/enforcement.js';
import {
  defaultRubricPath,
  loadDefaultRubric,
  readRubric,
  rubricIds,
  type RubricLine,
} from '../review/rubric.js';
import {
  OPENSPEC_COMPATIBLE_RANGE,
  OPENSPEC_TESTED_VERSION,
  isOpenspecPinCompatible,
} from './openspec-support.js';

/** Which check produced a finding — the stable category the CLI groups by. */
export type DoctorCheckId =
  'schema-bundle' | 'ci-template' | 'openspec-version' | 'adapter-lockfile-hash' | 'rubric-lines';

/**
 * A finding's weight. `drift` = a shipped TCB file diverged from its source and
 * (left unfixed) is a real problem the exit code reflects. `offer` = an optional
 * upstream rubric line the human may accept or skip (never affects exit —
 * skipping is a legitimate choice). `advise` = informational, no available fix.
 */
export type DoctorSeverity = 'drift' | 'offer' | 'advise';

/** How a finding's fix mutates its target file. */
export type DoctorFixKind = 'rewrite' | 'append-rubric-line';

/**
 * A proposed fix, carried as a diff (current → desired) so the CLI can render it
 * and the human can judge it before anything is written. `rewrite` replaces the
 * whole file; `append-rubric-line` re-reads the file at apply time and appends
 * `line`, so accepting several offers in one run composes correctly.
 */
export interface DoctorFix {
  kind: DoctorFixKind;
  /** File bytes at scan time, or null when the file is absent. */
  current: string | null;
  /** File bytes after this fix — the diff's target, for display. */
  desired: string;
  /** For `append-rubric-line`: the upstream line to append. */
  line?: RubricLine;
}

/** One thing doctor noticed about the installed setup. */
export interface DoctorFinding {
  check: DoctorCheckId;
  /** Stable id — the confirm edge and results key on it. */
  id: string;
  severity: DoctorSeverity;
  /** Human-readable one-liner (what is wrong / what is offered). */
  summary: string;
  /** Repo-relative path the fix targets. */
  relpath: string;
  /** The offered fix, absent for `advise` findings that carry no auto-fix. */
  fix?: DoctorFix;
}

/** What became of a finding: fixed on confirm, declined, or reported-only. */
export type DoctorResolution = 'fixed' | 'skipped' | 'reported';
export interface DoctorResult {
  id: string;
  resolution: DoctorResolution;
}

export interface DoctorReport {
  /** Everything detected, in check-registry order. */
  findings: DoctorFinding[];
  /** Per-finding outcome after the confirm pass. */
  results: DoctorResult[];
}

/** The injected decision edge: apply this finding's fix? Consulted only for
 * findings that HAVE a fix. Async so the CLI can render a diff and read y/N. */
export type ConfirmFix = (finding: DoctorFinding) => boolean | Promise<boolean>;

export interface DoctorDeps {
  confirmFix: ConfirmFix;
}

export interface DoctorOptions {
  /** The repo root to diagnose. */
  root: string;
}

/** The check registry — each returns zero or more findings, read-only. */
const CHECKS: readonly ((root: string) => DoctorFinding[])[] = [
  checkSchemaBundles,
  checkCiTemplate,
  checkOpenspecVersion,
  checkAdapterLockfileHash,
  checkRubricLines,
];

/**
 * Diagnose the Crucible setup under `options.root`: collect findings from every
 * check, then for each fixable finding consult `confirmFix` and apply on yes.
 * Fails closed (exit 2) if the repo is not a Crucible project — there is nothing
 * to diagnose and the fix is `crucible init`.
 */
export async function doctor(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorReport> {
  const { root } = options;
  requireInitialized(root);

  const findings = CHECKS.flatMap((check) => check(root));
  const results: DoctorResult[] = [];
  for (const finding of findings) {
    if (!finding.fix) {
      results.push({ id: finding.id, resolution: 'reported' });
      continue;
    }
    if (await deps.confirmFix(finding)) {
      applyFix(root, finding.fix, finding.relpath);
      results.push({ id: finding.id, resolution: 'fixed' });
    } else {
      results.push({ id: finding.id, resolution: 'skipped' });
    }
  }
  return { findings, results };
}

/** Fail closed (exit 2) unless `crucible.yaml` — init's first-written file — is
 * present. doctor diagnoses an installed setup; an absent one is init's job. */
function requireInitialized(root: string): void {
  if (!existsSync(join(root, 'crucible.yaml'))) {
    throw preconditionError(
      'NOT_A_CRUCIBLE_PROJECT',
      'No crucible.yaml found — this repo is not a Crucible project.',
      'Run `crucible init` to install a Crucible setup first.',
    );
  }
}

// --- Check: schema bundle integrity --------------------------------------------

/** Compare every installed `openspec/schemas/<name>/*` file against the shipped
 * `@crucible/schemas` bytes — a mismatch (tampered) or absence (missing) is drift
 * whose fix restores the shipped bytes verbatim. */
function checkSchemaBundles(root: string): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const name of SCHEMA_BUNDLE_NAMES) {
    const bundleDir = schemaBundleDir(name);
    for (const rel of walkRelFiles(bundleDir)) {
      const shipped = readFileSync(join(bundleDir, rel), 'utf8');
      const relpath = join('openspec', 'schemas', name, rel);
      const abs = join(root, relpath);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      if (current === shipped) continue;
      findings.push({
        check: 'schema-bundle',
        id: `schema-bundle:${relpath}`,
        severity: 'drift',
        summary:
          current === null
            ? `schema bundle file missing: ${relpath}`
            : `schema bundle file modified (tampered): ${relpath}`,
        relpath,
        fix: { kind: 'rewrite', current, desired: shipped },
      });
    }
  }
  return findings;
}

// --- Check: CI template currency -----------------------------------------------

/** Compare the installed workflow against the shipped `@crucible/ci-templates`
 * bytes — any divergence is a stale/modified template, restored on confirm. */
function checkCiTemplate(root: string): DoctorFinding[] {
  const relpath = join('.github', 'workflows', 'crucible.yml');
  const adapters = Object.keys(loadEnforcementConfig(root).adapters);
  const shipped = readFileSync(
    ciTemplatePathForAdapter(adapters.includes('java-junit') ? 'java-junit' : (adapters[0] ?? '')),
    'utf8',
  );
  const abs = join(root, relpath);
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  if (current === shipped) return [];
  return [
    {
      check: 'ci-template',
      id: 'ci-template',
      severity: 'drift',
      summary:
        current === null
          ? `CI workflow missing: ${relpath}`
          : `CI workflow stale/modified vs the shipped template: ${relpath}`,
      relpath,
      fix: { kind: 'rewrite', current, desired: shipped },
    },
  ];
}

// --- Check: OpenSpec version-range compliance ----------------------------------

/** Check the project's declared `@fission-ai/openspec` pin against the shipped
 * compatible range. A node project only — a repo without package.json cannot
 * declare a pin, so the check yields nothing there. An out-of-range pin is drift
 * whose fix re-pins to the tested version (a diff, applied only on confirm). */
function checkOpenspecVersion(root: string): DoctorFinding[] {
  const relpath = 'package.json';
  const abs = join(root, relpath);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, 'utf8');
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(text) as typeof pkg;
  } catch {
    return [
      {
        check: 'openspec-version',
        id: 'openspec-version',
        severity: 'advise',
        summary: 'package.json is not valid JSON — cannot check the OpenSpec pin',
        relpath,
      },
    ];
  }
  const dep =
    pkg.dependencies?.['@fission-ai/openspec'] ?? pkg.devDependencies?.['@fission-ai/openspec'];
  if (typeof dep !== 'string') {
    return [
      {
        check: 'openspec-version',
        id: 'openspec-version',
        severity: 'advise',
        summary: '@fission-ai/openspec is not pinned in package.json',
        relpath,
      },
    ];
  }
  if (isOpenspecPinCompatible(dep)) return [];
  return [
    {
      check: 'openspec-version',
      id: 'openspec-version',
      severity: 'drift',
      summary: `OpenSpec pin "${dep}" is outside the tested range ${OPENSPEC_COMPATIBLE_RANGE} — re-pin to ${OPENSPEC_TESTED_VERSION}`,
      relpath,
      fix: { kind: 'rewrite', current: text, desired: repinOpenspec(text) },
    },
  ];
}

/** Re-pin the `@fission-ai/openspec` dependency line to the tested version,
 * touching only that value so the rest of package.json stays byte-stable. */
function repinOpenspec(text: string): string {
  return text.replace(/("@fission-ai\/openspec"\s*:\s*)"[^"]*"/, `$1"${OPENSPEC_TESTED_VERSION}"`);
}

// --- Check: adapter lockfile hash validity ------------------------------------

/**
 * Recompute every installed adapter package digest using P3-06's canonical
 * domain-separated, length-framed hash. An absent lockfile means this project
 * has no pinned adapter for doctor to maintain. A present lockfile is parsed
 * strictly, and unreadable package bytes fail closed through the shared TCB hash
 * API. All mismatches are repaired in one canonical lockfile diff so confirming
 * a multi-adapter repair cannot overwrite an earlier repair from the same scan.
 */
function checkAdapterLockfileHash(root: string): DoctorFinding[] {
  const relpath = ADAPTER_LOCK_RELPATH;
  const abs = join(root, relpath);
  if (!existsSync(abs)) return [];

  const current = readFileSync(abs, 'utf8');
  const lock = loadAdapterLock(abs);
  const mismatches: string[] = [];
  for (const [name, pin] of Object.entries(lock.adapters).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const actual = hashAdapterPackage(join(root, pin.manifest), join(root, pin.executable));
    if (actual === pin.content_hash) continue;
    mismatches.push(name);
    pin.content_hash = actual;
  }
  if (mismatches.length === 0) return [];

  return [
    {
      check: 'adapter-lockfile-hash',
      id: 'adapter-lockfile-hash',
      severity: 'drift',
      summary: `bad adapter hash: ${mismatches.join(', ')} package bytes no longer match the lockfile pin`,
      relpath,
      fix: {
        kind: 'rewrite',
        current,
        desired: serializeAdapterLock(lock),
      },
    },
  ];
}

// --- Check: upstream rubric-line offers ----------------------------------------

/** Offer every line in the shipped default rubric the project's rubric lacks
 * (charter §499). Each is an `offer` merged only on an explicit confirm — never
 * silently. A malformed project rubric fails closed via readRubric (exit 3): the
 * reviewer's law must parse before we can reason about it (invariant 3). */
function checkRubricLines(root: string): DoctorFinding[] {
  const relpath = join('.crucible', 'rubric.yaml');
  const abs = join(root, relpath);
  const shippedDefault = readFileSync(defaultRubricPath(), 'utf8');
  if (!existsSync(abs)) {
    return [
      {
        check: 'rubric-lines',
        id: 'rubric-lines:missing',
        severity: 'drift',
        summary: `rubric missing: ${relpath} — install the shipped default`,
        relpath,
        fix: { kind: 'rewrite', current: null, desired: shippedDefault },
      },
    ];
  }
  const project = readRubric(abs);
  const have = rubricIds(project);
  const current = readFileSync(abs, 'utf8');
  return loadDefaultRubric()
    .lines.filter((line) => !have.has(line.id))
    .map((line) => ({
      check: 'rubric-lines' as const,
      id: `rubric-lines:${line.id}`,
      severity: 'offer' as const,
      summary: `upstream rubric line available: ${line.id} — ${line.criterion}`,
      relpath,
      fix: {
        kind: 'append-rubric-line' as const,
        current,
        desired: appendRubricLine(current, line),
        line,
      },
    }));
}

// --- Fix application -----------------------------------------------------------

/** Apply a confirmed fix. `rewrite` replaces the file with `desired`;
 * `append-rubric-line` re-reads the current file and appends the line, so
 * several accepted offers in one run compose (each sees the prior appends). */
function applyFix(root: string, fix: DoctorFix, relpath: string): void {
  const abs = join(root, relpath);
  if (fix.kind === 'append-rubric-line') {
    const current = readFileSync(abs, 'utf8');
    writeFileSync(abs, appendRubricLine(current, fix.line!), 'utf8');
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, fix.desired, 'utf8');
}

/**
 * Append one rubric line as a YAML sequence item to the `lines:` block of an
 * existing rubric's TEXT, preserving every other line and its comments (the
 * rubric is TCB; a full re-serialize would erase the human's annotations).
 * Detects the existing item/field indentation and inserts after the last item.
 */
function appendRubricLine(text: string, line: RubricLine): string {
  const rows = text.split('\n');
  const keyIdx = rows.findIndex((r) => /^lines\s*:/.test(r));
  if (keyIdx === -1) {
    // A valid rubric always has a `lines:` block (readRubric guarantees it before
    // this is called); fail-safe by appending a fresh block rather than throwing.
    return `${text.replace(/\s*$/, '')}\nlines:\n${serializeRubricLine(line, '  ', '    ')}\n`;
  }
  const keyIndent = leadingSpaces(rows[keyIdx]!);
  let itemIndent = '  ';
  let fieldIndent = '    ';
  let end = keyIdx;
  for (let i = keyIdx + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.trim() === '') continue; // blank: could be interior or trailing
    if (leadingSpaces(row).length <= keyIndent.length) break; // next top-level key
    end = i;
    const m = row.match(/^(\s*)-\s+\S/);
    if (m && itemIndent === '  ') {
      itemIndent = m[1]!;
      fieldIndent = `${m[1]!}  `;
    }
  }
  const item = serializeRubricLine(line, itemIndent, fieldIndent);
  return [...rows.slice(0, end + 1), item, ...rows.slice(end + 1)].join('\n');
}

/** Render one rubric line as a YAML sequence item at the given indentation. */
function serializeRubricLine(line: RubricLine, itemIndent: string, fieldIndent: string): string {
  return [
    `${itemIndent}- id: ${yamlScalar(line.id)}`,
    `${fieldIndent}severity: ${line.severity}`,
    `${fieldIndent}criterion: ${yamlScalar(line.criterion)}`,
    `${fieldIndent}evidence: ${yamlScalar(line.evidence)}`,
  ].join('\n');
}

/** A YAML scalar, plain when safe (matching the shipped rubric style) or
 * double-quoted when the value carries a character that would misparse plain. */
function yamlScalar(value: string): string {
  const needsQuote =
    value === '' || /:\s|:$|\s#|^\s|\s$/.test(value) || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value);
  return needsQuote ? JSON.stringify(value) : value;
}

function leadingSpaces(row: string): string {
  return row.match(/^(\s*)/)![1]!;
}

/** Every file under `dir`, as sorted paths relative to `dir` (mirrors init's
 * verbatim-copy walk so the two agree on the shipped bundle's file set). */
function walkRelFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(dir, abs));
    }
  };
  walk(dir);
  return out.sort();
}
