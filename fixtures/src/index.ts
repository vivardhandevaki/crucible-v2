// Fixtures workspace — programmatic access to the toy repo (P0-03).
//
// Core integration tests consume these path constants and the fail-closed
// loaders below. The fixture *data* lives under ../toy-repo and is deliberately
// excluded from lint/format/tsc (see eslint.config.js / .prettierignore): its
// bytes are author-controlled and sealed by the approval hash, so no tool may
// reformat it. This module only computes paths and parses; it never mutates.

import { cpSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/index.ts (or dist/index.js) → workspace root → toy-repo.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The monorepo root: one level above the fixtures workspace. Used to reach the
// stub adapter, which lives in the sibling `adapters/stub` workspace.
const monorepoRoot = dirname(workspaceRoot);

/** Absolute path to the toy fixture repo root. */
export const TOY_REPO_ROOT = join(workspaceRoot, 'toy-repo');

/** The stub adapter's workspace root (P1-10). */
export const STUB_ADAPTER_ROOT = join(monorepoRoot, 'adapters', 'stub');

/**
 * The stub adapter's manifest (`crucible-adapter.yaml`) — the P1-11 adapter
 * client loads this to learn the invocation strings it must spawn.
 */
export const STUB_ADAPTER_MANIFEST_PATH = join(STUB_ADAPTER_ROOT, 'crucible-adapter.yaml');

/**
 * The stub adapter's built executable (`dist/cli.js`). The manifest names
 * `crucible-adapter-stub`; tests spawn this file via `node <bin>` so the suite
 * needs no global install of the adapter bin.
 */
export const STUB_ADAPTER_BIN_PATH = join(STUB_ADAPTER_ROOT, 'dist', 'cli.js');

/** The stub adapter's declarative test inventory (design phase-0-1.md §7). */
export const TESTS_JSON_PATH = join(TOY_REPO_ROOT, 'tests.json');

/** Pre-written *valid* change bundle (an OpenSpec change directory). */
export const VALID_BUNDLE_DIR = join(TOY_REPO_ROOT, 'openspec', 'changes', 'add-greeting');

/**
 * Root from which enforcement config is resolved (`crucible.yaml` lives here).
 * For the toy repo this is the repo root; in CI the target-branch checkout root
 * is passed via `--config-from` instead (charter §The Target-Branch Rule).
 */
export const CONFIG_ROOT = TOY_REPO_ROOT;

/** Valid enforcement config fixture (charter §crucible.yaml — Reference Shape). */
export const CRUCIBLE_YAML_PATH = join(TOY_REPO_ROOT, 'crucible.yaml');

/** Valid team-convenience config fixture (`models` + `notify` only). */
export const SETTINGS_YAML_PATH = join(TOY_REPO_ROOT, '.crucible', 'settings.yaml');

/** Deliberately-invalid fixtures for parser tests, one defect per file. */
export const INVALID_FIXTURES_DIR = join(TOY_REPO_ROOT, 'bundles', 'invalid');

/** Machine-readable catalogue of every invalid fixture and its expected error. */
export const INVALID_EXPECTED_ERRORS_PATH = join(INVALID_FIXTURES_DIR, 'expected-errors.json');

/** Seed of the adapter conformance suite (P1-10): the golden-cases directory. */
export const CONFORMANCE_DIR = join(workspaceRoot, 'conformance');

/** Machine-readable catalogue of adapter conformance cases (verb+input→output). */
export const CONFORMANCE_CASES_PATH = join(CONFORMANCE_DIR, 'cases.json');

/** The `maven-basic` JVM conformance fixture root (task P3-01, design §1). */
export const MAVEN_BASIC_DIR = join(CONFORMANCE_DIR, 'maven-basic');

/** The `gradle-basic` JVM conformance fixture root (task P3-01, design §1). */
export const GRADLE_BASIC_DIR = join(CONFORMANCE_DIR, 'gradle-basic');

/**
 * Shared JVM conformance target manifest: the five categories both fixtures
 * embody, each target's expected `resolve` classification and `run` outcome.
 * One manifest describes both fixtures (identical sources; different classpaths).
 */
export const CONFORMANCE_TARGETS_PATH = join(CONFORMANCE_DIR, 'targets.json');


/**
 * Copy one JVM fixture's declared source surface into a private directory for a
 * build test. Gradle/Maven output trees are deliberately excluded: tests that
 * execute a fixture must never share mutable reports with the conformance
 * scripts, even when Vitest projects run concurrently (P3-10).
 */
export function copyJvmFixture(source: string, prefix: string): string {
  const destination = mkdtempSync(join(tmpdir(), prefix));
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !['build', 'target', '.gradle'].includes(basename(path)),
  });
  return destination;
}

