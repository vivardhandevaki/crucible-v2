import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STUB_ADAPTER_BIN_PATH,
  STUB_ADAPTER_MANIFEST_PATH,
  TOY_REPO_ROOT,
  VALID_BUNDLE_DIR,
} from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterClient } from '../src/adapters/client.js';
import { loadManifest } from '../src/adapters/manifest.js';
import type { Oracle } from '../src/artifacts/oracles.js';
import type { OracleResult } from '../src/adapters/types.js';
import type { ResolveFn } from '../src/lint/traceability.js';
import type { NotifyEvent } from '../src/notify/types.js';
import type { CheckResult, ReviewReport } from '../src/verifyx/report.js';
import { isCrucibleError } from '../src/util/errors.js';
import { readChangeType } from '../src/changetype/changetype.js';
import { loadEnforcementConfig } from '../src/config/enforcement.js';
import { rubricHash } from '../src/review/rubric.js';
import {
  liveWorktreeGit,
  runReproductionOnBase,
  worktreePathFor,
} from '../src/reproduction/reproduction.js';
import { approve } from '../src/commands/approve.js';
import { amend } from '../src/commands/amend.js';
import { escalate } from '../src/commands/escalate.js';
import { implement } from '../src/commands/implement.js';
import { propose } from '../src/commands/propose.js';
import { review } from '../src/commands/review.js';
import { verify, type DiffFacts, type VerifyDeps } from '../src/commands/verify.js';
import { FakeSubstrate } from '../src/substrate/fake.js';
import type { AgentSubstrate, SubstrateRequest } from '../src/substrate/types.js';

// ─── P2-17: the worked-examples integration suite — PERMANENT REGRESSION ANCHORS ─
//
// The Phase 2 exit criterion (PHASES.md Phase 2: "all three charter worked-example
// flows executable on toy repo"). One integration test per charter §Worked
// Examples flow, on fixtures/toy-repo:
//
//   1. Standard feature  — spec delta, no risk path → tier standard, routing AUTO.
//   2. Pure refactor     — no spec delta → tier trivial; correctness = the
//                          regression suite (a broken PAST promise turns it red).
//   3. Critical path     — risk-glob match → tier critical; mid-flight ambiguity
//                          halts implement, `amend` resolves it, routing → HUMAN;
//                          the follow-up `bugfix` is red-on-base / green-on-fix.
//
// Realness boundary (the P1-16 tracer's rule, extended): ONLY the agent sessions
// are faked (FakeSubstrate). Everything the framework's trust rests on is the real
// production path — the P1-11 client spawns the built stub adapter against each
// repo's tests.json (resolve + run); the seal, parsers, lint, tier/routing
// computation, the fail-closed verdict evaluator, and the real `git worktree`
// merge-base run all execute for real. These join P1-16 (tracer),
// bugfix-flow.test.ts (P2-08) and change-type-flow.test.ts (P2-07) as the
// behavioral anchors every later phase keeps green.
//
// A real-substrate mode (live Claude Code sessions) is documented for manual
// validation in docs/design/tracer-runbook.md §Worked examples; CI runs the
// FakeSubstrate variant only.

const MODEL = 'claude-opus-4-8';
const APPROVER = 'ada@example.com';

const manifest = loadManifest(STUB_ADAPTER_MANIFEST_PATH);

// The committed valid bundle's artifact bytes — a STANDARD feature (a spec delta
// with two SHALLs, both oracles bound to targets tests.json declares `pass`).
const FEATURE = 'add-greeting';
const FEATURE_REL = join('openspec', 'changes', FEATURE);
const FEATURE_BUNDLE: Record<string, string> = Object.fromEntries(
  ['proposal.md', 'design.md', 'oracles.md', join('specs', 'greeting', 'spec.md')].map((rel) => [
    join(FEATURE_REL, rel),
    readFileSync(join(VALID_BUNDLE_DIR, rel), 'utf8'),
  ]),
);

let scratch: string;
let now: () => string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-worked-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  // propose authors the bundle itself: start from a repo without the pre-baked one.
  rmSync(join(scratch, FEATURE_REL), { recursive: true, force: true });
  now = tickingClock();
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Injectable monotonic clock — deterministic, distinct per state event. */
function tickingClock(): () => string {
  let tick = 0;
  return () => `2026-07-29T00:00:${String(tick++).padStart(2, '0')}Z`;
}

