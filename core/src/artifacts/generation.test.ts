import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import {
  GENERATION_VERSION,
  checkStaleness,
  parseGeneration,
  readGenerationIfPresent,
  serializeGeneration,
  stampGeneration,
  type Generation,
} from './generation.js';

// TCB: generation.yaml is the staleness ledger (charter §Editing Artifacts). It
// must stamp per-artifact hashes in dependency order, detect a hand-edit to any
// UPSTREAM artifact as stale while treating a leaf (oracles) edit as safe, and
// fail closed on any malformed manifest (invariant 3). It is deterministic
// (invariant 12): the caller supplies the timestamp; same bytes → same stamp.

// The bundle's dependency order (upstream → downstream) for these tests.
const ORDER = ['proposal.md', 'design.md', 'specs/greeting/spec.md', 'oracles.md'] as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crucible-generation-'));
  writeFileSync(join(dir, 'proposal.md'), 'proposal v1\n');
  writeFileSync(join(dir, 'design.md'), 'design v1\n');
  writeFileSync(join(dir, 'oracles.md'), 'oracles v1\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write the nested spec file (specs/greeting/spec.md) the ORDER references. */
function writeSpec(content: string): void {
  const specDir = join(dir, 'specs', 'greeting');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, 'spec.md'), content);
}

function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected a CrucibleError to be thrown');
}

describe('stampGeneration — records hashes in dependency order', () => {
  it('stamps every artifact with its sha256, in the given order', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    expect(gen.version).toBe(GENERATION_VERSION);
    expect(gen.change).toBe('add-greeting');
    expect(gen.generated_at).toBe('2026-07-25T00:00:00Z');
    expect(gen.artifacts.map((a) => a.path)).toEqual([...ORDER]);
    for (const a of gen.artifacts) {
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is deterministic: same bytes + timestamp → identical stamp', () => {
    writeSpec('spec v1\n');
    const a = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    const b = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    expect(serializeGeneration(a)).toBe(serializeGeneration(b));
  });

  it('round-trips through serialize → parse unchanged', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    expect(parseGeneration(serializeGeneration(gen), 'generation.yaml')).toEqual(gen);
  });
});

describe('checkStaleness — upstream edit desyncs downstream (charter §Editing Artifacts)', () => {
  it('a freshly stamped, unedited bundle is not stale', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    expect(checkStaleness(dir, gen)).toEqual({ stale: false });
  });

  it('editing design.md after generation → stale, naming design + its downstream', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    writeFileSync(join(dir, 'design.md'), 'design v2 — hand-edited\n');
    const result = checkStaleness(dir, gen);
    expect(result.stale).toBe(true);
    if (result.stale) {
      expect(result.editedPath).toBe('design.md');
      // Everything generated after design is now suspect.
      expect(result.downstream).toEqual(['specs/greeting/spec.md', 'oracles.md']);
    }
  });

  it('editing an upstream spec → stale (oracles were generated before the edit)', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    writeSpec('spec v2 — new requirement\n');
    const result = checkStaleness(dir, gen);
    expect(result.stale).toBe(true);
    if (result.stale) {
      expect(result.editedPath).toBe('specs/greeting/spec.md');
      expect(result.downstream).toEqual(['oracles.md']);
    }
  });

  it('editing only the LEAF (oracles.md) is always safe — nothing depends on it', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    writeFileSync(join(dir, 'oracles.md'), 'oracles v2 — sharpened wording\n');
    expect(checkStaleness(dir, gen)).toEqual({ stale: false });
  });

  it('reports the FIRST (most-upstream) edited artifact when several changed', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    writeFileSync(join(dir, 'design.md'), 'design v2\n');
    writeSpec('spec v2\n');
    const result = checkStaleness(dir, gen);
    expect(result.stale).toBe(true);
    if (result.stale) expect(result.editedPath).toBe('design.md');
  });

  it('a vanished upstream artifact counts as stale (fail toward regeneration)', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    rmSync(join(dir, 'design.md'));
    const result = checkStaleness(dir, gen);
    expect(result.stale).toBe(true);
    if (result.stale) expect(result.editedPath).toBe('design.md');
  });
});

describe('readGenerationIfPresent — absence vs. corruption', () => {
  it('returns undefined when no generation.yaml exists (no lineage to check)', () => {
    expect(readGenerationIfPresent(join(dir, 'generation.yaml'))).toBeUndefined();
  });

  it('returns the parsed manifest when present and valid', () => {
    writeSpec('spec v1\n');
    const gen = stampGeneration(dir, 'add-greeting', ORDER, '2026-07-25T00:00:00Z');
    writeFileSync(join(dir, 'generation.yaml'), serializeGeneration(gen));
    expect(readGenerationIfPresent(join(dir, 'generation.yaml'))).toEqual(gen);
  });

  it('fails closed at exit 3 on a present-but-malformed manifest', () => {
    writeFileSync(join(dir, 'generation.yaml'), 'version: 1\nchange: x\n'); // missing fields
    const err = catchCrucible(() => readGenerationIfPresent(join(dir, 'generation.yaml')));
    expect(err.exit).toBe(3);
  });
});

describe('parseGeneration — fail closed on malformed input (invariant 3)', () => {
  it('rejects invalid YAML at exit 3', () => {
    const err = catchCrucible(() => parseGeneration('version: 1\n  bad: : :', 'generation.yaml'));
    expect(err.exit).toBe(3);
  });

  it('rejects an unknown top-level key at exit 3 (strict schema)', () => {
    const gen: Generation = {
      version: 1,
      change: 'x',
      generated_at: 't',
      artifacts: [{ path: 'proposal.md', hash: 'a'.repeat(64) }],
    };
    const withExtra = serializeGeneration(gen) + '\nbogus: nope\n';
    const err = catchCrucible(() => parseGeneration(withExtra, 'generation.yaml'));
    expect(err.exit).toBe(3);
  });

  it('rejects a non-hex artifact hash at exit 3', () => {
    const err = catchCrucible(() =>
      parseGeneration(
        'version: 1\nchange: x\ngenerated_at: t\nartifacts:\n  - path: proposal.md\n    hash: NOTHEX\n',
        'generation.yaml',
      ),
    );
    expect(err.exit).toBe(3);
  });

  it('rejects an empty artifacts array at exit 3', () => {
    const err = catchCrucible(() =>
      parseGeneration('version: 1\nchange: x\ngenerated_at: t\nartifacts: []\n', 'generation.yaml'),
    );
    expect(err.exit).toBe(3);
  });
});
