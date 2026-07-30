# `gradle-basic` — JVM conformance fixture (Gradle)

A minimal, self-contained JUnit 5 project the `java-junit` adapter conformance
suite drives (task P3-01, design phase-3.md §1). Its Maven twin is
[`../maven-basic`](../maven-basic); both carry **identical Java sources** under
package `com.crucible.conformance`, so one target manifest
([`../targets.json`](../targets.json)) describes both — each build tool supplies a
different classpath, not a different truth. Having both lets the adapter's XML
normalizer meet both Surefire and Gradle report dialects (design §2, P3-05).

## Build + run

```sh
gradle test                    # compiles + runs every test
gradle test --rerun-tasks      # force a re-run when nothing changed (Gradle caches)
```

Exits **non-zero on purpose**: the fixture contains a deliberate failing test
(see FAIL below). Gradle still writes complete per-test XML to
`build/test-results/test/` before the task result is decided — the conformance
runner reads that XML, never the aggregate exit code. Because Gradle caches task
outputs, use `--rerun-tasks` (or `cleanTest test`) when re-running to guarantee
fresh XML.

Bytecode is pinned to Java 17 (`options.release`) using whatever JDK runs Gradle
— no toolchain provisioning — so the fixture stays portable; the JUnit version
is kept in lockstep with `maven-basic` and the resolve helper.

## The five categories

Every category from design §1 is present. The addressable subset an oracle may
bind to is **plain `@Test` methods** — concrete, zero-argument, named.

| Category          | Where                                              | `resolve` | `run`   |
| ----------------- | -------------------------------------------------- | --------- | ------- |
| **pass**          | `CalculatorTest#addsTwoNumbers`, `#subtractsTwoNumbers`, `CanaryTest#writesMarkerWhenExecuted` | `found`   | `pass`  |
| **fail**          | `CalculatorTest#failsOnPurpose` (deliberate red)   | `found`   | `fail`  |
| **skip**          | `CalculatorTest#skippedFeature` (`@Disabled`)      | `found`   | `skip`  |
| **parameterized** | `ParameterizedCalculatorTest#evensAreEven`         | `unsupported` | (excluded) |
| **missing**       | `CalculatorTest#doesNotExist`, `GhostTest#neverWritten` (no such method / no such class) | `missing` | `error` |

Notes:

- **`resolve` discovers; it does not run.** A `@Disabled` skip and a deliberate
  fail are both plain, existing `@Test` methods, so resolve classifies them
  `found` — skip and fail are runtime outcomes the `run` verb reports later.
- **Parameterized is a test _template_**, not a single addressable method: at
  discovery time it is a container with no concrete invocations, so the resolve
  helper classifies it `unsupported` and it is **excluded from oracle
  addressing** (the addressable-subset rule). It still runs green under
  `gradle test` — excluded from _binding_, not from the build.
- **missing** covers both a missing method on a real class (`#doesNotExist`) and
  a missing class (`GhostTest`); both classify `missing`.

## Execution canary (task P3-03)

`CanaryTest#writesMarkerWhenExecuted` writes `canary-executed.txt` into the
directory named by `-Dcrucible.canary.dir` **only when its method body runs**.
Discovery loads the class but never runs the body, so resolve leaves no marker —
the proof that `resolve` never executes tests. A real run
(`gradle test --rerun-tasks -Dcrucible.canary.dir=<dir>`) _does_ write it,
proving the mechanism fires when the body executes.
