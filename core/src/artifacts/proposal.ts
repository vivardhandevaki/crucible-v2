// Proposal parser — the propose contract's honesty sections (charter §The
// Workflow, propose row; design phase-0-1.md §3).
//
// A Crucible proposal must carry an explicit `## Unspecified` section (what the
// proposal deliberately does NOT decide / out-of-scope) and a `## Seams`
// enumeration (external systems touched, contracts crossed, concurrent changes
// in flight). These are the two places a proposal admits the limits of its own
// authority — the human gate reads them to know what approval does *not* cover.
// A proposal that omits them hides scope instead of declaring it, so their
// absence, emptiness, or duplication fails closed at exit 3 (invariant 3),
// naming the section and (where one exists) the offending line. The rest of the
// proposal (Why / What Changes / Impact) is OpenSpec-conventional prose that
// Crucible displays but does not enforce — validation here is deliberately
// scoped to what Crucible's gate semantics depend on. TCB module: this parser
// is part of what `propose` uses to judge agent output.

import { readFileSync } from 'node:fs';
import { invalidInputError, preconditionError } from '../util/errors.js';

/** The parsed proposal: the two enforced sections, bodies verbatim (trimmed). */
export interface Proposal {
  /** Body of `## Unspecified` — out-of-scope / deliberately undecided items. */
  unspecified: string;
  /** Body of `## Seams` — external systems, crossed contracts, in-flight work. */
  seams: string;
}

/** The two headings the grammar requires, exactly (no trailing text). */
const REQUIRED_SECTIONS = ['Unspecified', 'Seams'] as const;
type SectionName = (typeof REQUIRED_SECTIONS)[number];

// A level-2 heading: `## <title>`. `###` and deeper stay inside section bodies.
const H2 = /^##\s+(.*?)\s*$/;

/** Parse proposal markdown, enforcing the two required sections. Exit 3 on any defect. */
export function parseProposal(markdown: string, source: string): Proposal {
  const lines = markdown.split(/\r?\n/);

  // One pass: collect each required section's heading line + body slice. A
  // section body runs from the line after its heading to the next `## ` heading
  // (exclusive) or EOF.
  const found = new Map<SectionName, { line: number; body: string }>();
  for (let i = 0; i < lines.length; i += 1) {
    const heading = H2.exec(lines[i]!);
    if (!heading) continue;
    const name = heading[1]!;
    if (!isRequiredSection(name)) continue;

    if (found.has(name)) {
      fail(source, i + 1, `duplicate \`## ${name}\` section — exactly one is required`);
    }

    let end = i + 1;
    while (end < lines.length && !H2.test(lines[end]!)) end += 1;
    found.set(name, {
      line: i + 1,
      body: lines
        .slice(i + 1, end)
        .join('\n')
        .trim(),
    });
  }

  for (const name of REQUIRED_SECTIONS) {
    const section = found.get(name);
    if (section === undefined) {
      fail(
        source,
        undefined,
        `missing required \`## ${name}\` section — a proposal must declare what it does not decide (charter §The Workflow)`,
      );
    }
    if (section.body.length === 0) {
      fail(
        source,
        section.line,
        `\`## ${name}\` section is empty — state the items explicitly (write \`None known.\` if there are none)`,
      );
    }
  }

  return {
    unspecified: found.get('Unspecified')!.body,
    seams: found.get('Seams')!.body,
  };
}

/** Read a proposal file from disk and parse it. Missing file → exit 2. */
export function loadProposal(path: string): Proposal {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) {
      throw preconditionError(
        'NO_PROPOSAL',
        `No proposal found at ${path}.`,
        'Run `crucible propose` to scaffold the change bundle.',
      );
    }
    throw invalidInputError(
      'INVALID_PROPOSAL',
      `${path}: could not be read — ${messageOf(cause)}`,
      'Check the file permissions on the proposal.',
    );
  }
  return parseProposal(text, path);
}

function isRequiredSection(name: string): name is SectionName {
  return (REQUIRED_SECTIONS as readonly string[]).includes(name);
}

/** Every structural defect routes here: exit 3, message anchored `source[:line]`. */
function fail(source: string, line: number | undefined, detail: string): never {
  const where = line !== undefined ? `${source}:${line}` : source;
  throw invalidInputError(
    'INVALID_PROPOSAL',
    `${where}: ${detail}`,
    'Add the required `## Unspecified` and `## Seams` sections; see the propose role prompt (.crucible/context/propose.md).',
  );
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
