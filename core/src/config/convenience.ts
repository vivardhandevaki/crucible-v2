// Convenience config — `.crucible/settings.yaml` (team) + `.crucible/local.yaml`
// (personal, gitignored). Charter §Configuration & Reviewer Law.
//
// Only `agent`, `models.*` (routing), and `notify` (channels) are parsed. This config can
// NEVER affect what merges (invariant 7 / 11): the guarantee is structural —
// enforcement code (./enforcement.ts) imports nothing from here, so no
// enforcement decision can reach this data. `local.yaml` deep-merges OVER
// `settings.yaml` (personal preference wins over team default).
//
// Absence is normal (personal file often missing) → empty config, not an error.
// A file that *is* present but malformed still fails closed (exit 3): a typo'd
// notify block should surface loudly, not vanish. Because enforcement never
// reads this, such a failure can only ever break a convenience surface, never a
// gate (invariant 11).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

export const AGENT_PROVIDERS = ['codex', 'claude-code'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const CODEX_SANDBOX_MODES = ['danger-full-access'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type ConvenienceConfigLayer = 'settings' | 'local';

export interface ConvenienceConfig {
  agent?: {
    provider?: AgentProvider;
    codex_sandbox?: CodexSandboxMode;
  };
  models: Record<string, string>;
  notify: Record<string, unknown>;
}

const settingsAgentSchema = z.strictObject({ provider: z.enum(AGENT_PROVIDERS) });
const localAgentSchema = z.strictObject({
  provider: z.enum(AGENT_PROVIDERS).optional(),
  codex_sandbox: z.enum(CODEX_SANDBOX_MODES).optional(),
});

const convenienceSchema = (layer: ConvenienceConfigLayer) =>
  z.strictObject({
    agent: (layer === 'local' ? localAgentSchema : settingsAgentSchema).optional(),
    models: z.record(z.string(), z.string()).default({}),
    notify: z.record(z.string(), z.unknown()).default({}),
  });

/** Parse + validate one convenience file's YAML text. Empty → empty config. */
export function parseConvenienceFile(
  yamlText: string,
  source: string,
  layer: ConvenienceConfigLayer = 'settings',
): ConvenienceConfig {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_CONVENIENCE_CONFIG',
      `${source}: not valid YAML — ${cause instanceof Error ? cause.message : String(cause)}`,
      'Fix the YAML syntax in the convenience config.',
    );
  }

  // An empty file (null) is a valid, empty convenience config.
  const result = convenienceSchema(layer).safeParse(data ?? {});
  if (!result.success) {
    throw invalidInputError(
      'INVALID_CONVENIENCE_CONFIG',
      `${source}: invalid convenience config —\n${formatIssues(result.error)}`,
      'Only `agent`, `models`, and `notify` are allowed in settings.yaml / local.yaml.',
    );
  }
  const parsedAgent = result.data.agent;
  const agent =
    parsedAgent === undefined
      ? undefined
      : {
          ...(parsedAgent.provider !== undefined ? { provider: parsedAgent.provider } : {}),
          ...('codex_sandbox' in parsedAgent && parsedAgent.codex_sandbox !== undefined
            ? { codex_sandbox: parsedAgent.codex_sandbox }
            : {}),
        };
  return {
    ...(agent ? { agent } : {}),
    models: result.data.models,
    notify: result.data.notify,
  };
}

/**
 * Deep-merge `override` onto `base` (local over settings). Nested plain objects
 * merge recursively; scalars and arrays from `override` replace `base`.
 */
export function mergeConvenience(
  base: ConvenienceConfig,
  override: ConvenienceConfig,
): ConvenienceConfig {
  const agent =
    base.agent !== undefined || override.agent !== undefined
      ? { ...base.agent, ...override.agent }
      : undefined;
  return {
    ...(agent ? { agent } : {}),
    models: { ...base.models, ...override.models },
    notify: deepMerge(base.notify, override.notify),
  };
}

/** Read + merge `.crucible/settings.yaml` then `.crucible/local.yaml`. */
export function loadConvenienceConfig(configRoot: string): ConvenienceConfig {
  const dir = join(configRoot, '.crucible');
  const settings = readIfPresent(join(dir, 'settings.yaml'), 'settings');
  const local = readIfPresent(join(dir, 'local.yaml'), 'local');
  return mergeConvenience(settings, local);
}

const EMPTY: ConvenienceConfig = { models: {}, notify: {} };

function readIfPresent(path: string, layer: ConvenienceConfigLayer): ConvenienceConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return EMPTY;
    throw invalidInputError(
      'INVALID_CONVENIENCE_CONFIG',
      `${path}: could not be read — ${cause instanceof Error ? cause.message : String(cause)}`,
      'Check the file permissions on the convenience config.',
    );
  }
  return parseConvenienceFile(text, path, layer);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prior = out[key];
    out[key] = isPlainObject(prior) && isPlainObject(value) ? deepMerge(prior, value) : value;
  }
  return out;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${at}: ${issue.message}`;
    })
    .join('\n');
}
