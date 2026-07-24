import { describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import {
  computeTier,
  parseTierName,
  renderTierDecision,
  tierDecisionSchema,
  TIER_NAMES,
  type TierConfigLike,
  type TierInputs,
} from './tier.js';

// `tier/` is the deterministic realization of the charter tier table (§Tier
// Definitions, §Tier Computation): facts in — spec-delta presence, touched paths,
// diff size, an optional `--tier` force — decision out. It is PURE (invariant 12):
// no I/O, no clock, no randomness; the git edge that assembles the facts is the
// caller's. These tests pin every row of the table plus the three honesty rules:
// risk-glob dominance, spec-delta ⇒ ≥ standard, and force-up-never-down.

/** The charter reference-shape config: risk globs + the three tier diff caps. */
const CONFIG: TierConfigLike = {
  risk: {
    critical: ['src/**/auth/**', 'src/**/payments/**', '**/pom.xml', '.crucible/**', 'crucible.yaml'],
    exempt: ['.crucible/settings.yaml', '.crucible/local.yaml'],
  },
  tiers: {
    trivial: { diff_cap: 150 },
    standard: { diff_cap: 400 },
    critical: { diff_cap: 400 },
  },
};

/** A fully-specified fact set; individual cases override only what they exercise. */
function facts(overrides: Partial<TierInputs> = {}): TierInputs {
  return {
    specDelta: false,
    touchedPaths: ['README.md'],
    diffLines: 10,
    forced: null,
    ...overrides,
  };
}

describe('computeTier — the charter table rows', () => {
  it('trivial: no spec delta, no risk match, within the trivial cap', () => {
    const d = computeTier(facts({ specDelta: false, touchedPaths: ['docs/x.md'], diffLines: 149 }), CONFIG);
    expect(d.tier).toBe('trivial');
    expect(d.computed).toBe('trivial');
    expect(d.facts.risk_matches).toEqual([]);
    expect(d.facts.diff_cap).toBe(150);
    expect(d.facts.cap_exceeded).toBe(false);
  });

  it('standard: spec delta present, no risk match', () => {
    const d = computeTier(facts({ specDelta: true, touchedPaths: ['src/greeting.ts'], diffLines: 20 }), CONFIG);
    expect(d.tier).toBe('standard');
    expect(d.facts.diff_cap).toBe(400);
  });

  it('critical: a risk-glob match', () => {
    const d = computeTier(facts({ specDelta: true, touchedPaths: ['src/api/auth/login.ts'] }), CONFIG);
    expect(d.tier).toBe('critical');
    expect(d.facts.risk_matches).toEqual([{ path: 'src/api/auth/login.ts', glob: 'src/**/auth/**' }]);
    expect(d.facts.diff_cap).toBe(400);
  });
});

describe('computeTier — honesty rule 1: risk-glob match dominates', () => {
  it('a "trivial" one-liner in a risk path is critical (no spec delta, tiny diff)', () => {
    const d = computeTier(
      facts({ specDelta: false, touchedPaths: ['src/x/payments/refund.ts'], diffLines: 1 }),
      CONFIG,
    );
    expect(d.tier).toBe('critical');
    expect(d.computed).toBe('critical');
    expect(d.facts.risk_matches[0]?.glob).toBe('src/**/payments/**');
  });

  it('risk match wins even when a spec delta is present', () => {
    const d = computeTier(facts({ specDelta: true, touchedPaths: ['pom.xml'], diffLines: 3 }), CONFIG);
    expect(d.tier).toBe('critical');
    expect(d.facts.risk_matches[0]?.glob).toBe('**/pom.xml');
  });

  it('records every distinct risk match, sorted by path', () => {
    const d = computeTier(
      facts({ touchedPaths: ['pom.xml', 'src/a/auth/x.ts', 'README.md'] }),
      CONFIG,
    );
    expect(d.facts.risk_matches).toEqual([
      { path: 'pom.xml', glob: '**/pom.xml' },
      { path: 'src/a/auth/x.ts', glob: 'src/**/auth/**' },
    ]);
  });
});

describe('computeTier — honesty rule 2: a spec delta guarantees at least standard', () => {
  it('spec delta with a tiny diff never falls to trivial', () => {
    const d = computeTier(facts({ specDelta: true, touchedPaths: ['src/x.ts'], diffLines: 1 }), CONFIG);
    expect(d.tier).toBe('standard');
  });
});

describe('computeTier — the diff-cap bump (a would-be-trivial change over its cap)', () => {
  it('no spec delta, no risk, diff over the trivial cap → standard', () => {
    const d = computeTier(facts({ specDelta: false, touchedPaths: ['docs/x.md'], diffLines: 151 }), CONFIG);
    expect(d.tier).toBe('standard');
    expect(d.reasons.join(' ')).toMatch(/exceeds trivial cap 150/);
  });

  it('exactly at the trivial cap stays trivial (boundary is inclusive)', () => {
    const d = computeTier(facts({ specDelta: false, touchedPaths: ['docs/x.md'], diffLines: 150 }), CONFIG);
    expect(d.tier).toBe('trivial');
  });

  it('honors a repo-tuned trivial cap', () => {
    const tuned: TierConfigLike = { ...CONFIG, tiers: { ...CONFIG.tiers, trivial: { diff_cap: 40 } } };
    expect(computeTier(facts({ diffLines: 41 }), tuned).tier).toBe('standard');
    expect(computeTier(facts({ diffLines: 40 }), tuned).tier).toBe('trivial');
  });
});

describe('computeTier — force up allowed, force down impossible', () => {
  it('forces trivial up to critical via --tier', () => {
    const d = computeTier(facts({ forced: 'critical', touchedPaths: ['docs/x.md'] }), CONFIG);
    expect(d.tier).toBe('critical');
    expect(d.computed).toBe('trivial');
    expect(d.forced).toBe('critical');
    expect(d.reasons.join(' ')).toMatch(/forced up to critical/);
    // The cap follows the EFFECTIVE (forced) tier, not the computed one.
    expect(d.facts.diff_cap).toBe(400);
  });

  it('forces trivial up to standard', () => {
    const d = computeTier(facts({ forced: 'standard', touchedPaths: ['docs/x.md'] }), CONFIG);
    expect(d.tier).toBe('standard');
  });

  it('refuses to force a computed-critical change DOWN to trivial', () => {
    const d = computeTier(
      facts({ forced: 'trivial', touchedPaths: ['src/x/auth/y.ts'], specDelta: true }),
      CONFIG,
    );
    expect(d.tier).toBe('critical');
    expect(d.computed).toBe('critical');
    expect(d.forced).toBe('trivial');
    expect(d.reasons.join(' ')).toMatch(/force down impossible/);
  });

  it('refuses to force a computed-standard change down to trivial', () => {
    const d = computeTier(facts({ forced: 'trivial', specDelta: true, touchedPaths: ['src/x.ts'] }), CONFIG);
    expect(d.tier).toBe('standard');
    expect(d.reasons.join(' ')).toMatch(/force down impossible/);
  });

  it('a redundant force (equal to computed) is a no-op', () => {
    const d = computeTier(facts({ forced: 'trivial', touchedPaths: ['docs/x.md'] }), CONFIG);
    expect(d.tier).toBe('trivial');
  });
});

describe('computeTier — exempt globs carve out of the risk set', () => {
  it('an exempt path matching a risk glob is not a risk match', () => {
    const d = computeTier(facts({ touchedPaths: ['.crucible/settings.yaml'], specDelta: false }), CONFIG);
    expect(d.facts.risk_matches).toEqual([]);
    expect(d.tier).toBe('trivial');
  });

  it('a non-exempt sibling under the same risk glob still matches', () => {
    const d = computeTier(facts({ touchedPaths: ['.crucible/rubric.yaml'] }), CONFIG);
    expect(d.tier).toBe('critical');
    expect(d.facts.risk_matches[0]?.glob).toBe('.crucible/**');
  });
});

describe('computeTier — glob semantics (gitignore-style)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['src/**/auth/**', 'src/auth/login.ts', true], // ** matches zero segments
    ['src/**/auth/**', 'src/a/b/auth/x.ts', true], // ** matches many segments
    ['src/**/auth/**', 'src/authorization/x.ts', false], // not the auth/ dir
    ['**/pom.xml', 'pom.xml', true], // leading **/ matches at the root
    ['**/pom.xml', 'modules/a/pom.xml', true],
    ['**/pom.xml', 'pom.xml.bak', false], // anchored at the end
    ['payments/**', 'payments/refund.ts', true],
    ['payments/**', 'payments', false], // the bare dir is not "contents"
    ['crucible.yaml', 'crucible.yaml', true], // no-slash pattern, exact basename
    ['crucible.yaml', 'src/crucible.yaml', true], // no-slash matches any depth
    ['*.md', 'README.md', true],
    ['*.md', 'docs/x.md', true], // no-slash → any depth
    ['*.md', 'x.mdx', false],
  ];
  for (const [glob, path, expected] of cases) {
    it(`${glob} ${expected ? 'matches' : 'rejects'} ${path}`, () => {
      const cfg: TierConfigLike = { risk: { critical: [glob], exempt: [] }, tiers: CONFIG.tiers };
      const matched = computeTier(facts({ touchedPaths: [path] }), cfg).facts.risk_matches.length > 0;
      expect(matched).toBe(expected);
    });
  }
});

