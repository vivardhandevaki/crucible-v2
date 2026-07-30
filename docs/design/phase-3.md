# Design — Phase 3 (Real Adapter: java-junit)

> **Status: RATIFIED (P3-00, 2026-07-29).** Reviewed against the as-built Phase 2 — the frozen adapter wire contract (architecture.md §7; `core/src/adapters/types.ts` strict schemas), the as-built seal path (`computeHashScope`'s fail-closed `UNRESOLVED_TARGET_FILE` precondition), the bugfix reproduction check, doctor's `CHECKS` seam (P2-13 → P3-09), and the green worked-examples suite (P2-17). The single Phase-2 dependency marker below is resolved inline (marked *Resolved P3-00*); contract drift found during review is amended in place with the same marking.

Reads with: charter §First Reference Adapter, §Bindings & the Adapter Protocol, §Adapter Lifecycle; architecture.md §7 (frozen).

**Exit criterion:** conformance suite passes for `java-junit` on both Maven and Gradle fixtures; a hello-world Spring Boot change flows propose → approve → implement → verify → CI end-to-end with the real adapter; stub retired into the conformance suite.

## §1 Conformance fixtures (built first — they define "correct adapter")

- `fixtures/conformance/maven-basic/` and `gradle-basic/`: minimal JUnit 5 projects, each containing: passing tests, a failing test, a skipped test (`@Disabled`), a parameterized test (must be *excluded* from oracle addressing per the addressable-subset rule), and a "missing" target list (tests that don't exist).
- `fixtures/conformance/spring-testcontainers/`: one `@SpringBootTest` + Testcontainers test — proves integration-kind tests are "just slow JUnit" and shapes CI templates for the validation project (charter build decision).
- Conformance runner (`fixtures/conformance/run.ts`): drives any adapter through a declared script — resolve found/missing sets, run expected statuses, skip→(raw `skip` in adapter output — the conformance assertion is on the adapter's verbatim per-target status; the oracle-verdict coercion to fail happens at core's ORC join, not in the adapter or client *(wording corrected P3-00 per as-built architecture §7)*), malformed-stdin rejection, manifest validity, hash stability of the packaged executable. **The stub must pass it too** (it becomes the protocol's executable spec); stub then lives on only inside conformance + core unit tests.

### §1.1 Conformance runner — script semantics *(settled P3-02 Fable pass, 2026-07-30)*

- **Shape:** `run.ts` is a generic engine (exported `runConformance(scriptPath)` + thin CLI); the "declared script" is a per-adapter JSON **conformance script** naming the wiring, plus a case catalogue in the existing P1-10 `cases.json` shape (verb + stdin targets → expected results). One expectation grammar for all adapters — JVM catalogues (P3-04/P3-05) are authored in the same format; `targets.json` stays the human/manifest truth those catalogues are derived from.
- **Script schema (strict, fail-closed):** `{ name, manifest, cwd, pathPrepend?, env?, timeoutMs?, cases, package: { files: [] } }`. All paths resolve relative to the script file's directory; unknown fields or duplicate targets within a case → runner exit 3 (authoring error, not a conformance verdict).
- **Spawning is verbatim:** the engine tokenizes and spawns the **manifest's invocation strings** with the same semantics as core's adapter client, from the script's `cwd` — conformance certifies exactly what core will spawn. `pathPrepend` (e.g. the workspace `node_modules/.bin`) only makes the named bin resolvable — convenience, invariant 11; it never alters what is asserted.
- **Canonical schemas, not re-declared:** the engine validates responses with the strict zod envelopes from `core/src/adapters/types.ts` and manifests with `core`'s `parseManifest` — re-stating them in fixtures would fork the spec. Dependency note: this adds a runtime edge `fixtures → core`; core's existing edge to fixtures is devDependency-only, so the runtime graph stays acyclic.
- **Match rule — declared-field exact match:** `target` and `status` are mandatory in every expected result; any other field present in `expected` must equal the actual value exactly; fields absent from `expected` are unconstrained (JVM cases may omit nondeterministic `message` / `duration_ms`). No substring or regex matching — deterministic comparison only (invariant 12).
- **Universal checks (built into the engine; a script cannot opt out):**
  1. `manifest-valid` — the manifest parses under core's schema.
  2. `envelope` — per case: exit 0, stdout is the verb's strict envelope, exactly one result per requested target, input order, no drops or extras.
  3. `missing-no-targetfile` — a `missing` resolve result must not carry `targetFile` (a phantom path here is seal-path poison; see §2 resolve grounding).
  4. `case-expectations` — declared-field exact match per case.
  5. `malformed-stdin` — per verb: non-JSON stdin **and** schema-invalid request (`{"targets": "x"}`) must yield non-zero exit and no valid envelope on stdout.
  6. `package-hash` — every declared `package.files` entry exists; the content digest (core hash module) computed twice independently agrees, and the digest is surfaced in the report for pin flows. Rebuild-twice byte-determinism is P3-06's packaging acceptance, not the runner's.
  - A hung (script `timeoutMs`), garbled, or non-zero-exiting adapter under a case is a **finding on the owning check** — the subject failed; the runner never crashes on adapter misbehavior.
- **Findings & exits (architecture §2/§3):** deterministic JSON report `{ adapter, checks: [...] }`; findings ordered by (check, case, target input order); no timestamps or durations in the report. Each finding is `{ check, case?, target?, expected?, actual?, detail }` — attribution is the acceptance bar. Exit 0 = green; exit 1 = findings (a verdict, not an error); exit 3 = the runner's *own* inputs malformed (script/cases/manifest unreadable at the file level); exit 4 = engine bug.
- **Broken variant:** sabotage never lives in the stub package. `fixtures/conformance/broken-stub/` carries its own manifest + a wrapper that delegates to the real stub with `--break <mode>`; every universal check has ≥1 mode that trips it, and the P3-02 tests assert each mode produces the expected finding (check id + target).

## §2 java-junit adapter

- Package `adapters/java-junit/`: TypeScript CLI wrapper + bundled Java helper jar.
- **detect:** `pom.xml` | `build.gradle(.kts)` presence + JDK availability check (JDK absent → detect declines with reason; never a runtime surprise).
- **resolve:** the helper jar on JUnit Platform Launcher API — input: target strings `com.acme.FooTest#bar`; output: found/missing + source `targetFile`. *(Resolved P3-00 — hash scope requires an exact, verified file; the convention fallback survives only as a derivation strategy, never a trust grant.)* Grounding: as-built P2 made `targetFile` load-bearing in two enforcement paths — `computeHashScope` seals its sha256 into approval.yaml (invariant 6) and fails closed (`UNRESOLVED_TARGET_FILE`, exit 2) when a `found` target reports none, and the bugfix reproduction check requires it identically. A guessed path that *exists but is wrong* would seal the wrong file: the real test file stays editable post-approval without voiding the seal — a silent invariant-6 hole `verifyApproval` cannot detect (it only checks sealed paths). Therefore: prefer engine metadata; else derive the conventional path from the build tool's *configured* test source roots + package dirs + the outermost class's simple name, and report it only after verifying the file exists **and declares a type of that simple name**. Unverifiable → report `found` with no `targetFile`: the run truth stays honest, and approval fails closed at seal time with re-propose guidance (the core side already enforces this). Non-plain targets (dynamic/@TestFactory, exotic parameterized): the helper classifies them `unsupported` internally (P3-03's three-way classification), but *(resolved P3-00)* `unsupported` never crosses the wire — charter §Bindings and `types.ts` freeze resolve at `found | missing`, so the wrapper maps `unsupported` → `missing` (reason on stderr; convenience, invariant 11), which fails closed at propose time per the addressable-subset rule.
- **run:** Maven: `mvn -q test -Dtest=<classlist>` ; Gradle: `gradle test --tests <patterns>`; then parse Surefire / Gradle JUnit XML into normalized results (status, message, location from stack-trace top frame in project sources, duration). Batch per class; join per method.
- **Wire/manifest:** exactly per frozen architecture.md §7; capabilities `[unit, property, contract, integration]` (no `scope`, no `mutation` — capability negotiation surfaces the gaps).
- Error posture: build failure before tests (compile error) → all requested targets `error` with the build log tail as message (fail-closed, attributable).

## §3 Harness updates

- `.crucible/context/propose.md` gains the JVM addressing convention + addressable-subset rules (oracle tests: plain `@Test` methods, concrete names, one assertion theme per oracle scenario).
- `init` detect flow offers java-junit; lockfile pins version + content hash of the packaged adapter. *(Amended P3-00:)* the hash covers the **entire packaged executable** — TS wrapper and bundled jar alike, not the jar alone: the wrapper normalizes results and speaks the wire, so it is TCB exactly like the jar (charter §Adapter Lifecycle: "the binary running in CI must hash-match the pin"). This pin flow mints the lockfile that doctor's fourth check verifies (P3-09, slotting into P2-13's `CHECKS` seam).
- CI template variant with JDK setup + (Testcontainers-ready) service config for the validation project.

## §4 Deliberate non-scope

`scope` verb (module-level diff mapping) — later; mutation via PIT — backlog A5, revisit during Phase 4 when critical-tier changes exist to justify it; Python/TS adapters — Category D.
