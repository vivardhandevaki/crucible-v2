// Adapter manifest loader — `crucible-adapter.yaml` (charter §Adapter Manifest
// & Transport). The manifest declares how an adapter is spawned: its runners,
// capabilities, and the invocation string per verb.
//
// The manifest is part of the TCB: the client spawns exactly what this file
// names, so a malformed manifest must fail closed at exit 3 (invariant 3) — a
// client that guesses invocation strings, or silently drops a typo'd key, is a
// bypass vector (architecture.md §4: "typo'd keys must not silently no-op").
// This module imports no test framework and no adapter; it only parses YAML.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError, preconditionError } from '../util/errors.js';

// `.strictObject` at every level: an unrecognized key fails rather than being
// stripped (fail-closed). `invocations` requires resolve + run; scope is
// optional (charter: "scope skipped for v2.0"). Invocation strings are the raw
// command lines the client tokenizes and spawns.
const manifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  runners: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  invocations: z.strictObject({
    resolve: z.string().min(1),
    run: z.string().min(1),
    scope: z.string().min(1).optional(),
  }),
});

export type AdapterManifest = z.infer<typeof manifestSchema>;

/** Parse + validate an adapter manifest from raw YAML text. Throws exit 3. */
export function parseManifest(yamlText: string, source: string): AdapterManifest {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (cause) {
    throw invalidInputError(
      'INVALID_ADAPTER_MANIFEST',
      `${source}: not valid YAML — ${messageOf(cause)}`,
      'Fix the YAML syntax in crucible-adapter.yaml.',
    );
  }

  const result = manifestSchema.safeParse(data);
  if (!result.success) {
    throw invalidInputError(
      'INVALID_ADAPTER_MANIFEST',
      `${source}: invalid adapter manifest —\n${formatIssues(result.error)}`,
      'Fix crucible-adapter.yaml against charter §Adapter Manifest & Transport.',
    );
  }
  return result.data;
}

/** Read + parse an adapter manifest from disk. Missing file → exit 2. */
export function loadManifest(path: string): AdapterManifest {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_ADAPTER_MANIFEST',
        `No adapter manifest found at ${path}.`,
        'Run `crucible init` to install and pin an adapter.',
      );
    }
    throw invalidInputError(
      'INVALID_ADAPTER_MANIFEST',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on crucible-adapter.yaml.',
    );
  }
  return parseManifest(text, path);
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
