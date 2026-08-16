import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeFrameworkPin } from '../framework/pin.js';
import { frameworkUpgrade } from './framework-upgrade.js';
import { renderAuthorityTransitionTemplateForAdapter } from '@crucible/ci-templates';

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

  it('requires explicit acknowledgement before staging a non-authoritative legacy bootstrap', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'on:\n  pull_request:\n');

    expect(() =>
      frameworkUpgrade({
        root,
        pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
        trackedDirty: false,
      }),
    ).toThrow(/legacy bootstrap.*acknowledgement/i);
    expect(readFileSync(join(root, '.crucible', 'framework.lock.json'), 'utf8')).toContain(OLD);
  });

  it('stages the exact acknowledged legacy bootstrap bridge', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'on:\n  pull_request:\n');

    const transition = frameworkUpgrade({
      root,
      pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
      trackedDirty: false,
      acknowledgeLegacyBootstrap: true,
    });
    expect(transition.phase).toBe('legacy-bootstrap');
    expect(transition.operatorInstructions).toContain(
      'Remove verify from required checks for this one legacy-bootstrap PR.',
    );
    expect(readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8')).toBe(
      renderAuthorityTransitionTemplateForAdapter('stub', 'required'),
    );
  });

  it('finalizes only an exact merged bootstrap bridge at the same pin', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'crucible.yml'),
      renderAuthorityTransitionTemplateForAdapter('stub', 'required'),
    );
    writeFileSync(
      join(root, '.crucible', 'framework.lock.json'),
      serializeFrameworkPin({ version: 1, repository: 'owner/crucible', commit: NEXT }),
    );

    const result = frameworkUpgrade({
      root,
      pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
      trackedDirty: false,
    });
    expect(result.phase).toBe('authority-finalization');
    expect(
      result.actions.find((action) => action.relpath === '.crucible/framework.lock.json')?.kind,
    ).toBe('unchanged');
    expect(readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8')).not.toContain(
      '  pull_request:\n',
    );
  });

  it('refuses to repin an unmerged legacy bootstrap bridge', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'crucible.yml'),
      renderAuthorityTransitionTemplateForAdapter('stub', 'required'),
    );

    expect(() =>
      frameworkUpgrade({
        root,
        pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
        trackedDirty: false,
      }),
    ).toThrow(/unmerged legacy bootstrap bridge/i);
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

  it('rolls back an earlier pin write when a later managed workflow write fails', () => {
    let writes = 0;
    expect(() =>
      frameworkUpgrade({
        root,
        pin: { version: 1, repository: 'owner/crucible', commit: NEXT },
        trackedDirty: false,
        writeFile: (path, content) => {
          writes += 1;
          if (writes === 2) throw new Error('simulated write failure');
          writeFileSync(path, content, 'utf8');
        },
      }),
    ).toThrow(/rolled back/i);

    expect(readFileSync(join(root, '.crucible', 'framework.lock.json'), 'utf8')).toContain(OLD);
  });

  it('refuses an unchanged pin before it rewrites managed workflow bytes', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'old workflow\n');
    const beforeWorkflow = readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8');

    expect(() =>
      frameworkUpgrade({
        root,
        pin: { version: 1, repository: 'owner/crucible', commit: OLD },
        trackedDirty: false,
      }),
    ).toThrow(/new immutable framework pin/i);

    expect(readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8')).toBe(
      beforeWorkflow,
    );
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
