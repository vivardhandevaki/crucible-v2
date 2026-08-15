import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import { buildOverride, serializeOverride } from '../artifacts/override.js';
import { loadEnforcementConfig } from '../config/enforcement.js';
import { aggregateRoute, routeDecision } from './route-decision.js';

const CHANGE = 'add-greeting';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-route-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('routeDecision — deterministic, non-executing routing', () => {
  it('recomputes standard routing from target config and candidate diff facts', () => {
    const decision = routeDecision(root, CHANGE, loadEnforcementConfig(root), {
      touchedPaths: ['src/greeting.ts'],
      diffLines: 10,
    });

    expect(decision.decision).toBe('auto');
  });

  it('routes a target-config risk match to human without invoking an adapter', () => {
    const decision = routeDecision(root, CHANGE, loadEnforcementConfig(root), {
      touchedPaths: ['src/app/auth/login.ts'],
      diffLines: 10,
    });

    expect(decision.decision).toBe('human');
  });

  it('fails closed when an override artifact is malformed', () => {
    writeFileSync(
      join(root, 'openspec', 'changes', CHANGE, 'override.yaml'),
      'version: not-a-number\n',
      'utf8',
    );

    expect(() =>
      routeDecision(root, CHANGE, loadEnforcementConfig(root), {
        touchedPaths: ['src/greeting.ts'],
        diffLines: 10,
      }),
    ).toThrow(/override\.yaml invalid/);
  });
  it('rejects an override when target-branch human review is advisory', () => {
    writeFileSync(
      join(root, 'crucible.yaml'),
      'risk:\n  critical: []\n  exempt: []\ntiers:\n  trivial: { diff_cap: 150 }\n  standard: { diff_cap: 400 }\n  critical: { diff_cap: 400, mutation: blocking }\ntrajectory:\n  require_local_verify: true\n  iteration_budget: 12\naudit:\n  sample_rate: 0.1\nreview:\n  ci_mode: advisory\n  human_mode: advisory\n',
      'utf8',
    );
    writeFileSync(
      join(root, 'openspec', 'changes', CHANGE, 'override.yaml'),
      serializeOverride(
        buildOverride({
          version: 1,
          change: CHANGE,
          reason: 'emergency',
          created_by: 'ada@example.com',
          created_at: '2026-08-15T00:00:00Z',
        }),
      ),
      'utf8',
    );

    expect(() =>
      routeDecision(root, CHANGE, loadEnforcementConfig(root), {
        touchedPaths: ['src/greeting.ts'],
        diffLines: 10,
      }),
    ).toThrow(/independent human review.*required/i);
  });

  it('aggregates human when any governed change needs it', () => {
    const auto = routeDecision(root, CHANGE, loadEnforcementConfig(root), {
      touchedPaths: ['src/greeting.ts'],
      diffLines: 10,
    });
    const human = routeDecision(root, CHANGE, loadEnforcementConfig(root), {
      touchedPaths: ['src/app/auth/login.ts'],
      diffLines: 10,
    });

    expect(aggregateRoute([auto, human])).toEqual(human);
  });

  it('fails closed when the governed bundle is absent', () => {
    try {
      routeDecision(root, 'missing', loadEnforcementConfig(root), {
        touchedPaths: [],
        diffLines: 0,
      });
      throw new Error('expected a CrucibleError');
    } catch (error) {
      expect(isCrucibleError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('NO_CHANGE');
    }
  });
});
