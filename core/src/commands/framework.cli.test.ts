import { describe, expect, it } from 'vitest';
import { assertFrameworkSourceReachable } from './framework.cli.js';

const pin = {
  version: 1 as const,
  repository: 'owner/crucible',
  commit: '1111111111111111111111111111111111111111',
};

describe('framework upgrade source validation', () => {
  it('accepts only an exact reachable immutable source commit', () => {
    expect(() =>
      assertFrameworkSourceReachable(pin, () => pin.commit + '\trefs/heads/main\n'),
    ).not.toThrow();
    expect(() =>
      assertFrameworkSourceReachable(
        pin,
        () => '2222222222222222222222222222222222222222\trefs/heads/main\n',
      ),
    ).toThrow(/not advertised/i);
    expect(() =>
      assertFrameworkSourceReachable(pin, () => {
        throw new Error('network unavailable');
      }),
    ).toThrow(/could not reach/i);
  });
});
