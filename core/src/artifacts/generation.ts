// generation.yaml — the per-artifact generation-hash ledger behind staleness
// tracking (charter §Editing Artifacts — Pre- vs. Post-Approval; design
// phase-2.md §3; task P2-05 "generation-hash staleness tracking").
//
// Pre-approval, direct edits are allowed but must never create *silent desync*:
// the advertised path is `crucible propose --revise`, which regenerates every
// dependent artifact coherently. This ledger is what makes a hand-edit that
// breaks that coherence VISIBLE. It records, in dependency order (proposal →
// design → specs → oracles), the sha256 each artifact had at the moment the
// propose/revise session last generated the bundle. `approve` recomputes and
// compares (see `checkStaleness`): if an *upstream* artifact was hand-edited
// after a *downstream* one was generated, the downstream may be stale — approve
// refuses until `--revise` regenerates or the human confirms consistency.
//
// This is a PRE-approval convenience/coherence guard, NOT the seal: it is never
// part of the approval hash scope, and its absence (a P1-era or hand-authored
// bundle with no recorded lineage) means "no lineage to check", not "stale" —
// the post-approval hash seal (approval.yaml) is the hard immutability
// guarantee. This module resolves nothing through an adapter and holds no
// wall-clock (invariant 12): the caller supplies the generation timestamp.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';
import { hashFile } from '../hash/hash.js';

/** The current generation.yaml schema version. */
export const GENERATION_VERSION = 1;

/** A lowercase sha256 hex digest (64 chars). */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex digest');

/** One artifact's generation record: its change-dir-relative path + sealed-at hash. */
const genArtifactSchema = z.strictObject({
  path: z.string().min(1),
  hash: sha256Hex,
});

/** generation.yaml, strict — an unknown key fails closed at exit 3. The
 * `artifacts` list is in dependency order, upstream → downstream. */
export const generationSchema = z.strictObject({
  version: z.number().int(),
  change: z.string().min(1),
  generated_at: z.string().min(1),
  artifacts: z.array(genArtifactSchema).min(1),
});

export type Generation = z.infer<typeof generationSchema>;
export type GenerationArtifact = z.infer<typeof genArtifactSchema>;

/**
 * Staleness verdict. `stale` names the first *upstream* artifact whose current
 * bytes differ from its recorded generation hash, plus the downstream artifacts
 * that were generated before that edit and are therefore suspect.
 */
export type StalenessResult =
  { stale: false } | { stale: true; editedPath: string; downstream: string[] };

/**
 * Stamp the current bundle: hash each artifact (relative to `changeDir`) in the
 * given dependency order and build the generation object. `orderedRelpaths` is
 * the upstream→downstream artifact order (from `dependencyOrder`); the caller
 * only stamps a COHERENT bundle (right after a clean propose/revise/amend
 * regeneration), so every listed file exists — a missing one fails closed at
 * exit 3 (`hashFile`). Never resolves paths via an adapter (invariant boundary).
 */
export function stampGeneration(
  changeDir: string,
  change: string,
  orderedRelpaths: readonly string[],
  generatedAt: string,
): Generation {
  const artifacts: GenerationArtifact[] = orderedRelpaths.map((path) => ({
    path,
    hash: hashFile(join(changeDir, path)),
  }));
  return {
    version: GENERATION_VERSION,
    change,
    generated_at: generatedAt,
    artifacts,
  };
}

/**
 * Compare the recorded generation hashes against the current bundle bytes and
 * decide staleness (charter §Editing Artifacts). The rule: the bundle is stale
 * iff any artifact that is NOT the last in dependency order has current bytes
 * differing from its recorded generation hash. A hand-edit to the most
 * downstream artifact (oracles) is always safe — nothing depends on it — so it
 * never triggers staleness; a hand-edit to any upstream artifact (design, a
 * spec) desyncs everything generated after it. Returns the FIRST offending
 * upstream artifact and every artifact downstream of it (the suspect set).
 */
export function checkStaleness(changeDir: string, generation: Generation): StalenessResult {
  const { artifacts } = generation;
  // The last artifact is the leaf: editing it desyncs nothing. Only artifacts
  // strictly upstream of the leaf can make the bundle stale.
  for (let i = 0; i < artifacts.length - 1; i++) {
    const artifact = artifacts[i]!;
    if (currentHash(join(changeDir, artifact.path)) !== artifact.hash) {
      return {
        stale: true,
        editedPath: artifact.path,
        downstream: artifacts.slice(i + 1).map((a) => a.path),
      };
    }
  }
  return { stale: false };
}

/** Serialize a generation manifest to canonical generation.yaml text (deterministic). */
export function serializeGeneration(generation: Generation): string {
  return stringifyYaml(generation, { sortMapEntries: false });
}

/** Parse + strict-validate generation.yaml text. Any defect → exit 3 (fail-closed). */
export function parseGeneration(text: string, source: string): Generation {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_GENERATION',
      `${source}: generation.yaml is not valid YAML — ${messageOf(cause)}`,
      'Do not hand-edit generation.yaml; re-run `crucible propose --revise` to regenerate.',
    );
  }
  const result = generationSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw invalidInputError(
      'INVALID_GENERATION',
      `${source}: generation.yaml invalid — ${where}: ${issue.message}`,
      'Do not hand-edit generation.yaml; re-run `crucible propose --revise` to regenerate.',
    );
  }
  return result.data;
}

/**
 * Read generation.yaml if present. Returns `undefined` when the file does not
 * exist — a bundle with no recorded generation lineage (P1-era or hand-authored)
 * simply has no staleness to check (the post-approval seal is the hard guarantee,
 * charter §Editing Artifacts). A present-but-malformed manifest fails closed at
 * exit 3 (invariant 3) — a corrupt lineage record is never silently ignored.
 */
export function readGenerationIfPresent(path: string): Generation | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw invalidInputError(
      'INVALID_GENERATION',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on generation.yaml.',
    );
  }
  return parseGeneration(text, path);
}

function currentHash(path: string): string | undefined {
  try {
    return hashFile(path);
  } catch {
    return undefined;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
