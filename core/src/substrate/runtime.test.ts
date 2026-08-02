import { describe, expect, it, vi } from 'vitest';
import { parseConvenienceFile } from '../config/convenience.js';
import type { AgentSubstrate } from './types.js';
import { selectAgentRuntime, type RuntimeFactories } from './runtime.js';

const codex: AgentSubstrate = { run: vi.fn() };
const claude: AgentSubstrate = { run: vi.fn() };
const factories: RuntimeFactories = {
  codex: () => codex,
  'claude-code': () => claude,
};

describe('agent runtime selection', () => {
  it('keeps missing-provider repositories on Claude Code with legacy defaults', () => {
    const config = parseConvenienceFile('', 'legacy');
    expect(selectAgentRuntime(config, 'propose', factories)).toEqual({
      provider: 'claude-code',
      model: 'claude-opus-4-8',
      substrate: claude,
    });
    expect(selectAgentRuntime(config, 'review', factories).model).toBe('claude-haiku-4-5-20251001');
  });

  it('uses Codex role defaults when selected', () => {
    const config = parseConvenienceFile('agent: { provider: codex }', 'codex');
    expect(selectAgentRuntime(config, 'propose', factories).model).toBe('gpt-5.6-sol');
    expect(selectAgentRuntime(config, 'implement', factories).model).toBe('gpt-5.6-terra');
    expect(selectAgentRuntime(config, 'review', factories)).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      substrate: codex,
    });
  });

  it('treats explicit per-role models as opaque provider-specific overrides', () => {
    const config = parseConvenienceFile(
      'agent: { provider: codex }\nmodels: { review: custom-reviewer }',
      'override',
    );
    expect(selectAgentRuntime(config, 'review', factories).model).toBe('custom-reviewer');
  });

  it('passes the local-only Codex sandbox opt-in to the Codex substrate', () => {
    let sandbox: string | undefined;
    const config = parseConvenienceFile(
      'agent: { provider: codex, codex_sandbox: danger-full-access }',
      'local',
      'local',
    );
    const runtime = selectAgentRuntime(config, 'propose', {
      codex: (options) => {
        sandbox = options.sandbox;
        return codex;
      },
      'claude-code': () => claude,
    });

    expect(runtime.substrate).toBe(codex);
    expect(sandbox).toBe('danger-full-access');
  });
});
