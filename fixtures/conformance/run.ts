// Adapter conformance runner (task P3-02, design phase-3.md §1 / §1.1).
//
// Drives ANY Crucible adapter through a declared conformance SCRIPT and reports
// which universal checks it satisfies. The stub adapter passing this run is what
// makes the run "the protocol's executable spec"; a real adapter (java-junit,
// P3-04/P3-05) is certified by authoring its own script in the same grammar.
//
// ─── What is asserted (design §1.1) ─────────────────────────────────────────
// The engine spawns the MANIFEST's invocation strings VERBATIM — same
// tokenization + spawn semantics as core's adapter client — so conformance
// certifies exactly what core will run in production, never a re-implementation.
// Responses are validated with core's OWN strict zod envelopes and manifests
// with core's OWN parseManifest; package files are digested with core's OWN
// hashFile. Re-stating any of these here would fork the spec, so they are
// imported from core source (see phase-3.md §1.1 for why source, not package).
//
// ─── Fail-closed posture (architecture §2/§3, invariant 3) ───────────────────
// Two failure planes, kept distinct:
//   * A misbehaving ADAPTER (hang, crash, garbled/wrong output) is a FINDING on
//     the owning check — the subject failed; the runner never crashes for it.
//   * The runner's OWN inputs being malformed (unreadable/invalid script, cases,
//     or manifest file) is a RunnerInputError → exit 3. That is a bug in the
//     conformance harness's wiring, not an adapter verdict.
// Determinism (invariant 12): synchronous, no wall-clock or randomness in the
// report; findings are ordered by (check, case, target input order).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

// Canonical contracts, imported from core SOURCE (not the package) — see the
// header and design §1.1. These are the single source of truth core enforces.
import { hashFile } from '../../core/src/hash/hash.js';
import { parseManifest, type AdapterManifest } from '../../core/src/adapters/manifest.js';
import {
  resolveEnvelopeSchema,
  runEnvelopeSchema,
  type AdapterVerb,
} from '../../core/src/adapters/types.js';

import { parseConformanceCases, type ConformanceCase } from '../src/index.js';

// ─── Public API ──────────────────────────────────────────────────────────────

/** The six universal checks, in report order. A script cannot opt out of any. */
export const CONFORMANCE_CHECKS = [
  'manifest-valid',
  'envelope',
  'missing-no-targetfile',
  'case-expectations',
  'malformed-stdin',
  'package-hash',
] as const;

export type ConformanceCheckName = (typeof CONFORMANCE_CHECKS)[number];

/** A declared conformance script — the per-adapter wiring the runner drives. */
export interface ConformanceScript {
  /** Adapter name, surfaced as `report.adapter`. */
  name: string;
  /** Path to the adapter manifest (crucible-adapter.yaml), rel to the script dir. */
  manifest: string;
  /** Working directory the adapter subprocess runs in, rel to the script dir. */
  cwd: string;
  /** Optional dir prepended to PATH so the manifest's bare bin resolves (rel to script dir). */
  pathPrepend?: string;
  /**
   * Optional map from a manifest bin NAME to a concrete command — the runner's
   * analogue of core's adapter-client `resolveExecutable` (client.ts). Use it
   * when the named bin is not reliably on PATH (e.g. a monorepo package whose
   * npm `.bin` symlink is absent under `npm ci` before the build). `command`
   * `"node"` resolves to the running interpreter; every `prefixArgs` entry is a
   * path resolved relative to the script dir. Keeps the invocation faithful:
   * only the bin-name→path binding changes, exactly as it does at `init`.
   */
  resolveBin?: Record<string, { command: string; prefixArgs?: string[] }>;
  /** Optional extra env for the adapter subprocess. */
  env?: Record<string, string>;
  /** Per-spawn timeout in ms (default 30000). A hung adapter is a finding. */
  timeoutMs?: number;
  /** Path to the case catalogue (cases.json shape, P1-10), rel to the script dir. */
  cases: string;
  /** The packaged executable's files to content-hash, rel to the script dir. */
  package: { files: string[] };
}

