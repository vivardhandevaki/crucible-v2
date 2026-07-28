// Change-type computation — the deterministic realization of the charter change
// types (charter §Change Types — Schema Templates; design phase-2.md §4).
//
// Crucible ships three change *types*, each a sibling OpenSpec schema bundle:
// `feature` (schema `crucible`, the default), `bugfix` (`crucible-bugfix`), and
// `refactor` (`crucible-refactor`). The type IS the schema choice: `propose`
// infers it from the intent (or takes `--type`), scaffolds with that schema, and
// the change's `.openspec.yaml` pins it thereafter. From then on the type is
// **revalidated, never trusted** — exactly the stance invariant 8 takes on tiers.
// A refactor that smuggles in a spec delta, or a bugfix with no reproduction
// oracle, is a bundle that violates its own pinned contract, and Crucible fails
// it closed (invariant 3) at propose / approve / verify.
//
// Like `tier/`, the DECISION logic here is PURE (invariant 12): facts in — is a
// spec delta present, how many oracles, how many reproduction oracles — violations
// out. No I/O, no clock, no randomness. Inference is a pure string classification.
// The one fs-touching function, `readChangeType`, is a deterministic read of the
// `.openspec.yaml` pin (like `collectArchivedRequirementIds`), kept here so the
// pin ↔ type mapping lives in one TCB module; it spawns nothing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalidInputError } from '../util/errors.js';

