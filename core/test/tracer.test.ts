import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
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
import { approve } from '../src/commands/approve.js';
import { implement } from '../src/commands/implement.js';
import { propose } from '../src/commands/propose.js';
import { verify } from '../src/commands/verify.js';
import { ClaudeCodeSubstrate } from '../src/substrate/claude-code.js';
import { CodexSubstrate } from '../src/substrate/codex.js';
import { FakeSubstrate } from '../src/substrate/fake.js';
import type { AgentSubstrate } from '../src/substrate/types.js';

// ─── P1-16: the tracer bullet — THE PERMANENT REGRESSION ANCHOR ──────────────
//
// The Phase 1 exit criterion (design phase-0-1.md §Phase 1 scope, §10): on
// fixtures/toy-repo, the scripted flow propose → approve → implement → verify
// runs green end-to-end. Every future phase keeps this test green.
//
// Realness boundary: ONLY the agent sessions are faked (FakeSubstrate). The
// adapter path is real — the P1-11 client spawns the real built stub adapter
// against the scratch repo's tests.json for both `resolve` (lint + hash scope)
// and `run` (oracle execution). verify.cli.ts names this test as the wiring
// proof for those deps. The seal, the parsers, the lint, and the verdict
// aggregation are all the production code paths.
//
// Three negative paths (task P1-16 acceptance), each pinned to its invariant:
//   1. post-approval oracle edit  → verify red on the approval check (inv. 6)
//   2. skipped oracle test        → red, with `=skip` provenance     (inv. 4)
//   3. REQ without oracle         → propose-stage red judgment       (inv. 2)
//
// A real-substrate mode (design §10) reuses the same flow with the selected live
// Codex or Claude Code provider for manual validation — see the tracer runbook.
// CI runs the FakeSubstrate variant only.

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const TASKS_REL = join(CHANGE_REL, 'tasks.md');
const ORACLES_REL = join(CHANGE_REL, 'oracles.md');

/** §10: the toy intent is checked into the integration test verbatim. */
const INTENT =
  'Add a greet(name) function that returns "Hello, <name>!" and greets the world when the name is empty.';
const MODEL = 'claude-opus-4-8';
const APPROVER = 'ada@example.com';

/** Real-substrate mode (manual, never CI) — docs/design/tracer-runbook.md. */
const REAL_SELECTOR = process.env['CRUCIBLE_REAL_SUBSTRATE'];
const REAL = ['1', 'claude-code', 'codex'].includes(REAL_SELECTOR ?? '');
const REAL_PROVIDER = REAL_SELECTOR === 'codex' ? 'codex' : 'claude-code';
const REAL_MODEL =
  process.env['CRUCIBLE_REAL_MODEL'] ?? (REAL_PROVIDER === 'codex' ? 'gpt-5.6-sol' : MODEL);

const manifest = loadManifest(STUB_ADAPTER_MANIFEST_PATH);

/** The valid bundle's artifact bytes, read once from the committed fixture. */
const CANNED_BUNDLE: Record<string, string> = Object.fromEntries(
  ['proposal.md', 'design.md', 'oracles.md', join('specs', 'greeting', 'spec.md')].map((rel) => [
    join(CHANGE_REL, rel),
    readFileSync(join(VALID_BUNDLE_DIR, rel), 'utf8'),
  ]),
);

// A third requirement + oracle bound to `greeting::is_localized`, which
// tests.json declares `skip`. The stub RESOLVES a skip row as found (only
// unknown/`missing` rows are unresolvable), so lint and approve stay green and
// the red lands exactly where invariant 4 demands: skip→fail in the oracle run.
const LOCALIZED_REQ = `
### Requirement: Localized greeting [REQ-greeting-localized-3]

The system SHALL greet in the configured locale.

#### Scenario: A locale is configured

- **WHEN** \`greet("Ada")\` runs under a configured locale
- **THEN** the greeting uses that locale
`;

const LOCALIZED_ORACLE = `
## ORC-greeting-003: Greeting is localized
**Given** a configured locale
**When** \`greet(name)\` is called
**Then** the greeting uses that locale

\`\`\`yaml crucible-binding
requirement: REQ-greeting-localized-3
kind: unit
runner: stub
target: greeting::is_localized
\`\`\`
`;

/** The canned bundle with extra content appended to the spec delta / oracles. */
function bundleWith(extra: { spec?: string; oracles?: string }): Record<string, string> {
  const specKey = join(CHANGE_REL, 'specs', 'greeting', 'spec.md');
  return {
    ...CANNED_BUNDLE,
    [specKey]: CANNED_BUNDLE[specKey]! + (extra.spec ?? ''),
    [ORACLES_REL]: CANNED_BUNDLE[ORACLES_REL]! + (extra.oracles ?? ''),
  };
}

