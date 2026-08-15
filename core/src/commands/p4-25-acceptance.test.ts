import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Evidence {
  file: string;
  title: string;
}
interface Requirement {
  id: string;
  status: 'covered' | 'pending';
  evidence: Evidence[];
}
interface Manifest {
  version: number;
  phase: string;
  requirements: Requirement[];
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(
  readFileSync(join(root, 'docs/acceptance/p4-25.json'), 'utf8'),
) as Manifest;

describe('P4-25 executable acceptance manifest', () => {
  it('maps each covered release requirement to discovered, non-skipped test evidence', () => {
    expect(manifest).toMatchObject({ version: 1, phase: 'P4-25' });
    for (const requirement of manifest.requirements.filter((item) => item.status === 'covered')) {
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

  it('keeps unqualified consumer evidence explicit', () => {
    expect(
      manifest.requirements.filter((item) => item.status === 'pending').map((item) => item.id),
    ).toEqual(['P4-25-worked-consumers', 'P4-25-notes-mirror']);
  });
});
