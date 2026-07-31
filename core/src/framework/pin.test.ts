import { describe, expect, it } from 'vitest';

import { parseFrameworkPin, serializeFrameworkPin, type FrameworkPin } from './pin.js';

const PIN: FrameworkPin = {
  version: 1,
  repository: 'vivardhandevaki/crucible-v2',
  commit: 'a'.repeat(40),
};

describe('validation framework pin', () => {
  it('round-trips the strict repository+commit shape', () => {
    expect(parseFrameworkPin(serializeFrameworkPin(PIN), 'pin')).toEqual(PIN);
  });

  it.each([
    '{"version":1,"repository":"vivardhandevaki/crucible-v2","commit":"short"}',
    '{"version":1,"repository":"owner/repo/extra","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    '{"version":1,"repository":"owner/repo","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":true}',
  ])('fails closed on an invalid pin', (text) => {
    expect(() => parseFrameworkPin(text, 'pin')).toThrowError(
      expect.objectContaining({ code: 'INVALID_FRAMEWORK_PIN', exit: 3 }),
    );
  });
});
