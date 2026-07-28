import { describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import { ratchetIssueSchema } from '../verifyx/report.js';
import {
  OVERRIDE_ISSUE_LABEL,
  OVERRIDE_VERSION,
  buildOverride,
  buildRatchetIssue,
  overrideSchema,
  parseOverride,
  serializeOverride,
  type Override,
} from './override.js';

// TCB: override.yaml is the 2am escape hatch (charter §Override; design §3). Its
// presence bypasses the automated gate, so its parser must fail closed on any
// defect (invariant 3) and its ratchet-issue payload must be deterministic and
// correctly shaped — CI files that payload verbatim.

const META = {
  version: OVERRIDE_VERSION,
  change: 'add-greeting',
  reason: 'prod incident: hotfix must ship before the postmortem',
  created_by: 'ada@example.com',
  created_at: '2026-07-25T02:00:00Z',
};

describe('override artifact — build + round-trip', () => {
  it('buildOverride produces a schema-valid artifact from its metadata', () => {
    const override = buildOverride(META);
    expect(() => overrideSchema.parse(override)).not.toThrow();
    expect(override).toMatchObject(META);
  });

  it('serialize → parse round-trips unchanged (deterministic bytes)', () => {
    const override = buildOverride(META);
    const text = serializeOverride(override);
    // Serialization is stable: same object → same bytes.
    expect(serializeOverride(override)).toBe(text);
    expect(parseOverride(text, 'override.yaml')).toEqual(override);
  });
});

describe('override artifact — fail-closed parsing (invariant 3)', () => {
  it('not valid YAML → exit 3', () => {
    try {
      parseOverride(':\n  not: [valid: yaml\n', 'override.yaml');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });

  it('an empty reason → exit 3 (a reasonless bypass is not honored)', () => {
    const text = serializeOverride({ ...buildOverride(META), reason: '' } as Override);
    try {
      parseOverride(text, 'override.yaml');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });

  it('an unknown key → exit 3 (strict schema)', () => {
    const text = serializeOverride(buildOverride(META)) + 'rogue: true\n';
    try {
      parseOverride(text, 'override.yaml');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });

  it('a missing required field → exit 3', () => {
    try {
      parseOverride('version: 1\nchange: add-greeting\n', 'override.yaml');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });
});

describe('override artifact — ratchet issue payload (design §3)', () => {
  it('builds a schema-valid payload labeled crucible-override', () => {
    const issue = buildRatchetIssue(buildOverride(META));
    expect(() => ratchetIssueSchema.parse(issue)).not.toThrow();
    expect(issue.labels).toContain(OVERRIDE_ISSUE_LABEL);
  });

  it('the title NAMES the change so CI can search for a duplicate (idempotency)', () => {
    const issue = buildRatchetIssue(buildOverride(META));
    expect(issue.title).toContain(META.change);
  });

  it('the body carries the reason + who/when + the closing condition', () => {
    const issue = buildRatchetIssue(buildOverride(META));
    expect(issue.body).toContain(META.reason);
    expect(issue.body).toContain(META.created_by);
    expect(issue.body).toContain(META.created_at);
    expect(issue.body.toLowerCase()).toContain('retroactive proposal');
  });

  it('is deterministic — same override → same payload (invariant 12)', () => {
    const a = buildRatchetIssue(buildOverride(META));
    const b = buildRatchetIssue(buildOverride(META));
    expect(a).toEqual(b);
  });
});
