// Detached CI reviewer transport (P4-14).
//
// This module is deliberately pure: workflow code obtains untrusted PR bytes,
// but only this canonical request/batch judge decides which bytes are bound to a
// reviewer result. The credentialed action may propose verdict JSON; it cannot
// choose the request, change set, rubric, prompt, or merge outcome.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Rubric } from './rubric.js';
import {
  evaluateVerdict,
  verdictSchema,
  type Observation,
  type VerdictOutcome,
} from './verdict.js';
import { invalidInputError } from '../util/errors.js';

export const CI_REVIEW_VERSION = 1;
export const CI_REVIEW_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const CI_REVIEW_MAX_DIFF_BYTES = 1024 * 1024;
export const CI_REVIEW_MAX_ARTIFACT_BYTES = 256 * 1024;
export const CI_REVIEW_MAX_VERDICT_BYTES = 256 * 1024;

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const repositorySchema = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
const changeNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const changeInputSchema = z.strictObject({
  name: changeNameSchema,
  approved_artifacts: z.record(z.string(), z.string()),
});

export const ciReviewRequestInputSchema = z.strictObject({
  repository: repositorySchema,
  pull_request: z.number().int().positive(),
  base_sha: shaSchema,
  head_sha: shaSchema,
  rubric: z.string(),
  prompt: z.string().min(1),
  diff: z.string(),
  changes: z.array(changeInputSchema),
});
export type CiReviewRequestInput = z.infer<typeof ciReviewRequestInputSchema>;

const requestChangeSchema = z.strictObject({
  name: changeNameSchema,
  approved_artifacts: z.record(z.string(), z.string()),
});