/** One attributable defect. `check` is always set; the rest narrow the location. */
export interface Finding {
  check: ConformanceCheckName;
  case?: string;
  target?: string;
  expected?: unknown;
  actual?: unknown;
  detail: string;
}

/** One digested package file, surfaced for the pin flow (design §1.1 check 6). */
export interface PackageDigestEntry {
  path: string;
  sha256: string;
}

/** The per-check result: its findings (empty = green) and whether it ran. */
export interface CheckReport {
  check: ConformanceCheckName;
  /** False iff a prior failure (e.g. an invalid manifest) prevented evaluation. */
  evaluated: boolean;
  findings: Finding[];
  /** Set only on `package-hash`: the content digest of each packaged file. */
  digest?: PackageDigestEntry[];
}

/** The deterministic conformance report (no timestamps, no durations). */
export interface ConformanceReport {
  adapter: string;
  checks: CheckReport[];
}

/** Options for `runConformance` (test seam: override env per invocation). */
export interface RunConformanceOptions {
  /** Env entries layered over `script.env` (used to drive break modes in tests). */
  envOverride?: Record<string, string>;
}

/** The runner's OWN inputs were malformed/unreadable → exit 3 (not an adapter verdict). */
export class RunnerInputError extends Error {
  override readonly name = 'RunnerInputError';
}

/** True iff any check produced a finding (maps to CLI exit 1: a verdict, not an error). */
export function hasFindings(report: ConformanceReport): boolean {
  return report.checks.some((c) => c.findings.length > 0);
}

// ─── Engine ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

export function runConformance(
  scriptPath: string,
  options: RunConformanceOptions = {},
): ConformanceReport {
  const scriptDir = dirname(scriptPath);
  const script = loadScript(scriptPath);

  const cases = loadCases(script, scriptDir);
  const manifestPath = resolvePath(scriptDir, script.manifest);
  const manifestText = readRunnerInput(manifestPath, 'adapter manifest');

  const spawnCtx: SpawnCtx = {
    scriptDir,
    cwd: resolvePath(scriptDir, script.cwd),
    env: buildEnv(script, scriptDir, options.envOverride),
    timeoutMs: script.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    resolveBin: script.resolveBin ?? {},
  };

  // 1 — manifest-valid. If the manifest is invalid we cannot spawn, so the
  // spawn-dependent checks are recorded as not-evaluated rather than fabricating
  // findings against an adapter we never reached.
  const manifestCheck = emptyCheck('manifest-valid');
  let manifest: AdapterManifest | undefined;
  try {
    manifest = parseManifest(manifestText, manifestPath);
  } catch (err) {
    manifestCheck.findings.push({
      check: 'manifest-valid',
      detail: messageOf(err),
    });
  }

  const envelope = emptyCheck('envelope');
  const missingNoTargetFile = emptyCheck('missing-no-targetfile');
  const caseExpectations = emptyCheck('case-expectations');
  const malformedStdin = emptyCheck('malformed-stdin');

  if (manifest === undefined) {
    for (const c of [envelope, missingNoTargetFile, caseExpectations, malformedStdin]) {
      c.evaluated = false;
    }
  } else {
    evaluateCases(manifest, cases, spawnCtx, {
      envelope,
      missingNoTargetFile,
      caseExpectations,
    });
    evaluateMalformedStdin(manifest, spawnCtx, malformedStdin);
  }

  // 6 — package-hash. Independent of the manifest; always evaluated.
  const packageHash = evaluatePackageHash(script, scriptDir);

  return {
    adapter: script.name,
    checks: [
      manifestCheck,
      envelope,
      missingNoTargetFile,
      caseExpectations,
      malformedStdin,
      packageHash,
    ],
  };
}

// ─── Universal checks 2–4: per-case envelope + semantics ─────────────────────

