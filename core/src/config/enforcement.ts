// Enforcement config — `crucible.yaml` (charter §Configuration & Reviewer Law).
//
// This is the ONE file that decides what merges: risk globs, tiers, adapters,
// suites, trajectory, audit. In CI it is read from the *target* branch, never
// the PR branch (invariant 7 / charter §The Target-Branch Rule) — the seam for
// that is `resolveEnforcementRoot`, wired by the verify command / CI template.
//
// Fail-closed (invariant 3, architecture.md §4): malformed YAML, an unknown
// key, or a wrong-typed field is exit 3, never a warning. A typo'd glob key
// must not silently no-op. This module imports NOTHING from ./convenience:
// enforcement never reads convenience config (proven by a boundary test).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError, preconditionError } from '../util/errors.js';

const tierSchema = z.strictObject({
  diff_cap: z.number().int().nonnegative(),
  mutation: z.literal('blocking').optional(),
});

const adapterSchema = z.strictObject({
  runners: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
});

const riskSchema = z.strictObject({
  critical: z.array(z.string()),
  exempt: z.array(z.string()).default([]),
});

const trajectorySchema = z.strictObject({
  require_local_verify: z.boolean(),
  iteration_budget: z.number().int().positive().optional(),
});

const auditSchema = z.strictObject({
  sample_rate: z.number().min(0).max(1),
});

const reviewSchema = z.strictObject({
  ci_mode: z.enum(['advisory', 'required']),
});

// `.strict()` at every level: an unrecognized key fails rather than being
// stripped, so config typos surface loudly (architecture.md §4). Dynamic maps
// (tiers/adapters/suites) key on names the project chooses; their *values* are
// still strict-validated.
const enforcementSchema = z.strictObject({
  risk: riskSchema,
  tiers: z.record(z.string(), tierSchema),
  adapters: z.record(z.string(), adapterSchema).default({}),
  suites: z.record(z.string(), z.string()).default({}),
  trajectory: trajectorySchema,
  audit: auditSchema,
  review: reviewSchema.optional(),
});

export type EnforcementConfig = z.infer<typeof enforcementSchema>;
export type TierConfig = z.infer<typeof tierSchema>;
export type AdapterConfig = z.infer<typeof adapterSchema>;
export type CiReviewMode = NonNullable<EnforcementConfig['review']>['ci_mode'];

/** Target-branch CI review policy; omission preserves P4-14 required mode. */
export function ciReviewMode(config: EnforcementConfig): CiReviewMode {
  return config.review?.ci_mode ?? 'required';
}

/** The path `crucible.yaml` is expected at, given the config root directory. */
export function enforcementConfigPath(configRoot: string): string {
  return join(configRoot, 'crucible.yaml');
}

/**
 * Which directory enforcement config is read from. `--config-from` (the CI
 * target-branch checkout) wins; otherwise the working tree. This is the single
 * seam that makes the target-branch rule true (charter §The Target-Branch Rule).
 */
export function resolveEnforcementRoot(configFrom: string | undefined, cwd: string): string {
  return configFrom ?? cwd;
}

/** Parse + validate enforcement config from raw YAML text. Throws exit 3. */
export function parseEnforcementConfig(yamlText: string, source: string): EnforcementConfig {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_ENFORCEMENT_CONFIG',
      `${source}: not valid YAML — ${cause instanceof Error ? cause.message : String(cause)}`,
      'Fix the YAML syntax in crucible.yaml.',
    );
  }

  const result = enforcementSchema.safeParse(data);
  if (!result.success) {
    throw invalidInputError(
      'INVALID_ENFORCEMENT_CONFIG',
      `${source}: invalid enforcement config —\n${formatIssues(result.error)}`,
      'Fix crucible.yaml against charter §crucible.yaml — Reference Shape.',
    );
  }
  return result.data;
}

/** Read + parse `<configRoot>/crucible.yaml`. Missing file → exit 2. */
export function loadEnforcementConfig(configRoot: string): EnforcementConfig {
  const path = enforcementConfigPath(configRoot);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_ENFORCEMENT_CONFIG',
        `No crucible.yaml found at ${path}.`,
        'Create a crucible.yaml at the repo root to enable enforcement.',
      );
    }
    throw invalidInputError(
      'INVALID_ENFORCEMENT_CONFIG',
      `${path}: could not be read — ${cause instanceof Error ? cause.message : String(cause)}`,
      'Check the file permissions on crucible.yaml.',
    );
  }
  return parseEnforcementConfig(text, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** One line per zod issue: `path: message`, naming the offending key. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${at}: ${issue.message}`;
    })
    .join('\n');
}
