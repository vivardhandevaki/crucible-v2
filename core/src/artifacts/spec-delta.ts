// Spec-delta REQ extractor — OpenSpec spec-delta markdown (charter §Requirement
// IDs in the Spec Delta; design phase-0-1.md §3).
//
// A spec delta carries requirement headings of the form
// `### Requirement: <title> [REQ-<domain>-<slug>-<n>]`. The bracketed id is a
// pure-additive extension of OpenSpec's heading convention (design §3 amendment)
// that turns the traceability linter's heading-text match into exact string
// matching. This module extracts ONLY those ids (ordered, with title + line for
// display) — it is the REQ-id universe every binding's `requirement:` is checked
// against. It is part of the TCB: a `### Requirement:` heading whose bracket id
// is missing or malformed, or a reused id, must never reach the gate, so it
// fails closed at exit 3 (invariant 3) naming the heading + line so a reviewer
// can find it. Duplicate ids are rejected because ids are immutable and never
// reused (charter §ID grammar). This module imports no adapter and no test
// framework.

import { readFileSync } from 'node:fs';
import { invalidInputError, preconditionError } from '../util/errors.js';

/** One extracted requirement: id + heading title + 1-based line, for display. */
export interface SpecRequirement {
  /** `REQ-<domain>-<slug>-<n>`, e.g. `REQ-greeting-basic-1`. */
  id: string;
  /** Heading text before the bracketed id, for display. */
  title: string;
  /** 1-based line number of the requirement heading. */
  line: number;
}

// A level-3 requirement heading: `### Requirement:` followed by its title and a
// bracketed id. `####` (a Scenario) and shallower headings are excluded because
// the char after `###` must be whitespace. The title and bracket are validated
// in a second step so a malformed id still fails *as a requirement heading*
// (naming heading + line) rather than being silently ignored.
const REQUIREMENT_HEADING = /^###\s+Requirement:\s*(.*)$/;
// The requirement id grammar (charter §ID grammar): `REQ-<domain>-<slug>-<n>`,
// where the trailing sequence is one or more digits and the body is lower-case
// alphanumerics + hyphens. Anchored to the whole `<title> [id]` remainder so a
// heading with trailing junk after the bracket also fails closed.
const TITLED_ID = /^(.*?)\s*\[(REQ-[a-z0-9-]+-\d+)\]\s*$/;

/** Extract ordered REQ requirements from raw spec-delta markdown. Throws exit 3 on any defect. */
export function parseSpecDelta(markdown: string, source: string): SpecRequirement[] {
  const lines = markdown.split(/\r?\n/);
  const requirements: SpecRequirement[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i += 1) {
    const headingLine = lines[i]!;
    const heading = REQUIREMENT_HEADING.exec(headingLine);
    if (!heading) continue;

    const headingNum = i + 1;
    const titled = TITLED_ID.exec(heading[1]!);
    if (!titled) {
      fail(
        source,
        headingNum,
        headingLine,
        `requirement heading is missing a well-formed \`[REQ-<domain>-<slug>-<n>]\` id`,
      );
    }
    const title = titled[1]!.trim();
    const id = titled[2]!;

    const prior = seen.get(id);
    if (prior !== undefined) {
      fail(
        source,
        headingNum,
        headingLine,
        `duplicate requirement id ${id} (first defined at line ${prior}); ids are immutable and never reused`,
      );
    }

    requirements.push({ id, title, line: headingNum });
    seen.set(id, headingNum);
  }

  return requirements;
}

/** Read a spec-delta markdown file from disk and extract it. Missing file → exit 2. */
export function loadSpecDelta(path: string): SpecRequirement[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_SPEC_DELTA',
        `No spec delta found at ${path}.`,
        'Run `crucible propose` to scaffold the change bundle.',
      );
    }
    throw invalidInputError(
      'INVALID_SPEC_DELTA',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on the spec delta.',
    );
  }
  return parseSpecDelta(text, path);
}

/**
 * Every structural defect routes here: exit 3 (fail-closed), message anchored as
 * `source:line:` and naming the heading — which for a requirement heading is
 * also the offending line text, the drift guard the invalid-fixtures catalogue
 * asserts against.
 */
function fail(source: string, line: number, heading: string, detail: string): never {
  throw invalidInputError(
    'INVALID_SPEC_DELTA',
    `${source}:${line}: requirement ${JSON.stringify(heading)} — ${detail}`,
    'Fix the spec delta against charter §Requirement IDs in the Spec Delta.',
  );
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
