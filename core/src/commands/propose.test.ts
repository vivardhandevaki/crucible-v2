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
import { TOY_REPO_ROOT, VALID_BUNDLE_DIR } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import type { ResolveFn, TargetResolution } from '../lint/traceability.js';
import { FakeSubstrate, type FakeScript } from '../substrate/fake.js';
import { checkStaleness, readGenerationIfPresent } from '../artifacts/generation.js';
import { propose, type ProposeDeps } from './propose.js';

// `propose` is where an agent authors the bundle and Crucible JUDGES the output
// (invariant 2 — agent self-report is worth zero). The tests drive both sides of
// that boundary with the FakeSubstrate: a fake that writes a valid bundle must
// come out green regardless of its exit code, and a fake that writes garbage (or
// nothing) must come out red as a *verdict* (report, exit 1 at the CLI) — never
// as a trusted success and never as a fail-closed exit 3, because the artifacts
// under judgment are the agent's product, not our input. Everything
// non-deterministic (substrate, scaffolder, resolver, clock) is injected
// (invariant 12).

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const FROZEN_NOW = '2026-07-23T00:00:00Z';

// The toy repo's two oracle targets → the files they live in (tests.json).
const TARGET_FILES: Record<string, string> = {
  'greeting::returns_hello_for_a_name': 'tests/greeting.test.ts',
  'greeting::defaults_to_world_when_empty': 'tests/greeting.test.ts',
};

/** A resolver that marks every requested target `found` with its file. */
const resolveAllFound: ResolveFn = (targets) =>
  Promise.resolve(
    targets.map((target): TargetResolution => {
      const targetFile = TARGET_FILES[target];
      return targetFile !== undefined
        ? { target, status: 'found', targetFile }
        : { target, status: 'missing' };
    }),
  );

/** A resolver that reports every target missing (drives the red-lint path). */
const resolveAllMissing: ResolveFn = (targets) =>
  Promise.resolve(targets.map((target): TargetResolution => ({ target, status: 'missing' })));

/** The valid bundle's artifact bytes, read once from the committed fixture. */
const CANNED_BUNDLE: Record<string, string> = Object.fromEntries(
  ['proposal.md', 'design.md', 'oracles.md', join('specs', 'greeting', 'spec.md')].map((rel) => [
    join(CHANGE_REL, rel),
    readFileSync(join(VALID_BUNDLE_DIR, rel), 'utf8'),
  ]),
);