/** Normalized-result statuses the stub adapter can report (charter schema). */
export type TestStatus = 'pass' | 'fail' | 'skip' | 'missing';

const TEST_STATUSES: readonly TestStatus[] = ['pass', 'fail', 'skip', 'missing'];

/** One entry in the toy repo's tests.json. `id` is the opaque adapter target. */
export interface StubTestEntry {
  id: string;
  file: string;
  status: TestStatus;
  message?: string;
}

/** One documented defect in the invalid-fixtures catalogue. */
export interface ExpectedError {
  /** Stable slug for the defect, e.g. `oracle-bad-kind`. */
  id: string;
  /** Which artifact grammar the defect violates. */
  artifact: 'oracles' | 'spec-delta';
  /** Path to the offending file, relative to the toy repo root. */
  path: string;
  /** Human-readable statement of the rule that is broken. */
  violation: string;
  /** The heading the defect sits under (for locating it in review). */
  heading: string;
  /** Exact text of the offending line (drift guard for `line`). */
  locator: string;
  /** 1-based line number of `locator` within the file. */
  line: number;
  /** Exit code the parser must fail with. Artifact grammar errors → 3. */
  exitCode: number;
  /** Downstream tasks that consume this fixture. */
  consumers: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTestEntry(value: unknown, index: number, source: string): StubTestEntry {
  if (!isRecord(value)) {
    throw new Error(`${source}: entry ${index} is not an object`);
  }
  const { id, file, status, message } = value;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${source}: entry ${index} has no string \`id\``);
  }
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(`${source}: entry ${index} (${id}) has no string \`file\``);
  }
  if (typeof status !== 'string' || !TEST_STATUSES.includes(status as TestStatus)) {
    throw new Error(
      `${source}: entry ${index} (${id}) has invalid \`status\`: ${JSON.stringify(status)}`,
    );
  }
  if (message !== undefined && typeof message !== 'string') {
    throw new Error(`${source}: entry ${index} (${id}) has non-string \`message\``);
  }
  return {
    id,
    file,
    status: status as TestStatus,
    ...(typeof message === 'string' ? { message } : {}),
  };
}

/** Load and fail-closed validate the toy repo's tests.json. */
export async function loadTestsJson(path: string = TESTS_JSON_PATH): Promise<StubTestEntry[]> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: tests.json must be a JSON array`);
  }
  return parsed.map((entry, index) => parseTestEntry(entry, index, path));
}

function parseExpectedError(value: unknown, index: number, source: string): ExpectedError {
  if (!isRecord(value)) {
    throw new Error(`${source}: error ${index} is not an object`);
  }
  const { id, artifact, path, violation, heading, locator, line, exitCode, consumers } = value;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${source}: error ${index} has no string \`id\``);
  }
  if (artifact !== 'oracles' && artifact !== 'spec-delta') {
    throw new Error(`${source}: error ${index} (${id}) has invalid \`artifact\``);
  }
  if (typeof path !== 'string' || typeof violation !== 'string' || typeof heading !== 'string') {
    throw new Error(`${source}: error ${index} (${id}) missing string field`);
  }
  if (typeof locator !== 'string' || typeof line !== 'number' || !Number.isInteger(line)) {
    throw new Error(`${source}: error ${index} (${id}) has invalid \`locator\`/\`line\``);
  }
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
    throw new Error(`${source}: error ${index} (${id}) has invalid \`exitCode\``);
  }
  if (!Array.isArray(consumers) || !consumers.every((c) => typeof c === 'string')) {
    throw new Error(`${source}: error ${index} (${id}) has invalid \`consumers\``);
  }
  return { id, artifact, path, violation, heading, locator, line, exitCode, consumers };
}

