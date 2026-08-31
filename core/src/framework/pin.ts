// A governed project records the exact released Crucible package installed in
// its own tree. The pin is strict and fail-closed because it selects the
// harness running the enforcement gate.

import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { invalidInputError, preconditionError } from '../util/errors.js';

export const FRAMEWORK_PIN_RELPATH = '.crucible/framework.lock.json';

const frameworkPinSchema = z.strictObject({
  version: z.literal(2),
  package: z.literal('@crucible/core'),
  release: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'must be an exact released version'),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hash'),
});

export type FrameworkPin = z.infer<typeof frameworkPinSchema>;

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
        'Run `crucible init` from the released Crucible distribution.',
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
    'Use an exact @crucible/core release with its immutable content hash.',
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
