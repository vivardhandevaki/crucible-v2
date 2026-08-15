import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnforcementConfig } from '../config/enforcement.js';
import { init } from './init.js';
import { assertReviewPostureCongruence, reviewPostureDrift } from './review-posture.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-review-posture-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('review posture — target-config workflow congruence', () => {
  it('accepts init-managed solo posture and rejects a restored route workflow', async () => {
    await init(
      {
        root,
        answers: {
          adapter: 'stub',
          runners: ['stub'],
          paths: ['**/*.ts'],
          unitCommand: 'npm test',
          ciReviewMode: 'advisory',
          humanReviewMode: 'advisory',
        },
      },
      { confirmOverwrite: () => true },
    );
    const config = loadEnforcementConfig(root);
    expect(reviewPostureDrift(root, config)).toEqual([]);

    writeFileSync(join(root, '.github', 'workflows', 'crucible-review.yml'), '# stale\n');
    expect(reviewPostureDrift(root, config)).toEqual(['.github/workflows/crucible-review.yml']);
    expect(() => assertReviewPostureCongruence(root, config)).toThrow(/managed workflows disagree/);
  });

  it('rejects a legacy config-only snapshot and accepts every complete init-generated posture', async () => {
    const modes = [
      ['required', 'required'],
      ['advisory', 'required'],
      ['required', 'advisory'],
      ['advisory', 'advisory'],
    ] as const;

    for (const [ciReviewMode, humanReviewMode] of modes) {
      const project = join(root, `${ciReviewMode}-${humanReviewMode}`);
      mkdirSync(project, { recursive: true });
      await init(
        {
          root: project,
          answers: {
            adapter: 'stub',
            runners: ['stub'],
            paths: ['**/*.ts'],
            unitCommand: 'npm test',
            ciReviewMode,
            humanReviewMode,
          },
        },
        { confirmOverwrite: () => true },
      );

      const legacy = join(project, 'legacy');
      mkdirSync(legacy, { recursive: true });
      copyFileSync(join(project, 'crucible.yaml'), join(legacy, 'crucible.yaml'));
      expect(reviewPostureDrift(legacy, loadEnforcementConfig(legacy))).toContain(
        '.github/workflows/crucible.yml',
      );

      const snapshot = join(project, 'snapshot');
      mkdirSync(join(snapshot, '.github', 'workflows'), { recursive: true });
      copyFileSync(join(project, 'crucible.yaml'), join(snapshot, 'crucible.yaml'));
      copyFileSync(
        join(project, '.github', 'workflows', 'crucible.yml'),
        join(snapshot, '.github', 'workflows', 'crucible.yml'),
      );
      const reviewWorkflow = join(project, '.github', 'workflows', 'crucible-review.yml');
      if (existsSync(reviewWorkflow)) {
        copyFileSync(reviewWorkflow, join(snapshot, '.github', 'workflows', 'crucible-review.yml'));
      }
      expect(reviewPostureDrift(snapshot, loadEnforcementConfig(snapshot))).toEqual([]);
    }
  });
});
