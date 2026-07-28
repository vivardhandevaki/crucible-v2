import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import {
  collectArchivedRequirementIds,
  collectRegressionSuite,
  groupByRunner,
} from './regression.js';

// The regression suite is the accumulated correctness criterion of every past
// change (charter §The Regression Suite; design phase-2.md §1). It is DERIVED
// from the archive on disk — archiving is registration, there is no separate
// registry — so these tests build archives by hand and assert the collector
// unions their bindings deterministically, and that the archived-REQ index makes
// an old requirement id legally bindable.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-regression-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write an archived change dir with the given oracles.md + optional spec.md. */
function archiveChange(
  dirName: string,
  opts: { oracles?: string; capability?: string; spec?: string } = {},
): void {
  const changeDir = join(root, 'openspec', 'changes', 'archive', dirName);
  mkdirSync(changeDir, { recursive: true });
  if (opts.oracles !== undefined) {
    writeFileSync(join(changeDir, 'oracles.md'), opts.oracles, 'utf8');
  }
  if (opts.spec !== undefined) {
    const specDir = join(changeDir, 'specs', opts.capability ?? 'cap');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'spec.md'), opts.spec, 'utf8');
  }
}

/** Write a merged living spec file at openspec/specs/<capability>/spec.md. */
function mergedSpec(capability: string, body: string): void {
  const specDir = join(root, 'openspec', 'specs', capability);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, 'spec.md'), body, 'utf8');
}

const GREETING_ORACLES = `# Oracles — add-greeting

## ORC-greeting-001: Greeting names the person
**Then** the result is \`Hello, <name>!\`

\`\`\`yaml crucible-binding
requirement: REQ-greeting-basic-1
kind: unit
runner: stub
target: greeting::returns_hello_for_a_name
\`\`\`

## ORC-greeting-002: Empty name greets the world
**Then** the result is \`Hello, world!\`

\`\`\`yaml crucible-binding
requirement: REQ-greeting-default-2
kind: unit
runner: stub
target: greeting::defaults_to_world_when_empty
\`\`\`
`;

const REFUND_ORACLE = `# Oracles — fix-refund

## ORC-refund-013: Refund against a disputed charge
**Then** it is rejected

\`\`\`yaml crucible-binding
requirement: REQ-payments-refund-4
kind: integration
runner: junit
target: com.example.RefundTest#disputedChargeRejected
\`\`\`
`;

const GREETING_MERGED_SPEC = `# greeting

### Requirement: Greeting a named user [REQ-greeting-basic-1]

The system SHALL return the greeting.

#### Scenario: A name is provided

- **WHEN** \`greet("Ada")\` is called
- **THEN** it returns \`Hello, Ada!\`

### Requirement: Default greeting [REQ-greeting-default-2]

The system SHALL greet the world.

#### Scenario: An empty name is given

- **WHEN** \`greet("")\` is called
- **THEN** it returns \`Hello, world!\`
`;

