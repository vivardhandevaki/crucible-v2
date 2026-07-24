import { describe, expect, it } from 'vitest';
import { greet } from '../src/greeting.js';

// Oracle-bound tests for the add-greeting change. The stub adapter addresses
// them by their tests.json ids (greeting::returns_hello_for_a_name and
// greeting::defaults_to_world_when_empty), not by re-running this file. These
// bytes are sealed by the approval hash — do not reformat.
describe('greet', () => {
  // ORC-greeting-001 / greeting::returns_hello_for_a_name
  it('returns hello for a name', () => {
    expect(greet('Ada')).toBe('Hello, Ada!');
  });

  // ORC-greeting-002 / greeting::defaults_to_world_when_empty
  it('defaults to world when empty', () => {
    expect(greet('')).toBe('Hello, world!');
  });
});