/** Load and fail-closed validate the invalid-fixtures catalogue. */
export async function loadExpectedErrors(
  path: string = INVALID_EXPECTED_ERRORS_PATH,
): Promise<ExpectedError[]> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) {
    throw new Error(`${path}: expected-errors.json must have an \`errors\` array`);
  }
  return parsed.errors.map((entry, index) => parseExpectedError(entry, index, path));
}

/** The two verbs every adapter honors (charter §Bindings & the Adapter Protocol). */
export type AdapterVerb = 'resolve' | 'run';

/** A `resolve` result: `found` (with the resolved file) or `missing`. */
export interface ResolveResult {
  target: string;
  status: 'found' | 'missing';
  /** Set only when `found`: the file component of the target (design §4/§7). */
  targetFile?: string;
}

/** A `run` result — the charter's normalized result schema, the only shape core parses. */
export interface RunResult {
  target: string;
  status: 'pass' | 'fail' | 'error' | 'skip';
  message?: string;
  location?: string;
  duration_ms?: number;
}

/** One golden conformance case: a verb + its stdin targets → expected results. */
export interface ConformanceCase {
  name: string;
  verb: AdapterVerb;
  targets: string[];
  /** Expected normalized output for `run`, or resolve output for `resolve`. */
  expected: (ResolveResult | RunResult)[];
}

function parseConformanceCase(value: unknown, index: number, source: string): ConformanceCase {
  if (!isRecord(value)) {
    throw new Error(`${source}: case ${index} is not an object`);
  }
  const { name, verb, targets, expected } = value;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${source}: case ${index} has no string \`name\``);
  }
  if (verb !== 'resolve' && verb !== 'run') {
    throw new Error(
      `${source}: case ${index} (${name}) has invalid \`verb\`: ${JSON.stringify(verb)}`,
    );
  }
  if (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string')) {
    throw new Error(`${source}: case ${index} (${name}) has invalid \`targets\``);
  }
  if (!Array.isArray(expected) || !expected.every(isRecord)) {
    throw new Error(`${source}: case ${index} (${name}) has invalid \`expected\``);
  }
  return { name, verb, targets, expected: expected as unknown as (ResolveResult | RunResult)[] };
}

/**
 * Parse + fail-closed validate an already-read conformance-case catalogue.
 * The synchronous core of `loadConformanceCases`, exported so the conformance
 * runner (P3-02, which is sync) validates through the SAME P1-10 grammar rather
 * than forking it.
 */
export function parseConformanceCases(raw: string, source: string): ConformanceCase[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.cases)) {
    throw new Error(`${source}: cases.json must have a \`cases\` array`);
  }
  return parsed.cases.map((entry, index) => parseConformanceCase(entry, index, source));
}

/** Load and fail-closed validate the adapter conformance-case catalogue. */
export async function loadConformanceCases(
  path: string = CONFORMANCE_CASES_PATH,
): Promise<ConformanceCase[]> {
  return parseConformanceCases(await readFile(path, 'utf8'), path);
}

// ─── JVM conformance target manifest (task P3-01) ────────────────────────────

/** The five conformance categories the maven-basic / gradle-basic fixtures embody. */
export type ConformanceCategory = 'pass' | 'fail' | 'skip' | 'parameterized' | 'missing';

const CONFORMANCE_CATEGORIES: readonly ConformanceCategory[] = [
  'pass',
  'fail',
  'skip',
  'parameterized',
  'missing',
];

/** How the resolve helper classifies a target (design §2 three-way, pre-wire). */
export type ResolveClassification = 'found' | 'missing' | 'unsupported';

const RESOLVE_CLASSIFICATIONS: readonly ResolveClassification[] = [
  'found',
  'missing',
  'unsupported',
];

