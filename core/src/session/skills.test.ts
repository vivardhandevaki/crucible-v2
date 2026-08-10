import { describe, expect, it } from 'vitest';
import { renderManagedSkill } from './skills.js';

describe('managed amend skill — P4-21', () => {
  it('uses only pinned session handoffs and stops for a human seal', () => {
    const skill = renderManagedSkill('amend');
    expect(skill).toContain('session amend start <change>');
    expect(skill).toContain('session amend seal');
    expect(skill).not.toContain('codex exec');
    expect(skill).toContain(
      'Never invoke a child agent, a headless amend command, or a sandbox fallback.',
    );
  });
});
