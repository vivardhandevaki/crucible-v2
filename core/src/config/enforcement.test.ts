import { readFileSync } from 'node:fs';
import { CONFIG_ROOT } from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import {
  enforcementConfigPath,
  loadEnforcementConfig,
  parseEnforcementConfig,
  resolveEnforcementRoot,
} from './enforcement.js';

// TCB: enforcement config is read from the target branch and decides what
// merges (invariant 7). Malformed or unknown-key config must fail closed at
// exit 3 (architecture.md §4), never silently no-op a typo'd glob key.

/** Grab the exit code off a thrown CrucibleError, or fail the test. */
function exitOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err.exit;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

const VALID = `
risk:
  critical: ["src/**/auth/**", "crucible.yaml"]
  exempt: [".crucible/settings.yaml"]
tiers:
  trivial: { diff_cap: 150 }
  critical: { diff_cap: 400, mutation: blocking }
adapters:
  stub: { runners: [stub], paths: ["**/*.ts"] }
suites:
  unit: "npm test"
trajectory:
  require_local_verify: true
  iteration_budget: 12
audit:
  sample_rate: 0.1
`;

describe('parseEnforcementConfig — valid', () => {
  it('parses the reference shape into a typed config', () => {
    const cfg = parseEnforcementConfig(VALID, 'inline');
    expect(cfg.risk.critical).toContain('crucible.yaml');
    expect(cfg.risk.exempt).toEqual(['.crucible/settings.yaml']);
    expect(cfg.tiers.trivial?.diff_cap).toBe(150);
    expect(cfg.tiers.critical?.mutation).toBe('blocking');
    expect(cfg.adapters.stub?.runners).toEqual(['stub']);
    expect(cfg.suites.unit).toBe('npm test');
    expect(cfg.trajectory.require_local_verify).toBe(true);
    expect(cfg.trajectory.iteration_budget).toBe(12);
    expect(cfg.audit.sample_rate).toBe(0.1);
  });

  it('defaults optional sections rather than leaving them undefined', () => {
    const cfg = parseEnforcementConfig(
      `
risk: { critical: [] }
tiers: { trivial: { diff_cap: 10 } }
trajectory: { require_local_verify: false }
audit: { sample_rate: 0 }
`,
      'inline',
    );
    expect(cfg.risk.exempt).toEqual([]);
    expect(cfg.adapters).toEqual({});
    expect(cfg.suites).toEqual({});
  });

  it('loads the committed fixture crucible.yaml', () => {
    const cfg = loadEnforcementConfig(CONFIG_ROOT);
    expect(cfg.tiers.critical?.mutation).toBe('blocking');
    expect(cfg.adapters.stub?.paths).toEqual(['**/*.ts']);
    // The fixture and the raw file agree — proves loadEnforcementConfig reads
    // the file this test thinks it does.
    expect(readFileSync(enforcementConfigPath(CONFIG_ROOT), 'utf8')).toContain('crucible.yaml');
  });
});

describe('parseEnforcementConfig — fail-closed (exit 3)', () => {
  it('rejects an unknown top-level enforcement key', () => {
    expect(exitOf(() => parseEnforcementConfig(VALID + '\nreward: 5\n', 'inline'))).toBe(3);
  });

  it('rejects an unknown key inside a tier (typo must not no-op)', () => {
    const bad = `
risk: { critical: [] }
tiers: { trivial: { diff_cap: 10, diffcap: 20 } }
trajectory: { require_local_verify: true }
audit: { sample_rate: 0 }
`;
    expect(exitOf(() => parseEnforcementConfig(bad, 'inline'))).toBe(3);
  });

  it('names the offending key in the error message', () => {
    let message = '';
    try {
      parseEnforcementConfig(VALID + '\nreward: 5\n', 'inline');
    } catch (err) {
      if (isCrucibleError(err)) message = err.message;
    }
    expect(message).toContain('reward');
    expect(message).toContain('inline');
  });

  it('rejects a wrong-typed field (diff_cap must be a number)', () => {
    const bad = `
risk: { critical: [] }
tiers: { trivial: { diff_cap: "big" } }
trajectory: { require_local_verify: true }
audit: { sample_rate: 0 }
`;
    expect(exitOf(() => parseEnforcementConfig(bad, 'inline'))).toBe(3);
  });

  it('rejects a bad mutation literal', () => {
    const bad = `
risk: { critical: [] }
tiers: { critical: { diff_cap: 400, mutation: advisory } }
trajectory: { require_local_verify: true }
audit: { sample_rate: 0 }
`;
    expect(exitOf(() => parseEnforcementConfig(bad, 'inline'))).toBe(3);
  });

  it('rejects a missing required section', () => {
    expect(exitOf(() => parseEnforcementConfig('risk: { critical: [] }', 'inline'))).toBe(3);
  });

  it('rejects malformed YAML', () => {
    expect(exitOf(() => parseEnforcementConfig('risk: [unclosed', 'inline'))).toBe(3);
  });

  it('rejects an empty file (no object at all)', () => {
    expect(exitOf(() => parseEnforcementConfig('', 'inline'))).toBe(3);
  });
});

describe('loadEnforcementConfig — missing file', () => {
  it('is a precondition (exit 2), naming the expected path', () => {
    let err: unknown;
    try {
      loadEnforcementConfig('/nonexistent-crucible-root');
    } catch (e) {
      err = e;
    }
    expect(isCrucibleError(err)).toBe(true);
    if (isCrucibleError(err)) {
      expect(err.exit).toBe(2);
      expect(err.message).toContain('crucible.yaml');
    }
  });
});

describe('resolveEnforcementRoot — target-branch seam', () => {
  it('prefers --config-from when given (CI target-branch checkout)', () => {
    expect(resolveEnforcementRoot('/tmp/target-checkout', '/repo')).toBe('/tmp/target-checkout');
  });

  it('falls back to the working tree when --config-from is absent', () => {
    expect(resolveEnforcementRoot(undefined, '/repo')).toBe('/repo');
  });
});
