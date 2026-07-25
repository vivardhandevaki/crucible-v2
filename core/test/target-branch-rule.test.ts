import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnforcementConfig } from '../src/config/enforcement.js';
import { verify, type DiffFacts, type VerifyDeps } from '../src/commands/verify.js';
import type { ResolveFn, TargetResolution } from '../src/lint/traceability.js';
import type { Oracle } from '../src/artifacts/oracles.js';
import type { OracleResult } from '../src/adapters/types.js';

// ─── P2-18: THE TARGET-BRANCH RULE — INVARIANT #7's PERMANENT REGRESSION ANCHOR ─
//
// Charter §The Target-Branch Rule: "CI evaluates enforcement config from the
// branch being merged INTO, never from the PR branch. The rules that judge you
// are the rules already on main." P1-15 shipped only the *structural* half (the
// workflow sources config from origin/<base_ref>, asserted by parsing the YAML)
// because P1 `verify` did not yet CONSUME config. P2-03 made verify consume it;
// this test is the **behavioral** half — the analog of P1-16 (the tracer) for
// invariant #7, and it stays green for every future phase.
//
// The escape it locks out: a PR that LOOSENS a risk glob in its own crucible.yaml
// to dodge human review. Because CI extracts the config from the target branch
// (git show origin/main:crucible.yaml → outside the PR tree) and hands it to
// verify via --config-from, the loosening is inert for that PR — the change is
// still routed to human. Only after the loosening MERGES to main does it take
// effect (and merging crucible.yaml itself requires human review, since it is in
// its own risk globs). Two PRs, by design.
//
// HARNESS (resolved for P2-18; see docs/design/phase-2.md §2): a hermetic
// test-repo, not `act`. A real temp git repo + the real config-extraction command
// (`git show <target>:crucible.yaml`) + the real `verify` core consuming the
// extracted config with real git diff facts. The adapter is orthogonal to
// invariant #7, so oracle resolve/run are injected pass-throughs (the tracer,
// P1-16, already covers the real stub-adapter path end-to-end). `act` was
// rejected: the framework CI is pure Node/npm with no act/runner images, so it
// would either add heavy infra or not gate most PRs, and the route job's
// reviews-API call still needs mocking — fidelity the structural template test
// (ci-templates/src/crucible-template.test.ts) already provides for the YAML.

const CHANGE = 'add-greeting';

/** Strict target-branch config: everything under src/** is critical. */
const STRICT = `risk:
  critical:
    - "src/**"
  exempt: []
tiers:
  trivial: { diff_cap: 150 }
  standard: { diff_cap: 400 }
  critical: { diff_cap: 400 }
trajectory:
  require_local_verify: true
audit:
  sample_rate: 0.1
`;

/** The same config with the src/** glob loosened away — no path is critical. */
const LOOSE = `risk:
  critical: []
  exempt: []
tiers:
  trivial: { diff_cap: 150 }
  standard: { diff_cap: 400 }
  critical: { diff_cap: 400 }
trajectory:
  require_local_verify: true
audit:
  sample_rate: 0.1
`;

/** Resolver/runner stubs: every binding resolves + every oracle passes (green).
 * The adapter is not what invariant #7 is about; the tracer covers the real one. */
const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((target): TargetResolution => ({ target, status: 'found', targetFile: 'x' })),
  );
const runAllPass = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o): OracleResult => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: 'pass',
      targets: o.binding.targets.map((t) => ({ target: t, status: 'pass' as const })),
    })),
  );
/** A runner whose first oracle fails — drives the "verify red → check red" case. */
const runFirstFails = (oracles: readonly Oracle[]): Promise<OracleResult[]> =>
  Promise.resolve(
    oracles.map((o, i): OracleResult => ({
      oracleId: o.id,
      requirement: o.binding.requirement,
      status: i === 0 ? 'fail' : 'pass',
      targets: o.binding.targets.map((t) => ({ target: t, status: i === 0 ? 'fail' : 'pass' })),
    })),
  );

let scratch: string;