let scratch: string;
let now: () => string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-tracer-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  // propose authors the bundle itself: start from a repo without one.
  rmSync(join(scratch, CHANGE_REL), { recursive: true });
  if (REAL) {
    const commands = [
      ['init', '-q'],
      ['add', '.'],
      [
        '-c',
        'user.name=Crucible Tracer',
        '-c',
        'user.email=tracer@example.com',
        'commit',
        '-qm',
        'tracer baseline',
      ],
    ];
    for (const args of commands) {
      const result = spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    }
  }
  now = tickingClock();
});

afterEach(() => {
  // Real mode keeps the scratch repo so transcripts can be inspected (runbook).
  if (!REAL) rmSync(scratch, { recursive: true, force: true });
});

/** Injectable monotonic clock — deterministic, and distinct per state event. */
function tickingClock(): () => string {
  let tick = 0;
  return () => `2026-07-23T00:00:${String(tick++).padStart(2, '0')}Z`;
}

/**
 * The REAL adapter edge: a P1-11 client that spawns the built stub adapter
 * against the scratch repo's tests.json (the client.test.ts wiring, pointed at
 * the scratch instead of the shared fixture).
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
  return {
    resolve: (targets) => client.resolve(targets),
    run: (oracles) => client.run(oracles),
  };
}

/** A scaffolder that mimics `openspec new change` (dir + OpenSpec metadata). */
function fakeScaffold(root: string): (change: string) => Promise<void> {
  return (change) => {
    const dir = join(root, 'openspec', 'changes', change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.openspec.yaml'), `schema: crucible\ncreated: 2026-07-23\n`);
    writeFileSync(join(dir, 'README.md'), `# ${change}\n`);
    return Promise.resolve();
  };
}

/** A propose substrate scripted to author `files` as the change bundle. */
function proposeSubstrate(files: Record<string, string>): FakeSubstrate {
  return new FakeSubstrate({ files });
}

/** A two-session implement substrate: tasks breakdown first, then the code. */
function implementSubstrate(): FakeSubstrate {
  let call = 0;
  return new FakeSubstrate(() => {
    call += 1;
    return call === 1
      ? { files: { [TASKS_REL]: '# Tasks\n\n- [ ] 1.1 implement greet per the spec delta\n' } }
      : {
          files: {
            [join('src', 'greeting.ts')]:
              'export const greet = (name: string): string =>\n' +
              "  `Hello, ${name === '' ? 'world' : name}!`;\n",
          },
        };
  });
}

// ─── Flow drivers (shared by the CI variant and the real-substrate mode) ─────

function doPropose(substrate: AgentSubstrate, model = MODEL) {
  const { resolve } = adapterDeps(scratch);
  return propose(
    { root: scratch, change: CHANGE, intent: INTENT, model },
    { substrate, scaffold: fakeScaffold(scratch), resolve, now },
  );
}

function doApprove() {
  const { resolve } = adapterDeps(scratch);
  return approve(
    { root: scratch, change: CHANGE, yes: true },
    {
      resolve,
      // --yes is scripted end to end: prompting here would hang CI. Blow up loudly.
      confirm: () => Promise.reject(new Error('confirm must not be called under --yes')),
      now,
      approvedBy: () => APPROVER,
    },
  );
}

function doImplement(substrate: AgentSubstrate, model = MODEL) {
  const { resolve, run } = adapterDeps(scratch);
  return implement({ root: scratch, change: CHANGE, model }, { substrate, resolve, run, now });
}

function doVerify() {
  const { resolve, run } = adapterDeps(scratch);
  return verify({ root: scratch, change: CHANGE }, { resolve, run });
}

describe.skipIf(REAL)('tracer — the P1 exit criterion (FakeSubstrate, runs in CI)', () => {
  it('propose → approve → implement → verify runs green end-to-end', async () => {
    // propose: the fake authors the canned valid bundle; Crucible judges it.
    const proposed = await doPropose(proposeSubstrate(CANNED_BUNDLE));
    expect(proposed.report.verdict).toBe('pass');
    expect(existsSync(proposed.transcriptPath)).toBe(true);

    // approve --yes: the real seal over the bundle + its bound test files.
    const approved = await doApprove();
    expect(approved.approved).toBe(true);
    expect(existsSync(join(scratch, CHANGE_REL, 'approval.yaml'))).toBe(true);

    // implement: tasks session, implement session, then a real local verify.
    const implemented = await doImplement(implementSubstrate());
    expect(implemented.report.verdict).toBe('pass');
    expect(existsSync(join(scratch, TASKS_REL))).toBe(true);

    // verify: the standalone authority check — all three checks, all green.
    const report = await doVerify();
    expect(report.verdict).toBe('pass');
    expect(report.checks.map((c) => c.name)).toEqual(['traceability', 'oracles', 'approval']);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);

    // The audit trail recorded every stage, in order (invariant 1: audit, never gate).
    const state = readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8');
    const offsets = ['bundle judged pass', 'sealed', 'tasks.md generated', 'local verify pass'].map(
      (marker) => state.indexOf(marker),
    );
    expect(offsets.every((i) => i >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('negative: a post-approval oracle edit turns verify red (invariant 6)', async () => {
    await doPropose(proposeSubstrate(CANNED_BUNDLE));
    await doApprove();

    // The exact escape the seal exists to catch: an oracle edited after approval.
    appendFileSync(join(scratch, ORACLES_REL), '\n<!-- sharpened after approval -->\n');

    const report = await doVerify();
    expect(report.verdict).toBe('fail');
    const approval = report.checks.find((c) => c.name === 'approval')!;
    expect(approval.status).toBe('fail');
    expect(approval.findings.some((f) => f.id === ORACLES_REL)).toBe(true);
  });

  it('negative: a skipped oracle test is a fail, not a pass (invariant 4)', async () => {
    // The bundle binds ORC-greeting-003 to `greeting::is_localized` — declared
    // `skip` in tests.json. It resolves as found, so propose and approve are
    // green; only the oracle RUN can catch it, and it must catch it as red.
    const proposed = await doPropose(
      proposeSubstrate(bundleWith({ spec: LOCALIZED_REQ, oracles: LOCALIZED_ORACLE })),
    );
    expect(proposed.report.verdict).toBe('pass');
    const approved = await doApprove();
    expect(approved.approved).toBe(true);

    const report = await doVerify();
    expect(report.verdict).toBe('fail');
    const oracles = report.checks.find((c) => c.name === 'oracles')!;
    expect(oracles.status).toBe('fail');
    const finding = oracles.findings.find((f) => f.id === 'ORC-greeting-003')!;
    // The provenance names the skip: this red is invariant 4, not a test failure.
    expect(finding.message).toContain('greeting::is_localized=skip');
    // And it is the ONLY red source — the seal itself is intact.
    expect(report.checks.find((c) => c.name === 'approval')!.status).toBe('pass');
  });

  it('negative: a REQ without an oracle is judged red at the propose stage', async () => {
    // The agent authored a requirement with no oracle covering it. Its exit code
    // says success; the judgment says otherwise (invariant 2).
    const proposed = await doPropose(proposeSubstrate(bundleWith({ spec: LOCALIZED_REQ })));
    expect(proposed.report.verdict).toBe('fail');
    const trace = proposed.report.checks.find((c) => c.name === 'traceability')!;
    expect(trace.status).toBe('fail');
    expect(trace.findings.some((f) => f.id === 'REQ-greeting-localized-3')).toBe(true);
    // The red judgment is recorded, and nothing downstream was minted.
    expect(existsSync(join(scratch, CHANGE_REL, 'approval.yaml'))).toBe(false);
    expect(readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8')).toContain('propose-red');
  });
});

describe.runIf(REAL)('tracer — real substrate (manual; see docs/design/tracer-runbook.md)', () => {
  it(
    'runs the full flow green with the selected live provider',
    { timeout: 1_800_000 },
    async () => {
      // Manual mode: the runbook points here for transcript inspection.
      console.log(`tracer real-substrate scratch repo (kept for inspection): ${scratch}`);
      const substrate =
        REAL_PROVIDER === 'codex' ? new CodexSubstrate() : new ClaudeCodeSubstrate();

      // The real propose session authors the bundle from the checked-in intent.
      const proposed = await doPropose(substrate, REAL_MODEL);
      expect(proposed.report.verdict).toBe('pass');

      const approved = await doApprove();
      expect(approved.approved).toBe(true);

      // Two real implement sessions (tasks, then code), judged by local verify.
      const implemented = await doImplement(substrate, REAL_MODEL);
      expect(implemented.report.verdict).toBe('pass');

      const report = await doVerify();
      expect(report.verdict).toBe('pass');
    },
  );
});