export const ciReviewRequestSchema = z.strictObject({
  version: z.literal(CI_REVIEW_VERSION),
  repository: repositorySchema,
  pull_request: z.number().int().positive(),
  base_sha: shaSchema,
  head_sha: shaSchema,
  rubric: z.string(),
  rubric_hash: z.string().regex(/^[0-9a-f]{64}$/),
  prompt: z.string().min(1),
  prompt_hash: z.string().regex(/^[0-9a-f]{64}$/),
  diff: z.string(),
  changes: z.array(requestChangeSchema),
  request_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CiReviewRequest = z.infer<typeof ciReviewRequestSchema>;

const batchEntrySchema = verdictSchema;
export const ciReviewBatchSchema = z.strictObject({
  version: z.literal(CI_REVIEW_VERSION),
  request_hash: z.string().regex(/^[0-9a-f]{64}$/),
  base_sha: shaSchema,
  head_sha: shaSchema,
  changes: z.array(batchEntrySchema),
});

export type CiReviewBatchOutcome =
  | { status: 'pass'; observations: Observation[] }
  | { status: 'fail'; code: string; reason: string; observations: Observation[] };

/**
 * Canonicalize and bind an inert CI review request. All caller input is strict;
 * malformed paths and size overflows abort before a credentialed action starts.
 */
export function makeCiReviewRequest(input: CiReviewRequestInput): CiReviewRequest {
  const parsed = ciReviewRequestInputSchema.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_CI_REVIEW_REQUEST', issue(parsed.error));
  const value = parsed.data;

  const changes = [...value.changes]
    .map((change) => ({
      name: change.name,
      approved_artifacts: canonicalArtifacts(change.approved_artifacts),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set<string>();
  for (const change of changes) {
    if (names.has(change.name))
      throw invalid('INVALID_CI_REVIEW_REQUEST', `duplicate change ${change.name}`);
    names.add(change.name);
  }
  if (byteLength(value.diff) > CI_REVIEW_MAX_DIFF_BYTES) {
    throw invalid('INVALID_CI_REVIEW_REQUEST', `diff exceeds ${CI_REVIEW_MAX_DIFF_BYTES} bytes`);
  }

  const base = {
    version: 1 as const,
    repository: value.repository,
    pull_request: value.pull_request,
    base_sha: value.base_sha,
    head_sha: value.head_sha,
    rubric: value.rubric,
    rubric_hash: sha256(value.rubric),
    prompt: value.prompt,
    prompt_hash: sha256(value.prompt),
    diff: value.diff,
    changes,
  };
  if (byteLength(stableJson(base)) > CI_REVIEW_MAX_REQUEST_BYTES) {
    throw invalid(
      'INVALID_CI_REVIEW_REQUEST',
      `request exceeds ${CI_REVIEW_MAX_REQUEST_BYTES} bytes`,
    );
  }
  return { ...base, request_hash: sha256(stableJson(base)) };
}

/** Strictly judge a batch emitted by the credentialed action. */
export function judgeCiReviewBatch(input: {
  text: string | undefined;
  request: CiReviewRequest;
  rubric: Rubric;
}): CiReviewBatchOutcome {
  if (input.text === undefined)
    return fail('NO_BATCH_VERDICT', 'no reviewer batch verdict was produced');
  if (byteLength(input.text) > CI_REVIEW_MAX_VERDICT_BYTES) {
    return fail(
      'BATCH_VERDICT_TOO_LARGE',
      `reviewer batch verdict exceeds ${CI_REVIEW_MAX_VERDICT_BYTES} bytes`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.text);
  } catch (cause) {
    return fail(
      'MALFORMED_BATCH_VERDICT',
      `reviewer batch verdict is not JSON — ${messageOf(cause)}`,
    );
  }
  const parsed = ciReviewBatchSchema.safeParse(raw);
  if (!parsed.success)
    return fail(
      'MALFORMED_BATCH_VERDICT',
      `reviewer batch verdict invalid — ${issue(parsed.error)}`,
    );
  const batch = parsed.data;
  if (
    batch.request_hash !== input.request.request_hash ||
    batch.base_sha !== input.request.base_sha ||
    batch.head_sha !== input.request.head_sha
  ) {
    return fail('BATCH_BINDING_MISMATCH', 'reviewer batch does not bind to this request/base/head');
  }

  const expected = new Set(input.request.changes.map((change) => change.name));
  const seen = new Set<string>();
  const observations: Observation[] = [];
  for (const verdict of batch.changes) {
    if (!expected.has(verdict.change) || seen.has(verdict.change)) {
      return fail(
        'BATCH_CHANGE_SET_MISMATCH',
        `reviewer batch has an unexpected or duplicate change ${verdict.change}`,
      );
    }
    seen.add(verdict.change);
    if (verdict.reviewed_sha !== input.request.head_sha) {
      return fail('VERDICT_HEAD_MISMATCH', `verdict for ${verdict.change} names a different head`);
    }
    const outcome: VerdictOutcome = evaluateVerdict({
      text: JSON.stringify(verdict),
      rubric: input.rubric,
      expectedRubricHash: input.request.rubric_hash,
    });
    observations.push(...outcome.observations);
    if (outcome.status === 'fail') return fail(outcome.code, outcome.reason, observations);
  }
  if (seen.size !== expected.size)
    return fail(
      'BATCH_CHANGE_SET_MISMATCH',
      'reviewer batch omitted a requested change',
      observations,
    );
  return { status: 'pass', observations };
}

function canonicalArtifacts(artifacts: Record<string, string>): Record<string, string> {
  const sorted = Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, string> = {};
  for (const [path, text] of sorted) {
    if (!isSafePath(path))
      throw invalid('INVALID_CI_REVIEW_REQUEST', `artifact path is unsafe: ${path}`);
    if (byteLength(text) > CI_REVIEW_MAX_ARTIFACT_BYTES) {
      throw invalid(
        'INVALID_CI_REVIEW_REQUEST',
        `artifact ${path} exceeds ${CI_REVIEW_MAX_ARTIFACT_BYTES} bytes`,
      );
    }
    result[path] = text;
  }
  return result;
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function invalid(code: string, message: string): ReturnType<typeof invalidInputError> {
  return invalidInputError(
    code,
    message,
    'Fix the target-branch CI reviewer input; no reviewer action was started.',
  );
}

function issue(error: z.ZodError): string {
  const first = error.issues[0]!;
  return `${first.path.join('.') || '(root)'}: ${first.message}`;
}

function fail(
  code: string,
  reason: string,
  observations: Observation[] = [],
): CiReviewBatchOutcome {
  return { status: 'fail', code, reason, observations };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
