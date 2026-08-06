// P3-02 acceptance — the conformance runner (fixtures/conformance/run.ts).
//
// Two halves of the task's acceptance bar:
//   1. The reference STUB adapter passes the full conformance run — this is what
//      makes the run "the protocol's executable spec" (design phase-3.md §1/§1.1).
//   2. A deliberately-broken stub variant FAILS with ATTRIBUTABLE findings — each
//      break trips exactly its owning universal check and no other, proving the
//      runner localizes a defect rather than just going red.
//
// The runner spawns the manifest's invocation strings verbatim (design §1.1), so
// this suite drives REAL subprocesses: the built stub and a wrapper that delegates
// to it. It therefore needs the stub built (adapters/stub/dist) — the same
// build-before-test posture the JVM conformance suite and core integration tests
// take. `hasTool`-style guards are unnecessary: the stub is pure Node.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONFORMANCE_DIR } from './index.js';
import {
  CONFORMANCE_CHECKS,
  hasFindings,
  runConformance,
  type ConformanceReport,
} from '../conformance/run.js';

const STUB_SCRIPT = join(CONFORMANCE_DIR, 'stub.script.json');
const BROKEN_DIR = join(CONFORMANCE_DIR, 'broken-stub');
const BROKEN_SCRIPT = join(BROKEN_DIR, 'broken.script.json');
const BAD_MANIFEST_SCRIPT = join(BROKEN_DIR, 'manifest-invalid.script.json');
const MISSING_PKG_SCRIPT = join(BROKEN_DIR, 'missing-package.script.json');

function checkOf(report: ConformanceReport, name: string) {
  const c = report.checks.find((entry) => entry.check === name);
  expect(c, `report is missing the '${name}' check`).toBeDefined();
  return c!;
}

function findingsOf(report: ConformanceReport, name: string) {
  return checkOf(report, name).findings;
}

/** Names of the checks OTHER than `name`. */
function otherChecks(name: string): string[] {
  return CONFORMANCE_CHECKS.filter((c) => c !== name);
}

