import { describe, expect, it } from 'vitest';
import {
  CrucibleError,
  internalError,
  invalidInputError,
  isCrucibleError,
  preconditionError,
} from './errors.js';

// TCB: the error taxonomy is the spine of every exit-code decision
// (architecture.md §3). Cover construction, the type guard, and each
// exit-tier helper.
describe('CrucibleError', () => {
  it('carries code, exit, hint, and message', () => {
    const err = new CrucibleError('bundle missing', {
      code: 'NO_BUNDLE',
      exit: 2,
      hint: 'Run `crucible propose` first.',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CrucibleError');
    expect(err.message).toBe('bundle missing');
    expect(err.code).toBe('NO_BUNDLE');
    expect(err.exit).toBe(2);
    expect(err.hint).toBe('Run `crucible propose` first.');
  });

  it('preserves an underlying cause when given', () => {
    const cause = new Error('boom');
    const err = new CrucibleError('wrapping', {
      code: 'X',
      exit: 4,
      hint: '',
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('isCrucibleError distinguishes framework errors from bare errors', () => {
    expect(isCrucibleError(preconditionError('C', 'm', 'h'))).toBe(true);
    expect(isCrucibleError(new Error('plain'))).toBe(false);
    expect(isCrucibleError('a string')).toBe(false);
    expect(isCrucibleError(null)).toBe(false);
  });

  it('exit-tier helpers map to the architecture.md §2 codes', () => {
    expect(preconditionError('A', 'm', 'h').exit).toBe(2);
    expect(invalidInputError('B', 'm', 'h').exit).toBe(3);
    expect(internalError('C', 'm', 'h').exit).toBe(4);
  });
});
