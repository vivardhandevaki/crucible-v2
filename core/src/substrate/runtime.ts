// The single command-layer resolver for provider selection and model routing.

import {
  loadConvenienceConfig,
  type AgentProvider,
  type ConvenienceConfig,
} from '../config/convenience.js';
import { ClaudeCodeSubstrate } from './claude-code.js';
import { CodexSubstrate, type CodexSubstrateOptions } from './codex.js';
import type { AgentSubstrate, SubstrateRole } from './types.js';

export interface AgentRuntime {
  provider: AgentProvider;
  model: string;
  substrate: AgentSubstrate;
}

export interface RuntimeFactories {
  codex: (options: CodexSubstrateOptions) => AgentSubstrate;
  'claude-code': () => AgentSubstrate;
}

const DEFAULT_MODELS: Record<AgentProvider, Record<SubstrateRole, string>> = {
  codex: {
    propose: 'gpt-5.6-sol',
    implement: 'gpt-5.6-terra',
    review: 'gpt-5.6-sol',
  },
  'claude-code': {
    propose: 'claude-opus-4-8',
    implement: 'claude-opus-4-8',
    review: 'claude-haiku-4-5-20251001',
  },
};

const DEFAULT_FACTORIES: RuntimeFactories = {
  codex: (options) => new CodexSubstrate(options),
  'claude-code': () => new ClaudeCodeSubstrate(),
};

export function resolveAgentRuntime(root: string, role: SubstrateRole): AgentRuntime {
  return selectAgentRuntime(loadConvenienceConfig(root), role);
}

export function selectAgentRuntime(
  config: ConvenienceConfig,
  role: SubstrateRole,
  factories: RuntimeFactories = DEFAULT_FACTORIES,
): AgentRuntime {
  // Missing provider is the compatibility contract for already-initialized repos.
  const provider: AgentProvider = config.agent?.provider ?? 'claude-code';
  return {
    provider,
    model: config.models[role] ?? DEFAULT_MODELS[provider][role],
    substrate:
      provider === 'codex'
        ? factories.codex(
            config.agent?.codex_sandbox ? { sandbox: config.agent.codex_sandbox } : {},
          )
        : factories['claude-code'](),
  };
}
