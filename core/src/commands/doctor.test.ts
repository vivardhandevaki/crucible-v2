import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_TEMPLATE_PATH } from '@crucible/ci-templates';
import { schemaBundleFile } from '@crucible/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTER_LOCK_RELPATH, hashAdapterPackage, loadAdapterLock } from '../adapters/lockfile.js';
import { isCrucibleError } from '../util/errors.js';
import { loadDefaultRubric } from '../review/rubric.js';
import { init, type InitAnswers } from './init.js';
import { doctor, type ConfirmFix, type DoctorFinding, type DoctorReport } from './doctor.js';
import { OPENSPEC_TESTED_VERSION } from './openspec-support.js';

// TCB: doctor is the maintenance surface that checks a project's installed copies
// against Crucible's SHIPPED sources of truth — the same sources init (P2-12)
// installs from. It never writes silently: every fix is routed through the
// injected `confirmFix` edge (design phase-2.md §7 "offers fixes as diffs, never
// silent writes"). These tests pin the doctor checks — schema-bundle
// integrity, CI-template currency, OpenSpec version-range, adapter-lockfile hash
// validity, and upstream rubric-line offers — plus the never-silent-merge and
// read-only guarantees.

const ANSWERS: InitAnswers = {
  adapter: 'stub',
  runners: ['stub'],
  paths: ['**/*.ts'],
  unitCommand: 'npm test',
};

/** A confirm edge that must never be consulted (asserts the no-finding path). */
const confirmNever: ConfirmFix = () => {
  throw new Error('confirmFix must not be called when there is nothing to fix');
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-doctor-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function read(relpath: string): string {
  return readFileSync(join(scratch, relpath), 'utf8');
}
function write(relpath: string, text: string): void {
  writeFileSync(join(scratch, relpath), text, 'utf8');
}

/** Install a clean, fully-initialized Crucible setup into the scratch repo. */
async function initClean(): Promise<void> {
  await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: () => true });
}

