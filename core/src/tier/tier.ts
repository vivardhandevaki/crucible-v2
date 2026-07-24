// Tier computation — the deterministic realization of the charter tier table
// (charter §Tier Definitions, §Tier Computation — Operational Details; design
// phase-2.md §2).
//
// **Tiers are computed, never declared** (invariant 8): the propose agent may
// *suggest* a tier, but the CLI and CI recompute it from observable facts and a
// claim that disagrees fails. This module is that recomputation, and it is part
// of the TCB — every future Crucible project's ceremony-vs-risk dial runs through
// here. It is therefore PURE (invariant 12): facts in — spec-delta presence,
// touched paths, diff size, an optional `--tier` force — decision out. No I/O, no
// clock, no randomness. The git edge that assembles the diff facts is injected by
// the caller (design §2, following the P1-14 `StatusDeps` precedent); this module
// never reads a file or shells to git.
//
// The three honesty rules the charter names are enforced here, in order:
//   1. a risk-glob match always DOMINATES (a "trivial" one-liner in payments/** is
//      critical) — checked before spec delta and diff size;
//   2. a spec delta guarantees AT LEAST standard (new promises always get a real
//      gate) — never trivial;
//   3. force UP is allowed, force DOWN is impossible (a self-declared downgrade is
//      exactly what the meta-rule forbids) — the effective tier is the maximum of
//      the computed tier and any `--tier` force.
//
// The decision carries the *facts used* (design §2: "output includes the facts
// used, for state.yaml and status display") and validates against its own zod
// schema before it is returned — a malformed decision is a bug that fails closed
// (invariant 3) rather than being persisted into the audit trail.

import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

/** The three tiers, low → high. Ordering is the force-up / force-down spine. */
export const TIER_NAMES = ['trivial', 'standard', 'critical'] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** Rank for the max()-based force rule: force up allowed, force down impossible. */
const TIER_RANK: Record<TierName, number> = { trivial: 0, standard: 1, critical: 2 };

/** One risk-glob hit: the touched path and the critical glob it matched. */
export const riskMatchSchema = z.strictObject({
  path: z.string().min(1),
  glob: z.string().min(1),
});
export type RiskMatch = z.infer<typeof riskMatchSchema>;

/** The observable facts the tier was computed from — the audit-trail payload. */
export const tierFactsSchema = z.strictObject({
  /** Whether a normative spec delta is present in the bundle. */
  spec_delta: z.boolean(),
  /** Every touched path that matched a (non-exempt) critical glob, sorted. */
  risk_matches: z.array(riskMatchSchema),
  /** Total changed lines in the diff (added + deleted). */
  diff_lines: z.number().int().nonnegative(),
  /** The diff cap of the EFFECTIVE tier (from config), for cap enforcement. */
  diff_cap: z.number().int().nonnegative(),
  /** True iff diff_lines exceeds diff_cap (P2-03 enforces; recorded here). */
  cap_exceeded: z.boolean(),
});
export type TierFacts = z.infer<typeof tierFactsSchema>;

/** The full decision: effective tier, the pre-force computation, and the facts. */
export const tierDecisionSchema = z.strictObject({
  /** The effective tier after applying any `--tier` force (force up only). */
  tier: z.enum(TIER_NAMES),
  /** The tier computed from the facts alone, before the force was applied. */
  computed: z.enum(TIER_NAMES),
  /** The `--tier` force requested, or `null` when none was. */
  forced: z.enum(TIER_NAMES).nullable(),
  /** Human-readable "why" lines, in computation order (deterministic). */
  reasons: z.array(z.string().min(1)),
  /** The observable facts the decision rests on. */
  facts: tierFactsSchema,
});
export type TierDecision = z.infer<typeof tierDecisionSchema>;

/** The facts the caller assembles (spec delta + the injected git diff edge). */
export interface TierInputs {
  /** Is a normative spec delta present? (Refactors have none — charter §Change Types.) */
  specDelta: boolean;
  /** Repo-relative paths changed in the diff; order is irrelevant (sorted here). */
  touchedPaths: readonly string[];
  /** Total changed lines (added + deleted) in the diff. */
  diffLines: number;
  /** A `--tier` force, or null/omitted. Force UP only; a lower value is refused. */
  forced?: TierName | null;
}

/**
 * The slice of enforcement config the computation reads: risk globs and the
 * per-tier diff caps. Declared structurally (not imported from `config/`) so the
 * module stays a pure island — a full `EnforcementConfig` is assignable to it.
 */
export interface TierConfigLike {
  risk: { critical: readonly string[]; exempt: readonly string[] };
  tiers: Record<string, { diff_cap: number }>;
}

/**
 * Compute the tier for a change from its facts + the enforcement config. Pure and
 * deterministic (invariant 12): sorts touched paths, applies the charter table in
 * dominance order, then the force rule, and returns a schema-validated decision.
 * Fail-closed (invariant 3) if the config lacks a diff cap for a needed tier.
 */
