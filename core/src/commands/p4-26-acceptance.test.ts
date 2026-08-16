import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Evidence {
  file: string;
  title: string;
}
interface Requirement {
  id: string;
  evidence: Evidence[];
}
interface Manifest {
  version: number;
  phase: string;
  requirements: Requirement[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(
  readFileSync(join(root, 'docs/acceptance/p4-26.json'), 'utf8'),
) as Manifest;

describe('P4-26 executable acceptance manifest', () => {
  it('maps each root-bootstrap requirement to discovered, non-skipped test evidence', () => {
    expect(manifest).toMatchObject({ version: 1, phase: 'P4-26' });
    for (const requirement of manifest.requirements) {
      expect(requirement.evidence.length, requirement.id).toBeGreaterThan(0);
      for (const evidence of requirement.evidence) {
        const path = join(root, evidence.file);
        expect(existsSync(path), requirement.id + ': ' + evidence.file).toBe(true);
        const source = readFileSync(path, 'utf8');
        expect(source, requirement.id + ': ' + evidence.title).toContain(evidence.title);
        expect(source, requirement.id + ': skipped evidence').not.toContain(
          'it.skip(' + evidence.title,
        );
      }
    }
  });
});
