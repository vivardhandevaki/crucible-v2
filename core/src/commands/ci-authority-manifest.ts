import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

const schema = z
  .strictObject({
    version: z.literal(1),
    lane: z.enum(['governed', 'framework-bootstrap', 'authority-finalization', 'archive']),
    changes: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
    base_sha: sha,
    head_sha: sha,
    snapshot_hash: hash,
  })
  .superRefine((value, ctx) => {
    const sorted = [...value.changes].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(value.changes)) {
      ctx.addIssue({
        code: 'custom',
        message: 'changes must be sorted and unique',
        path: ['changes'],
      });
    }
    if (value.lane === 'governed' && value.changes.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'governed lane requires at least one change',
        path: ['changes'],
      });
    }
    if (
      (value.lane === 'framework-bootstrap' || value.lane === 'authority-finalization') &&
      value.changes.length !== 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-governed bootstrap/finalization lanes cannot name changes',
        path: ['changes'],
      });
    }
    if (value.lane === 'archive' && value.changes.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'archive lane requires exactly one change',
        path: ['changes'],
      });
    }
  });

export type CiAuthorityManifest = z.infer<typeof schema>;

export function serializeCiAuthorityManifest(value: CiAuthorityManifest): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw manifestError('authority manifest', parsed.error.message);
  return JSON.stringify(parsed.data) + '\n';
}

export function parseCiAuthorityManifest(text: string, source: string): CiAuthorityManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw manifestError(source, 'not valid JSON — ' + messageOf(cause));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw manifestError(
      source,
      (issue?.path.join('.') || '(root)') + ': ' + (issue?.message || 'invalid'),
    );
  }
  return parsed.data;
}

function manifestError(source: string, detail: string) {
  return invalidInputError(
    'INVALID_CI_AUTHORITY_MANIFEST',
    source + ': invalid CI authority manifest — ' + detail,
    'Re-run the target-owned authority stage; do not hand-edit its handoff.',
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
