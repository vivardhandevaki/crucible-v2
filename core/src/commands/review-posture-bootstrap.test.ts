import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CI_REVIEW_TEMPLATE_PATH,
  renderAuthorityTransitionTemplateForAdapter,
  renderCiTemplateForAdapter,
} from '@crucible/ci-templates';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeFrameworkPin } from '../framework/pin.js';
import { P4_25_LEGACY_BRIDGE_COMMIT, reviewPostureBootstrap } from './review-posture-bootstrap.js';

const NEXT = '2222222222222222222222222222222222222222';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-review-posture-bootstrap-'));
  cpSync(TOY_REPO_ROOT, root, { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.crucible', 'framework.lock.json'),
    serializeFrameworkPin({
      version: 1,
      repository: 'vivardhandevaki/crucible-v2',
      commit: P4_25_LEGACY_BRIDGE_COMMIT,
    }),
  );
  writeFileSync(
    join(root, '.github', 'workflows', 'crucible.yml'),
    renderAuthorityTransitionTemplateForAdapter('stub', 'required'),
  );
  writeFileSync(
    join(root, '.github', 'workflows', 'crucible-review.yml'),
    readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8'),
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('reviewPostureBootstrap - P4-26 manual root transaction', () => {
  it('stages only the exact acknowledged five-file solo-posture transaction', () => {
    const beforeProduct = readFileSync(join(root, 'src', 'greeting.ts'), 'utf8');

    const report = reviewPostureBootstrap({
      root,
      pin: { version: 1, repository: 'vivardhandevaki/crucible-v2', commit: NEXT },
      trackedDirty: false,
      acknowledgeRootBootstrap: true,
    });

    expect(report.actions).toEqual([
      { relpath: '.crucible/framework.lock.json', kind: 'updated' },
      { relpath: '.github/workflows/crucible.yml', kind: 'updated' },
      { relpath: '.github/workflows/crucible-review.yml', kind: 'removed' },
      { relpath: 'crucible.yaml', kind: 'updated' },
      { relpath: '.crucible/settings.yaml', kind: 'updated' },
    ]);
    expect(report.operatorInstructions).toContain(
      'Remove verify from required checks for this one review-posture root bootstrap PR.',
    );
    expect(readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8')).toBe(
      renderCiTemplateForAdapter('stub', 'advisory'),
    );
    expect(existsSync(join(root, '.github', 'workflows', 'crucible-review.yml'))).toBe(false);
    expect(readFileSync(join(root, 'crucible.yaml'), 'utf8')).toContain(
      'review:\n  ci_mode: advisory\n  human_mode: advisory\n',
    );
    expect(readFileSync(join(root, '.crucible', 'settings.yaml'), 'utf8')).toContain(
      'review:\n  local_mode: required\n',
    );
    expect(readFileSync(join(root, 'src', 'greeting.ts'), 'utf8')).toBe(beforeProduct);
  });

  it('requires explicit acknowledgement before it writes any root-bootstrap byte', () => {
    const beforeWorkflow = readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8');

    expect(() =>
      reviewPostureBootstrap({
        root,
        pin: { version: 1, repository: 'vivardhandevaki/crucible-v2', commit: NEXT },
        trackedDirty: false,
      }),
    ).toThrow(/root bootstrap.*acknowledgement/i);

    expect(readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8')).toBe(
      beforeWorkflow,
    );
  });

  it('rejects a lookalike bridge or an already explicit review policy', () => {
    writeFileSync(
      join(root, 'crucible.yaml'),
      readFileSync(join(root, 'crucible.yaml'), 'utf8') + '\nreview:\n  ci_mode: required\n',
    );

    expect(() =>
      reviewPostureBootstrap({
        root,
        pin: { version: 1, repository: 'vivardhandevaki/crucible-v2', commit: NEXT },
        trackedDirty: false,
        acknowledgeRootBootstrap: true,
      }),
    ).toThrow(/absent review policy/i);
  });

  it('rolls back the complete transaction when a later write fails', () => {
    const originalLock = readFileSync(join(root, '.crucible', 'framework.lock.json'), 'utf8');
    const originalWorkflow = readFileSync(
      join(root, '.github', 'workflows', 'crucible.yml'),
      'utf8',
    );
    let writes = 0;

    expect(() =>
      reviewPostureBootstrap({
        root,
        pin: { version: 1, repository: 'vivardhandevaki/crucible-v2', commit: NEXT },
        trackedDirty: false,
        acknowledgeRootBootstrap: true,
        writeFile: (path, content) => {
          writes += 1;
          if (writes === 3) throw new Error('simulated write failure');
          writeFileSync(path, content, 'utf8');
        },
      }),
    ).toThrow(/rolled back/i);

    expect(readFileSync(join(root, '.crucible', 'framework.lock.json'), 'utf8')).toBe(originalLock);
    expect(readFileSync(join(root, '.github', 'workflows', 'crucible.yml'), 'utf8')).toBe(
      originalWorkflow,
    );
    expect(existsSync(join(root, '.github', 'workflows', 'crucible-review.yml'))).toBe(true);
  });
  it('rejects a stale source pin and a non-regular required workflow path', () => {
    expect(() =>
      reviewPostureBootstrap({
        root,
        pin: {
          version: 1,
          repository: 'vivardhandevaki/crucible-v2',
          commit: P4_25_LEGACY_BRIDGE_COMMIT,
        },
        trackedDirty: false,
        acknowledgeRootBootstrap: true,
      }),
    ).toThrow(/new immutable Crucible source/i);

    rmSync(join(root, '.github', 'workflows', 'crucible-review.yml'));
    mkdirSync(join(root, '.github', 'workflows', 'crucible-review.yml'));

    expect(() =>
      reviewPostureBootstrap({
        root,
        pin: { version: 1, repository: 'vivardhandevaki/crucible-v2', commit: NEXT },
        trackedDirty: false,
        acknowledgeRootBootstrap: true,
      }),
    ).toThrow(/requires .github\/workflows\/crucible-review.yml/i);
  });
});
