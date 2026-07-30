# Tasks — Phase 3

> **Ratified via P3-00 (2026-07-29)** — tasks below are executable. The `[P2-DEP]` resolution and contract-drift amendments live inline in `docs/design/phase-3.md` (marked *Resolved/Amended P3-00*). Rules as ever: test-first, done = named tests pass + committed.

**P3-00 · Re-ratification of Phase 3 design** · Tier: Fable / Sol · Depends: P2-17 green
Delivers: phase-3.md with `[P2-DEP]` markers resolved against frozen protocol + Phase 2 learnings.
Acceptance: zero markers remain; PHASES.md updated.

**P3-01 · Conformance fixtures (Maven + Gradle)** · Tier: Opus / Terra · Depends: P3-00
Delivers: `maven-basic`, `gradle-basic` fixture projects per design §1.
Acceptance: both build + run under plain `mvn test` / `gradle test`; every declared category (pass/fail/skip/parameterized/missing) present and documented.

**P3-02 · Conformance runner** · Tier: Fable / Sol (script semantics) + Opus / Terra (impl) · Depends: P3-01
Delivers: `fixtures/conformance/run.ts` + declared expectation script.
Acceptance: **stub adapter passes the full conformance run** (protocol's executable spec established); a deliberately-broken stub variant fails with attributable findings.

**P3-03 · Launcher-API resolve helper (jar)** · Tier: Opus / Terra · Depends: P3-00
Delivers: small Java project + packaged jar; wrapper invocation.
Acceptance: found/missing/unsupported classification correct on both fixtures incl. parameterized→unsupported; no test executes during resolve (asserted via side-effect canary test).

**P3-04 · java-junit detect + run (Maven)** · Tier: Opus / Terra · Depends: P3-02
Delivers: adapter CLI with detect + Maven run path + Surefire XML normalization.
Acceptance: conformance maven-basic green; compile-error path → all-targets `error` with log tail; JDK-absent detect declines.

**P3-05 · Gradle run path** · Tier: Opus / Terra · Depends: P3-04
Delivers: Gradle invocation + XML normalization unification.
Acceptance: conformance gradle-basic green; shared normalizer covered by both build tools' XML dialects.

**P3-10 · Claude Code + OpenAI Codex compatibility** · Tier: Fable / Sol (contract) + Opus / Terra (impl) · Depends: P3-05
Reads: architecture.md §1, §6; design/tracer-runbook.md; AGENTS.md; init and convenience-config contracts.
Delivers: canonical AGENTS.md + CLAUDE.md bridge; CodexSubstrate beside ClaudeCodeSubstrate; central provider/model resolver; Codex-default new init with legacy Claude fallback; agent-influence risk globs; dual-provider tracer; paired task tiers; deterministic JVM fixture isolation.
Acceptance: both provider invocations are hermetic-tested; every live role path uses the resolver; fresh init and old-block migration are idempotent and preserve human content; invalid providers fail exit 3; build, lint, layering, formatting, and the full suite are green twice.

**P3-06 · Full java-junit conformance + packaging** · Tier: Opus / Terra · Depends: P3-03, P3-05, P3-10
Delivers: resolve wired in; packaged executable + manifest; content-hash stability.
Acceptance: complete conformance run green on both fixtures; packaged hash byte-stable across builds (or hashing rule amended + documented); lockfile pin flow works via `init`/`adapter add`.

*(As-built P3-06.)* Shipped one executable (`package/java-junit.mjs`) plus its manifest: esbuild bundles the TypeScript verdict path and embeds the reproducibly-built helper jar, whose Maven output timestamp is fixed; two clean package builds are byte-identical. Maven effective-model roots and a Gradle model task ground found targets to project-contained Java files only after a comment/string-aware type-declaration check. Both packaged conformance suites are green. `init` and `adapter add` install canonical `.crucible/adapters/*` files and mint strict `.crucible/adapters.lock.yaml` version+content-hash pins; the content hash length-frames manifest + executable bytes, and every approval seals the lockfile when present.

**P3-07 · Harness + CI updates for JVM** · Tier: Fable / Sol (prompt) + Opus / Terra (templates) · Depends: P3-06
Delivers: propose prompt JVM conventions; JDK CI template variant; spring-testcontainers fixture proving integration-kind flow.
Acceptance: propose on a JVM toy change emits addressable oracle tests; Testcontainers test flows through verify as ordinary (slow) oracle.

*(As-built P3-07.)* The shipped propose prompt now selects conventions from the
installed adapter and teaches JUnit's plain-`@Test`, fully-qualified
`Class#method` addressable subset. `java-junit` init installs a distinct
target-branch-safe workflow with Temurin 17 and a fail-closed Docker readiness
check; doctor selects the same shipped bytes from enforcement config. The Spring
Boot fixture binds one real Testcontainers method as `kind: integration`, and
the acceptance test drives propose → approve → verify through the packaged
adapter with exact `targetFile` grounding and a real Docker container.

**P3-08 · Hello-world Spring Boot end-to-end** · Tier: Fable / Sol · Depends: P3-07
Delivers: scripted end-to-end on a minimal Spring Boot app (real substrate manual + Fake in CI); stub retired from default `init` detect.
Acceptance: full loop green incl. CI; negative paths (post-approval oracle edit, skip) still red with real adapter; PHASES.md Phase 3 done.

*(As-built P3-08.)* Shipped `fixtures/spring-hello-world` and
`core/test/p3-08-spring-boot-flow.test.ts`: CI fakes only propose, implement,
and review sessions while init, version+hash pinning, JUnit resolve/run, sealing,
local verify, tier computation, and CI review evaluation use production paths.
Every live command now loads and hash-verifies the installed adapter bytes; an
unknown init target fails instead of installing the stub. The same test exposes
manual Codex/Claude Code mode. Oracle drift and JUnit skip remain independently

**P3-09 · doctor adapter-lockfile-hash check** · Tier: Opus / Terra · Depends: P3-06
Reads: charter §Adapter §"Pinned by version and content hash in a lockfile"; design phase-2.md §7 (doctor); phase-3.md §P3-06 (lockfile pin flow).
Delivers: the fourth `crucible doctor` check — adapter lockfile hash validity — added to `doctor.ts`'s `CHECKS` registry (the seam left for it in P2-13). Verifies the `init`/`adapter add`-written lockfile's pinned content hash still matches the installed adapter's packaged bytes; a mismatch is a `drift` finding whose fix re-pins (offered as a diff, never silent), matching the other three checks.
Acceptance: a tampered/updated adapter whose bytes no longer match the lockfile pin → detected as `bad adapter hash`; re-pin offered as a diff and applied only on confirm; a matching lockfile → no finding. *(Split out of P2-13: doctor's other three checks shipped in Phase 2, but the lockfile-with-content-hash mechanism this check verifies is minted by P3-06's pin flow — it did not exist in Phase 2, so P2-13 deferred this clause here rather than fold a can't-yet-run check into doctor. See P2-13 note + design phase-2.md §7.)*

*(As-built P3-09.)* Added `adapter-lockfile-hash` to doctor's `CHECKS`
registry. It strictly loads a present adapter lockfile, recomputes every pin with
P3-06's shared manifest+executable package digest, and reports all mismatches as
one blocking `bad adapter hash` drift finding. Its canonical lockfile re-pin is
carried as a `current → desired` rewrite and reaches disk only through an
explicit `confirmFix`; matching pins and projects without a lockfile stay quiet.
