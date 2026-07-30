# Tracer runbook - real-substrate mode (P1-16, P2-17, P3-10)

The tracer (`core/test/tracer.test.ts`) drives propose -> approve -> implement -> verify on `fixtures/toy-repo`. CI uses `FakeSubstrate`; real mode manually validates the same role prompts and frozen substrate contract with either OpenAI Codex or Claude Code.

Real runs cost tokens, require network access and authentication, and are never a CI gate. A red result is evidence about the provider invocation or prompts, not a reason to rerun until green.

## Prerequisites

Build the monorepo first:

```sh
npm run build
```

For Codex:

```sh
codex --version
```

For Claude Code:

```sh
claude --version
```

The selected CLI must already be authenticated.

## Run

Codex (default real model: `gpt-5.6-sol`):

```sh
CRUCIBLE_REAL_SUBSTRATE=codex npx vitest run core/test/tracer.test.ts
```

Claude Code (default real model: `claude-opus-4-8`):

```sh
CRUCIBLE_REAL_SUBSTRATE=claude-code npx vitest run core/test/tracer.test.ts
```

Legacy `CRUCIBLE_REAL_SUBSTRATE=1` remains an alias for Claude Code. Override either provider's model with `CRUCIBLE_REAL_MODEL`.

The FakeSubstrate cases are skipped in real mode. The live flow has a 30-minute test timeout.

## What happens

1. The test copies `fixtures/toy-repo` to a temporary directory, initializes Git, and commits a baseline. Codex therefore runs with its normal repository check enabled.
2. The selected substrate runs a fresh propose session with `.crucible/context/propose.md`; Crucible judges the authored bundle through the real parsers, lint, and stub-adapter resolve.
3. `approve --yes` seals the bundle.
4. Two fresh implement sessions create `tasks.md` and implement the change; local verify runs through the real adapter client.
5. Standalone verify renders the final deterministic verdict.

The scratch repository is printed and retained for inspection. Remove it manually when finished.

## Transcript and failure behavior

Crucible stores provider stdout verbatim under `.crucible/transcripts/<change>/`:

- Codex transcripts are Codex `exec --json` JSONL.
- Claude Code transcripts are `stream-json` JSONL.

A started process always returns its exit code and preserves any partial transcript, including timeouts and non-zero exits. Only an unreadable role prompt or an unspawnable binary throws `SUBSTRATE_UNAVAILABLE` with exit 3.

Read the transcript when propose or implement is red. The agent process exit status is never treated as proof of success; only the required artifacts and deterministic checks count.

## P2-only manual surfaces

After a retained real tracer run, the same selected provider can exercise the P2 command surfaces:

```sh
cd <scratch>
crucible escalate add-greeting --question "..." --option "(a) ..." --option "(b) ..."
crucible implement add-greeting
crucible amend add-greeting "(a) ..."
crucible review add-greeting --base origin/main
```

A successful amend clears the escalation and reseals the bundle. Review writes a verdict under `.crucible/verdicts/add-greeting/`, consumed by `verify --review`.

## Future agent shortcut

A future milestone may ship a provider-neutral `$crucible` repository skill under `.agents/skills/crucible/`. P3-10 deliberately does not install a Codex skill or slash-command shortcut; agents drive the CLI using the managed `AGENTS.md` instructions.
