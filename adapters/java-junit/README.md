# `@crucible/adapter-java-junit`

The real Crucible adapter for JUnit 5 projects (design phase-3.md §2). Like
every adapter it is a standalone executable speaking the JSON wire protocol —
**core never imports it.** This is the state after **P3-06**: grounded source
paths, deterministic single-file packaging, dual-tool conformance, and lock pins.

## `resolve-helper/` — the Launcher-API classification jar (P3-03)

A small Maven Java project (`com.crucible.junit.ResolveHelper`) packaged as a
self-contained shaded jar (`resolve-helper/target/resolve-helper.jar`, built by
`mvn -q package`). Given adapter target strings it classifies each — using only
the JUnit Platform Launcher's **discovery** pass, never execution — as one of:

- **`found`** — a plain, addressable `@Test` method exists (a `TEST` node);
- **`unsupported`** — the target names a test _template_ (`@ParameterizedTest`
  / `@TestFactory`): a `CONTAINER` node with no single addressable invocation,
  so it is excluded from oracle addressing (the addressable-subset rule);
- **`missing`** — no such class, no such method, or a method with no test
  annotation.

It selects the whole **class** and matches methods against the discovered plan
(a per-method selector cannot tell a parameterized template apart from a missing
method). It never calls `execute()` — the conformance canary
(`fixtures/conformance/*/CanaryTest`) proves no test body runs during resolve.

The three-way vocabulary is the helper's own. The frozen wire resolve envelope
is `found | missing` only (architecture.md §7); the adapter CLI (P3-04) folds
`unsupported` → `missing` (reason on stderr; convenience per invariant 11), which
fails closed at propose time.

## `src/resolve.ts` — wrapper invocation

`invokeResolve(...)` is the thin TypeScript seam that spawns the jar with an
explicit evaluated test-execution classpath (project outputs plus the build
tool's test runtime dependencies, appended to the fat jar) and fail-closed-
validates its JSON output. A spawn failure, non-zero
exit, non-JSON stdout, or schema violation all throw — a resolve that cannot
speak is never a clean/empty result. P3-04 grows this into the full stdin/stdout
wire adapter and its manifest.

## Adapter state through P3-06

- `detect` declines without a JDK and selects Maven or Gradle from project files.
- `resolve` discovers without execution and grounds found targets only to verified Java source files under build-tool-configured test roots.
- `run` drives Maven Surefire or Gradle test execution and normalizes both XML dialects through the shared reports layer.
- `npm run package` emits `package/java-junit.mjs` (wrapper + embedded helper jar) and its manifest with byte-stable content across clean builds.
- Maven and Gradle packaged conformance suites are green, including malformed input, missing targets, skips, and compile-before-test failures.

## Building / testing

```sh
npm run package -w @crucible/adapter-java-junit # emit the pinned package
npm test -w @crucible/adapter-java-junit        # unit + integration acceptance
```

The test suite builds the jar and compiles the conformance fixtures itself, and
skips wholesale when the JVM toolchain (java / mvn / gradle) is absent — the same
decline-when-no-JDK posture the adapter's `detect` will take (P3-04).
