// Oracle parser — `oracles.md` (charter §Oracle File Syntax & Adapter Binding
// Spec; design phase-0-1.md §3).
//
// An oracle is a human-readable heading + Given/When/Then prose + exactly one
// fenced `yaml crucible-binding` block. Humans read the prose at the gate; this
// parser extracts ONLY the fences and the id. It is part of the TCB: a
// malformed oracle must never reach the gate, so every structural or schema
// violation fails closed at exit 3 (invariant 3) naming the heading + line so a
// reviewer can find it. This module imports no adapter and no test framework —
// the `target` string is opaque here (charter §Bindings & the Adapter Protocol).

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError, preconditionError } from '../util/errors.js';

/** Honest metadata driving review emphasis; all kinds run through a runner. */
export type OracleKind = 'unit' | 'property' | 'contract' | 'integration';

/** The parsed, normalized `crucible-binding` block of one oracle. */
export interface OracleBinding {
  /** The single requirement this oracle judges (zero requirements forbidden). */
  requirement: string;
  kind: OracleKind;
  /** The runner an adapter must claim; a binding naming no runner is invalid. */
  runner: string;
  /** Opaque adapter targets, always ≥1. `target:` is normalized into this list. */
  targets: string[];
  /**
   * `reproduces: true` marks a bugfix's reproduction oracle (charter §Change
   * Types; design phase-2.md §4). Absent on ordinary oracles. Bugfix conformance
   * requires ≥1 of these; P2-08's red-on-base/green-on-fix check runs them.
   */
  reproduces?: boolean;
}

/** One fully-parsed oracle: id + heading + its single binding. */
export interface Oracle {
  /** `ORC-<slug>-<seq3>`, e.g. `ORC-greeting-001`. */
  id: string;
  /** Heading text after the id colon, for display. */
  title: string;
  /** The raw `## ...` heading line (as it appears in the file). */
  heading: string;
  /** 1-based line number of the heading. */
  line: number;
  binding: OracleBinding;
}

// A level-2 heading: `##` followed by whitespace. `###` (char after `##` is
// `#`, not whitespace) and the level-1 `# Oracles` title are excluded.
const L2_HEADING = /^##\s/;
// The oracle id grammar (charter §ID grammar): sequence is exactly three digits.
const ORACLE_HEADING = /^##\s+(ORC-[a-z0-9-]+-\d{3}):\s*(.*\S)?\s*$/;
const FENCE_OPEN = /^```yaml\s+crucible-binding\s*$/;
const FENCE_CLOSE = /^```\s*$/;

const bindingSchema = z
  .strictObject({
    requirement: z.string().min(1),
    kind: z.enum(['unit', 'property', 'contract', 'integration']),
    runner: z.string().min(1),
    target: z.string().min(1).optional(),
    targets: z.array(z.string().min(1)).min(1).optional(),
    reproduces: z.boolean().optional(),
  })
  // Exactly one of `target` / `targets` — the list form lets one oracle bind
  // multiple tests (all must pass); zero targets is not addressable.
  .refine((b) => (b.target !== undefined) !== (b.targets !== undefined), {
    message: 'binding must set exactly one of `target` or `targets`',
  });

interface Fence {
  /** 1-based line of the opening ```` ```yaml crucible-binding ````. */
  openLine: number;
  /** 1-based line of the first content line inside the fence. */
  contentStartLine: number;
  contentLines: string[];
}