describe('collectRegressionSuite', () => {
  it('empty archive → empty suite (nothing archived yet)', () => {
    const suite = collectRegressionSuite(root);
    expect(suite.oracles).toEqual([]);
    expect(suite.byRunner.size).toBe(0);
  });

  it('registers every binding of an archived change (acceptance: archiving registers bindings)', () => {
    archiveChange('2026-07-24-add-greeting', { oracles: GREETING_ORACLES });
    const suite = collectRegressionSuite(root);
    expect(suite.oracles.map((o) => o.id)).toEqual(['ORC-greeting-001', 'ORC-greeting-002']);
    expect(suite.oracles.map((o) => o.binding.targets[0])).toEqual([
      'greeting::returns_hello_for_a_name',
      'greeting::defaults_to_world_when_empty',
    ]);
  });

  it('unions bindings across archives, ordered by archive dir name then source order', () => {
    // Written out of chronological order to prove the collector sorts by dir name.
    archiveChange('2026-08-01-fix-refund', { oracles: REFUND_ORACLE });
    archiveChange('2026-07-24-add-greeting', { oracles: GREETING_ORACLES });
    const suite = collectRegressionSuite(root);
    expect(suite.oracles.map((o) => o.id)).toEqual([
      'ORC-greeting-001',
      'ORC-greeting-002',
      'ORC-refund-013',
    ]);
  });

  it('groups by runner (design §1: union of bindings, grouped by runner)', () => {
    archiveChange('2026-07-24-add-greeting', { oracles: GREETING_ORACLES });
    archiveChange('2026-08-01-fix-refund', { oracles: REFUND_ORACLE });
    const suite = collectRegressionSuite(root);
    expect([...suite.byRunner.keys()].sort()).toEqual(['junit', 'stub']);
    expect(suite.byRunner.get('stub')!.map((o) => o.id)).toEqual([
      'ORC-greeting-001',
      'ORC-greeting-002',
    ]);
    expect(suite.byRunner.get('junit')!.map((o) => o.id)).toEqual(['ORC-refund-013']);
  });

  it('skips an archived change that authored no oracles (e.g. a refactor)', () => {
    archiveChange('2026-09-01-extract-retry', {}); // no oracles.md
    archiveChange('2026-07-24-add-greeting', { oracles: GREETING_ORACLES });
    const suite = collectRegressionSuite(root);
    expect(suite.oracles.map((o) => o.id)).toEqual(['ORC-greeting-001', 'ORC-greeting-002']);
  });

  it('a malformed archived oracles.md fails closed (exit 3 — a corrupt past promise is a bug)', () => {
    archiveChange('2026-07-24-bad', { oracles: '## ORC-oops: missing the binding fence\n' });
    try {
      collectRegressionSuite(root);
      throw new Error('expected a fail-closed CrucibleError');
    } catch (err) {
      expect(isCrucibleError(err)).toBe(true);
      expect((err as { exit: number }).exit).toBe(3);
    }
  });
});

describe('collectArchivedRequirementIds', () => {
  it('empty repo → empty index', () => {
    expect(collectArchivedRequirementIds(root).size).toBe(0);
  });

  it('indexes REQ ids from the merged living spec set', () => {
    mergedSpec('greeting', GREETING_MERGED_SPEC);
    const ids = collectArchivedRequirementIds(root);
    expect([...ids].sort()).toEqual(['REQ-greeting-basic-1', 'REQ-greeting-default-2']);
  });

  it('also indexes REQ ids carried in archived deltas', () => {
    archiveChange('2026-08-01-fix-refund', {
      capability: 'payments',
      spec: `# payments

## MODIFIED Requirements

### Requirement: Refund policy [REQ-payments-refund-4]

The system SHALL reject refunds on disputed charges.

#### Scenario: Disputed charge

- **WHEN** a refund is attempted on a disputed charge
- **THEN** it is rejected
`,
    });
    const ids = collectArchivedRequirementIds(root);
    expect(ids.has('REQ-payments-refund-4')).toBe(true);
  });

  it('unions the merged specs and archived deltas', () => {
    mergedSpec('greeting', GREETING_MERGED_SPEC);
    archiveChange('2026-08-01-fix-refund', {
      capability: 'payments',
      spec: `# payments

## ADDED Requirements

### Requirement: Refund policy [REQ-payments-refund-4]

SHALL reject.

#### Scenario: x

- **THEN** rejected
`,
    });
    const ids = collectArchivedRequirementIds(root);
    expect([...ids].sort()).toEqual([
      'REQ-greeting-basic-1',
      'REQ-greeting-default-2',
      'REQ-payments-refund-4',
    ]);
  });
});

describe('groupByRunner', () => {
  it('is a pure regrouping (empty in → empty out)', () => {
    expect(groupByRunner([]).size).toBe(0);
  });
});