export function computeTier(inputs: TierInputs, config: TierConfigLike): TierDecision {
  const paths = [...new Set(inputs.touchedPaths)].sort();
  const riskMatches = matchRisk(paths, config.risk);
  const reasons: string[] = [];

  // Rule 1 — a risk-glob match dominates: before spec delta, before diff size.
  let computed: TierName;
  if (riskMatches.length > 0) {
    computed = 'critical';
    const first = riskMatches[0]!;
    reasons.push(`risk-glob match: ${first.path} ~ ${first.glob} → critical (dominates)`);
  } else if (inputs.specDelta) {
    // Rule 2 — a spec delta guarantees at least standard.
    computed = 'standard';
    reasons.push('spec delta present, no risk-glob match → at least standard');
  } else {
    // No spec delta, no risk match: trivial unless it overruns the trivial cap
    // (the diff-cap bump — charter table "Selected when" for standard).
    const trivialCap = capFor('trivial', config);
    if (inputs.diffLines > trivialCap) {
      computed = 'standard';
      reasons.push(
        `no spec delta, but diff ${inputs.diffLines} lines exceeds trivial cap ${trivialCap} → standard`,
      );
    } else {
      computed = 'trivial';
      reasons.push('no spec delta, no risk-glob match, within the trivial cap → trivial');
    }
  }

  // Rule 3 — force up allowed, force down impossible: effective = max(computed, forced).
  const forced = inputs.forced ?? null;
  let tier = computed;
  if (forced !== null) {
    if (TIER_RANK[forced] > TIER_RANK[computed]) {
      tier = forced;
      reasons.push(`forced up to ${forced} via --tier`);
    } else if (TIER_RANK[forced] < TIER_RANK[computed]) {
      reasons.push(`--tier ${forced} ignored: computed tier is ${computed} (force down impossible)`);
    } else {
      reasons.push(`--tier ${forced} matches the computed tier`);
    }
  }

  const diffCap = capFor(tier, config);
  const facts: TierFacts = {
    spec_delta: inputs.specDelta,
    risk_matches: riskMatches,
    diff_lines: inputs.diffLines,
    diff_cap: diffCap,
    cap_exceeded: inputs.diffLines > diffCap,
  };

  // Validate before returning: the decision is bound for the audit trail, and a
  // malformed one is a bug that must fail closed rather than be persisted.
  return tierDecisionSchema.parse({ tier, computed, forced, reasons, facts });
}

/**
 * The touched paths that match a critical glob and are not carved out by an
 * exempt glob (charter reference shape: `.crucible/settings.yaml` is exempt from
 * `.crucible/**`). Returns the first matching critical glob per path; paths are
 * already sorted so the result is deterministic.
 */
function matchRisk(
  paths: readonly string[],
  risk: TierConfigLike['risk'],
): RiskMatch[] {
  const critical = risk.critical.map((glob) => ({ glob, re: globToRegExp(glob) }));
  const exempt = risk.exempt.map((glob) => globToRegExp(glob));
  const matches: RiskMatch[] = [];
  for (const path of paths) {
    if (exempt.some((re) => re.test(path))) continue;
    const hit = critical.find((c) => c.re.test(path));
    if (hit) matches.push({ path, glob: hit.glob });
  }
  return matches;
}

/** The configured diff cap for a tier. Missing → fail-closed exit 3 (invariant 3). */
function capFor(tier: TierName, config: TierConfigLike): number {
  const entry = config.tiers[tier];
  if (entry === undefined) {
    throw invalidInputError(
      'MISSING_TIER_CAP',
      `crucible.yaml has no diff_cap for the ${tier} tier.`,
      `Add a tiers.${tier}.diff_cap entry to crucible.yaml (charter §crucible.yaml — Reference Shape).`,
    );
  }
  return entry.diff_cap;
}

/**
 * Translate a `.gitignore`-style path glob to an anchored full-match RegExp
 * (charter §Tier Computation: "*Glob* = .gitignore-style wildcard path pattern").
 *
 *   `**` between/around slashes  → zero or more whole path segments
 *   `**` otherwise               → any characters, including `/`
 *   `*`                          → any run of non-slash characters (one segment)
 *   `?`                          → one non-slash character
 *   a pattern with NO slash      → matches the basename at any depth (gitignore)
 *   a pattern with a slash       → anchored at the repo root
 *
 * Correctness-critical (this decides tiers), so it is hand-written and covered by
 * the glob-semantics cases in the sibling test rather than pulled from a
 * transitive dependency the core does not declare.
 */
function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/');
  const chars = [...glob];
  let body = '';
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    if (c === '*') {
      if (chars[i + 1] === '*') {
        i += 1; // consume the second '*'
        if (chars[i + 1] === '/') {
          i += 1; // consume the trailing slash → zero-or-more whole segments
          body += '(?:.*/)?';
        } else {
          body += '.*'; // `**` not delimited by a slash → any chars incl. '/'
        }
      } else {
        body += '[^/]*'; // a single segment
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      body += `\\${c}`; // escape regex metacharacters
    } else {
      body += c;
    }
  }
  // A pattern with no slash matches the basename at any directory depth.
  const prefix = anchored ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}${body}$`);
}

/** Validate a `--tier` string against the known tiers. Unknown → fail-closed exit 3. */
export function parseTierName(value: string): TierName {
  if ((TIER_NAMES as readonly string[]).includes(value)) {
    return value as TierName;
  }
  throw invalidInputError(
    'INVALID_TIER',
    `Unknown tier ${JSON.stringify(value)}.`,
    `--tier must be one of: ${TIER_NAMES.join(', ')}.`,
  );
}

/**
 * Plain terminal render of a tier decision (the rich surface is elsewhere). One
 * header line with the effective tier — annotated when a force moved it off the
 * computed value — then one indented "why" line per reason.
 */
export function renderTierDecision(decision: TierDecision): string {
  const lines: string[] = [];
  const forceNote =
    decision.tier !== decision.computed ? ` (computed ${decision.computed})` : '';
  lines.push(`Tier: ${decision.tier}${forceNote}`);
  for (const reason of decision.reasons) {
    lines.push(`  - ${reason}`);
  }
  return lines.join('\n');
}