/** The `run` outcome a target is expected to report, or `null` when not addressable. */
export type RunOutcome = 'pass' | 'fail' | 'error' | 'skip' | null;

const RUN_OUTCOMES: readonly Exclude<RunOutcome, null>[] = ['pass', 'fail', 'error', 'skip'];

/** One declared target in the JVM conformance manifest (`targets.json`). */
export interface ConformanceTarget {
  /** The adapter target string, e.g. `com.acme.FooTest#bar`. */
  target: string;
  category: ConformanceCategory;
  /** Expected three-way classification from the resolve helper (P3-03). */
  resolve: ResolveClassification;
  /** Expected `run` outcome, or `null` for a target excluded from addressing. */
  run: RunOutcome;
}

/** The `canary` block: how the execution canary announces it ran (P3-03). */
export interface ConformanceCanary {
  /** System property naming the directory the marker is written into. */
  systemProperty: string;
  /** Marker file the canary test writes iff its body executes. */
  markerFilename: string;
  /** The canary test's target string. */
  target: string;
}

/** The parsed JVM conformance target manifest, shared by both fixtures. */
export interface ConformanceTargetsManifest {
  package: string;
  canary: ConformanceCanary;
  targets: ConformanceTarget[];
}

function parseConformanceCanary(value: unknown, source: string): ConformanceCanary {
  if (!isRecord(value)) {
    throw new Error(`${source}: \`canary\` is not an object`);
  }
  const { systemProperty, markerFilename, target } = value;
  if (typeof systemProperty !== 'string' || systemProperty.length === 0) {
    throw new Error(`${source}: \`canary.systemProperty\` must be a non-empty string`);
  }
  if (typeof markerFilename !== 'string' || markerFilename.length === 0) {
    throw new Error(`${source}: \`canary.markerFilename\` must be a non-empty string`);
  }
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error(`${source}: \`canary.target\` must be a non-empty string`);
  }
  return { systemProperty, markerFilename, target };
}

function parseConformanceTarget(value: unknown, index: number, source: string): ConformanceTarget {
  if (!isRecord(value)) {
    throw new Error(`${source}: target ${index} is not an object`);
  }
  const { target, category, resolve, run } = value;
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error(`${source}: target ${index} has no string \`target\``);
  }
  if (
    typeof category !== 'string' ||
    !CONFORMANCE_CATEGORIES.includes(category as ConformanceCategory)
  ) {
    throw new Error(
      `${source}: target ${index} (${target}) has invalid \`category\`: ${JSON.stringify(category)}`,
    );
  }
  if (
    typeof resolve !== 'string' ||
    !RESOLVE_CLASSIFICATIONS.includes(resolve as ResolveClassification)
  ) {
    throw new Error(
      `${source}: target ${index} (${target}) has invalid \`resolve\`: ${JSON.stringify(resolve)}`,
    );
  }
  if (
    run !== null &&
    (typeof run !== 'string' || !RUN_OUTCOMES.includes(run as Exclude<RunOutcome, null>))
  ) {
    throw new Error(
      `${source}: target ${index} (${target}) has invalid \`run\`: ${JSON.stringify(run)}`,
    );
  }
  return {
    target,
    category: category as ConformanceCategory,
    resolve: resolve as ResolveClassification,
    run: run as RunOutcome,
  };
}

/** Load and fail-closed validate the JVM conformance target manifest. */
export async function loadConformanceTargets(
  path: string = CONFORMANCE_TARGETS_PATH,
): Promise<ConformanceTargetsManifest> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${path}: targets.json must be a JSON object`);
  }
  if (typeof parsed.package !== 'string' || parsed.package.length === 0) {
    throw new Error(`${path}: targets.json must have a string \`package\``);
  }
  if (!Array.isArray(parsed.targets)) {
    throw new Error(`${path}: targets.json must have a \`targets\` array`);
  }
  return {
    package: parsed.package,
    canary: parseConformanceCanary(parsed.canary, path),
    targets: parsed.targets.map((entry, index) => parseConformanceTarget(entry, index, path)),
  };
}
