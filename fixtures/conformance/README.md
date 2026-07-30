# Adapter conformance suite

Golden `(verb + input → expected normalized output)` cases every Crucible
adapter must satisfy. Written against the toy repo's `tests.json`
(`fixtures/toy-repo/tests.json`) so the reference **stub** adapter can be driven
by them today, but the cases are **adapter-agnostic in spirit**: they assert
only the wire protocol and the charter's normalized result schema
(charter §"Bindings & the Adapter Protocol"), never stub-internal details.

## Layout

- `run.ts` — the **conformance runner** (task P3-02). Drives any adapter through
  a declared conformance *script* and reports which of six universal checks it
  satisfies (`manifest-valid`, `envelope`, `missing-no-targetfile`,
  `case-expectations`, `malformed-stdin`, `package-hash`). It spawns the
  manifest's invocation strings **verbatim** — same tokenization + spawn as
  core's adapter client — so it certifies exactly what core runs, and it reuses
  core's own zod envelopes / `parseManifest` / `hashFile` (imported from core
  source; see design phase-3.md §1.1). CLI: `run.ts <script.json>` → exit 0 green,
  1 findings, 2 usage, 3 the runner's own inputs malformed, 4 engine bug.
- `stub.script.json` — the reference **stub** adapter's conformance script. The
  stub passing this run is what makes the run "the protocol's executable spec".
- `broken-stub/` — a wrapper that faithfully delegates to the stub but sabotages
  one output dimension per the `CRUCIBLE_BREAK` env var, plus scripts for the
  manifest/package failure paths. Each break trips exactly one universal check,
  proving findings are attributable (the P3-02 acceptance bar).
- `cases.json` — the stub adapter's golden verb+input→output catalogue (below).
- `targets.json` — the **JVM** conformance target manifest: the five categories
  the `maven-basic` / `gradle-basic` fixtures embody and, per target, the
  expected `resolve` classification and `run` outcome (task P3-01). Loaded and
  fail-closed validated by `@crucible/fixtures` (`loadConformanceTargets`).
- `maven-basic/`, `gradle-basic/` — minimal, self-contained JUnit 5 projects the
  real `java-junit` adapter is driven against (design phase-3.md §1). Identical
  Java sources, one per build tool, so the adapter's XML normalizer meets both
  Surefire and Gradle report dialects. See each project's `README.md`.

## Stub cases (`cases.json`)

- The machine-readable case catalogue. Each case names a `verb`
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