describe('conformance runner — the stub is the protocol executable spec', () => {
  const report = runConformance(STUB_SCRIPT);

  it('the stub passes the full conformance run with zero findings', () => {
    expect(report.adapter).toBe('stub');
    // Every universal check is present and evaluated (none silently skipped).
    for (const name of CONFORMANCE_CHECKS) {
      const c = checkOf(report, name);
      expect(c.evaluated, `${name} was not evaluated`).toBe(true);
      expect(
        c.findings,
        `${name} produced findings:\n${JSON.stringify(c.findings, null, 2)}`,
      ).toEqual([]);
    }
    expect(hasFindings(report)).toBe(false);
  });

  it('surfaces the package content digest for the pin flow', () => {
    const digest = checkOf(report, 'package-hash').digest;
    expect(digest, 'package-hash must surface a digest').toBeDefined();
    expect(digest!.length).toBeGreaterThan(0);
    for (const entry of digest!) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the report is deterministic — same inputs, byte-identical report', () => {
    const again = runConformance(STUB_SCRIPT);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it('resolves the adapter bin without relying on PATH (CI has no .bin symlink)', () => {
    // The stub script binds its bin via `resolveBin` (node + dist path), not the
    // npm-hoisted node_modules/.bin — which is absent under `npm ci` before the
    // build. Clearing PATH proves the resolution is PATH-independent; this is the
    // regression guard for the ENOENT the first CI run hit.
    const cleared = runConformance(STUB_SCRIPT, { envOverride: { PATH: '' } });
    expect(
      hasFindings(cleared),
      JSON.stringify(
        cleared.checks.filter((c) => c.findings.length > 0),
        null,
        2,
      ),
    ).toBe(false);
  });
});

describe('conformance runner — a deliberately-broken variant fails attributably', () => {
  it('a faithful no-break pass-through wrapper is still fully green', () => {
    // Proves the wrapper is a true delegate: any redness under a break mode is
    // caused by the break, not by the wrapper itself.
    const report = runConformance(BROKEN_SCRIPT);
    expect(hasFindings(report)).toBe(false);
  });

  // Each break mode is orthogonal: it trips exactly one universal check.
  const modes: { mode: string; check: string }[] = [
    { mode: 'envelope-drop', check: 'envelope' },
    { mode: 'missing-targetfile', check: 'envelope' },
    { mode: 'wrong-status', check: 'case-expectations' },
    { mode: 'accept-garbage', check: 'malformed-stdin' },
  ];

  it.each(modes)('break "$mode" is attributed to the $check check alone', ({ mode, check }) => {
    const report = runConformance(BROKEN_SCRIPT, { envOverride: { CRUCIBLE_BREAK: mode } });

    expect(hasFindings(report)).toBe(true);
    const findings = findingsOf(report, check);
    expect(findings.length, `${mode} should trip ${check}`).toBeGreaterThan(0);
    // Every finding is self-attributing to its check.
    for (const f of findings) expect(f.check).toBe(check);
    // Isolation: no other universal check fired.
    for (const other of otherChecks(check)) {
      expect(
        findingsOf(report, other),
        `${mode} unexpectedly tripped ${other}:\n${JSON.stringify(findingsOf(report, other), null, 2)}`,
      ).toEqual([]);
    }
  });

  it('an invalid adapter manifest is caught by the manifest-valid check', () => {
    const report = runConformance(BAD_MANIFEST_SCRIPT);
    expect(findingsOf(report, 'manifest-valid').length).toBeGreaterThan(0);
    expect(hasFindings(report)).toBe(true);
  });

  it('a missing packaged file is caught by the package-hash check, and nothing else', () => {
    const report = runConformance(MISSING_PKG_SCRIPT);
    expect(findingsOf(report, 'package-hash').length).toBeGreaterThan(0);
    // The manifest is valid and the wrapper delegates faithfully, so the spawn
    // checks stay green — the failure is localized to package-hash.
    for (const other of otherChecks('package-hash')) {
      expect(findingsOf(report, other)).toEqual([]);
    }
  });
});

describe('conformance runner — its OWN inputs fail closed (exit 3 territory)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'crucible-conformance-'));

  function writeScript(name: string, body: string): string {
    const p = join(tmp, name);
    writeFileSync(p, body);
    return p;
  }

  it('rejects a script with an unknown field', () => {
    const p = writeScript(
      'unknown-field.json',
      JSON.stringify({
        name: 'x',
        manifest: './m.yaml',
        cwd: '.',
        cases: './c.json',
        package: { files: [] },
        surpriseKey: true,
      }),
    );
    expect(() => runConformance(p)).toThrow(/unknown|unrecognized|surpriseKey/i);
  });

  it('rejects a script that is not valid JSON', () => {
    const p = writeScript('not-json.json', '{ this is not json');
    expect(() => runConformance(p)).toThrow();
  });

  it('rejects a case catalogue with duplicate targets in one case', () => {
    writeScript('dupe-manifest.yaml', 'name: x\n');
    writeScript(
      'dupe-cases.json',
      JSON.stringify({
        cases: [
          {
            name: 'dupe',
            verb: 'resolve',
            targets: ['a::b', 'a::b'],
            expected: [{ target: 'a::b', status: 'found' }],
          },
        ],
      }),
    );
    const p = writeScript(
      'dupe-script.json',
      JSON.stringify({
        name: 'x',
        manifest: './dupe-manifest.yaml',
        cwd: '.',
        cases: './dupe-cases.json',
        package: { files: [] },
      }),
    );
    expect(() => runConformance(p)).toThrow(/duplicate/i);
  });

  it('fails closed when the script file does not exist', () => {
    expect(() => runConformance(join(tmp, 'nope.json'))).toThrow();
  });
});

it('exposes the fixed set of six universal checks', () => {
  expect([...CONFORMANCE_CHECKS]).toEqual([
    'manifest-valid',
    'envelope',
    'missing-no-targetfile',
    'case-expectations',
    'malformed-stdin',
    'package-hash',
  ]);
});
