// Fixtures workspace — programmatic access to the toy repo (P0-03).
//
// Core integration tests consume these path constants and the fail-closed
// loaders below. The fixture *data* lives under ../toy-repo and is deliberately
// excluded from lint/format/tsc (see eslint.config.js / .prettierignore): its
// bytes are author-controlled and sealed by the approval hash, so no tool may
// reformat it. This module only computes paths and parses; it never mutates.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/index.ts (or dist/index.js) → workspace root → toy-repo.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path to the toy fixture repo root. */
export const TOY_REPO_ROOT = join(workspaceRoot, 'toy-repo');

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
