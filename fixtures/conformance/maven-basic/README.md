# `maven-basic` — JVM conformance fixture (Maven)

A minimal, self-contained JUnit 5 project the `java-junit` adapter conformance
suite drives (task P3-01, design phase-3.md §1). Its Gradle twin is
[`../gradle-basic`](../gradle-basic); both carry **identical Java sources** under
package `com.crucible.conformance`, so one target manifest
([`../targets.json`](../targets.json)) describes both — each build tool supplies a
different classpath, not a different truth.

## Build + run

```sh
mvn test          # compiles + runs every test
```

Exits **non-zero on purpose**: the fixture contains a deliberate failing test
(see FAIL below). Surefire still writes complete per-test XML to
`target/surefire-reports/` before the aggregate result is decided — the
conformance runner reads that XML, never the aggregate exit code. To get a
zero exit while keeping full XML (e.g. in a driver script):
`mvn -Dmaven.test.failure.ignore=true test`.

Bytecode is pinned to Java 17 (`maven.compiler.release`) so the fixture stays
portable even when built on a newer JDK; the JUnit version is kept in lockstep
with `gradle-basic` and the resolve helper.

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
  `mvn test` — excluded from _binding_, not from the build.
- **missing** covers both a missing method on a real class (`#doesNotExist`) and
  a missing class (`GhostTest`); both classify `missing`.

## Execution canary (task P3-03)

`CanaryTest#writesMarkerWhenExecuted` writes `canary-executed.txt` into the
directory named by `-Dcrucible.canary.dir` **only when its method body runs**.
Discovery loads the class but never runs the body, so resolve leaves no marker —
the proof that `resolve` never executes tests. A real run
(`mvn -Dcrucible.canary.dir=<dir> test`) _does_ write it, proving the mechanism
fires when the body executes.
