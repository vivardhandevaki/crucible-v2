import { describe, expect, it } from 'vitest';
import { isCrucibleError, type CrucibleError } from '../util/errors.js';
import {
  ESCALATION_VERSION,
  buildEscalation,
  parseEscalation,
  serializeEscalation,
  type EscalationMeta,
} from './escalation.js';

// escalation.yaml is the structural teeth of the escalation layer (charter
// §Escalation — Three Enforcement Layers, layer 2; design phase-2.md §3): the
// agent files it on an ambiguity, its presence halts + refuses implement, and it
// is resolved through `crucible amend`. Like every Crucible artifact it is strict
// and fail-closed (invariant 3): an escalation we cannot parse is not an
// escalation we can honor, so it fails at exit 3 rather than being ignored.

const META: EscalationMeta = {
  version: ESCALATION_VERSION,
  change: 'refund-partial',
  oracle: 'ORC-refund-007',
  question: 'fee handling on a partial refund is not derivable from the spec delta',
  options: ['refund the fee pro-rata', 'retain the full fee', 'refund the fee in full'],
  filed_by: 'implement@crucible',
  filed_at: '2026-07-25T02:00:00Z',
};

function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('escalation — build + round-trip', () => {
  it('builds a valid artifact from caller metadata', () => {
    const esc = buildEscalation(META);
    expect(esc).toMatchObject({
      version: ESCALATION_VERSION,
      change: 'refund-partial',
      oracle: 'ORC-refund-007',
      question: META.question,
      options: META.options,
      filed_by: 'implement@crucible',
      filed_at: '2026-07-25T02:00:00Z',
    });
  });

  it('round-trips through serialize → parse unchanged (deterministic, invariant 12)', () => {
    const esc = buildEscalation(META);
    const text = serializeEscalation(esc);
    // Serialization is stable: same artifact → same bytes.
    expect(serializeEscalation(buildEscalation(META))).toBe(text);
    expect(parseEscalation(text, 'escalation.yaml')).toEqual(esc);
  });

  it('the oracle field is optional (an open-ended ambiguity may name no oracle)', () => {
    const rest: EscalationMeta = { ...META };
    delete rest.oracle;
    const esc = buildEscalation(rest);
    expect(esc.oracle).toBeUndefined();
    const parsed = parseEscalation(serializeEscalation(esc), 'escalation.yaml');
    expect(parsed.oracle).toBeUndefined();
  });
});

describe('escalation — fail-closed parsing (invariant 3, exit 3)', () => {
  it('rejects non-YAML text', () => {
    const err = catchCrucible(() => parseEscalation(':\n  - [unbalanced', 'escalation.yaml'));
    expect(err.exit).toBe(3);
  });

  it('rejects an empty question', () => {
    const bad = serializeEscalation(buildEscalation(META)).replace(META.question, '');
    const err = catchCrucible(() => parseEscalation(bad, 'escalation.yaml'));
    expect(err.exit).toBe(3);
  });

  it('rejects an escalation with no options (nothing actionable to resolve)', () => {
    const err = catchCrucible(() =>
      parseEscalation(
        'version: 1\nchange: c\nquestion: q\noptions: []\nfiled_by: x\nfiled_at: t\n',
        'escalation.yaml',
      ),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects an unknown key (strict schema)', () => {
    const bad = serializeEscalation(buildEscalation(META)) + 'sneaky: true\n';
    const err = catchCrucible(() => parseEscalation(bad, 'escalation.yaml'));
    expect(err.exit).toBe(3);
  });
});