describe('computeTier — determinism (invariant 12)', () => {
  it('same inputs → byte-identical decision across runs', () => {
    const input = facts({ specDelta: true, touchedPaths: ['src/x/auth/y.ts', 'a.ts'], diffLines: 200 });
    const a = computeTier(input, CONFIG);
    const b = computeTier(input, CONFIG);
    expect(a).toEqual(b);
  });

  it('touched-path order does not change the decision', () => {
    const a = computeTier(facts({ touchedPaths: ['a.ts', 'src/x/auth/y.ts'] }), CONFIG);
    const b = computeTier(facts({ touchedPaths: ['src/x/auth/y.ts', 'a.ts'] }), CONFIG);
    expect(a).toEqual(b);
  });

  it('the emitted decision validates against its own schema (trust boundary)', () => {
    const d = computeTier(facts({ specDelta: true, touchedPaths: ['src/x.ts'] }), CONFIG);
    expect(() => tierDecisionSchema.parse(d)).not.toThrow();
  });
});

describe('computeTier — fail-closed on a config missing a tier cap', () => {
  it('a config with no trivial cap fails closed (exit 3)', () => {
    const broken: TierConfigLike = {
      risk: { critical: [], exempt: [] },
      tiers: { standard: { diff_cap: 400 }, critical: { diff_cap: 400 } },
    };
    try {
      computeTier(facts({ specDelta: false, diffLines: 1 }), broken);
      expect.unreachable('expected a fail-closed error');
    } catch (err) {
      expect(isCrucibleError(err)).toBe(true);
      if (isCrucibleError(err)) expect(err.exit).toBe(3);
    }
  });
});

describe('parseTierName', () => {
  it('accepts each known tier', () => {
    for (const name of TIER_NAMES) expect(parseTierName(name)).toBe(name);
  });

  it('rejects an unknown tier fail-closed (exit 3), naming the valid set', () => {
    try {
      parseTierName('urgent');
      expect.unreachable('expected a fail-closed error');
    } catch (err) {
      expect(isCrucibleError(err)).toBe(true);
      if (isCrucibleError(err)) {
        expect(err.exit).toBe(3);
        expect(err.hint).toMatch(/trivial.*standard.*critical/);
      }
    }
  });
});

describe('renderTierDecision', () => {
  it('names the effective tier and the reasons', () => {
    const d = computeTier(facts({ touchedPaths: ['src/x/auth/y.ts'] }), CONFIG);
    const text = renderTierDecision(d);
    expect(text).toMatch(/critical/);
    expect(text).toMatch(/src\/x\/auth\/y\.ts/);
  });
});
