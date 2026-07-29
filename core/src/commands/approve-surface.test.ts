import { describe, expect, it } from 'vitest';
import type { Oracle } from '../artifacts/oracles.js';
import {
  PLAIN_STYLE,
  renderPanel,
  renderTestDiff,
  type OracleSource,
  type SurfaceStyle,
} from './approve-surface.js';

// The approve surface is display-only, but its two pure primitives — the
// side-by-side column layout and the LCS line diff — are worth pinning directly:
// they are what makes the "one rich gate" readable, and both have off-by-one and
// wrapping edges that a full-flow test would not isolate.

const oracle: Oracle = {
  id: 'ORC-x-001',
  title: 'X does the thing',
  heading: '## ORC-x-001: X does the thing',
  line: 1,
  sectionEnd: 8,
  prose: ['## ORC-x-001: X does the thing', '**Given** a thing', '**Then** it works'].join('\n'),
  binding: { requirement: 'REQ-x-1', kind: 'unit', runner: 'stub', targets: ['x::t'] },
};

const sources: OracleSource[] = [{ relpath: 'tests/x.test.ts', content: 'it("works", () => {});' }];

describe('renderPanel — scenario ┆ test layout', () => {
  it('splits into columns with a gutter at width ≥ 100', () => {
    const wide: SurfaceStyle = { width: 120, color: false };
    const panel = renderPanel(oracle, sources, { critical: false, acknowledged: false }, wide);
    expect(panel).toContain('│'); // the column gutter
    expect(panel).toContain('**Given** a thing'); // left pane
    expect(panel).toContain('it("works"'); // right pane
    expect(panel).toContain('tests/x.test.ts'); // the source's relpath label
  });

  it('stacks the panes with no gutter below the threshold', () => {
    const narrow: SurfaceStyle = { width: 80, color: false };
    const panel = renderPanel(oracle, sources, { critical: false, acknowledged: false }, narrow);
    expect(panel).not.toContain('│');
    expect(panel).toContain('scenario');
    expect(panel).toContain('it("works"');
  });

  it('surfaces the ack state only under the critical regime', () => {
    const s = PLAIN_STYLE;
    expect(renderPanel(oracle, sources, { critical: false, acknowledged: false }, s)).not.toContain(
      'acknowledg',
    );
    expect(renderPanel(oracle, sources, { critical: true, acknowledged: false }, s)).toContain(
      'awaiting acknowledgment',
    );
    expect(renderPanel(oracle, sources, { critical: true, acknowledged: true }, s)).toContain(
      '✓ acknowledged',
    );
  });
});

describe('renderTestDiff — LCS line diff', () => {
  it('marks removed and added lines and keeps the common spine', () => {
    const out = renderTestDiff(
      [{ relpath: 'a.ts', before: 'one\ntwo\nthree', after: 'one\nTWO\nthree' }],
      PLAIN_STYLE,
    );
    expect(out).toContain('regenerated: a.ts');
    expect(out).toContain('  one'); // unchanged spine (space prefix)
    expect(out).toContain('- two'); // removed
    expect(out).toContain('+ TWO'); // added
    expect(out).toContain('  three');
  });

  it('omits files whose bytes did not change', () => {
    const out = renderTestDiff([{ relpath: 'a.ts', before: 'same', after: 'same' }], PLAIN_STYLE);
    expect(out).toContain('no test files changed');
  });
});
