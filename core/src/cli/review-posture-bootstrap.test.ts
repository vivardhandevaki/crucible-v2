import { describe, expect, it } from 'vitest';
import { buildProgram } from './program.js';

describe('review-posture bootstrap surface', () => {
  it('requires immutable source and explicit root acknowledgement', () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain('review-posture');
    const posture = buildProgram().commands.find((command) => command.name() === 'review-posture');
    expect(posture?.helpInformation()).toContain('bootstrap');
    const bootstrap = posture?.commands.find((command) => command.name() === 'bootstrap');
    expect(bootstrap?.helpInformation()).toContain('--source <owner/repository@sha>');
    expect(bootstrap?.helpInformation()).toContain('--acknowledge-root-bootstrap');
  });
});
