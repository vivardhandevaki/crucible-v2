# Design — Phase 2 (Deepen the Loop) — **DRAFT**

> **Status: DRAFT — written before Phase 1 completion.** Do not execute Phase 2 tasks until a Fable-tier re-ratification session has reviewed this doc against the as-built Phase 1 (interfaces frozen in architecture.md §6–8, spike notes, tracer learnings) and amended it. Sections most likely to change are marked `[P1-DEP]`.

Reads with: charter (§Loop Mechanics, §Configuration & Reviewer Law, §Tier Definitions, §Change Types), architecture.md, phase-0-1.md.

**Exit criterion:** all three charter worked-example flows (standard feature, pure refactor, critical + escalation/amend + bugfix ratchet) are executable end-to-end against the toy fixture repo, with FakeSubstrate in CI and real substrate manually.

## §1 Archive & the regression suite

- `crucible archive <change>`: merges spec deltas into `specs/` (via OpenSpec's archive mechanism `[P1-DEP]` — spike notes govern), moves the change to archived, and thereby registers its bindings in the regression set.
- Regression collection: scan archived changes' oracles.md files → union of bindings, grouped by runner. No separate registry (charter: archiving is registration).
- Lint upgrade: `requirement:` may now reference archived REQ IDs (bugfix/ratchet oracles). Archived-REQ index built from `specs/` + archived deltas.

## §2 Tier computation & routing

- `tier/` implements the charter table: inputs = spec-delta presence, risk-glob matches (enforcement config), diff size (git diff vs merge-base `[P1-DEP]` on how implement/CI obtain the diff). Output includes the *facts* used (for state.yaml and `status` display).
- Recomputation points: propose (suggest), approve (display + record), implement (refuse on mismatch with claim), CI verify (authoritative).
- Routing: verify's report gains `routing: auto | human` + reasons. Mechanically: CI check `crucible-route` fails when `human` and no approving review exists `[P1-DEP: exact GitHub mechanics]`; auto-merge is enabled per-repo via branch settings + GH auto-merge — Crucible emits the decision, GitHub enforces it. Trivial/standard green → auto-merge path; critical → required human review.
- Diff caps enforced in verify (per-tier from config); stacked-change plans deferred to just-in-time (backlog A6) unless the validation project needs them earlier.

## §3 amend / override / escalate

- **escalate:** writes `escalation.yaml {oracle?, question, options[], filed_at}`; ends implement run; implement precondition: refuse while unresolved. Notify hooks fire.
- **amend:** interactive resolution + general mid-flight spec fixes. Flow: show approved-vs-current artifact diff (or escalation options) → human picks/edits → substrate(role=propose) regenerates affected artifacts + bound tests → human confirms that diff → append `amendments[]` entry to approval.yaml with fresh hashes → clear escalation. Staleness rules from charter §Editing Artifacts apply pre-approval via `propose --revise` (also this phase).
- **override:** `crucible override "<reason>"` writes `override.yaml`; verify treats gate-bypass as permitted but marks the report `override: true`; CI forces human review regardless of tier and files the ratchet issue (GH issue via API `[P1-DEP: token plumbing]`) that stays open until a retroactive change references it.

## §4 Change types

- Schema bundle gains `feature` / `bugfix` / `refactor` variants (OpenSpec schema mechanism per spike notes `[P1-DEP]`).
- `refactor`: spec delta present → exit 3 at propose; lint requires zero new oracles; correctness = regression suite.
- `bugfix`: requires ≥1 new oracle marked `reproduces: true`; verify gains the **red-on-base/green-on-fix** check: run the reproduction target against merge-base (worktree checkout) expecting fail, against head expecting pass. Fail-closed: reproduction passing on base → exit 1 ("does not reproduce").
- Type inference in propose from intent text; `--type` overrides; recorded in proposal frontmatter and re-validated like tiers.

## §5 Adversarial reviewer

- `.crucible/rubric.yaml` loader + zod schema (charter format). Rubric is TCB: included in approval hash scope? **No** — rubric is repo-global, protected by risk globs + target-branch rule, not per-change hashing. Verdicts pin `rubric_hash`.
- `commands/review.ts`: substrate(role=review, fresh context) with inputs = diff, spec delta, oracles, rubric; expects strict verdict JSON (charter schema) on stdout-file `[P1-DEP: how substrate returns structured output — likely "write verdict to a named path, core validates"]`.
- Fail-closed enforcement in core, not prompt: malformed → fail; fail-with-no-block-findings → fail; unknown rubric ID → fail. Observations attached to verify report + PR comment.
- `verify --review` optional locally; CI always. Reviewer model from settings.yaml `models.review` (prefer_different_family honored when resolvable).
- `.crucible/context/review.md` authored this phase (Fable-tier): instructs evidence-cited findings only, observations channel, no invented rules.

## §6 Trajectory capture (checks parked)

- Transcripts already captured (P1). This phase: index transcripts in state.yaml events; verify records a `local_verify_ran` stamp (from state events) surfaced in CI report when `trajectory.require_local_verify`. Deterministic trajectory *checks* beyond this remain parked (backlog C17) — capture now, judge later.

## §7 init & doctor

- `crucible init`: interactive — detect adapters (stub/java-junit when present), write crucible.yaml + settings.yaml defaults, install schema bundle into `openspec/schemas/crucible/`, write `.crucible/context/*` + rubric.yaml defaults, install CI template, write managed CLAUDE.md/AGENTS.md block, gitignore local.yaml + transcripts. Idempotent: re-run = diff-and-confirm.
- `crucible doctor`: verify schema bundle integrity vs shipped version, CI template currency, OpenSpec version-range compliance, adapter lockfile hash validity; offers fixes as diffs, never silent writes (TCB respect). Upstream rubric-line offers live here (accept/skip).

## §8 Approve surface, notify, why

- **Approve surface (backlog A3 decision):** terminal-first for v2.0 — a rendered review flow: bundle summary → per-oracle scenario + bound-test source side-by-side (pager) → Unspecified/Seams surfaced prominently → inline "edit" drops to $EDITOR then re-validates (P1 approve semantics) → critical tier: per-oracle ack prompts. A `--web` local HTML view is an optional stretch, not required for exit.
- **Notify hooks:** `notify/` dispatcher reading convenience config; hooks: terminal, desktop (node-notifier), webhook, github-issue/pr-comment. Fire-and-forget with logged failures (convenience-never-enforcement).
- **`crucible why <check|ORC|R-id>`:** walks report → oracle → binding → adapter result → raw tool output path; for reviewer findings, prints rubric line + evidence + remediation.

## §9 Deferred within Phase 2

Weekly audit digest (A7) → just-in-time in Phase 4 unless earlier need; stacked changes (A6) → same; mutation testing → Phase 3+ (needs real adapter; PIT decision is backlog A5).
