import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGE_TYPES,
  DEFAULT_CHANGE_TYPE,
  assertTypeConformance,
  inferType,
  parseTypeName,
  readChangeType,
  schemaForType,
  typeForSchema,
  validateType,
  type ChangeType,
  type TypeFacts,
} from './changetype.js';
import { isCrucibleError } from '../util/errors.js';

/** Facts for a full, conformant feature bundle (override per-case). */
function facts(overrides: Partial<TypeFacts> = {}): TypeFacts {
  return { specDelta: true, oracleCount: 1, reproductionOracleCount: 0, ...overrides };
}

describe('schema ↔ type mapping', () => {
  it('maps every type to a distinct sibling schema and round-trips', () => {
    const schemas = CHANGE_TYPES.map(schemaForType);
    expect(new Set(schemas).size).toBe(CHANGE_TYPES.length); // distinct
    for (const type of CHANGE_TYPES) {
      expect(typeForSchema(schemaForType(type))).toBe(type);
    }
  });

  it('feature is the crucible schema and the default type', () => {
    expect(schemaForType('feature')).toBe('crucible');
    expect(DEFAULT_CHANGE_TYPE).toBe('feature');
  });

  it('an unknown schema pin is fail-closed (exit 3)', () => {
    try {
      typeForSchema('spec-driven');
      expect.unreachable('unknown schema must throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
      expect((err as Error).message).toContain('spec-driven');
    }
  });
});

describe('parseTypeName (--type)', () => {
  it('accepts each known type', () => {
    for (const type of CHANGE_TYPES) expect(parseTypeName(type)).toBe(type);
  });

  it('rejects an unknown type with exit 3 naming the valid set', () => {
    try {
      parseTypeName('chore');
      expect.unreachable('unknown --type must throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
      expect((err as Error).message).toContain('chore');
    }
  });
});

describe('inferType', () => {
  const cases: Array<[string, ChangeType]> = [
    ['Add a greet(name) function that returns a friendly message', 'feature'],
    ['Support exporting reports as CSV', 'feature'],
    ['Fix the crash when the name is empty', 'bugfix'],
    ['Resolve the login regression introduced last week', 'bugfix'],
    ['The parser is broken on nested fences — fix it', 'bugfix'],
    ['Refactor the tier module to remove duplication', 'refactor'],
    ['Rename greet to greeting across the codebase', 'refactor'],
    ['Extract the glob matcher into its own helper', 'refactor'],
    ['Clean up the verify command, no behavior change', 'refactor'],
  ];
  it.each(cases)('infers %j → %s', (intent, expected) => {
    expect(inferType(intent)).toBe(expected);
  });

  it('is deterministic: refactor signal dominates a co-occurring bugfix word', () => {
    // "fix" is generic and co-occurs with refactors; the refactor word wins.
    expect(inferType('Refactor the auth module to fix its messy structure')).toBe('refactor');
  });

  it('empty / whitespace intent falls back to the feature default', () => {
    expect(inferType('')).toBe('feature');
    expect(inferType('   ')).toBe('feature');
  });
});

describe('validateType — conformance rules (pure)', () => {
  it('a full feature bundle is conformant', () => {
    expect(validateType('feature', facts())).toEqual([]);
  });

  it('feature imposes no shape rules (spec delta / oracles optional here)', () => {
    expect(validateType('feature', facts({ specDelta: false, oracleCount: 0 }))).toEqual([]);
  });

  it('a conformant refactor has no spec delta and zero oracles', () => {
    expect(validateType('refactor', facts({ specDelta: false, oracleCount: 0 }))).toEqual([]);
  });

  it('refactor + spec delta → violation', () => {
    const v = validateType('refactor', facts({ specDelta: true, oracleCount: 0 }));
    expect(v.map((x) => x.rule)).toEqual(['refactor-no-spec-delta']);
  });

  it('refactor + oracles → violation', () => {
    const v = validateType('refactor', facts({ specDelta: false, oracleCount: 2 }));
    expect(v.map((x) => x.rule)).toEqual(['refactor-no-oracles']);
  });

  it('refactor with both defects reports both, in order', () => {
    const v = validateType('refactor', facts({ specDelta: true, oracleCount: 1 }));
    expect(v.map((x) => x.rule)).toEqual(['refactor-no-spec-delta', 'refactor-no-oracles']);
  });

  it('a bugfix with a reproduction oracle is conformant', () => {
    expect(
      validateType('bugfix', facts({ specDelta: false, oracleCount: 1, reproductionOracleCount: 1 })),
    ).toEqual([]);
  });

  it('a bugfix with oracles but none marked reproduces → violation', () => {
    const v = validateType('bugfix', facts({ oracleCount: 2, reproductionOracleCount: 0 }));
    expect(v.map((x) => x.rule)).toEqual(['bugfix-needs-reproduction']);
  });
});

describe('assertTypeConformance — fail-closed gate', () => {
  it('passes silently on a conformant bundle', () => {
    expect(() => assertTypeConformance('refactor', facts({ specDelta: false, oracleCount: 0 }))).not.toThrow();
  });

  it('refactor with a spec delta throws exit 3 (the P2-07 acceptance)', () => {
    try {
      assertTypeConformance('refactor', facts({ specDelta: true, oracleCount: 0 }));
      expect.unreachable('refactor + spec delta must fail closed');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
      expect((err as Error).message).toContain('spec delta');
    }
  });

  it('bugfix without a reproduction oracle throws exit 3', () => {
    try {
      assertTypeConformance('bugfix', facts({ reproductionOracleCount: 0 }));
      expect.unreachable('bugfix without reproduction must fail closed');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
      expect((err as Error).message).toContain('reproduces');
    }
  });
});

describe('readChangeType — the .openspec.yaml pin', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crucible-ct-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads each shipped schema pin back to its type', () => {
    for (const type of CHANGE_TYPES) {
      writeFileSync(join(dir, '.openspec.yaml'), `schema: ${schemaForType(type)}\ncreated: 2026-07-25\n`);
      expect(readChangeType(dir)).toBe(type);
    }
  });

  it('an absent .openspec.yaml defaults to feature (P1-era bundle)', () => {
    expect(readChangeType(dir)).toBe('feature');
  });

  it('a file with no schema key defaults to feature', () => {
    writeFileSync(join(dir, '.openspec.yaml'), `created: 2026-07-25\n`);
    expect(readChangeType(dir)).toBe('feature');
  });

  it('an unknown pinned schema is fail-closed exit 3', () => {
    writeFileSync(join(dir, '.openspec.yaml'), `schema: spec-driven\n`);
    try {
      readChangeType(dir);
      expect.unreachable('unknown pin must throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });

  it('a non-string schema value is fail-closed exit 3', () => {
    writeFileSync(join(dir, '.openspec.yaml'), `schema:\n  - crucible\n`);
    try {
      readChangeType(dir);
      expect.unreachable('non-string schema must throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });

  it('unparseable YAML is fail-closed exit 3', () => {
    writeFileSync(join(dir, '.openspec.yaml'), `schema: : :\n  - [unbalanced\n`);
    try {
      readChangeType(dir);
      expect.unreachable('malformed yaml must throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  });
});
