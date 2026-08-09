import { describe, expect, it } from 'vitest';
import { parseRubric, type Rubric } from './rubric.js';
import {
  CI_REVIEW_MAX_REQUEST_BYTES,
  judgeCiReviewBatch,
  makeCiReviewRequest,
  type CiReviewRequestInput,
} from './ci.js';

const RUBRIC: Rubric = parseRubric(
  `version: 1
lines:
  - id: R-001
    severity: block
    criterion: block rule
    evidence: observable evidence
`,
  'rubric.yaml',
);

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function input(over: Partial<CiReviewRequestInput> = {}): CiReviewRequestInput {
  return {
    repository: 'acme/notes',
    pull_request: 42,
    base_sha: BASE,
    head_sha: HEAD,
    rubric: `version: 1\nlines: []\n`,
    prompt: 'Review only the supplied change data.',
    diff: 'diff --git a/a b/a\n+new\n',
    changes: [
      {
        name: 'create-note',
        approved_artifacts: {
          'openspec/changes/create-note/proposal.md': '# Proposal\n',
          'openspec/changes/create-note/oracles.md': '# Oracles\n',
        },
      },
    ],
    ...over,
  };
}

function batch(request: ReturnType<typeof makeCiReviewRequest>) {
  return JSON.stringify({
    version: 1,
    request_hash: request.request_hash,
    base_sha: request.base_sha,
    head_sha: request.head_sha,
    changes: request.changes.map((change) => ({
      change: change.name,
      reviewed_sha: HEAD,
      rubric_hash: request.rubric_hash,
      model: 'gpt-5.6-sol',
      verdict: 'pass',
      findings: [],
      observations: [],
    })),
  });
}

describe('P4-14 CI review request', () => {
  it('canonicalizes the change set and hashes every security-relevant input', () => {
    const first = makeCiReviewRequest(input());
    const second = makeCiReviewRequest(
      input({
        changes: [
          {
            name: 'z-last',
            approved_artifacts: { 'openspec/changes/z-last/proposal.md': '# Z\n' },
          },
          ...input().changes,
        ],
      }),
    );
    const reordered = makeCiReviewRequest(input({ changes: [...second.changes].reverse() }));

    expect(first.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.rubric_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.changes.map((c) => c.name)).toEqual(['create-note', 'z-last']);
    expect(reordered.request_hash).toBe(second.request_hash);
  });

  it('rejects duplicate changes, traversal artifact paths, and oversized data', () => {
    expect(() =>
      makeCiReviewRequest(input({ changes: [input().changes[0]!, input().changes[0]!] })),
    ).toThrow(/duplicate/i);
    expect(() =>
      makeCiReviewRequest(
        input({
          changes: [{ name: 'create-note', approved_artifacts: { '../secret': 'no' } }],
        }),
      ),
    ).toThrow(/path/i);
    expect(() =>
      makeCiReviewRequest(input({ diff: 'x'.repeat(CI_REVIEW_MAX_REQUEST_BYTES) })),
    ).toThrow(/exceeds/i);
  });
});

describe('P4-14 CI review batch judgment', () => {
  it('accepts exactly one bound passing verdict for each requested change', () => {
    const request = makeCiReviewRequest(input());
    const result = judgeCiReviewBatch({ text: batch(request), request, rubric: RUBRIC });
    expect(result.status).toBe('pass');
  });

  it('fails closed on stale bindings, extra results, and malformed agent output', () => {
    const request = makeCiReviewRequest(input());
    const stale = JSON.parse(batch(request));
    stale.head_sha = 'c'.repeat(40);
    expect(
      judgeCiReviewBatch({ text: JSON.stringify(stale), request, rubric: RUBRIC }).status,
    ).toBe('fail');

    const extra = JSON.parse(batch(request));
    extra.changes.push({ ...extra.changes[0], change: 'extra' });
    expect(
      judgeCiReviewBatch({ text: JSON.stringify(extra), request, rubric: RUBRIC }).status,
    ).toBe('fail');
    expect(
      judgeCiReviewBatch({ text: 'the agent said it passed', request, rubric: RUBRIC }).status,
    ).toBe('fail');
  });
});
