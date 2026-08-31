import { describe, expect, it } from 'vitest';

import { parseFrameworkPin, serializeFrameworkPin, type FrameworkPin } from './pin.js';

const PIN: FrameworkPin = {
  version: 2,
  package: '@crucible/core',
  release: '1.2.3',
  content_hash: 'a'.repeat(64),
};

describe('validation framework pin', () => {
  it('round-trips the strict release+content-hash shape', () => {
    expect(parseFrameworkPin(serializeFrameworkPin(PIN), 'pin')).toEqual(PIN);
  });

  it.each([
    '{"version":2,"package":"@crucible/core","release":"^1.2.3","content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    '{"version":2,"package":"@crucible/core","release":"1.2.3","content_hash":"short"}',
    '{"version":2,"package":"@crucible/core","release":"1.2.3","content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":true}',
  ])('fails closed on an invalid pin', (text) => {
    expect(() => parseFrameworkPin(text, 'pin')).toThrowError(
      expect.objectContaining({ code: 'INVALID_FRAMEWORK_PIN', exit: 3 }),
    );
  });
});
