import { join } from 'node:path';
import { VALID_BUNDLE_DIR } from '@crucible/fixtures';
import { describe, expect, it } from 'vitest';
import { CrucibleError, isCrucibleError } from '../util/errors.js';
import { loadProposal, parseProposal } from './proposal.js';

// TCB: the proposal parser enforces the charter's propose contract — every
// proposal carries an explicit `## Unspecified` (out-of-scope / undetermined)
// section and a `## Seams` enumeration (charter §The Workflow, propose row).
// These sections are how a proposal admits what it does NOT decide; a proposal
// without them hides scope instead of declaring it, so their absence fails
// closed at exit 3 (invariant 3). Coverage is deliberately thorough including
// malformed-input cases (CLAUDE.md test-first rule for TCB modules).

const VALID_PROPOSAL = join(VALID_BUNDLE_DIR, 'proposal.md');

/** A minimal valid proposal body for inline grammar cases. */
function proposalWith(sections: { unspecified?: string; seams?: string }): string {
  const lines = ['# Proposal — inline', '', '## Why', '', 'Because.', ''];
  if (sections.unspecified !== undefined) {
    lines.push('## Unspecified', '', sections.unspecified, '');
  }
  if (sections.seams !== undefined) {
    lines.push('## Seams', '', sections.seams, '');
  }
  return lines.join('\n');
}

/** Capture the CrucibleError a call throws, or fail the test loudly. */
function catchCrucible(fn: () => unknown): CrucibleError {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

describe('parseProposal — valid input', () => {
  it('parses the toy fixture proposal, extracting both required sections', () => {
    const proposal = loadProposal(VALID_PROPOSAL);
    expect(proposal.unspecified.length).toBeGreaterThan(0);
    expect(proposal.seams.length).toBeGreaterThan(0);
  });

  it('extracts section bodies verbatim (trimmed)', () => {
    const proposal = parseProposal(
      proposalWith({ unspecified: '- Localization is out of scope.', seams: '- None known.' }),
      'inline.md',
    );
    expect(proposal.unspecified).toBe('- Localization is out of scope.');
    expect(proposal.seams).toBe('- None known.');
  });

  it('a section body runs until the next `## ` heading, not `###` subheadings', () => {
    const markdown = [
      '## Unspecified',
      '',
      'intro line',
      '',
      '### Detail',
      '',
      'detail line',
      '',
      '## Seams',
      '',
      '- None known.',
    ].join('\n');
    const proposal = parseProposal(markdown, 'inline.md');
    expect(proposal.unspecified).toContain('intro line');
    expect(proposal.unspecified).toContain('detail line');
    expect(proposal.unspecified).not.toContain('None known');
  });

  it('section order does not matter (Seams may precede Unspecified)', () => {
    const markdown = ['## Seams', '', '- s', '', '## Unspecified', '', '- u'].join('\n');
    const proposal = parseProposal(markdown, 'inline.md');
    expect(proposal.seams).toBe('- s');
    expect(proposal.unspecified).toBe('- u');
  });
});

describe('parseProposal — required sections fail closed (exit 3)', () => {
  it('missing `## Unspecified` → exit 3 naming the section', () => {
    const err = catchCrucible(() => parseProposal(proposalWith({ seams: '- s' }), 'inline.md'));
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Unspecified');
    expect(err.message).toContain('inline.md');
  });

  it('missing `## Seams` → exit 3 naming the section', () => {
    const err = catchCrucible(() =>
      parseProposal(proposalWith({ unspecified: '- u' }), 'inline.md'),
    );
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Seams');
  });

  it('an empty Unspecified body → exit 3 naming heading + line', () => {
    const markdown = ['## Unspecified', '', '   ', '', '## Seams', '', '- s'].join('\n');
    const err = catchCrucible(() => parseProposal(markdown, 'inline.md'));
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Unspecified');
    expect(err.message).toContain(':1');
  });

  it('an empty Seams body (section at EOF) → exit 3', () => {
    const markdown = ['## Unspecified', '', '- u', '', '## Seams'].join('\n');
    const err = catchCrucible(() => parseProposal(markdown, 'inline.md'));
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Seams');
  });

  it('a duplicated required section → exit 3 (ambiguity fails closed)', () => {
    const markdown = [
      '## Unspecified',
      '',
      '- u1',
      '',
      '## Unspecified',
      '',
      '- u2',
      '',
      '## Seams',
      '',
      '- s',
    ].join('\n');
    const err = catchCrucible(() => parseProposal(markdown, 'inline.md'));
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Unspecified');
  });

  it('a heading with trailing text (`## Unspecified stuff`) is not the section', () => {
    const markdown = ['## Unspecified stuff', '', '- u', '', '## Seams', '', '- s'].join('\n');
    const err = catchCrucible(() => parseProposal(markdown, 'inline.md'));
    expect(err.exit).toBe(3);
    expect(err.message).toContain('Unspecified');
  });

  it('an empty file → exit 3', () => {
    const err = catchCrucible(() => parseProposal('', 'inline.md'));
    expect(err.exit).toBe(3);
  });
});

describe('loadProposal — file-level failure modes', () => {
  it('missing file → exit 2 (precondition, names propose)', () => {
    const err = catchCrucible(() => loadProposal(join(VALID_BUNDLE_DIR, 'nope.md')));
    expect(err.exit).toBe(2);
    expect(err.hint).toContain('propose');
  });
});
