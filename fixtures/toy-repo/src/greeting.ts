// Reference implementation for the toy add-greeting feature.
//
// The stub adapter is data-driven — test outcomes come from tests.json, not from
// executing this file — so this source is illustrative: it shows the end state
// the oracle-bound tests describe. Fixture bytes are author-controlled and
// excluded from lint/format/tsc.
export function greet(name: string): string {
  return name.length === 0 ? 'Hello, world!' : `Hello, ${name}!`;
}
