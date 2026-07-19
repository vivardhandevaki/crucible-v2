# Design — Phase 3 (Real Adapter: java-junit) — **DRAFT**

> **Status: DRAFT — re-ratify after Phase 2** (gate task P3-00). The adapter protocol is frozen by then; this design is mostly *constrained* — JVM specifics inside a fixed contract. `[P2-DEP]` marks the few open joints.

Reads with: charter §First Reference Adapter, §Bindings & the Adapter Protocol, §Adapter Lifecycle; architecture.md §7 (frozen).

**Exit criterion:** conformance suite passes for `java-junit` on both Maven and Gradle fixtures; a hello-world Spring Boot change flows propose → approve → implement → verify → CI end-to-end with the real adapter; stub retired into the conformance suite.

## §1 Conformance fixtures (built first — they define "correct adapter")

- `fixtures/conformance/maven-basic/` and `gradle-basic/`: minimal JUnit 5 projects, each containing: passing tests, a failing test, a skipped test (`@Disabled`), a parameterized test (must be *excluded* from oracle addressing per the addressable-subset rule), and a "missing" target list (tests that don't exist).
- `fixtures/conformance/spring-testcontainers/`: one `@SpringBootTest` + Testcontainers test — proves integration-kind tests are "just slow JUnit" and shapes CI templates for the validation project (charter build decision).
- Conformance runner (`fixtures/conformance/run.ts`): drives any adapter through a declared script — resolve found/missing sets, run expected statuses, skip→(raw `skip` in adapter output; client maps to fail), malformed-stdin rejection, manifest validity, hash stability of the packaged executable. **The stub must pass it too** (it becomes the protocol's executable spec); stub then lives on only inside conformance + core unit tests.

## §2 java-junit adapter

- Package `adapters/java-junit/`: TypeScript CLI wrapper + bundled Java helper jar.
- **detect:** `pom.xml` | `build.gradle(.kts)` presence + JDK availability check (JDK absent → detect declines with reason; never a runtime surprise).
- **resolve:** the helper jar on JUnit Platform Launcher API — input: target strings `com.acme.FooTest#bar`; output: found/missing + source `targetFile` (from engine metadata where available; fallback: convention `src/test/java/...` `[P2-DEP: whether hash scope tolerates fallback or requires exact file]`). Rejects non-plain targets (dynamic/@TestFactory) as `unsupported` → propose-time error per addressable-subset rule.
- **run:** Maven: `mvn -q test -Dtest=<classlist>` ; Gradle: `gradle test --tests <patterns>`; then parse Surefire / Gradle JUnit XML into normalized results (status, message, location from stack-trace top frame in project sources, duration). Batch per class; join per method.
- **Wire/manifest:** exactly per frozen architecture.md §7; capabilities `[unit, property, contract, integration]` (no `scope`, no `mutation` — capability negotiation surfaces the gaps).
- Error posture: build failure before tests (compile error) → all requested targets `error` with the build log tail as message (fail-closed, attributable).

## §3 Harness updates

- `.crucible/context/propose.md` gains the JVM addressing convention + addressable-subset rules (oracle tests: plain `@Test` methods, concrete names, one assertion theme per oracle scenario).
- `init` detect flow offers java-junit; lockfile pins version + content hash of the packaged adapter (hash covers the jar).
- CI template variant with JDK setup + (Testcontainers-ready) service config for the validation project.

## §4 Deliberate non-scope

`scope` verb (module-level diff mapping) — later; mutation via PIT — backlog A5, revisit during Phase 4 when critical-tier changes exist to justify it; Python/TS adapters — Category D.
