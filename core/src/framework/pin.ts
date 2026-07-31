// Validation-only framework source pin. Phase 4 deliberately defers public
// distribution, so a governed project records the exact Crucible GitHub commit
// CI must check out and build. The pin is strict and fail-closed because it
// selects the harness running the enforcement gate.

import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { invalidInputError, preconditionError } from '../util/errors.js';

export const FRAMEWORK_PIN_RELPATH = '.crucible/framework.lock.json';

const frameworkPinSchema = z.strictObject({
  version: z.literal(1),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be a GitHub owner/repository'),
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a lowercase 40-character Git commit SHA'),
});

export type FrameworkPin = z.infer<typeof frameworkPinSchema>;

/** Parse the explicit `owner/repository@40-char-sha` CLI override. */
export function parseFrameworkSource(value: string): FrameworkPin {
  const match = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})$/.exec(value);
  if (match === null) {
    throw invalidInputError(
      'INVALID_FRAMEWORK_SOURCE',
      `Invalid validation framework source ${JSON.stringify(value)}.`,
      'Use owner/repository@<lowercase-40-character-commit-sha>.',
    );
  }
  return { version: 1, repository: match[1]!, commit: match[2]! };
}

export function parseFrameworkPin(text: string, source: string): FrameworkPin {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalidPin(source, `not valid JSON — ${messageOf(error)}`);
  }
  const parsed = frameworkPinSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidPin(source, issues);
  }
  return parsed.data;
}

export function loadFrameworkPin(path: string): FrameworkPin {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw preconditionError(
        'NO_FRAMEWORK_PIN',
        `No validation framework pin found at ${path}.`,
        'Re-run `crucible init` from the pinned Crucible source checkout.',
      );
    }
    throw invalidPin(path, `could not be read — ${messageOf(error)}`);
  }
  return parseFrameworkPin(text, path);
}

export function serializeFrameworkPin(pin: FrameworkPin): string {
  const parsed = frameworkPinSchema.safeParse(pin);
  if (!parsed.success) throw invalidPin(FRAMEWORK_PIN_RELPATH, parsed.error.message);
  return `${JSON.stringify(parsed.data, null, 2)}\n`;
}

function invalidPin(source: string, detail: string) {
  return invalidInputError(
    'INVALID_FRAMEWORK_PIN',
    `${source}: invalid validation framework pin — ${detail}`,
    'Use a GitHub repository and immutable 40-character commit SHA.',
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