let scratch: string;
let events: string[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-propose-'));
  cpSync(TOY_REPO_ROOT, scratch, { recursive: true });
  // propose scaffolds the change itself: start from a repo without the bundle.
  rmSync(join(scratch, CHANGE_REL), { recursive: true });
  events = [];
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A scaffolder that mimics `openspec new change` (dir + OpenSpec metadata). */
function fakeScaffold(root: string): (change: string) => Promise<void> {
  return (change) => {
    events.push('scaffold');
    const dir = join(root, 'openspec', 'changes', change);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.openspec.yaml'), `schema: crucible\ncreated: 2026-07-23\n`);
    writeFileSync(join(dir, 'README.md'), `# ${change}\n`);
    return Promise.resolve();
  };
}

/** Deps with a substrate scripted to write `files` (default: the valid bundle). */
function deps(overrides: Partial<ProposeDeps> = {}, script: FakeScript = {}): ProposeDeps {
  const substrate = new FakeSubstrate((req) => {
    events.push('substrate');
    void req;
    return { files: CANNED_BUNDLE, ...script };
  });
  return {
    substrate,
    scaffold: fakeScaffold(scratch),
    resolve: resolveAllFound,
    now: () => FROZEN_NOW,
    ...overrides,
  };
}

function options(over: Partial<Parameters<typeof propose>[0]> = {}): Parameters<typeof propose>[0] {
  return {
    root: scratch,
    change: CHANGE,
    intent: 'Add a greet(name) function with a default greeting.',
    model: 'claude-opus-4-8',
    ...over,
  };
}

/** Capture the CrucibleError a call throws, or fail the test loudly. */
async function catchCrucible(fn: () => Promise<unknown>): Promise<CrucibleError> {
  try {
    await fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

describe('propose — green path (acceptance: fake produces a bundle passing parsers+lint)', () => {
  it('produces a bundle that passes parsers + lint: verdict pass', async () => {
    const result = await propose(options(), deps());
    expect(result.report.verdict).toBe('pass');
    expect(result.report.checks.map((c) => c.name)).toEqual(['bundle', 'traceability']);
    expect(result.report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(result.render).toContain(`propose ${CHANGE}: PASS`);
  });

  it('scaffolds before the substrate session runs', async () => {
    await propose(options(), deps());
    expect(events).toEqual(['scaffold', 'substrate']);
  });

  it('invokes the substrate with the propose role contract (architecture §6)', async () => {
    const d = deps();
    await propose(options(), d);
    const substrate = d.substrate as FakeSubstrate;
    expect(substrate.calls).toHaveLength(1);
    const req = substrate.calls[0]!;
    expect(req.role).toBe('propose');
    expect(req.cwd).toBe(scratch);
    expect(req.model).toBe('claude-opus-4-8');
    expect(req.rolePromptPath).toBe(join(scratch, '.crucible', 'context', 'propose.md'));
    // The work order carries the change name and the verbatim intent.
    expect(req.taskPayload).toContain(CHANGE);
    expect(req.taskPayload).toContain('Add a greet(name) function');
  });

  it('mints the transcript path from the injected clock (caller-owned naming)', async () => {
    const result = await propose(options(), deps());
    expect(result.transcriptPath).toBe(
      join(scratch, '.crucible', 'transcripts', CHANGE, 'propose-2026-07-23T00-00-00Z.jsonl'),
    );
    // The substrate contract: the transcript exists on every returned result.
    expect(existsSync(result.transcriptPath)).toBe(true);
  });

  it('judges artifacts, not the exit code: non-zero substrate exit + valid bundle → pass', async () => {
    const result = await propose(options(), deps({}, { exitCode: 1 }));
    expect(result.report.verdict).toBe('pass');
  });

  it('appends a propose state event with the frozen clock', async () => {
    await propose(options(), deps());
    const state = readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8');
    expect(state).toContain('propose');
    expect(state).toContain(FROZEN_NOW);
    expect(state).toContain('proposed');
  });
});

describe('propose — the agent is judged, not trusted (invariant 2)', () => {
  it('a fake emitting a malformed oracles.md → red report, not exit 3', async () => {
    const bad = {
      ...CANNED_BUNDLE,
      [join(CHANGE_REL, 'oracles.md')]: '## ORC-BAD: no id grammar, no fence\n',
    };
    const result = await propose(options(), deps({}, { files: bad }));
    expect(result.report.verdict).toBe('fail');
    const bundle = result.report.checks.find((c) => c.name === 'bundle')!;
    expect(bundle.status).toBe('fail');
    expect(bundle.findings.some((f) => f.id === 'oracles.md')).toBe(true);
  });

  it('a proposal without Unspecified/Seams sections → red bundle finding', async () => {
    const bad = {
      ...CANNED_BUNDLE,
      [join(CHANGE_REL, 'proposal.md')]: '# Proposal\n\n## Why\n\nBecause.\n',
    };
    const result = await propose(options(), deps({}, { files: bad }));
    expect(result.report.verdict).toBe('fail');
    const bundle = result.report.checks.find((c) => c.name === 'bundle')!;
    const finding = bundle.findings.find((f) => f.id === 'proposal.md')!;
    expect(finding.message).toContain('Unspecified');
  });

  it('a fake that writes nothing (exit 0) → every artifact reported missing', async () => {
    const result = await propose(options(), deps({}, { files: {} }));
    expect(result.report.verdict).toBe('fail');
    const bundle = result.report.checks.find((c) => c.name === 'bundle')!;
    const ids = bundle.findings.map((f) => f.id);
    expect(ids).toContain('proposal.md');
    expect(ids).toContain('design.md');
    expect(ids).toContain('oracles.md');
    expect(ids.some((id) => id.startsWith('specs'))).toBe(true);
  });

  it('an orphan oracle (REQ not in the delta) → red traceability finding', async () => {
    const orphan = CANNED_BUNDLE[join(CHANGE_REL, 'oracles.md')]!.replace(
      'requirement: REQ-greeting-basic-1',
      'requirement: REQ-greeting-ghost-9',
    );
    const result = await propose(
      options(),
      deps({}, { files: { ...CANNED_BUNDLE, [join(CHANGE_REL, 'oracles.md')]: orphan } }),
    );
    expect(result.report.verdict).toBe('fail');
    const trace = result.report.checks.find((c) => c.name === 'traceability')!;
    expect(trace.findings.some((f) => f.message.includes('REQ-greeting-ghost-9'))).toBe(true);
  });

  it('an unresolvable binding → red traceability finding naming the oracle', async () => {
    const result = await propose(options(), deps({ resolve: resolveAllMissing }));
    expect(result.report.verdict).toBe('fail');
    const trace = result.report.checks.find((c) => c.name === 'traceability')!;
    expect(trace.findings.some((f) => f.id === 'ORC-greeting-001')).toBe(true);
  });

  it('skips the lint check when the bundle itself is red (nothing to lint)', async () => {
    const result = await propose(options(), deps({}, { files: {} }));
    expect(result.report.checks.map((c) => c.name)).toEqual(['bundle']);
  });

  it('a red judgment still appends the audit event (invariant 1: audit, not gate)', async () => {
    await propose(options(), deps({}, { files: {} }));
    const state = readFileSync(join(scratch, CHANGE_REL, 'state.yaml'), 'utf8');
    expect(state).toContain('propose');
  });
});

describe('propose — input validation and preconditions', () => {
  it.each(['123-x', 'Has-Caps', 'with_underscore', 'double--dash', '-lead'])(
    'rejects invalid change name %s at exit 3 without scaffolding',
    async (change) => {
      const err = await catchCrucible(() => propose(options({ change }), deps()));
      expect(err.exit).toBe(3);
      expect(events).toEqual([]);
    },
  );

  it('rejects an empty / whitespace-only intent at exit 3', async () => {
    const err = await catchCrucible(() => propose(options({ intent: '   ' }), deps()));
    expect(err.exit).toBe(3);
    expect(events).toEqual([]);
  });

  it('refuses when the change dir already exists (exit 2; points at --revise)', async () => {
    cpSync(VALID_BUNDLE_DIR, join(scratch, CHANGE_REL), { recursive: true });
    const err = await catchCrucible(() => propose(options(), deps()));
    expect(err.exit).toBe(2);
    expect(err.hint).toContain('--revise');
    expect(events).toEqual([]);
  });

  it('refuses when the propose role prompt is missing (exit 2 naming the path)', async () => {
    rmSync(join(scratch, '.crucible', 'context', 'propose.md'));
    const err = await catchCrucible(() => propose(options(), deps()));
    expect(err.exit).toBe(2);
    expect(err.message).toContain('.crucible/context/propose.md');
    expect(events).toEqual([]);
  });

  it('fails closed at exit 3 when the scaffolder did not create the change dir', async () => {
    const err = await catchCrucible(() =>
      propose(
        options(),
        deps({
          scaffold: () => {
            events.push('scaffold');
            return Promise.resolve();
          },
        }),
      ),
    );
    expect(err.exit).toBe(3);
    expect(events).toEqual(['scaffold']);
  });
});

describe('propose — generation ledger stamped on a green bundle (P2-05 staleness)', () => {
  const generationPath = () => join(scratch, CHANGE_REL, 'generation.yaml');

  it('stamps generation.yaml in dependency order on a green bundle', async () => {
    await propose(options(), deps());
    const gen = readGenerationIfPresent(generationPath())!;
    expect(gen.change).toBe(CHANGE);
    expect(gen.artifacts.map((a) => a.path)).toEqual([
      'proposal.md',
      'design.md',
      join('specs', 'greeting', 'spec.md'),
      'oracles.md',
    ]);
    // A freshly stamped, unedited bundle is not stale.
    expect(checkStaleness(join(scratch, CHANGE_REL), gen)).toEqual({ stale: false });
  });

  it('does NOT stamp a ledger for a red bundle (no coherent lineage)', async () => {
    await propose(options(), deps({}, { files: {} }));
    expect(readGenerationIfPresent(generationPath())).toBeUndefined();
  });
});

describe('propose --revise — coherent regeneration of an existing bundle (P2-05)', () => {
  const generationPath = () => join(scratch, CHANGE_REL, 'generation.yaml');

  /** Place the valid bundle on disk (as a prior propose would have). */
  function seedBundle(): void {
    cpSync(VALID_BUNDLE_DIR, join(scratch, CHANGE_REL), { recursive: true });
  }

  it('regenerates in place without scaffolding and uses the revise role payload', async () => {
    seedBundle();
    const d = deps();
    const result = await propose(options({ revise: true, intent: 'switch to token-bucket' }), d);
    expect(result.report.verdict).toBe('pass');
    // Revise skips scaffolding: only the substrate session ran.
    expect(events).toEqual(['substrate']);
    const req = (d.substrate as FakeSubstrate).calls[0]!;
    expect(req.role).toBe('propose');
    expect(req.taskPayload).toContain('Revise the EXISTING bundle');
    expect(req.taskPayload).toContain('switch to token-bucket');
    // The transcript is named for a revise session.
    expect(result.transcriptPath).toContain('revise-');
  });

  it('re-stamps the generation ledger, clearing prior staleness (acceptance)', async () => {
    seedBundle();
    // Establish a ledger by revising once, then hand-edit design.md to go stale.
    await propose(options({ revise: true, intent: 'initial regen' }), deps());
    const design = join(scratch, CHANGE_REL, 'design.md');
    writeFileSync(design, readFileSync(design, 'utf8') + '\nhand edit\n');
    const stale = checkStaleness(
      join(scratch, CHANGE_REL),
      readGenerationIfPresent(generationPath())!,
    );
    expect(stale.stale).toBe(true);

    // --revise regenerates coherently and re-stamps → no longer stale.
    await propose(options({ revise: true, intent: 'coherent regen' }), deps());
    const fresh = checkStaleness(
      join(scratch, CHANGE_REL),
      readGenerationIfPresent(generationPath())!,
    );
    expect(fresh).toEqual({ stale: false });
  });

  it('refuses to revise a bundle that does not exist (exit 2)', async () => {
    const err = await catchCrucible(() => propose(options({ revise: true, intent: 'x' }), deps()));
    expect(err.exit).toBe(2);
    expect(err.code).toBe('NO_CHANGE');
    expect(events).toEqual([]);
  });

  it('refuses to revise an already-approved bundle, pointing at amend (exit 2)', async () => {
    seedBundle();
    writeFileSync(join(scratch, CHANGE_REL, 'approval.yaml'), 'version: 1\n');
    const err = await catchCrucible(() => propose(options({ revise: true, intent: 'x' }), deps()));
    expect(err.exit).toBe(2);
    expect(err.code).toBe('ALREADY_APPROVED');
    expect(err.hint).toContain('amend');
    expect(events).toEqual([]);
  });

  it('rejects an empty revision instruction at exit 3', async () => {
    seedBundle();
    const err = await catchCrucible(() =>
      propose(options({ revise: true, intent: '   ' }), deps()),
    );
    expect(err.exit).toBe(3);
    expect(err.code).toBe('EMPTY_INTENT');
  });
});