/**
 * The REAL adapter edge: a P1-11 client that spawns the built stub adapter against
 * `root`'s tests.json — the same wiring the tracer uses, pointed at the scratch.
 */
function adapterDeps(root: string): {
  resolve: ResolveFn;
  run: (oracles: readonly Oracle[]) => Promise<OracleResult[]>;
} {
  const client = createAdapterClient({
    manifest,
    cwd: root,
    resolveExecutable: (name) =>
      name === 'crucible-adapter-stub'
        ? { command: process.execPath, prefixArgs: [STUB_ADAPTER_BIN_PATH] }
        : { command: name, prefixArgs: [] },
    extraArgs: ['--tests', 'tests.json'],
    timeoutMs: 10_000,
  });
  return { resolve: (t) => client.resolve(t), run: (o) => client.run(o) };
}

/** A scaffolder mimicking `openspec new change` — dir + .openspec.yaml pinned to schema. */
function fakeScaffold(root: string): (change: string, schema: string) => Promise<void> {
  return (change, schema) => {
    const dir = join(root, 'openspec', 'changes', change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.openspec.yaml'), `schema: ${schema}\ncreated: 2026-07-29\n`);
    return Promise.resolve();
  };
}

/** A propose/amend substrate scripted to author `files` as the change bundle. */
function proposeSubstrate(files: Record<string, string>): FakeSubstrate {
  return new FakeSubstrate({ files });
}

/** A two-session implement substrate: tasks breakdown first, then the code. */
function implementSubstrate(): FakeSubstrate {
  let call = 0;
  return new FakeSubstrate(() => {
    call += 1;
    return call === 1
      ? { files: { [join(FEATURE_REL, 'tasks.md')]: '# Tasks\n\n- [ ] 1.1 implement per spec\n' } }
      : {
          files: {
            [join('src', 'greeting.ts')]:
              'export const greet = (name: string): string =>\n' +
              "  `Hello, ${name === '' ? 'world' : name}!`;\n",
          },
        };
  });
}

// ─── Diff facts (the git edge, injected — design phase-2.md §2) ───────────────
//
// Tier is computed from the diff, independent of the bundle's contents: a change
// whose diff touches a risk glob is critical no matter what the artifacts say. The
// toy crucible.yaml routes `src/**/auth/**` (among others) to critical.

function facts(touchedPaths: string[], diffLines: number): () => DiffFacts {
  return () => ({ touchedPaths, diffLines });
}
const NON_RISK = facts(['src/greeting.ts'], 30); // spec delta + non-risk → standard
const SMALL_NON_RISK = facts(['src/greeting.ts'], 12); // no spec delta, < 150 cap → trivial
const RISK_PATH = facts(['src/app/auth/login.ts'], 20); // risk-glob match → critical

// ─── The real adversarial reviewer edge (a canned PASS verdict, real evaluator) ─
//
// verify takes the reviewer as one injected edge. We run the REAL `commands/review`
// flow — fresh-context session, caller-minted verdict path, the P2-09 fail-closed
// evaluator — with a FakeSubstrate that writes a well-formed pass verdict to the
// exact path the work order names. The verdict must pin THIS repo's rubric hash
// (core owns the expected value), so a green review here is the production law
// passing, not a stub.

function passVerdict(root: string, change: string): string {
  return JSON.stringify({
    change,
    reviewed_sha: 'HEAD',
    rubric_hash: rubricHash(join(root, '.crucible', 'rubric.yaml')),
    model: 'claude-haiku-4-5-20251001',
    verdict: 'pass',
    findings: [],
    observations: [{ note: 'Retry-path idempotency is untested.' }],
  });
}

function reviewEdge(
  root: string,
  change: string,
): () => Promise<{ check: CheckResult; review: ReviewReport }> {
  return async () => {
    const substrate = new FakeSubstrate((req: SubstrateRequest) => {
      const match = req.taskPayload.match(/(\.crucible\/verdicts\/\S+\.json)/);
      expect(match, 'review work order names the minted verdict path').toBeTruthy();
      return { files: { [match![1]!]: passVerdict(root, change) } };
    });
    const run = await review(
      { root, change, model: MODEL, base: 'origin/main', head: 'HEAD' },
      { substrate, now },
    );
    return { check: run.check, review: run.review };
  };
}

// ─── Flow drivers (real cores, real adapter; only the substrate is faked) ─────

function doPropose(
  change: string,
  substrate: AgentSubstrate,
  intent: string,
  type?: 'refactor' | 'feature',
) {
  const { resolve } = adapterDeps(scratch);
  return propose(
    { root: scratch, change, intent, model: MODEL, ...(type ? { type } : {}) },
    { substrate, scaffold: fakeScaffold(scratch), resolve, now },
  );
}

function doApprove(change: string) {
  const { resolve } = adapterDeps(scratch);
  return approve(
    { root: scratch, change, yes: true },
    {
      resolve,
      confirm: () => Promise.reject(new Error('confirm must not be called under --yes')),
      now,
      approvedBy: () => APPROVER,
    },
  );
}

function doImplement(change: string, substrate: AgentSubstrate) {
  const { resolve, run } = adapterDeps(scratch);
  return implement({ root: scratch, change, model: MODEL }, { substrate, resolve, run, now });
}

/** Authoritative verify: real adapter + enforcement config + diff facts + reviewer. */
function doVerify(change: string, diffFacts: () => DiffFacts, extra: Partial<VerifyDeps> = {}) {
  const { resolve, run } = adapterDeps(scratch);
  return verify(
    { root: scratch, change, config: loadEnforcementConfig(scratch) },
    { resolve, run, diffFacts, review: reviewEdge(scratch, change), ...extra },
  );
}

async function catchExit(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (err) {
    return isCrucibleError(err) ? err.exit : Promise.reject(err);
  }
  throw new Error('expected the call to throw a CrucibleError');
}

// ─── Example 1 — Standard feature ────────────────────────────────────────────
// charter §Worked Examples #1: "Lock accounts after 5 failed logins". A spec
// delta on a non-risk path → tier standard → the auto-merge path. (The toy
// analogue of the charter's account-lockout is the greeting feature.)

describe.skipIf(process.env['CRUCIBLE_REAL_SUBSTRATE'] === '1')(
  'Worked example 1 — standard feature: propose → approve → implement → verify → AUTO',
  () => {
    it('a spec-delta change on a non-risk path routes to auto-merge, all checks green', async () => {
      // propose: the fresh-context author writes the bundle; Crucible judges it.
      const proposed = await doPropose(
        FEATURE,
        proposeSubstrate(FEATURE_BUNDLE),
        'Greet a named user, defaulting to the world when empty.',
      );
      expect(proposed.report.verdict).toBe('pass');

      // approve --yes: the one human moment — the real seal over bundle + bound tests.
      expect((await doApprove(FEATURE)).approved).toBe(true);

      // implement: tasks then code, judged by a real local verify.
      expect((await doImplement(FEATURE, implementSubstrate())).report.verdict).toBe('pass');

      // CI authority verify: tier recomputed from the diff, reviewer run, all green.
      const report = await doVerify(FEATURE, NON_RISK);
      expect(report.verdict).toBe('pass');
      expect(report.tier?.tier).toBe('standard');
      expect(report.tier?.facts.risk_matches).toEqual([]);
      // The mechanical proof of "auto-merge": routing is auto for a green standard tier.
      expect(report.routing?.decision).toBe('auto');
      // The adversarial reviewer passed (real evaluator, real rubric pin).
      expect(report.checks.find((c) => c.name === 'review')?.status).toBe('pass');
      expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    });
  },
);

// ─── Example 2 — Pure refactor ───────────────────────────────────────────────
// charter §Worked Examples #2: "Extract retry logic into a shared module". No
// behavior change → no spec delta → no new oracles → tier trivial. Correctness is
// the ACCUMULATED REGRESSION SUITE: every past oracle must still pass, spec
// untouched. Trivial tier skips authoring ceremony, never executed checks.

const REFACTOR = 'tidy-greeting';
const REFACTOR_REL = join('openspec', 'changes', REFACTOR);
const ARCHIVED_TARGET = 'greeting::returns_hello_for_a_name'; // tests.json: pass

// One archived promise so the regression suite is NON-EMPTY — a refactor's whole
// correctness criterion. Its target is real (resolves + passes under the stub).
const ARCHIVED_ORACLE = `# Oracles

## ORC-greeting-001: Greeting returns hello for a name
**Given** a name
**When** \`greet(name)\` is called
**Then** it returns "Hello, <name>!"

\`\`\`yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: unit
runner: stub
target: ${ARCHIVED_TARGET}
\`\`\`
`;

const REFACTOR_BUNDLE: Record<string, string> = {
  [join(REFACTOR_REL, 'proposal.md')]: `# Proposal: tidy greeting

## Why
The greeting module has grown tangled; tidy it without changing behavior.

## What Changes
- Extract the formatting helper. No behavior change.

## Impact
- src/greeting.ts

## Unspecified
None known.

## Seams
None known.
`,
  [join(REFACTOR_REL, 'design.md')]: `# Design

## Context
The greeting logic is inlined. Extract it.

## Behavior Preservation
The regression suite pins greet()'s output; it must stay green.
`,
  [join(REFACTOR_REL, 'oracles.md')]: `# Oracles

<!-- A refactor adds no new oracles. Correctness is the regression suite. -->
`,
};

/** Seed the archive so the regression suite is non-empty (a refactor's correctness). */
function seedArchive(): void {
  const dir = join(scratch, 'openspec', 'changes', 'archive', '2026-07-01-add-greeting');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'oracles.md'), ARCHIVED_ORACLE);
}

