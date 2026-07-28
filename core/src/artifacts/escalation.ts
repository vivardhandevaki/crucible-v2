// escalation.yaml — the structural teeth of the escalation layer (charter
// §Escalation — Three Enforcement Layers, layer 2; design phase-2.md §3).
//
// When the implement agent hits a decision that is NOT derivable from the approved
// spec, it does not improvise (charter: "ambiguity is a spec bug, fixed upstream at
// propose, never improvised at implement"). It runs `crucible escalate`, which
// writes THIS committed artifact into the change bundle. Its mere presence is
// load-bearing: it halts the current implement run and, while it exists unresolved,
// `crucible implement` refuses to resume (see commands/implement.ts). Resolution
// flows through `crucible amend` (spec patch + delta-approval), which clears it.
//
// This module is the artifact's schema + (de)serialization. It resolves NOTHING
// through an adapter and holds no wall-clock (invariant 12) — the caller supplies
// who/when. A malformed escalation.yaml fails closed at exit 3 like every other
// artifact parser (invariant 3): an escalation we cannot read is not an escalation
// we can honor, so it stops the loop rather than being silently ignored.

import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

/** The current escalation.yaml schema version. */
export const ESCALATION_VERSION = 1;

/** escalation.yaml (design §3), strict — an unknown key fails closed at exit 3. */
export const escalationSchema = z.strictObject({
  version: z.number().int(),
  change: z.string().min(1),
  /** The oracle the ambiguity concerns, when it maps to one (optional — an
   * open-ended ambiguity may name no single oracle). */
  oracle: z.string().min(1).optional(),
  /** What is underspecified — the question the human must resolve (never empty). */
  question: z.string().min(1),
  /** The candidate resolutions the agent surfaced — at least one, each non-empty.
   * An escalation with nothing actionable is not resolvable, so it fails closed. */
  options: z.array(z.string().min(1)).min(1),
  /** Who filed it (the implement role / operator). */
  filed_by: z.string().min(1),
  /** When (ISO 8601). Injected by the caller — no wall-clock in the artifact. */
  filed_at: z.string().min(1),
});
export type Escalation = z.infer<typeof escalationSchema>;

/** The who/when/what the caller supplies; the artifact is assembled from it. */
export interface EscalationMeta {
  version: number;
  change: string;
  oracle?: string;
  question: string;
  options: string[];
  filed_by: string;
  filed_at: string;
}

/** Build the escalation artifact object from the caller's metadata (pure). */
export function buildEscalation(meta: EscalationMeta): Escalation {
  // Omit `oracle` entirely when absent — exactOptionalPropertyTypes + strict zod.
  return escalationSchema.parse({
    version: meta.version,
    change: meta.change,
    ...(meta.oracle !== undefined ? { oracle: meta.oracle } : {}),
    question: meta.question,
    options: meta.options,
    filed_by: meta.filed_by,
    filed_at: meta.filed_at,
  });
}

/** Serialize an escalation to canonical escalation.yaml text (deterministic). */
export function serializeEscalation(escalation: Escalation): string {
  return stringifyYaml(escalation, { sortMapEntries: false });
}

/** Parse + strict-validate escalation.yaml text. Any defect → exit 3 (fail-closed). */
export function parseEscalation(text: string, source: string): Escalation {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_ESCALATION',
      `${source}: escalation.yaml is not valid YAML — ${messageOf(cause)}`,
      'Do not hand-edit escalation.yaml; resolve it with `crucible amend <change>`.',
    );
  }
  const result = escalationSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw invalidInputError(
      'INVALID_ESCALATION',
      `${source}: escalation.yaml invalid — ${where}: ${issue.message}`,
      'Do not hand-edit escalation.yaml; resolve it with `crucible amend <change>`.',
    );
  }
  return result.data;
}

/**
 * Read escalation.yaml if present. Returns `undefined` when the file does not
 * exist (no escalation pending — the common case), the parsed artifact when it is
 * valid, and throws exit 3 when it is present-but-malformed (fail-closed: a
 * corrupt escalation halts the loop, never a silent skip). This single "read if
 * present" shape is what implement's precondition + mid-run halt both consume.
 */
export function readEscalationIfPresent(path: string): Escalation | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw invalidInputError(
      'INVALID_ESCALATION',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on escalation.yaml.',
    );
  }
  return parseEscalation(text, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