interface CaseChecks {
  envelope: CheckReport;
  missingNoTargetFile: CheckReport;
  caseExpectations: CheckReport;
}

function evaluateCases(
  manifest: AdapterManifest,
  cases: ConformanceCase[],
  ctx: SpawnCtx,
  checks: CaseChecks,
): void {
  for (const c of cases) {
    const requested = c.targets;
    const spawnResult = spawnAdapter(manifest, c.verb, jsonRequest(requested), ctx);

    // 2 — envelope: exit 0, strict envelope, one result per requested target,
    // input order, no drops or extras. Any breach makes the response untrusted,
    // so we skip the semantic checks (3, 4) for this case.
    const results = checkEnvelope(c, requested, spawnResult, checks.envelope);
    if (results === undefined) continue;

    // 3 — missing-no-targetfile (resolve only): a `missing` result must not
    // carry a targetFile (a phantom path is seal poison; design §2 resolve).
    if (c.verb === 'resolve') {
      for (const r of results) {
        const rec = r as Record<string, unknown>;
        if (rec['status'] === 'missing' && rec['targetFile'] !== undefined) {
          checks.missingNoTargetFile.findings.push({
            check: 'missing-no-targetfile',
            case: c.name,
            target: String(rec['target']),
            actual: rec['targetFile'],
            detail: 'a `missing` resolve result carries a targetFile (phantom seal path)',
          });
        }
      }
    }

    // 4 — case-expectations: declared-field exact match. Only fields PRESENT in
    // the expected entry are constrained; target + status are always compared.
    const byTarget = indexByTarget(results);
    for (const expected of c.expected) {
      const exp = expected as unknown as Record<string, unknown>;
      const target = String(exp['target']);
      const actual = byTarget.get(target) as Record<string, unknown> | undefined;
      if (actual === undefined) {
        // Envelope passed, so every requested target has a result; an expected
        // target with none means the catalogue references an un-requested target.
        checks.caseExpectations.findings.push({
          check: 'case-expectations',
          case: c.name,
          target,
          detail: 'expected result references a target not in the case request',
        });
        continue;
      }
      for (const key of Object.keys(exp)) {
        if (!deepEqual(exp[key], actual[key])) {
          checks.caseExpectations.findings.push({
            check: 'case-expectations',
            case: c.name,
            target,
            expected: { [key]: exp[key] },
            actual: { [key]: actual[key] },
            detail: `field \`${key}\` does not match`,
          });
        }
      }
    }
  }
}

/**
 * Validate the envelope for one case. Returns the results array on success, or
 * `undefined` (after recording findings) when the response cannot be trusted.
 */