describe.skipIf(process.env['CRUCIBLE_REAL_SUBSTRATE'] === '1')(
  'Worked example 2 — pure refactor: correctness IS the regression suite',
  () => {
    it('no spec delta → tier trivial, routes auto, the regression suite carries correctness', async () => {
      seedArchive();
      const proposed = await doPropose(
        REFACTOR,
        proposeSubstrate(REFACTOR_BUNDLE),
        'extract duplicated retry logic into a shared util (no behavior change)',
        'refactor',
      );
      expect(proposed.report.verdict).toBe('pass');
      // Type inferred/pinned as refactor and recorded (revalidated like tier).
      expect(proposed.type).toBe('refactor');
      expect(readChangeType(join(scratch, REFACTOR_REL))).toBe('refactor');

      expect((await doApprove(REFACTOR)).approved).toBe(true);
      expect(
        (
          await doImplement(
            REFACTOR,
            new FakeSubstrate(() => ({
              files: { [join(REFACTOR_REL, 'tasks.md')]: '# Tasks\n\n- [ ] 1.1 extract helper\n' },
            })),
          )
        ).report.verdict,
      ).toBe('pass');

      const report = await doVerify(REFACTOR, SMALL_NON_RISK);
      expect(report.verdict).toBe('pass');
      expect(report.tier?.tier).toBe('trivial');
      expect(report.routing?.decision).toBe('auto');
      // The change added no oracles; the regression suite ran in full and passed.
      const regression = report.checks.find((c) => c.name === 'regression');
      expect(regression?.status).toBe('pass');
    });

    it('honest residual: a refactor that breaks a PAST promise → regression red → verdict fail', async () => {
      seedArchive();
      await doPropose(
        REFACTOR,
        proposeSubstrate(REFACTOR_BUNDLE),
        'extract retry logic (no behavior change)',
        'refactor',
      );
      await doApprove(REFACTOR);

      // The refactor subtly changed behavior a past oracle pinned: its target now
      // fails. tests.json is the stub's world, so we flip that target to `fail`.
      const testsPath = join(scratch, 'tests.json');
      const tests = JSON.parse(readFileSync(testsPath, 'utf8')) as Array<{
        id: string;
        status: string;
      }>;
      for (const t of tests) if (t.id === ARCHIVED_TARGET) t.status = 'fail';
      writeFileSync(testsPath, JSON.stringify(tests, null, 2));

      const report = await doVerify(REFACTOR, SMALL_NON_RISK);
      expect(report.verdict).toBe('fail');
      const regression = report.checks.find((c) => c.name === 'regression');
      expect(regression?.status).toBe('fail');
      expect(regression?.findings.some((f) => f.id === 'ORC-greeting-001')).toBe(true);
    });
  },
);

