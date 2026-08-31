import { describe, expect, it } from 'vitest';
import { renderWorkflow } from './workflow.js';

describe('P4R-02 generated active-session workflow', () => {
  it('renders the complete provider-neutral workflow for Codex and Claude Code', () => {
    const workflow = renderWorkflow();

    expect(Object.keys(workflow.codex)).toEqual([
      'crucible-propose',
      'crucible-implement',
      'crucible-verify',
      'crucible-amend',
      'crucible-archive',
      'crucible-submit',
      'crucible-status',
    ]);
    expect(Object.keys(workflow.claude)).toEqual(Object.keys(workflow.codex));
    for (const body of [...Object.values(workflow.codex), ...Object.values(workflow.claude)]) {
      expect(body).toContain('.crucible/bin/crucible');
      expect(body).not.toMatch(/codex exec|claude -p|AgentSubstrate/i);
      expect(body).toContain('active agent session');
    }
  });
});