function checkEnvelope(
  c: ConformanceCase,
  requested: readonly string[],
  spawn: SpawnResult,
  check: CheckReport,
): Record<string, unknown>[] | undefined {
  const fail = (detail: string, extra?: Partial<Finding>): undefined => {
    check.findings.push({ check: 'envelope', case: c.name, detail, ...extra });
    return undefined;
  };

  if (spawn.timedOut) return fail(`adapter timed out after ${spawn.timeoutMs}ms`);
  if (spawn.spawnError !== undefined) {
    // The process never ran (e.g. ENOENT: the manifest's bin was not found).
    return fail(`adapter could not be spawned — ${spawn.spawnError}`);
  }
  if (spawn.status !== 0) {
    return fail(
      `adapter exited ${spawn.status === null ? '(killed)' : String(spawn.status)}` +
        `${spawn.stderr.trim() ? `: ${spawn.stderr.trim()}` : ''}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(spawn.stdout);
  } catch (err) {
    return fail(`stdout is not valid JSON — ${messageOf(err)}`);
  }

  const schema = c.verb === 'resolve' ? resolveEnvelopeSchema : runEnvelopeSchema;
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return fail(`response violates the ${c.verb} envelope schema — ${formatZod(validated.error)}`);
  }

  const results = validated.data.results as unknown as Record<string, unknown>[];
  // Exactly one result per requested target, in input order (no drops/extras).
  const maxLen = Math.max(results.length, requested.length);
  let ok = true;
  for (let i = 0; i < maxLen; i++) {
    const want = requested[i];
    const got = results[i]?.['target'] as string | undefined;
    if (want !== got) {
      ok = false;
      check.findings.push({
        check: 'envelope',
        case: c.name,
        // Exactly one of want/got may be undefined here (equal ⇒ not in this
        // branch), so the coalesce is always a defined string.
        target: (want ?? got) as string,
        expected: want,
        actual: got,
        detail:
          want === undefined
            ? 'adapter returned a result for an un-requested target'
            : got === undefined
              ? 'adapter dropped a requested target'
              : 'adapter returned results out of requested order',
      });
    }
  }
  return ok ? results : undefined;
}

// ─── Universal check 5: malformed-stdin rejection ────────────────────────────

function evaluateMalformedStdin(
  manifest: AdapterManifest,
  ctx: SpawnCtx,
  check: CheckReport,
): void {
  const probes: { name: string; body: string }[] = [
    { name: 'non-json', body: 'this is not json' },
    { name: 'schema-invalid', body: JSON.stringify({ targets: 'not-an-array' }) },
  ];
  const verbs: AdapterVerb[] = ['resolve', 'run'];
  for (const verb of verbs) {
    for (const probe of probes) {
      const spawn = spawnAdapter(manifest, verb, probe.body, ctx);
      const label = `${verb}:${probe.name}`;
      // The adapter MUST reject: non-zero exit AND no valid envelope on stdout.
      if (spawn.timedOut) {
        check.findings.push({
          check: 'malformed-stdin',
          case: label,
          detail: `adapter timed out on malformed stdin after ${spawn.timeoutMs}ms`,
        });
        continue;
      }
      const emittedValidEnvelope = parsesAsEnvelope(verb, spawn.stdout);
      if (spawn.status === 0 || emittedValidEnvelope) {
        check.findings.push({
          check: 'malformed-stdin',
          case: label,
          actual: { status: spawn.status, emittedValidEnvelope },
          detail: 'adapter accepted malformed stdin instead of failing closed',
        });
      }
    }
  }
}

function parsesAsEnvelope(verb: AdapterVerb, stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  const schema = verb === 'resolve' ? resolveEnvelopeSchema : runEnvelopeSchema;
  return schema.safeParse(parsed).success;
}

// ─── Universal check 6: package hash / existence ─────────────────────────────

function evaluatePackageHash(script: ConformanceScript, scriptDir: string): CheckReport {
  const check = emptyCheck('package-hash');
  const digest: PackageDigestEntry[] = [];
  for (const file of script.package.files) {
    const abs = resolvePath(scriptDir, file);
    let first: string;
    try {
      // Two independent digests must agree (hashFile is deterministic, invariant
      // 12); a read failure here means the declared file is absent/unreadable.
      first = hashFile(abs);
    } catch (err) {
      check.findings.push({
        check: 'package-hash',
        target: file,
        detail: `declared package file is missing or unreadable — ${messageOf(err)}`,
      });
      continue;
    }
    const second = hashFile(abs);
    if (first !== second) {
      check.findings.push({
        check: 'package-hash',
        target: file,
        detail: 'content digest is non-deterministic across two reads',
      });
      continue;
    }
    digest.push({ path: file, sha256: first });
  }
  check.digest = digest;
  return check;
}

// ─── Spawning (verbatim manifest invocation, core-client semantics) ──────────

interface SpawnCtx {
  scriptDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  resolveBin: Record<string, { command: string; prefixArgs?: string[] }>;
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
  /** Spawn-level failure (e.g. ENOENT: the bin was never found), if any. */
  spawnError?: string;
}

function spawnAdapter(
  manifest: AdapterManifest,
  verb: AdapterVerb,
  input: string,
  ctx: SpawnCtx,
): SpawnResult {
  const invocation = manifest.invocations[verb];
  // Tokenize exactly as core's adapter client does (client.ts `invoke`).
  const tokens = invocation.split(/\s+/).filter((t) => t.length > 0);
  const name = tokens[0];
  if (name === undefined) {
    // A structurally-valid manifest always has a non-empty invocation (schema
    // min(1)); an empty token list here is a runner-side impossibility.
    throw new RunnerInputError(`${manifest.name}: empty ${verb} invocation string`);
  }
  // Resolve the bin NAME → concrete command, mirroring core's resolveExecutable.
  const binding = ctx.resolveBin[name];
  const command =
    binding === undefined ? name : binding.command === 'node' ? process.execPath : binding.command;
  const prefixArgs =
    binding === undefined
      ? []
      : (binding.prefixArgs ?? []).map((a) => resolvePath(ctx.scriptDir, a));
  const argv = [...prefixArgs, ...tokens.slice(1)];
  const result = spawnSync(command, argv, {
    cwd: ctx.cwd,
    env: ctx.env,
    input,
    encoding: 'utf8',
    timeout: ctx.timeoutMs,
  });
  const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errCode === 'ETIMEDOUT' || (result.status === null && result.signal !== null);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    timeoutMs: ctx.timeoutMs,
    ...(result.error && !timedOut ? { spawnError: messageOf(result.error) } : {}),
  };
}

function buildEnv(
  script: ConformanceScript,
  scriptDir: string,
  envOverride?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...script.env, ...envOverride };
  if (script.pathPrepend !== undefined) {
    const dir = resolvePath(scriptDir, script.pathPrepend);
    env['PATH'] = `${dir}${delimiter}${env['PATH'] ?? ''}`;
  }
  return env;
}

// ─── Loading + validating the runner's OWN inputs (fail-closed → exit 3) ──────

function loadScript(scriptPath: string): ConformanceScript {
  const raw = readRunnerInput(scriptPath, 'conformance script');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RunnerInputError(`${scriptPath}: not valid JSON — ${messageOf(err)}`);
  }
  return validateScript(parsed, scriptPath);
}

const KNOWN_SCRIPT_KEYS = new Set([
  '//', // the repo-wide JSON comment convention (cases.json, targets.json)
  'name',
  'manifest',
  'cwd',
  'pathPrepend',
  'resolveBin',
  'env',
  'timeoutMs',
  'cases',
  'package',
]);

function validateScript(value: unknown, source: string): ConformanceScript {
  if (!isRecord(value)) {
    throw new RunnerInputError(`${source}: conformance script must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_SCRIPT_KEYS.has(key)) {
      throw new RunnerInputError(`${source}: unknown field \`${key}\` (fail-closed on typos)`);
    }
  }
  requireString(value, 'name', source);
  requireString(value, 'manifest', source);
  requireString(value, 'cwd', source);
  requireString(value, 'cases', source);
  if (value['pathPrepend'] !== undefined && typeof value['pathPrepend'] !== 'string') {
    throw new RunnerInputError(`${source}: \`pathPrepend\` must be a string`);
  }
  if (value['timeoutMs'] !== undefined && typeof value['timeoutMs'] !== 'number') {
    throw new RunnerInputError(`${source}: \`timeoutMs\` must be a number`);
  }
  if (value['env'] !== undefined && !isStringRecord(value['env'])) {
    throw new RunnerInputError(`${source}: \`env\` must be a string→string map`);
  }
  const resolveBin = parseResolveBin(value['resolveBin'], source);
  const pkg = value['package'];
  if (
    !isRecord(pkg) ||
    !Array.isArray(pkg['files']) ||
    !pkg['files'].every((f) => typeof f === 'string')
  ) {
    throw new RunnerInputError(`${source}: \`package.files\` must be a string array`);
  }
  return {
    name: value['name'] as string,
    manifest: value['manifest'] as string,
    cwd: value['cwd'] as string,
    cases: value['cases'] as string,
    ...(typeof value['pathPrepend'] === 'string' ? { pathPrepend: value['pathPrepend'] } : {}),
    ...(resolveBin !== undefined ? { resolveBin } : {}),
    ...(typeof value['timeoutMs'] === 'number' ? { timeoutMs: value['timeoutMs'] } : {}),
    ...(isStringRecord(value['env']) ? { env: value['env'] } : {}),
    package: { files: pkg['files'] as string[] },
  };
}

