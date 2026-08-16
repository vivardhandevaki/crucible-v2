import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeFrameworkPin } from '../framework/pin.js';
import { frameworkUpgrade } from './framework-upgrade.js';

const OLD = '1111111111111111111111111111111111111111';
const NEXT = '2222222222222222222222222222222222222222';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-p4-27-upgrade-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
  writeFileSync(
    join(root, '.crucible', 'framework.lock.json'),
    serializeFrameworkPin({ version: 1, repository: 'owner/framework', commit: OLD }),
  );
  writeFileSync(
    join(root, 'crucible.yaml'),
    readFileSync(join(root, 'crucible.yaml'), 'utf8') +
      '\nreview:\n  ci_mode: advisory\n  human_mode: advisory\n',
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('P4-27 ordinary advisory framework upgrade', () => {
  it('does not render the required-review legacy bridge for an ordinary advisory upgrade', () => {
    const report = frameworkUpgrade({
      root,
      pin: { version: 1, repository: 'owner/framework', commit: NEXT },
      trackedDirty: false,
    });

    expect(report.phase).toBe('ordinary');
    expect(report.actions.map((action) => action.relpath)).toEqual([
      '.crucible/framework.lock.json',
      '.github/workflows/crucible.yml',
    ]);
  });
});
