import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