// ─── Example 3 — Critical path with mid-flight ambiguity ──────────────────────
// charter §Worked Examples #3: "Partial refunds". A risk-glob match → tier
// critical. Mid-implementation the agent hits ambiguity → `escalate` HALTS the
// run; implement refuses to resume until `amend` resolves it; a green run then
// routes to a HUMAN (critical never auto-merges). Two weeks later a bugfix ships
// the escaped edge case, red-on-base / green-on-fix.

describe.skipIf(process.env['CRUCIBLE_REAL_SUBSTRATE'] === '1')(
  'Worked example 3 — critical path: escalate halts, amend resolves, routes HUMAN',
  () => {
    it('a risk-path change escalates, refuses to resume, amends, then routes to human', async () => {
      const notices: NotifyEvent[] = [];
      const notify = (e: NotifyEvent) => {
        notices.push(e);
      };

      await doPropose(
        FEATURE,
        proposeSubstrate(FEATURE_BUNDLE),
        'partial refunds on orders (touches the payments risk path)',
      );
      await doApprove(FEATURE);

      // Mid-implementation the agent hits ambiguity it may not improvise on. It
      // does NOT guess — it escalates, which writes escalation.yaml and notifies.
      const esc = await escalate(
        {
          root: scratch,
          change: FEATURE,
          oracle: 'ORC-greeting-002',
          question: 'Fee handling on partial refund is not derivable from the spec.',
          options: ['(a) proportional recalc', '(b) no fee refund', '(c) flat re-fee'],
        },
        { now, filedBy: () => 'implement-agent', notify },
      );
      expect(existsSync(join(scratch, esc.path))).toBe(true);
      expect(notices.map((n) => n.kind)).toContain('escalation');

      // Structural teeth (charter §Escalation layer 2): implement REFUSES to
      // resume while the escalation is unresolved — exit 2 naming `crucible amend`.
      expect(await catchExit(() => doImplement(FEATURE, implementSubstrate()))).toBe(2);

      // The human resolves it with `amend`: pick option (a). The propose role
      // regenerates the affected artifacts (here, a design note recording the
      // decision), Crucible re-judges, re-seals with fresh hashes, and clears the
      // escalation. The ambiguity now lives permanently in the spec, not a head.
      const amendedDesign =
        FEATURE_BUNDLE[join(FEATURE_REL, 'design.md')]! +
        '\n## Resolved (amend)\nFee handling: option (a) proportional recalc.\n';
      const amendResult = await amend(
        {
          root: scratch,
          change: FEATURE,
          resolution: '(a) proportional recalc',
          model: MODEL,
          yes: true,
        },
        {
          substrate: proposeSubstrate({ [join(FEATURE_REL, 'design.md')]: amendedDesign }),
          resolve: adapterDeps(scratch).resolve,
          confirm: () => Promise.reject(new Error('confirm must not be called under --yes')),
          now,
          amendedBy: () => APPROVER,
          notify,
        },
      );
      expect(amendResult.amended).toBe(true);
      expect(amendResult.sealedFiles).toContain(join(FEATURE_REL, 'design.md'));
      // The escalation is cleared — the structural blocker is gone.
      expect(existsSync(join(scratch, FEATURE_REL, 'escalation.yaml'))).toBe(false);

      // implement resumes and runs green now that both gates pass again.
      expect((await doImplement(FEATURE, implementSubstrate())).report.verdict).toBe('pass');

      // CI authority: the risk-glob match makes this critical, and critical NEVER
      // auto-merges — it routes to a human even fully green (the gate's whole point).
      const report = await doVerify(FEATURE, RISK_PATH);
      expect(report.verdict).toBe('pass');
      expect(report.tier?.tier).toBe('critical');
      expect(report.tier?.facts.risk_matches[0]?.glob).toBe('src/**/auth/**');
      expect(report.routing?.decision).toBe('human');
    });
  },
);

