# Tasks — Phase 3

> **Ratified via P3-00 (2026-07-29)** — tasks below are executable. The `[P2-DEP]` resolution and contract-drift amendments live inline in `docs/design/phase-3.md` (marked *Resolved/Amended P3-00*). Rules as ever: test-first, done = named tests pass + committed.

**P3-00 · Re-ratification of Phase 3 design** · Tier: Fable · Depends: P2-17 green
Delivers: phase-3.md with `[P2-DEP]` markers resolved against frozen protocol + Phase 2 learnings.
Acceptance: zero markers remain; PHASES.md updated.

**P3-01 · Conformance fixtures (Maven + Gradle)** · Tier: Opus · Depends: P3-00
Delivers: `maven-basic`, `gradle-basic` fixture projects per design §1.
Acceptance: both build + run under plain `mvn test` / `gradle test`; every declared category (pass/fail/skip/parameterized/missing) present and documented.

**P3-02 · Conformance runner** · Tier: Fable (script semantics) + Opus (impl) · Depends: P3-01
Delivers: `fixtures/conformance/run.ts` + declared expectation script.
Acceptance: **stub adapter passes the full conformance run** (protocol's executable spec established); a deliberately-broken stub variant fails with attributable findings.

**P3-03 · Launcher-API resolve helper (jar)** · Tier: Opus · Depends: P3-00
Delivers: small Java project + packaged jar; wrapper invocation.
Acceptance: found/missing/unsupported classification correct on both fixtures incl. parameterized→unsupported; no test executes during resolve (asserted via side-effect canary test).

**P3-04 · java-junit detect + run (Maven)** · Tier: Opus · Depends: P3-02
Delivers: adapter CLI with detect + Maven run path + Surefire XML normalization.
Acceptance: conformance maven-basic green; compile-error path → all-targets `error` with log tail; JDK-absent detect declines.

**P3-05 · Gradle run path** · Tier: Opus · Depends: P3-04
Delivers: Gradle invocation + XML normalization unification.
Acceptance: conformance gradle-basic green; shared normalizer covered by both build tools' XML dialects.

**P3-06 · Full java-junit conformance + packaging** · Tier: Opus · Depends: P3-03, P3-05
Delivers: resolve wired in; packaged executable + manifest; content-hash stability.
Acceptance: complete conformance run green on both fixtures; packaged hash byte-stable across builds (or hashing rule amended + documented); lockfile pin flow works via `init`/`adapter add`.

**P3-07 · Harness + CI updates for JVM** · Tier: Fable (prompt) + Opus (templates) · Depends: P3-06
Delivers: propose prompt JVM conventions; JDK CI template variant; spring-testcontainers fixture proving integration-kind flow.
Acceptance: propose on a JVM toy change emits addressable oracle tests; Testcontainers test flows through verify as ordinary (slow) oracle.

**P3-08 · Hello-world Spring Boot end-to-end** · Tier: Fable · Depends: P3-07
Delivers: scripted end-to-end on a minimal Spring Boot app (real substrate manual + Fake in CI); stub retired from default `init` detect.
Acceptance: full loop green incl. CI; negative paths (post-approval oracle edit, skip) still red with real adapter; PHASES.md Phase 3 done.

**P3-09 · doctor adapter-lockfile-hash check** · Tier: Opus · Depends: P3-06
Reads: charter §Adapter §"Pinned by version and content hash in a lockfile"; design phase-2.md §7 (doctor); phase-3.md §P3-06 (lockfile pin flow).
Delivers: the fourth `crucible doctor` check — adapter lockfile hash validity — added to `doctor.ts`'s `CHECKS` registry (the seam left for it in P2-13). Verifies the `init`/`adapter add`-written lockfile's pinned content hash still matches the installed adapter's packaged bytes; a mismatch is a `drift` finding whose fix re-pins (offered as a diff, never silent), matching the other three checks.
Acceptance: a tampered/updated adapter whose bytes no longer match the lockfile pin → detected as `bad adapter hash`; re-pin offered as a diff and applied only on confirm; a matching lockfile → no finding. *(Split out of P2-13: doctor's other three checks shipped in Phase 2, but the lockfile-with-content-hash mechanism this check verifies is minted by P3-06's pin flow — it did not exist in Phase 2, so P2-13 deferred this clause here rather than fold a can't-yet-run check into doctor. See P2-13 note + design phase-2.md §7.)*
