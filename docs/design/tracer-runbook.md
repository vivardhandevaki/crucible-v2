# Tracer runbook — real-substrate mode (P1-16)

The tracer (`core/test/tracer.test.ts`) is the P1 exit criterion: propose →
approve → implement → verify on `fixtures/toy-repo`. CI runs it with the
FakeSubstrate — agent sessions are scripted, everything else (adapter client,
stub adapter, seal, verify) is real.

This runbook covers the **real-substrate mode** (design phase-0-1.md §10): the
same flow with live Claude Code sessions, run manually to validate that the
`ClaudeCodeSubstrate` and the P1 role prompts actually drive a real agent
through the loop. It is never run in CI: it costs real tokens, needs network +
an authenticated `claude`, and a red run is *signal about the prompts or the
substrate*, not a build failure.

## Prerequisites

- Claude Code installed and authenticated (`claude --version` works).
- The monorepo built (`npm run build` from the root) — the tracer spawns the
  stub adapter from `adapters/stub/dist/`.

## Run

From the repo root:

```sh
CRUCIBLE_REAL_SUBSTRATE=1 npx vitest run core/test/tracer.test.ts
```

Optionally pin the session model (defaults to `claude-opus-4-8`):

```sh
CRUCIBLE_REAL_SUBSTRATE=1 CRUCIBLE_REAL_MODEL=claude-fable-5 npx vitest run core/test/tracer.test.ts
```

The FakeSubstrate suite is skipped in this mode; the single real-mode test runs
the whole flow with a generous timeout (30 min).

## What happens

1. A scratch copy of `fixtures/toy-repo` is made under the system tmpdir; its
   path is printed at the start of the run and **kept after the run** (real
   mode skips cleanup) so transcripts and artifacts can be inspected.
2. `propose` runs a live session from the checked-in intent + the toy repo's
   `.crucible/context/propose.md` role prompt; the authored bundle is judged by
   the real parsers + traceability lint (real stub-adapter resolve).
3. `approve --yes` seals the bundle (real hash scope from the real resolve).
4. `implement` runs two live sessions (tasks breakdown, then code), then a real
   local verify.
5. Standalone `verify` renders the final verdict.

## Interpreting the outcome

- **Green** — the substrate contract and the P1 role prompts hold end-to-end.
- **Red at propose** — the live agent's bundle failed the parsers or the lint:
  role-prompt drift against the artifact grammar. Read the propose transcript
  under `<scratch>/.crucible/transcripts/add-greeting/`.
- **Red at implement/verify** — check which check is red in the report: an
  `approval` red means the session edited a sealed file (the seal working as
  designed); an `oracles` red means the declared toy tests don't pass as bound.
- **`SUBSTRATE_UNAVAILABLE` (exit 3)** — `claude` is missing or the role prompt
  is unreadable; nothing ran.

Live sessions are nondeterministic — an occasional red is data, not flake to
rerun until green. If the *contract* (not the prompts) misbehaves, record it as
a spike-notes addendum (the P1-08 idiom) and fix before relying on the
substrate in later phases.

Clean up inspected scratch dirs manually (`rm -rf /tmp/crucible-tracer-*`).
