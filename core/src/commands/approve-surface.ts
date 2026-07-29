// The approve review surface — the "one rich gate" rendered (charter §The Approve
// Session — Validation, Editing & the "One Rich Gate"; design phase-2.md §8).
//
// approve is the single human touchpoint, so it gets disproportionate investment
// (charter Learnings): the bundle renders as a readable review surface — the
// proposal's honesty sections first, then each oracle's scenario prose beside the
// full source of its bound test files, then the seal confirm. This module owns the
// STRING rendering only; it is pure and deterministic (invariant 12) — width and
// color are inputs, never read from a terminal here (the CLI passes
// `process.stdout.columns` / TTY-and-NO_COLOR state). The flow orchestration
// (paging, prompting, the edit loop) lives in `approve.ts`; the real terminal
// edges live in `approve.cli.ts`.

import type { Oracle } from '../artifacts/oracles.js';
import type { Proposal } from '../artifacts/proposal.js';
import type { SpecRequirement } from '../artifacts/spec-delta.js';
import type { TierDecision } from '../tier/tier.js';
import type { VerifyFinding } from '../verifyx/report.js';

/** Render inputs (design §8: "width and color are render inputs"). */
export interface SurfaceStyle {
  /** Target render width; the CLI passes `process.stdout.columns`, else 80. */
  width: number;
  /** Emit ANSI (bold headings, dim rules, ±-colored diffs)? Off when not a TTY
   * or `NO_COLOR` is set — the core/tests default to false for stable bytes. */
  color: boolean;
}

/** The default style for a non-TTY / test render: 80 cols, no color. */
export const PLAIN_STYLE: SurfaceStyle = { width: 80, color: false };

/** Below this render width the scenario/test panes stack instead of splitting. */
const SIDE_BY_SIDE_MIN = 100;

/** One bound test file resolved for an oracle's right pane. */
export interface OracleSource {
  /** Repo-relative path of the test file (the sealed unit). */
  relpath: string;
  /** The file's current bytes — the same bytes the seal will hash. */
  content: string;
}

// ── ANSI (all gated on `style.color`) ────────────────────────────────────────
const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const RED = '[31m';
const RESET = '[0m';

function bold(s: string, style: SurfaceStyle): string {
  return style.color ? `${BOLD}${s}${RESET}` : s;
}
function dim(s: string, style: SurfaceStyle): string {
  return style.color ? `${DIM}${s}${RESET}` : s;
}

/** A horizontal rule with a leading label: `── label ─────…` to the width. */
function rule(label: string, style: SurfaceStyle): string {
  const lead = `── ${label} `;
  const fill = Math.max(0, style.width - visibleLength(lead));
  return dim(lead + '─'.repeat(fill), style);
}

/** ANSI-blind length (the core never colors before measuring, but be safe). */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').length;
}

// ── Stage 1: the overview ────────────────────────────────────────────────────

/** Everything the overview screen needs (design §8, Stage 1). */
export interface OverviewInput {
  change: string;
  /** The pinned change type (`feature` / `bugfix` / `refactor`). */
  type: string;
  /** The computed tier decision, when approve had the config + diff facts. */
  decision: TierDecision | undefined;
  proposal: Proposal;
  requirements: readonly SpecRequirement[];
  oracles: readonly Oracle[];
  /** The relative paths the seal will cover (the P1 files-to-seal list). */
  relpaths: readonly string[];
}

/**
 * Stage 1 — the overview screen: a header naming the change/type/tier, the
 * proposal's Unspecified + Seams sections FIRST (design §8: "prominently" means
 * before any mechanics), then requirements, oracles, and the files-to-seal list.
 * A zero-oracle (refactor) bundle says so and the caller skips the oracle walk.
 */
export function renderOverview(input: OverviewInput, style: SurfaceStyle): string {
  const { change, type, decision, proposal, requirements, oracles, relpaths } = input;
  const lines: string[] = [];

  const tier = decision ? decision.tier : 'not computed';
  lines.push(bold(`APPROVE ${change} · type: ${type} · tier: ${tier}`, style));
  if (decision) {
    for (const reason of decision.reasons) lines.push(dim(`  tier: ${reason}`, style));
  }
  lines.push('');

  // Unspecified / Seams first — the two places the proposal admits the limits of
  // its own authority; the human must read them before the mechanics.
  lines.push(rule('Unspecified (what this change does NOT decide)', style));
  lines.push(proposal.unspecified.length > 0 ? proposal.unspecified : '(none stated)');
  lines.push('');
  lines.push(rule('Seams (systems touched, contracts crossed, work in flight)', style));
  lines.push(proposal.seams.length > 0 ? proposal.seams : '(none stated)');
  lines.push('');

  lines.push(rule(`Requirements (${requirements.length})`, style));
  for (const req of requirements) lines.push(`  ${req.id} — ${req.title}`);
  if (requirements.length === 0) lines.push('  (none — this change promises no new behavior)');
  lines.push('');

  lines.push(rule(`Oracles (${oracles.length})`, style));
  if (oracles.length === 0) {
    lines.push('  no new oracles — the regression suite is the correctness criterion');
  } else {
    for (const oracle of oracles) {
      const repro = oracle.binding.reproduces === true ? ' (reproduces)' : '';
      lines.push(
        `  ${oracle.id} → ${oracle.binding.requirement} ` +
          `[${oracle.binding.runner}: ${oracle.binding.targets.join(', ')}]${repro}`,
      );
      lines.push(`    ${oracle.title}`);
    }
  }
  lines.push('');

  lines.push(rule(`Files to seal (${relpaths.length})`, style));
  for (const rel of relpaths) lines.push(`  ${rel}`);
  lines.push('');

  return lines.join('\n');
}

