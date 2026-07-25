// override.yaml — the 2am escape hatch (charter §Approval, Amend, Override — Wire
// Format; design phase-2.md §3; charter §What Survives From V1 row 5).
//
// `crucible override "<reason>"` writes this committed artifact into the change
// bundle. Its presence PERMITS a gate bypass — verify forces its verdict green
// but flags the report `override: true`, and forces routing to `human` regardless
// of the computed tier (see commands/verify.ts). In exchange the override is
// LOUD: CI files a ratchet issue (payload built here, filed by the CI-template
// step) that stays open until a retroactive proposal lands. "Instant to use,
// impossible to use quietly": visibility replaces prohibition (charter row 5).
//
// This module is the artifact's schema + (de)serialization + the pure ratchet-
// issue payload builder. It resolves NOTHING through an adapter and holds no
// wall-clock (invariant 12) — the caller supplies who/when. There is deliberately
// no token plumbing here (design §3, resolved P2-00): core only EMITS the issue
// payload; the CI-template step files it idempotently via the ambient
// GITHUB_TOKEN. A malformed override.yaml fails closed at exit 3 like every other
// artifact parser (invariant 3) — a bypass we cannot read is not a bypass we honor.

import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError, preconditionError } from '../util/errors.js';
import { ratchetIssueSchema, type RatchetIssue } from '../verifyx/report.js';

/** The GitHub label the ratchet issue carries — CI searches by it for idempotency. */
export const OVERRIDE_ISSUE_LABEL = 'crucible-override';

/** The current override.yaml schema version. */
export const OVERRIDE_VERSION = 1;

/** override.yaml (design §3), strict — an unknown key fails closed at exit 3. */
export const overrideSchema = z.strictObject({
  version: z.number().int(),
  change: z.string().min(1),
  /** Why the gate is being bypassed — the human's stated reason (never empty). */
  reason: z.string().min(1),
  /** Who invoked the override (e.g. git user email). */
  created_by: z.string().min(1),
  /** When (ISO 8601). Injected by the caller — no wall-clock in the artifact. */
  created_at: z.string().min(1),
});
export type Override = z.infer<typeof overrideSchema>;

/** The who/when/what the caller supplies; the artifact is assembled from it. */
export interface OverrideMeta {
  version: number;
  change: string;
  reason: string;
  created_by: string;
  created_at: string;
}

/** Build the override artifact object from the caller's metadata (pure). */
export function buildOverride(meta: OverrideMeta): Override {
  return overrideSchema.parse({
    version: meta.version,
    change: meta.change,
    reason: meta.reason,
    created_by: meta.created_by,
    created_at: meta.created_at,
  });
}

/**
 * Build the ratchet-issue payload CI files when an override bypasses the gate
 * (design §3). Pure and deterministic (invariant 12): same override → same
 * payload. The title NAMES the change so the CI step can search open
 * `crucible-override`-labeled issues for it and avoid filing a duplicate
 * (idempotency). The body records the reason + who/when and states the closing
 * condition (a retroactive proposal). Core only builds this; the CI-template step
 * files it via the ambient GITHUB_TOKEN — no token plumbing here.
 */
export function buildRatchetIssue(override: Override): RatchetIssue {
  const title = `crucible override: ${override.change} needs a retroactive proposal`;
  const body = [
    `A gate bypass was recorded for change \`${override.change}\` via \`crucible override\`.`,
    '',
    `**Reason:** ${override.reason}`,
    `**Overridden by:** ${override.created_by}`,
    `**When:** ${override.created_at}`,
    '',
    'This change merged without a passing automated gate. This issue stays OPEN ' +
      'until a retroactive proposal lands that closes the coverage gap the override ' +
      'papered over (a new oracle, rubric line, or rule — the ratchet only tightens).',
  ].join('\n');
  return ratchetIssueSchema.parse({ title, body, labels: [OVERRIDE_ISSUE_LABEL] });
}

/** Serialize an override to canonical override.yaml text (deterministic). */
export function serializeOverride(override: Override): string {
  return stringifyYaml(override, { sortMapEntries: false });
}

/** Parse + strict-validate override.yaml text. Any defect → exit 3 (fail-closed). */
export function parseOverride(text: string, source: string): Override {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_OVERRIDE',
      `${source}: override.yaml is not valid YAML — ${messageOf(cause)}`,
      'Do not hand-edit override.yaml; re-run `crucible override <change> "<reason>"`.',
    );
  }
  const result = overrideSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw invalidInputError(
      'INVALID_OVERRIDE',
      `${source}: override.yaml invalid — ${where}: ${issue.message}`,
      'Do not hand-edit override.yaml; re-run `crucible override <change> "<reason>"`.',
    );
  }
  return result.data;
}

/** Read override.yaml from disk and parse it. Missing file → exit 2. */
export function loadOverride(path: string): Override {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_OVERRIDE',
        `No override.yaml found at ${path}.`,
        'Run `crucible override <change> "<reason>"` to record a gate bypass.',
      );
    }
    throw invalidInputError(
      'INVALID_OVERRIDE',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on override.yaml.',
    );
  }
  return parseOverride(text, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