/** Validate the optional `resolveBin` map (bin name → { command, prefixArgs? }). */
function parseResolveBin(
  value: unknown,
  source: string,
): Record<string, { command: string; prefixArgs?: string[] }> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RunnerInputError(`${source}: \`resolveBin\` must be an object`);
  }
  const out: Record<string, { command: string; prefixArgs?: string[] }> = {};
  for (const [name, binding] of Object.entries(value)) {
    if (!isRecord(binding) || typeof binding['command'] !== 'string') {
      throw new RunnerInputError(`${source}: \`resolveBin.${name}.command\` must be a string`);
    }
    const prefixArgs = binding['prefixArgs'];
    if (
      prefixArgs !== undefined &&
      (!Array.isArray(prefixArgs) || !prefixArgs.every((a) => typeof a === 'string'))
    ) {
      throw new RunnerInputError(
        `${source}: \`resolveBin.${name}.prefixArgs\` must be a string array`,
      );
    }
    out[name] = {
      command: binding['command'],
      ...(Array.isArray(prefixArgs) ? { prefixArgs: prefixArgs as string[] } : {}),
    };
  }
  return out;
}

function loadCases(script: ConformanceScript, scriptDir: string): ConformanceCase[] {
  const casesPath = resolvePath(scriptDir, script.cases);
  const raw = readRunnerInput(casesPath, 'case catalogue');
  let cases: ConformanceCase[];
  try {
    // Validate through the SAME P1-10 grammar the async loader uses (index.ts).
    cases = parseConformanceCases(raw, casesPath);
  } catch (err) {
    throw new RunnerInputError(messageOf(err));
  }
  for (const c of cases) {
    const seen = new Set<string>();
    for (const t of c.targets) {
      if (seen.has(t)) {
        throw new RunnerInputError(
          `${casesPath}: case '${c.name}' has a duplicate target \`${t}\` ` +
            `(the wire dedupes; a duplicated request target is an authoring error)`,
        );
      }
      seen.add(t);
    }
  }
  return cases;
}