// ── Stage 2: one oracle panel (scenario ┆ bound test source) ──────────────────

/** Whether this panel is under the critical ack regime, and its ack state. */
export interface PanelState {
  critical: boolean;
  acknowledged: boolean;
}

/**
 * Stage 2 — one oracle's review panel: the scenario prose on the left, the full
 * source of every resolved bound test file on the right (design §8). At width ≥
 * 100 the two split into columns joined by a ` │ ` gutter; below that they stack
 * (scenario, then each test file). The sealed unit is the FILE, so the whole file
 * renders — there is no line-level test highlighting (design §8, "not delivered").
 */
export function renderPanel(
  oracle: Oracle,
  sources: readonly OracleSource[],
  state: PanelState,
  style: SurfaceStyle,
): string {
  const repro = oracle.binding.reproduces === true ? ' · reproduces' : '';
  const header = rule(
    `${oracle.id} → ${oracle.binding.requirement} · ${oracle.binding.runner}${repro}`,
    style,
  );

  const left = oracle.prose;
  const right = sources
    .map((s) => `${dim(`── ${s.relpath} ──`, style)}\n${s.content.replace(/\s+$/, '')}`)
    .join('\n\n');

  const body = twoUp('scenario', left, sources.map((s) => s.relpath).join(', '), right, style);

  const parts = [header, body];
  if (state.critical) {
    parts.push(
      state.acknowledged
        ? bold('✓ acknowledged', style)
        : dim('… awaiting acknowledgment (press `a`)', style),
    );
  }
  return parts.join('\n');
}

/**
 * Lay two labelled blocks side by side (≥ SIDE_BY_SIDE_MIN wide) or stacked. In
 * column mode each side gets half the remaining width (after the 3-char gutter),
 * long lines hard-wrapped; rows are zipped and the left column padded so the
 * gutter aligns. Deterministic given `style.width`.
 */
function twoUp(
  leftLabel: string,
  left: string,
  rightLabel: string,
  right: string,
  style: SurfaceStyle,
): string {
  if (style.width < SIDE_BY_SIDE_MIN) {
    return [dim(leftLabel, style), left, '', dim(rightLabel, style), right].join('\n');
  }

  const gutter = ' │ ';
  const colWidth = Math.max(20, Math.floor((style.width - gutter.length) / 2));
  const leftRows = wrap(left, colWidth);
  const rightRows = wrap(right, colWidth);
  // Column headers on the first row, then the zipped content.
  const rows: string[] = [];
  const labelRow = pad(dim(leftLabel, style), colWidth) + gutter + dim(rightLabel, style);
  rows.push(labelRow);
  const height = Math.max(leftRows.length, rightRows.length);
  for (let i = 0; i < height; i += 1) {
    const l = leftRows[i] ?? '';
    const r = rightRows[i] ?? '';
    rows.push(pad(l, colWidth) + gutter + r);
  }
  return rows.join('\n');
}

/** Split into rows, hard-wrapping any line longer than `width` (design §8). */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (visibleLength(line) <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (visibleLength(rest) > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  }
  return out;
}

/** Right-pad to `width` (measuring the visible length so ANSI does not skew it). */
function pad(s: string, width: number): string {
  const gap = width - visibleLength(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

// ── The edit loop's surfaces ──────────────────────────────────────────────────

/** One test file's before/after bytes, for the regeneration diff. */
export interface TestDiffFile {
  relpath: string;
  before: string;
  after: string;
}

/**
 * Render the unified diff of the bound test files a regeneration rewrote (design
 * §8: "the unified diff of the affected bound test files (pre-edit bytes vs
 * post-regen)"). One labelled block per file; unchanged files are omitted.
 */
export function renderTestDiff(files: readonly TestDiffFile[], style: SurfaceStyle): string {
  const blocks: string[] = [];
  for (const file of files) {
    if (file.before === file.after) continue;
    const rows = diffRows(file.before.split('\n'), file.after.split('\n'));
    const rendered = rows.map((r) => colorDiffRow(r, style)).join('\n');
    blocks.push(`${rule(`regenerated: ${file.relpath}`, style)}\n${rendered}`);
  }
  if (blocks.length === 0) return dim('(no test files changed)', style);
  return blocks.join('\n\n');
}

interface DiffRow {
  sign: ' ' | '-' | '+';
  text: string;
}

/**
 * A minimal LCS-based line diff (Myers not needed for small test files): the
 * longest common subsequence of lines is the unchanged spine; everything else is
 * a delete (`-`, only-in-before) or insert (`+`, only-in-after). Deterministic.
 */
function diffRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ sign: ' ', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ sign: '-', text: a[i]! });
      i += 1;
    } else {
      rows.push({ sign: '+', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) rows.push({ sign: '-', text: a[i++]! });
  while (j < m) rows.push({ sign: '+', text: b[j++]! });
  return rows;
}

function colorDiffRow(row: DiffRow, style: SurfaceStyle): string {
  const line = `${row.sign} ${row.text}`;
  if (!style.color || row.sign === ' ') return line;
  return `${row.sign === '+' ? GREEN : RED}${line}${RESET}`;
}

/** Render a red revalidation's findings after an edit (design §8, edit loop). */
export function renderFindings(findings: readonly VerifyFinding[], style: SurfaceStyle): string {
  const lines = [rule('the edit left the bundle red — fix it and re-edit', style)];
  for (const f of findings) lines.push(`  ✗ [${f.check}] ${f.id}: ${f.message}`);
  return lines.join('\n');
}