/** Parse + validate oracles from raw markdown text. Throws exit 3 on any defect. */
export function parseOracles(markdown: string, source: string): Oracle[] {
  const lines = markdown.split(/\r?\n/);
  const oracles: Oracle[] = [];
  const seen = new Map<string, number>();

  let i = 0;
  while (i < lines.length) {
    if (!L2_HEADING.test(lines[i]!)) {
      i += 1;
      continue;
    }

    const headingLine = lines[i]!;
    const headingNum = i + 1;
    const match = ORACLE_HEADING.exec(headingLine);
    if (!match) {
      fail(
        source,
        headingNum,
        headingLine,
        `heading does not match the oracle id grammar \`## ORC-<slug>-<seq3>: <title>\``,
      );
    }
    const id = match[1]!;
    const title = (match[2] ?? '').trim();

    const prior = seen.get(id);
    if (prior !== undefined) {
      fail(
        source,
        headingNum,
        headingLine,
        `duplicate oracle id ${id} (first defined at line ${prior})`,
      );
    }

    // Collect every crucible-binding fence until the next level-2 heading.
    const fences: Fence[] = [];
    let j = i + 1;
    while (j < lines.length && !L2_HEADING.test(lines[j]!)) {
      if (!FENCE_OPEN.test(lines[j]!)) {
        j += 1;
        continue;
      }
      const openLine = j + 1;
      const contentLines: string[] = [];
      let k = j + 1;
      while (k < lines.length && !FENCE_CLOSE.test(lines[k]!) && !L2_HEADING.test(lines[k]!)) {
        contentLines.push(lines[k]!);
        k += 1;
      }
      if (k >= lines.length || !FENCE_CLOSE.test(lines[k]!)) {
        fail(
          source,
          openLine,
          headingLine,
          `oracle has an unterminated \`\`\`yaml crucible-binding fence`,
        );
      }
      fences.push({ openLine, contentStartLine: j + 2, contentLines });
      j = k + 1;
    }

    if (fences.length !== 1) {
      fail(
        source,
        headingNum,
        headingLine,
        `oracle must have exactly one \`\`\`yaml crucible-binding fence, found ${fences.length}`,
      );
    }

    oracles.push({
      id,
      title,
      heading: headingLine,
      line: headingNum,
      binding: parseBinding(fences[0]!, headingLine, headingNum, source),
    });
    seen.set(id, headingNum);
    i = j;
  }

  return oracles;
}

/** Read `oracles.md` from disk and parse it. Missing file → exit 2. */
export function loadOracles(path: string): Oracle[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_ORACLES',
        `No oracles.md found at ${path}.`,
        'Run `crucible propose` to scaffold the change bundle.',
      );
    }
    throw invalidInputError(
      'INVALID_ORACLES',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on oracles.md.',
    );
  }
  return parseOracles(text, path);
}

function parseBinding(
  fence: Fence,
  headingLine: string,
  headingNum: number,
  source: string,
): OracleBinding {
  let data: unknown;
  try {
    data = parseYaml(fence.contentLines.join('\n'));
  } catch (cause) {
    fail(
      source,
      fence.contentStartLine,
      headingLine,
      `binding is not valid YAML — ${messageOf(cause)}`,
    );
  }

  const result = bindingSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
    const at = keyLine(fence, key);
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    fail(
      source,
      at?.line ?? headingNum,
      headingLine,
      `binding invalid — ${where}: ${issue.message}`,
      at?.text,
    );
  }

  const b = result.data;
  const targets = b.targets ?? (b.target !== undefined ? [b.target] : []);
  return {
    requirement: b.requirement,
    kind: b.kind,
    runner: b.runner,
    targets,
    ...(b.reproduces !== undefined ? { reproduces: b.reproduces } : {}),
  };
}

/** Locate the fence line defining `key`, so a schema error can point at it. */
function keyLine(
  fence: Fence,
  key: string | undefined,
): { line: number; text: string } | undefined {
  if (key === undefined) return undefined;
  const prefix = `${key}:`;
  for (let idx = 0; idx < fence.contentLines.length; idx += 1) {
    const text = fence.contentLines[idx]!;
    if (text.trim().startsWith(prefix)) {
      return { line: fence.contentStartLine + idx, text: text.trim() };
    }
  }
  return undefined;
}

/**
 * Every structural/schema defect routes here: exit 3 (fail-closed), message
 * anchored as `source:line:` and naming the heading — plus the offending line
 * text when known, which is the drift guard the invalid-fixtures catalogue asserts.
 */
function fail(
  source: string,
  line: number,
  heading: string,
  detail: string,
  offendingLine?: string,
): never {
  const locator = offendingLine !== undefined ? ` [${offendingLine}]` : '';
  throw invalidInputError(
    'INVALID_ORACLES',
    `${source}:${line}: oracle ${JSON.stringify(heading)} — ${detail}${locator}`,
    'Fix oracles.md against charter §Oracle File Syntax & Adapter Binding Spec.',
  );
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