/** The three change types, in canonical order (feature is the default). */
export const CHANGE_TYPES = ['feature', 'bugfix', 'refactor'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** The default type when nothing is inferred or pinned (charter: feature is the default). */
export const DEFAULT_CHANGE_TYPE: ChangeType = 'feature';

/** Each type's sibling schema-bundle name — the string that becomes the `.openspec.yaml` pin. */
export const SCHEMA_FOR_TYPE: Record<ChangeType, string> = {
  feature: 'crucible',
  bugfix: 'crucible-bugfix',
  refactor: 'crucible-refactor',
};

/** The reverse map: schema-bundle name → the change type it encodes. */
const TYPE_FOR_SCHEMA: ReadonlyMap<string, ChangeType> = new Map(
  CHANGE_TYPES.map((t) => [SCHEMA_FOR_TYPE[t], t] as const),
);

/** The schema-bundle name for a type (the `--schema` argument / `.openspec.yaml` pin). */
export function schemaForType(type: ChangeType): string {
  return SCHEMA_FOR_TYPE[type];
}

/**
 * The change type a pinned schema name encodes. An UNKNOWN schema is fail-closed
 * (exit 3, invariant 3): a change pinned to a schema Crucible does not ship is a
 * change whose type rules Crucible cannot enforce, so it must not slip through.
 */
export function typeForSchema(schema: string): ChangeType {
  const type = TYPE_FOR_SCHEMA.get(schema);
  if (type === undefined) {
    throw invalidInputError(
      'UNKNOWN_SCHEMA',
      `.openspec.yaml pins schema ${JSON.stringify(schema)}, which is not a Crucible change-type bundle.`,
      `The schema must be one of: ${CHANGE_TYPES.map(schemaForType).join(', ')} (run \`crucible init\` to install them).`,
    );
  }
  return type;
}

/** Validate a `--type` string against the known types. Unknown → fail-closed exit 3. */
export function parseTypeName(value: string): ChangeType {
  if ((CHANGE_TYPES as readonly string[]).includes(value)) {
    return value as ChangeType;
  }
  throw invalidInputError(
    'INVALID_TYPE',
    `Unknown change type ${JSON.stringify(value)}.`,
    `--type must be one of: ${CHANGE_TYPES.join(', ')}.`,
  );
}

// Inference keyword sets. Word-boundary matched over the lowercased intent.
// Refactor words are SPECIFIC (a "refactor"/"rename"/"extract" is rarely a
// feature by accident); bugfix words include the generic "fix", so refactor is
// checked FIRST and dominates when both appear — a refactor that also mentions a
// fix is still structurally a refactor, and the conformance backstop catches a
// genuine misclassification either way (a suggestion, not a verdict).
const REFACTOR_SIGNAL =
  /\b(refactor(?:s|ing|ed)?|restructur\w*|reorganiz\w*|reorganis\w*|renam\w*|extract\w*|inlin\w*|deduplicat\w*|cleanup|tidy|behaviou?r-preserving)\b|\bclean\s+up\b|\bno\s+behaviou?r\s+change\b/;
const BUGFIX_SIGNAL =
  /\b(bug|bugs|bugfix|fix|fixes|fixed|fixing|regression|regressions|broken|crash(?:es|ing|ed)?|defect|hotfix|misbehav\w*)\b/;

/**
 * Infer the change type from the intent text (charter: "infers the type from the
 * description and says so; `--type` overrides"). Deterministic classification —
 * refactor signal dominates bugfix signal, both dominate the feature default. A
 * SUGGESTION only: propose reports it, `--type` overrides it, and conformance
 * revalidates the real bundle regardless.
 */
export function inferType(intent: string): ChangeType {
  const text = intent.toLowerCase();
  if (REFACTOR_SIGNAL.test(text)) return 'refactor';
  if (BUGFIX_SIGNAL.test(text)) return 'bugfix';
  return DEFAULT_CHANGE_TYPE;
}

/** The observable facts a type is revalidated against (the bundle's real shape). */
export interface TypeFacts {
  /** Is a normative spec delta present in the bundle (any specs/**\/*.md)? */
  specDelta: boolean;
  /** How many oracles the bundle authored (a refactor must have zero). */
  oracleCount: number;
  /** How many of those oracles are marked `reproduces: true` (a bugfix needs ≥1). */
  reproductionOracleCount: number;
}

/** One way the bundle's real shape violates its pinned type's contract. */
export interface TypeViolation {
  /** Short kebab-case rule id (stable, for tests + `why`). */
  rule: string;
  /** One-line human rendering naming the type and what is wrong. */
  message: string;
}

/**
 * Revalidate a bundle's real shape against its pinned type — pure and
 * deterministic (invariant 12). Returns every violation in a stable order; empty
 * means conformant. The rules (charter §Change Types; design phase-2.md §4):
 *   - refactor: NO spec delta permitted, and ZERO new oracles (correctness is
 *     the regression suite alone).
 *   - bugfix: at least ONE reproduction oracle (`reproduces: true`).
 *   - feature: no extra shape rules (the full bundle is checked elsewhere).
 */
export function validateType(type: ChangeType, facts: TypeFacts): TypeViolation[] {
  const violations: TypeViolation[] = [];
  if (type === 'refactor') {
    if (facts.specDelta) {
      violations.push({
        rule: 'refactor-no-spec-delta',
        message:
          'refactor change carries a spec delta — a refactor promises nothing new, so no spec delta is permitted (charter §Change Types)',
      });
    }
    if (facts.oracleCount > 0) {
      violations.push({
        rule: 'refactor-no-oracles',
        message: `refactor change authored ${facts.oracleCount} oracle(s) — a refactor adds no new oracles; its correctness is the regression suite alone`,
      });
    }
  } else if (type === 'bugfix') {
    if (facts.reproductionOracleCount < 1) {
      violations.push({
        rule: 'bugfix-needs-reproduction',
        message:
          'bugfix change has no reproduction oracle — a bugfix requires at least one oracle marked `reproduces: true` (charter §Change Types)',
      });
    }
  }
  return violations;
}

/**
 * Fail-closed conformance gate (invariant 3): throw exit 3 if the bundle's real
 * shape violates its pinned type. Used at propose / approve / verify so a change
 * that lies about its type never advances — the type analogue of tier's "computed,
 * never declared". The message names every violation.
 */
export function assertTypeConformance(type: ChangeType, facts: TypeFacts): void {
  const violations = validateType(type, facts);
  if (violations.length === 0) return;
  throw invalidInputError(
    'TYPE_NONCONFORMANT',
    `Change bundle does not conform to its ${type} type:\n${violations
      .map((v) => `  ✗ ${v.message}`)
      .join('\n')}`,
    'Fix the bundle, or re-propose with the correct `--type` (charter §Change Types).',
  );
}

/**
 * Read the change type a bundle is pinned to, from its OpenSpec `.openspec.yaml`
 * `schema:` field (design phase-2.md §4: the pin IS the recorded type). A
 * deterministic filesystem read (invariant 12), not an injected edge. An ABSENT
 * `.openspec.yaml` defaults to `feature` (a P1-era bundle predates typed schemas);
 * a present-but-unparseable file, or one pinning an unknown schema, is fail-closed
 * exit 3 (invariant 3) — we never guess the type of a bundle we cannot read.
 */
export function readChangeType(changeDir: string): ChangeType {
  const path = join(changeDir, '.openspec.yaml');
  if (!existsSync(path)) return DEFAULT_CHANGE_TYPE;

  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw invalidInputError(
      'INVALID_OPENSPEC_YAML',
      `${path}: is not valid YAML — ${cause instanceof Error ? cause.message : String(cause)}`,
      'Restore the change dir with `crucible propose` (it writes a valid .openspec.yaml).',
    );
  }
  const schema =
    typeof data === 'object' && data !== null ? (data as { schema?: unknown }).schema : undefined;
  if (schema === undefined) return DEFAULT_CHANGE_TYPE;
  if (typeof schema !== 'string') {
    throw invalidInputError(
      'INVALID_OPENSPEC_YAML',
      `${path}: \`schema\` must be a string, got ${typeof schema}.`,
      'Restore the change dir with `crucible propose` (it writes a valid .openspec.yaml).',
    );
  }
  return typeForSchema(schema);
}