/** Install a tiny adapter package through P3-06's real init+pin flow. */
async function initWithPinnedAdapter(): Promise<void> {
  const manifestPath = join(scratch, 'source-adapter.yaml');
  const executablePath = join(scratch, 'source-adapter.mjs');
  writeFileSync(
    manifestPath,
    [
      'name: java-junit',
      'version: 0.0.0',
      'runners: [junit]',
      'capabilities: [unit]',
      'invocations:',
      "  resolve: 'crucible-adapter-java-junit resolve'",
      "  run: 'crucible-adapter-java-junit run'",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(executablePath, '#!/usr/bin/env node\n', 'utf8');
  await init(
    {
      root: scratch,
      answers: {
        adapter: 'java-junit',
        runners: ['junit'],
        paths: ['**/*.java'],
        unitCommand: 'mvn test',
      },
      adapterPackage: { manifestPath, executablePath },
    },
    { confirmOverwrite: () => true },
  );
}

function findingsFor(report: DoctorReport, check: string): DoctorFinding[] {
  return report.findings.filter((f) => f.check === check);
}
function resolutionOf(report: DoctorReport, id: string): string | undefined {
  return report.results.find((r) => r.id === id)?.resolution;
}

describe('doctor — a clean install is healthy', () => {
  it('finds nothing and never consults confirm on a freshly init-ed repo', async () => {
    await initClean();
    const report = await doctor({ root: scratch }, { confirmFix: confirmNever });
    expect(report.findings).toEqual([]);
    expect(report.results).toEqual([]);
  });

  it('fails closed (exit 2) on an un-initialized repo, pointing at init', async () => {
    await expect(doctor({ root: scratch }, { confirmFix: confirmNever })).rejects.toSatisfy(
      (e: unknown) => isCrucibleError(e) && e.exit === 2 && /init/.test(e.hint),
    );
  });
});

describe('doctor — schema bundle integrity (tampered bundle)', () => {
  it('detects a tampered schema file and restores it on confirm', async () => {
    await initClean();
    const rel = join('openspec', 'schemas', 'crucible', 'schema.yaml');
    const shipped = readFileSync(schemaBundleFile('crucible'), 'utf8');
    write(rel, shipped + '\n# tampered\n');

    const confirm = vi.fn<ConfirmFix>(() => true);
    const report = await doctor({ root: scratch }, { confirmFix: confirm });

    const finding = findingsFor(report, 'schema-bundle').find((f) => f.relpath === rel);
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('drift');
    expect(confirm).toHaveBeenCalled();
    expect(resolutionOf(report, finding!.id)).toBe('fixed');
    expect(read(rel)).toBe(shipped); // restored byte-for-byte
  });

  it('leaves the tampered file untouched when confirm declines (no silent write)', async () => {
    await initClean();
    const rel = join('openspec', 'schemas', 'crucible', 'schema.yaml');
    write(rel, '# hand-edited bundle\n');

    const report = await doctor({ root: scratch }, { confirmFix: () => false });

    const finding = findingsFor(report, 'schema-bundle').find((f) => f.relpath === rel);
    expect(finding).toBeDefined();
    expect(resolutionOf(report, finding!.id)).toBe('skipped');
    expect(read(rel)).toBe('# hand-edited bundle\n'); // untouched
  });

  it('flags a missing bundle file as drift', async () => {
    await initClean();
    const rel = join('openspec', 'schemas', 'crucible', 'schema.yaml');
    rmSync(join(scratch, rel));
    const report = await doctor({ root: scratch }, { confirmFix: () => false });
    const finding = findingsFor(report, 'schema-bundle').find((f) => f.relpath === rel);
    expect(finding).toBeDefined();
    expect(finding!.summary).toMatch(/missing/i);
  });
});

describe('doctor — adapter lockfile hash validity (P3-09)', () => {
  it('reports no finding when every installed adapter package matches its pin', async () => {
    await initWithPinnedAdapter();

    const report = await doctor({ root: scratch }, { confirmFix: confirmNever });

    expect(findingsFor(report, 'adapter-lockfile-hash')).toEqual([]);
  });

  it('detects bad adapter bytes, offers a lockfile diff, and writes nothing when declined', async () => {
    await initWithPinnedAdapter();
    const executableRel = '.crucible/adapters/java-junit.mjs';
    write(executableRel, `${read(executableRel)}// updated after pin\n`);
    const lockBefore = read(ADAPTER_LOCK_RELPATH);

    const confirm = vi.fn<ConfirmFix>(() => false);
    const report = await doctor({ root: scratch }, { confirmFix: confirm });

    const finding = findingsFor(report, 'adapter-lockfile-hash')[0]!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('drift');
    expect(finding.summary).toMatch(/bad adapter hash/i);
    expect(finding.relpath).toBe(ADAPTER_LOCK_RELPATH);
    expect(finding.fix).toMatchObject({ kind: 'rewrite', current: lockBefore });
    expect(finding.fix!.desired).not.toBe(lockBefore);
    expect(confirm).toHaveBeenCalledOnce();
    expect(resolutionOf(report, finding.id)).toBe('skipped');
    expect(read(ADAPTER_LOCK_RELPATH)).toBe(lockBefore);
  });

  it('re-pins the installed package hash only after its diff is confirmed', async () => {
    await initWithPinnedAdapter();
    const manifestRel = '.crucible/adapters/java-junit.yaml';
    const executableRel = '.crucible/adapters/java-junit.mjs';
    write(executableRel, `${read(executableRel)}// replacement package\n`);

    const report = await doctor({ root: scratch }, { confirmFix: () => true });

    const finding = findingsFor(report, 'adapter-lockfile-hash')[0]!;
    expect(resolutionOf(report, finding.id)).toBe('fixed');
    const repaired = loadAdapterLock(join(scratch, ADAPTER_LOCK_RELPATH));
    expect(repaired.adapters['java-junit']!.content_hash).toBe(
      hashAdapterPackage(join(scratch, manifestRel), join(scratch, executableRel)),
    );

    const clean = await doctor({ root: scratch }, { confirmFix: confirmNever });
    expect(findingsFor(clean, 'adapter-lockfile-hash')).toEqual([]);
  });
});

describe('doctor — CI template currency (stale template)', () => {
  it('detects a stale workflow and restores the shipped bytes on confirm', async () => {
    await initClean();
    const rel = join('.github', 'workflows', 'crucible.yml');
    write(rel, '# a stale, hand-edited workflow\n');

    const confirm = vi.fn<ConfirmFix>(() => true);
    const report = await doctor({ root: scratch }, { confirmFix: confirm });

    const finding = findingsFor(report, 'ci-template')[0]!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('drift');
    expect(resolutionOf(report, finding.id)).toBe('fixed');
    expect(read(rel)).toBe(readFileSync(CI_TEMPLATE_PATH, 'utf8'));
  });
});

describe('doctor — OpenSpec version-range compliance', () => {
  it('accepts an in-range pin', async () => {
    await initClean();
    write('package.json', JSON.stringify({ devDependencies: { '@fission-ai/openspec': '1.6.0' } }));
    const report = await doctor({ root: scratch }, { confirmFix: confirmNever });
    expect(findingsFor(report, 'openspec-version')).toEqual([]);
  });

  it('detects an out-of-range pin and re-pins to the tested version on confirm', async () => {
    await initClean();
    write(
      'package.json',
      JSON.stringify({ devDependencies: { '@fission-ai/openspec': '2.0.0' } }, null, 2) + '\n',
    );

    const confirm = vi.fn<ConfirmFix>(() => true);
    const report = await doctor({ root: scratch }, { confirmFix: confirm });

    const finding = findingsFor(report, 'openspec-version')[0]!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('drift');
    expect(resolutionOf(report, finding.id)).toBe('fixed');
    expect(read('package.json')).toContain(`"@fission-ai/openspec": "${OPENSPEC_TESTED_VERSION}"`);
  });

  it('skips the check when the project has no package.json', async () => {
    await initClean();
    const report = await doctor({ root: scratch }, { confirmFix: confirmNever });
    expect(findingsFor(report, 'openspec-version')).toEqual([]);
  });
});

describe('doctor — upstream rubric-line offers (accept/skip, never silent merge)', () => {
  it('offers each upstream line the project rubric lacks, and appends only accepted ones', async () => {
    await initClean();
    const def = loadDefaultRubric();
    // Trim the project rubric down to its first line only — the rest are "upstream".
    const first = def.lines[0]!;
    write(
      join('.crucible', 'rubric.yaml'),
      `version: 1\nlines:\n  - id: ${first.id}\n    severity: ${first.severity}\n    criterion: ${first.criterion}\n    evidence: ${first.evidence}\n`,
    );

    const missing = def.lines.slice(1);
    // Accept the first offered line, skip the rest.
    const confirm = vi.fn<ConfirmFix>((f: DoctorFinding) => f.id.endsWith(missing[0]!.id));

    const report = await doctor({ root: scratch }, { confirmFix: confirm });

    const offers = findingsFor(report, 'rubric-lines');
    expect(offers).toHaveLength(missing.length);
    expect(offers.every((f) => f.severity === 'offer')).toBe(true);
    // confirm consulted once per offer — nothing merged without an explicit yes.
    expect(confirm).toHaveBeenCalledTimes(missing.length);

    const rubric = read(join('.crucible', 'rubric.yaml'));
    expect(rubric).toContain(`id: ${missing[0]!.id}`); // accepted → appended
    expect(rubric).not.toContain(`id: ${missing[1]!.id}`); // skipped → absent
  });

  it('makes no rubric offers when the project already has every upstream line', async () => {
    await initClean(); // init installs the full default rubric
    const report = await doctor({ root: scratch }, { confirmFix: confirmNever });
    expect(findingsFor(report, 'rubric-lines')).toEqual([]);
  });

  it('an accepted upstream line parses back as a valid rubric line', async () => {
    await initClean();
    const def = loadDefaultRubric();
    const first = def.lines[0]!;
    write(
      join('.crucible', 'rubric.yaml'),
      `version: 1\nlines:\n  - id: ${first.id}\n    severity: ${first.severity}\n    criterion: ${first.criterion}\n    evidence: ${first.evidence}\n`,
    );
    await doctor({ root: scratch }, { confirmFix: () => true });
    // Re-running finds nothing to offer: every line now present and valid.
    const report = await doctor({ root: scratch }, { confirmFix: confirmNever });
    expect(findingsFor(report, 'rubric-lines')).toEqual([]);
  });
});

describe('doctor — read-only unless confirmed (TCB respect)', () => {
  it('writes nothing to disk when every fix is declined', async () => {
    await initClean();
    write(join('.github', 'workflows', 'crucible.yml'), '# stale\n');
    write('package.json', JSON.stringify({ devDependencies: { '@fission-ai/openspec': '9.9.9' } }));
    const ciBefore = read(join('.github', 'workflows', 'crucible.yml'));
    const pkgBefore = read('package.json');

    const report = await doctor({ root: scratch }, { confirmFix: () => false });

    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.results.every((r) => r.resolution !== 'fixed')).toBe(true);
    expect(read(join('.github', 'workflows', 'crucible.yml'))).toBe(ciBefore);
    expect(read('package.json')).toBe(pkgBefore);
  });
});
