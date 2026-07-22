# Adapter conformance suite (seed)

Golden `(verb + input → expected normalized output)` cases every Crucible
adapter must satisfy. Written against the toy repo's `tests.json`
(`fixtures/toy-repo/tests.json`) so the reference **stub** adapter can be driven
by them today, but the cases are **adapter-agnostic in spirit**: they assert
only the wire protocol and the charter's normalized result schema
(charter §"Bindings & the Adapter Protocol"), never stub-internal details.

## Files

- `cases.json` — the machine-readable case catalogue. Each case names a `verb`
  (`resolve` | `run`), the `targets[]` fed on stdin, and the `expected`
  results array. Loaded and fail-closed validated by `@crucible/fixtures`
  (`loadConformanceCases`).

## Wire protocol under test

- Verb is selected by argv (`resolve` / `run`); the request body is JSON on
  stdin: `{ "targets": string[] }`. The response is JSON on stdout:
  `{ "results": [...] }`. See the stub CLI header comment
  (`adapters/stub/src/cli.ts`) for the authoritative envelope definition — the
  core adapter client (P1-11) conforms to it.

## Mapping rules asserted

- `resolve`: a target matching a `tests.json` `id` → `found` with
  `targetFile` = that row's `file`; an unknown target, or a row whose status is
  `"missing"` (uncollectible), → `missing` (no `targetFile`).
- `run`: `pass` / `fail` / `skip` pass through verbatim, carrying `message`
  where the row has one; a target with **no** row → `error` (fail-closed — a
  judge that cannot be found is never silently dropped). `skip` is **not**
  mapped to fail here; that is core's responsibility downstream
  (charter: "skip maps to fail for oracle targets").
</content>