beforeEach(() => {
  // A real git repo: main carries the (strict) config + the change bundle; the PR
  // branch touches a src/** file AND loosens crucible.yaml.
  scratch = mkdtempSync(join(tmpdir(), 'crucible-tbr-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });

  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'anchor@example.com']);
  git(['config', 'user.name', 'anchor']);

  // main: strict config committed.
  writeFileSync(join(scratch, 'crucible.yaml'), STRICT, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base: strict config + change bundle']);

  // PR branch: touch a src/** file (matches main's critical glob) and loosen the
  // config so that, judged by the PR's OWN config, the change would be non-critical.
  git(['checkout', '-q', '-b', 'pr']);
  mkdirSync(join(scratch, 'src'), { recursive: true });
  writeFileSync(join(scratch, 'src', 'greeting.ts'), 'export const x = 1;\n', 'utf8');
  writeFileSync(join(scratch, 'crucible.yaml'), LOOSE, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'pr: loosen risk glob + touch src']);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Run git in the scratch repo (throws on failure — the setup must be sound). */
function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: scratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Extract the enforcement config from a git ref, mirroring the shipped workflow's
 * step (`git show origin/<base_ref>:crucible.yaml` → a dir outside the PR tree),
 * and return that dir for `--config-from`. This is the target-branch rule made
 * concrete: the config CI judges by never comes from the PR working tree.
 */
function extractConfigFrom(ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-target-'));
  writeFileSync(join(dir, 'crucible.yaml'), git(['show', `${ref}:crucible.yaml`]), 'utf8');
  return dir;
}

/** The real diff facts vs a base ref (what --diff-base computes in the CLI). */
function diffFacts(base: string): DiffFacts {
  const range = `${base}...HEAD`;
  const touchedPaths = git(['diff', '--name-only', range])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let diffLines = 0;
  for (const line of git(['diff', '--numstat', range]).split('\n')) {
    if (line.trim().length === 0) continue;
    const [added, deleted] = line.split('\t');
    diffLines += num(added) + num(deleted);
  }
  return { touchedPaths, diffLines };
}

function num(v: string | undefined): number {
  if (v === undefined || v === '-') return 0;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** verify the PR working tree using the config at `configDir`, diffing vs main. */
function verifyWith(configDir: string, overrides: Partial<VerifyDeps> = {}) {
  return verify(
    { root: scratch, change: CHANGE, config: loadEnforcementConfig(configDir) },
    { resolve: resolveAllFound, run: runAllPass, diffFacts: () => diffFacts('main'), ...overrides },
  );
}

describe('the target-branch rule (invariant #7) — behavioral anchor', () => {
  it('a PR that loosens its own risk glob is STILL routed to human (target config governs)', async () => {
    // CI extracts the config from the TARGET branch (main), where src/** is still
    // critical — never from the PR tree, which loosened it.
    const targetConfig = extractConfigFrom('main');
    const report = await verifyWith(targetConfig);

    // The change touches src/greeting.ts, which main's config marks critical →
    // routing human. The PR's loosening achieved nothing.
    expect(report.tier?.tier).toBe('critical');
    expect(report.routing?.decision).toBe('human');
    expect(report.tier?.facts.risk_matches.map((m) => m.path)).toContain('src/greeting.ts');
    // The change is otherwise green — a critical change is HELD for review, not failed.
    expect(report.verdict).toBe('pass');

    rmSync(targetConfig, { recursive: true, force: true });
  });

  it("the escape it blocks: judged by the PR's OWN loosened config it would auto-merge", async () => {
    // The counterfactual — the PR working-tree config exempts src/**. If CI had
    // (wrongly) read this, the critical change would slip onto the auto path. The
    // difference between this and the test above IS invariant #7.
    const report = await verifyWith(scratch); // scratch/crucible.yaml == LOOSE
    expect(report.tier?.tier).toBe('standard');
    expect(report.routing?.decision).toBe('auto');
  });

  it('the mirror: once the loosening has MERGED to the target branch, it auto-merges', async () => {
    // "Two PRs, by design": after the glob loosening lands on main, a subsequent
    // change judged by the (now-loosened) target config routes to auto.
    const loosenedTarget = mkdtempSync(join(tmpdir(), 'crucible-target-'));
    writeFileSync(join(loosenedTarget, 'crucible.yaml'), LOOSE, 'utf8');

    const report = await verifyWith(loosenedTarget);
    expect(report.tier?.tier).toBe('standard');
    expect(report.routing?.decision).toBe('auto');

    rmSync(loosenedTarget, { recursive: true, force: true });
  });

  it('verify red → check red still holds under the target-branch config', async () => {
    // Routing is orthogonal to the verdict: a red oracle run fails the verdict even
    // as the change routes to human — the gate stays fail-closed (invariant #3).
    const targetConfig = extractConfigFrom('main');
    const report = await verifyWith(targetConfig, { run: runFirstFails });

    expect(report.verdict).toBe('fail');
    expect(report.routing?.decision).toBe('human');

    rmSync(targetConfig, { recursive: true, force: true });
  });
});