// ─── Example 3 (continued) — the follow-up bugfix ─────────────────────────────
// "Two weeks later a customer hits an escaped edge case." The fix is a Crucible
// change of type `bugfix`, whose schema MECHANICALLY requires a reproduction
// oracle, verified red-on-base / green-on-fix by CI. This segment proves that tail
// on a REAL two-commit git repo + REAL worktree run (see bugfix-flow.test.ts for
// the exhaustive negative cases; here it is the worked-example narrative anchor).

const BUGFIX = 'fix-refund-dispute';
const BUGFIX_REL = join('openspec', 'changes', BUGFIX);
const REPRO_TARGET = 'greeting::rejects_null_bytes';
const REPRO_FILE = 'tests/greeting_extra.test.ts';

const BUGFIX_SPEC = `# greeting

## ADDED Requirements

### Requirement: Greeting strips null bytes [REQ-greeting-nullbyte-9]

The system SHALL strip embedded null bytes before greeting.

#### Scenario: A name contains a null byte

- **WHEN** \`greet("a\\u0000b")\` is called
- **THEN** it returns \`Hello, ab!\`
`;

const BUGFIX_ORACLES = `# Oracles — ${BUGFIX}

## ORC-greeting-repro-001: Null byte is stripped (reproduction)
**Given** a name with an embedded null byte
**When** \`greet(name)\` is called
**Then** the null byte is stripped

\`\`\`yaml crucible-binding
requirement: REQ-greeting-nullbyte-9
kind: unit
runner: stub
target: ${REPRO_TARGET}
reproduces: true
\`\`\`
`;

