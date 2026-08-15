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
  root = mkdtempSync(join(tmpdir(), 'crucible-framework-upgrade-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
  writeFileSync(
    join(root, '.crucible', 'framework.lock.json'),
    serializeFrameworkPin({ version: 1, repository: 'owner/crucible', commit: OLD }),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('frameworkUpgrade — restricted pin transaction (P4-25)', () => {
  it('updates only the strict pin and managed workflow outputs', () => {
    const beforeConfig = readFileSync(join(root, 'crucible.yaml'), 'utf8');
    const beforeProduct = readFileSync(join(root, 'src', 'greeting.ts'), 'utf8');

    const report = frameworkUpgrade({
      root,
      pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
      trackedDirty: false,
    });

    expect(report.actions.map((action) => action.relpath)).toEqual([
      '.crucible/framework.lock.json',
      '.github/workflows/crucible.yml',
      '.github/workflows/crucible-review.yml',
    ]);
    expect(readFileSync(join(root, 'crucible.yaml'), 'utf8')).toBe(beforeConfig);
    expect(readFileSync(join(root, 'src', 'greeting.ts'), 'utf8')).toBe(beforeProduct);
    expect(readFileSync(join(root, '.crucible', 'framework.lock.json'), 'utf8')).toContain(NEXT);
  });

  it('refuses tracked dirt before it writes anything', () => {
    expect(() =>
      frameworkUpgrade({
        root,
        pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
        trackedDirty: true,
      }),
    ).toThrow(/tracked-clean/i);
    expect(readFileSync(join(root, '.crucible', 'framework.lock.json'), 'utf8')).toContain(OLD);
  });

  it('refuses when an active approval seals the current framework lock', () => {
    writeFileSync(
      join(root, 'openspec', 'changes', 'add-greeting', 'approval.yaml'),
      'version: 1\nchange: add-greeting\napproved_by: ada\napproved_at: 2026-08-15T00:00:00Z\nfiles:\n  .crucible/framework.lock.json: "0000000000000000000000000000000000000000000000000000000000000000"\namendments: []\n',
    );

    expect(() =>
      frameworkUpgrade({
        root,
        pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
        trackedDirty: false,
      }),
    ).toThrow(/approval.*framework lock/i);
  });
});