// ─── small helpers ───────────────────────────────────────────────────────────

function emptyCheck(check: ConformanceCheckName): CheckReport {
  return { check, evaluated: true, findings: [] };
}

function jsonRequest(targets: readonly string[]): string {
  return JSON.stringify({ targets });
}

function indexByTarget(results: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const byTarget = new Map<string, Record<string, unknown>>();
  for (const r of results) {
    const t = String(r['target']);
    if (!byTarget.has(t)) byTarget.set(t, r);
  }
  return byTarget;
}

function readRunnerInput(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new RunnerInputError(`could not read ${what} at ${path} — ${messageOf(err)}`);
  }
}

function requireString(value: Record<string, unknown>, key: string, source: string): void {
  if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
    throw new RunnerInputError(`${source}: \`${key}\` must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatZod(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const scriptArg = process.argv[2];
  if (scriptArg === undefined) {
    process.stderr.write('usage: run.ts <conformance-script.json>\n');
    process.exitCode = 2;
  } else {
    try {
      const report = runConformance(resolvePath(process.cwd(), scriptArg));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = hasFindings(report) ? 1 : 0;
    } catch (err) {
      if (err instanceof RunnerInputError) {
        process.stderr.write(`conformance runner: ${err.message}\n`);
        process.exitCode = 3;
      } else {
        process.stderr.write(`conformance runner (internal error): ${messageOf(err)}\n`);
        if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
        process.exitCode = 4;
      }
    }
  }
}