/** tests.json declaring the reproduction target with the given status. */
function bugfixTestsJson(reproStatus: 'pass' | 'fail'): string {
  return JSON.stringify([{ id: REPRO_TARGET, file: REPRO_FILE, status: reproStatus }], null, 2);
}

function bugfixClient(cwd: string) {
  return createAdapterClient({
    manifest,
    cwd,
    resolveExecutable: (name) =>
      name === 'crucible-adapter-stub'
        ? { command: process.execPath, prefixArgs: [STUB_ADAPTER_BIN_PATH] }
        : { command: name, prefixArgs: [] },
    extraArgs: ['--tests', 'tests.json'],
    timeoutMs: 10_000,
  });
}

describe('Worked example 3 (continued) — the follow-up bugfix (real git + real stub)', () => {
  let repo: string;
  let baseSha: string;

  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'crucible-worked-bugfix-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);

    // Base commit (the buggy pre-fix source): the reproduction target FAILS here.
    writeFileSync(join(repo, 'src.txt'), 'buggy\n');
    writeFileSync(join(repo, 'tests.json'), bugfixTestsJson('fail'));
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base (pre-fix)']);
    baseSha = git(['rev-parse', 'HEAD']).trim();

    // Fix commit (HEAD, the working tree): the bugfix bundle, the reproduction
    // test, and a tests.json declaring the reproduction target `pass` (green-on-fix).
    const specDir = join(repo, BUGFIX_REL, 'specs', 'greeting');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(repo, BUGFIX_REL, '.openspec.yaml'), 'schema: crucible-bugfix\n');
    writeFileSync(join(repo, BUGFIX_REL, 'oracles.md'), BUGFIX_ORACLES);
    writeFileSync(join(specDir, 'spec.md'), BUGFIX_SPEC);
    mkdirSync(join(repo, 'tests'), { recursive: true });
    writeFileSync(join(repo, REPRO_FILE), '// the new reproduction test\n');
    writeFileSync(join(repo, 'src.txt'), 'fixed\n');
    writeFileSync(join(repo, 'tests.json'), bugfixTestsJson('pass'));
    git(['add', '.']);
    git(['commit', '-q', '-m', 'fix + reproduction oracle']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('the reproduction oracle fails on base and passes on fix → the bugfix verifies green', async () => {
    const root = bugfixClient(repo);
    const report = await verify(
      { root: repo, change: BUGFIX },
      {
        resolve: (t) => root.resolve(t),
        run: (o) => root.run(o),
        runOnBase: (oracles) =>
          runReproductionOnBase(
            { root: repo, base: baseSha, oracles },
            {
              git: liveWorktreeGit(repo),
              resolve: (t) => root.resolve(t),
              runIn: (wt, orcs) => bugfixClient(wt).run(orcs),
            },
          ),
      },
    );

    expect(report.verdict).toBe('pass');
    // red-on-base: the carried-over test failed against the pre-fix source.
    expect(report.checks.find((c) => c.name === 'reproduction')?.status).toBe('pass');
    // green-on-fix: the same reproduction oracle passed against HEAD.
    expect(report.checks.find((c) => c.name === 'oracles')?.status).toBe('pass');
    // The merge-base worktree is torn down (on disk and in git's registry).
    expect(existsSync(worktreePathFor(repo, baseSha))).toBe(false);
    expect(git(['worktree', 'list'])).not.toContain(worktreePathFor(repo, baseSha));
  });
});
