// The regression suite — the accumulated correctness criterion of every past
// change (charter §The Regression Suite: "Judgment comes only from oracles
// (current change) and the regression suite (all past changes)"; design
// phase-2.md §1).
//
// Archiving IS registration (charter): there is no separate regression registry.
// The suite is *derived*, deterministically, from what is on disk:
//   - `collectRegressionSuite` scans `openspec/changes/archive/*/oracles.md` with
//     the P1-03 oracle parser and unions every archived binding. This is the set
//     of past promises `verify` re-runs on every change — the machine that makes
//     the refactor tier sound (a refactor promises nothing new; its correctness
//     *is* the regression suite) and the ratchet permanent (a bugfix's
//     reproduction oracle joins it and can never regress silently again).
//   - `collectArchivedRequirementIds` builds the archived-REQ index the
//     traceability lint consults so a bugfix/ratchet oracle may legally bind an
//     OLD requirement id (charter §ID grammar: "every binding's `requirement:`
//     exists in the delta OR in the archived spec"). Sources: the merged
//     `openspec/specs/**/spec.md` (bracketed `[REQ-*]` headings survive OpenSpec's
//     archive merge — spike §Repro) plus the archived deltas themselves.
//
// Both functions are pure, deterministic reads (invariant 12): same files →
// same suite, in the same order. They spawn nothing. They fail closed like every
// other parser: a malformed archived oracles.md / spec.md throws exit 3 from the
// P1-03/P1-04 parsers (a corrupt past promise is never silently dropped —
// invariant 3). The date prefix on each archive dir is OpenSpec-owned and opaque
// to collection (design §1); we key off directory presence, never parse it.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadOracles, type Oracle } from '../artifacts/oracles.js';
import { loadSpecDelta } from '../artifacts/spec-delta.js';

/** Where OpenSpec's `archive` moves a change dir to (design §1). Root-relative. */
const ARCHIVE_REL = join('openspec', 'changes', 'archive');
/** Where `archive` merges deltas into the living spec set (design §1). Root-relative. */
const SPECS_REL = join('openspec', 'specs');

/** The derived regression suite: every archived oracle, plus a by-runner view. */
export interface RegressionSuite {
  /**
   * Every archived oracle, deterministically ordered: by archive directory name
   * (sorted — the date prefix makes this chronological), then oracle source
   * order within each file. Deduped by oracle id (ids are immutable and never
   * reused — charter §ID grammar — so a duplicate would be corruption; first
   * wins, deterministically).
   */
  oracles: Oracle[];
  /**
   * The same oracles grouped by their binding `runner` (design §1: "union of
   * bindings, grouped by runner") — the shape a per-adapter dispatch consumes.
   * Insertion order within each group follows `oracles`.
   */
  byRunner: Map<string, Oracle[]>;
}

/**
 * Collect the regression suite from the archive. Scans every
 * `openspec/changes/archive/<dir>/oracles.md` (a dir without one — e.g. a
 * refactor that promised no new oracles — is skipped, not an error). Returns the
 * empty suite when nothing has been archived yet. A malformed archived oracles.md
 * fails closed at exit 3 (the P1-03 parser) — a corrupt past promise is a bug,
 * never a silent gap.
 */
export function collectRegressionSuite(root: string): RegressionSuite {
  const archiveDir = join(root, ARCHIVE_REL);
  const oracles: Oracle[] = [];
  const seen = new Set<string>();

  for (const entry of archiveDirs(archiveDir)) {
    const oraclesPath = join(archiveDir, entry, 'oracles.md');
    if (!existsSync(oraclesPath)) continue; // e.g. an archived refactor: no oracles.
    for (const oracle of loadOracles(oraclesPath)) {
      if (seen.has(oracle.id)) continue; // ids never reused; first wins.
      seen.add(oracle.id);
      oracles.push(oracle);
    }
  }

  return { oracles, byRunner: groupByRunner(oracles) };
}

/**
 * Build the archived-REQ id index the traceability lint consults (charter §ID
 * grammar; design §1). Union of every `[REQ-*]` id in:
 *   (a) the merged living spec set under `openspec/specs/`, and
 *   (b) the archived deltas under each `openspec/changes/archive/<dir>/specs/`.
 * Both are read with the P1-04 spec-delta extractor, so a malformed archived
 * requirement heading fails closed at exit 3. Returns the empty set when neither
 * source exists yet (a P1-era repo with nothing archived).
 */
export function collectArchivedRequirementIds(root: string): Set<string> {
  const ids = new Set<string>();

  // (a) the merged living spec set.
  for (const specFile of specMarkdownUnder(join(root, SPECS_REL))) {
    for (const req of loadSpecDelta(specFile)) ids.add(req.id);
  }

  // (b) the archived deltas (defensive belt-and-suspenders: the merge is the
  // primary source, but an archived delta's own specs/** carry the same ids and
  // guarantee coverage even if a future OpenSpec merge shape changes).
  const archiveDir = join(root, ARCHIVE_REL);
  for (const entry of archiveDirs(archiveDir)) {
    for (const specFile of specMarkdownUnder(join(archiveDir, entry, 'specs'))) {
      for (const req of loadSpecDelta(specFile)) ids.add(req.id);
    }
  }

  return ids;
}

/** Group oracles by their binding runner, preserving first-appearance order. */
export function groupByRunner(oracles: readonly Oracle[]): Map<string, Oracle[]> {
  const byRunner = new Map<string, Oracle[]>();
  for (const oracle of oracles) {
    const group = byRunner.get(oracle.binding.runner);
    if (group) group.push(oracle);
    else byRunner.set(oracle.binding.runner, [oracle]);
  }
  return byRunner;
}

/**
 * The archive's immediate child directories, sorted. The `archive/` dir itself is
 * OpenSpec-created on first archive; absent → empty (nothing archived yet). Only
 * directories are returned (a stray file is ignored — collection is tolerant of
 * foreign files, spike §Repro).
 */
function archiveDirs(archiveDir: string): string[] {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir)
    .filter((entry) => statSync(join(archiveDir, entry)).isDirectory())
    .sort();
}

/** Every `spec.md` under `dir` (recursive), absolute paths, sorted. Empty if absent. */
function specMarkdownUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...specMarkdownUnder(full));
    } else if (entry === 'spec.md') {
      out.push(full);
    }
  }
  return out;
}
