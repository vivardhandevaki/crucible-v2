import { describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import { mergeConvenience, parseConvenienceFile } from './convenience.js';

describe('convenience agent provider', () => {
  it('parses both supported providers and rejects unknown providers with exit 3', () => {
    expect(parseConvenienceFile('agent: { provider: codex }', 'codex').agent?.provider).toBe(
      'codex',
    );
    expect(parseConvenienceFile('agent: { provider: claude-code }', 'claude').agent?.provider).toBe(
      'claude-code',
    );

    expect(() => parseConvenienceFile('agent: { provider: cursor }', 'invalid')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONVENIENCE_CONFIG', exit: 3 }),
    );
  });

  it('lets local.yaml override the team provider without losing models or notify', () => {
    const team = parseConvenienceFile(
      'agent: { provider: claude-code }\nmodels: { propose: team-model }\nnotify: { slack: "#team" }',
      'settings',
    );
    const local = parseConvenienceFile('agent: { provider: codex }', 'local');
    expect(mergeConvenience(team, local)).toEqual({
      agent: { provider: 'codex' },
      models: { propose: 'team-model' },
      notify: { slack: '#team' },
    });
  });

  it('reports the normal Crucible invalid-input contract', () => {
    try {
      parseConvenienceFile('agent: { provider: unknown }', 'invalid');
      throw new Error('expected invalid provider to fail');
    } catch (error) {
      expect(isCrucibleError(error)).toBe(true);
      if (isCrucibleError(error)) expect(error.exit).toBe(3);
    }
  });
});
