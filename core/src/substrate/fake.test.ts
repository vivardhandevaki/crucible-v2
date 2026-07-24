import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSubstrate } from './fake.js';
import type { SubstrateRequest } from './types.js';

// The Fake backs command tests without network (architecture.md §6). Its only
// frozen obligations are the AgentSubstrate contract: write scripted files under
// cwd, always leave a transcript at request.transcriptPath, return the scripted
// exit code. The scripting shape itself is unfrozen test infrastructure.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-substrate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function req(overrides: Partial<SubstrateRequest> = {}): SubstrateRequest {
  return {
    role: 'propose',
    rolePromptPath: join(dir, '.crucible/context/propose.md'),
    taskPayload: 'author the greeting spec',
    cwd: dir,
    model: 'fable',
    transcriptPath: join(dir, '.crucible/transcripts/greeting/propose-1.jsonl'),
    ...overrides,
  };
}

describe('FakeSubstrate', () => {
  it('writes scripted artifacts under cwd and a transcript, returns scripted exit', async () => {
    const fake = new FakeSubstrate({
      files: { 'openspec/changes/greeting/spec.md': '# spec\n' },
      transcript: '{"type":"result"}\n',
      exitCode: 0,
    });
    const result = await fake.run(req());

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'openspec/changes/greeting/spec.md'), 'utf8')).toBe('# spec\n');
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe('{"type":"result"}\n');
  });

  it('echoes transcriptPath and always leaves a transcript file (even with no script)', async () => {
    const fake = new FakeSubstrate();
    const r = req();
    const result = await fake.run(r);

    expect(result.transcriptPath).toBe(r.transcriptPath);
    expect(existsSync(result.transcriptPath)).toBe(true);
    expect(readFileSync(result.transcriptPath, 'utf8').length).toBeGreaterThan(0);
  });

  it('creates missing parent directories for both artifacts and transcript', async () => {
    const fake = new FakeSubstrate({ files: { 'deep/nested/tree/spec.md': 'x' } });
    const result = await fake.run(req());
    expect(existsSync(join(dir, 'deep/nested/tree/spec.md'))).toBe(true);
    expect(existsSync(result.transcriptPath)).toBe(true);
  });

  it('supports a per-request script function (different bundle per role)', async () => {
    const fake = new FakeSubstrate((r) => ({
      files: { 'out.txt': `${r.role}:${r.model}` },
      exitCode: r.role === 'review' ? 1 : 0,
    }));
    const good = await fake.run(req({ role: 'implement', model: 'opus' }));
    expect(good.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('implement:opus');

    const bad = await fake.run(req({ role: 'review' }));
    expect(bad.exitCode).toBe(1);
  });

  it('records every request for command-test assertions', async () => {
    const fake = new FakeSubstrate();
    await fake.run(req({ role: 'propose' }));
    await fake.run(req({ role: 'implement' }));
    expect(fake.calls.map((c) => c.role)).toEqual(['propose', 'implement']);
  });

  it('a non-zero scripted exit still leaves a transcript (contract: transcript always exists)', async () => {
    const fake = new FakeSubstrate({ exitCode: 2, transcript: 'partial' });
    const result = await fake.run(req());
    expect(result.exitCode).toBe(2);
    expect(readFileSync(result.transcriptPath, 'utf8')).toBe('partial');
  });
});
