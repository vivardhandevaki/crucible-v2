# Spike Notes — P0-01: OpenSpec Integration (2026-07-19)

**Ground truth tested:** [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec), docs read at tag `v1.6.0`, CLI exercised at **`@fission-ai/openspec@1.6.0`** (latest stable on npm, published 2026-07-10).

**Pinned version policy:** exact pin `1.6.0` in root `package.json` (see §Version Pinning below for why the range is deliberately narrow).

**Scratch exercise:** disposable repo at `/tmp/openspec-spike` (own git history, not part of this repo). Full repro sequence in §Repro at the bottom.

---

## Verdict on charter assumptions (§OpenSpec Integration Mechanics)

| Charter claim | Verdict | Evidence |
|---|---|---|
| Custom schemas are project-level bundles at `openspec/schemas/<name>/` (schema.yaml + templates) | **Verified** | `schema init` scaffolds exactly this layout; hand-edited bundle validates and drives the workflow |
| Dependency ordering via `requires` | **Verified** (advisory, not enforced — see D3) | `status --json` reports `blocked` + `missingDeps` per the chain; five-artifact chain proposal→specs→design→oracles→tasks works |
| Schemas survive OpenSpec upgrades; `update` regenerates AI instruction/skill files only | **Verified at 1.6.0** | `openspec update --force` rewrote only `.claude/` files; zero git diff to `openspec/schemas/`, `config.yaml`, `changes/`, `specs/` (cross-version upgrade untestable until >1.6.0 exists) |
| `crucible init` installs the bundle and sets it in config.yaml, same path community schemas use | **Verified** | `schema: crucible` in `openspec/config.yaml` makes it the default; community schemas are documented as installed by copying into `openspec/schemas/<name>/` — same mechanism `crucible init` will use |
| OpenSpec has no approval concept; artifacts freely editable | **Verified** | No gating anywhere: `instructions` on a blocked artifact exits 0 and returns full guidance; files are written by the agent, OpenSpec only observes presence |
| Tasks generated post-approval is structurally compatible | **Verified** | Artifact completion is computed from file presence only; nothing in OpenSpec objects to `tasks.md` appearing later or being written by a different process |

**Headline: the charter's integration model survives contact with OpenSpec 1.6.0.** No charter *mechanics* needed amending. Two caveats were amended into the docs in this commit (see §Amendments).

---

## Answers to the four spike questions (phase-0-1.md §Phase 0 item 1)

### 1. What the schema format actually permits

`schema.yaml`: `name`, `version`, `description`; `artifacts[]` with `id`, `generates` (filename or glob — `specs/**/*.md` works), `description`, `template` (path under `templates/`), optional `instruction` (multiline AI guidance), `requires[]` (artifact IDs); plus `apply: {requires: [...], tracks: tasks.md}`.

- **Custom artifact IDs (e.g. `oracles`) are accepted when the schema.yaml is hand-authored.** `openspec schema validate crucible` passes: YAML parse, structure, template existence, dependency-cycle checks.
- **But the `schema init --artifacts` scaffolder rejects unknown IDs** (`Unknown artifact 'oracles'` — fixed vocabulary `proposal,specs,design,tasks`). Consequence for `crucible init`: ship the complete bundle as files and copy it into `openspec/schemas/crucible/`; do not drive OpenSpec's generator.
- **Schema commands print "experimental and may change."** This is the main reason for the exact version pin.

### 2. How templates work

Plain markdown files under `templates/`, one per artifact. They are **prompt material, not validators**: `openspec instructions <artifact> --change <c> --json` returns the template verbatim plus the artifact `instruction`, project `context`/`rules` from config.yaml, and the content of dependency artifacts. Output is never checked against the template. Crucible's propose role can therefore call `openspec instructions` per artifact for enriched prompts, while all real validation stays in Crucible's parsers (as designed).

### 3. What `openspec update` regenerates

Only AI-tool integration files (`.claude/skills/openspec-*/`, `.claude/commands/opsx/`, equivalents for other tools), driven by global profile/delivery config. Confirmed by committing the tree and diffing after `update --force`: **zero changes** outside those paths. Project schemas, config.yaml, changes, and specs are untouched. The charter's upgrade procedure (`openspec update` + `crucible doctor`) is sound.

### 4. Deltas from charter/design assumptions

**D1 — Change dirs contain OpenSpec metadata files not in our bundle layout.** `openspec new change` creates `.openspec.yaml` (`schema: crucible`, `created: <date>`) and a `README.md` in the change dir. Design §3's bundle layout amended: these are OpenSpec-owned metadata, **outside the approval hash scope** (they're not review material and OpenSpec may rewrite them).

**D2 — Spec deltas must satisfy OpenSpec's own delta grammar.** `openspec validate` enforces: delta operation headers (`## ADDED/MODIFIED/REMOVED/RENAMED Requirements`), `### Requirement:` headings, and **at least one `#### Scenario:` block per requirement**. The charter's bracketed-ID heading form `### Requirement: <title> [REQ-x-1]` is compatible (validates clean, and the brackets survive `archive`'s merge into `openspec/specs/` verbatim). Crucible's spec-delta template must include the operation headers and scenario blocks or `validate`/`archive` fail. (OpenSpec's parsed-delta JSON drops the heading text, so Crucible's own REQ extractor reading headings — P1-04 — is still required.)

**D3 — `requires` ordering is advisory.** OpenSpec never blocks writing files out of order; `status`/`instructions` merely report readiness. Expected (charter already assigns enforcement to Crucible), but worth stating: **nothing about artifact ordering is enforced by OpenSpec at all.**

**D4 — `validate --json` always exits 0**, even with `valid: false` and ERROR-level issues. Non-JSON mode exits 1 on invalid. Any Crucible code shelling out to `openspec validate --json` must parse the JSON verdict, never trust the exit code (fail-closed invariant #3).

**D5 — `planningHome.defaultSchema` in `status --json` ignored project config.yaml** (reported `spec-driven` while config said `crucible`). The change itself resolved correctly via its `.openspec.yaml`. Looks like a minor OpenSpec bug; defensive rule for Crucible: **always pass `--schema` or rely on the change's `.openspec.yaml`, never on ambient default-schema resolution.**

**D6 — Change names are validated**: lowercase kebab-case, no leading digit (`ticket-123-x` ok, `123-x` not). `crucible propose` must apply the same rule to change names it accepts.

Useful confirmations beyond the questions:

- **Foreign files are tolerated everywhere.** `approval.yaml`, `state.yaml`, a `tests/` dir in the change folder: `validate --strict` clean, and `archive` moves the entire dir (foreign files included) to `openspec/changes/archive/YYYY-MM-DD-<name>/` intact.
- **`archive` merges deltas into `openspec/specs/<capability>/spec.md` preserving REQ-bracketed headings** — the regression ratchet's traceability inheritance works.
- **Scaffolding mechanism for `propose` (the phase-0-1 §6 "spike-determined mechanism"):** `openspec new change <name> --schema crucible --json` (returns paths as JSON), then the substrate session authors artifact files directly; `openspec status --change <name> --json` gives machine-readable per-artifact completion.
- A fenced `yaml crucible-binding` block inside `oracles.md` passes through OpenSpec untouched (OpenSpec doesn't parse artifacts other than `specs/**`).

---

## Version Pinning

- Repo: `https://github.com/Fission-AI/OpenSpec` (docs under `/docs`)
- npm package: `@fission-ai/openspec`
- **Tested & pinned: `1.6.0` (exact)**, recorded in root `package.json` as a devDependency.
- Range policy: schema commands are officially experimental, so no semver range is trusted. Upgrades are deliberate: bump the pin, re-run this spike's repro sequence (§Repro), and let `crucible doctor` (P2) verify the installed bundle. Expected-compatible range is `1.6.x`, but that is an expectation, not a contract.

## Repro

```bash
mkdir spike && cd spike && git init && npm init -y
npm install --save-exact @fission-ai/openspec@1.6.0
npx openspec init --tools claude --force
npx openspec schema init crucible --artifacts "proposal,specs,design,tasks" --no-default
# hand-edit openspec/schemas/crucible/schema.yaml: insert `oracles` artifact
#   (requires: [design]) and repoint tasks.requires to [oracles]; add templates/oracles.md
npx openspec schema validate crucible --verbose
echo 'schema: crucible' > openspec/config.yaml
npx openspec new change add-greeting --json
# author proposal.md, specs/greeting/spec.md (ADDED-header + [REQ-*] headings + Scenario blocks),
#   design.md, oracles.md (ORC headings + crucible-binding fences), tasks.md
npx openspec status --change add-greeting --json   # 5/5 complete
npx openspec validate add-greeting --strict --json # valid (parse JSON, not exit code!)
git add -A && git commit -m pre-update && npx openspec update --force && git status  # clean
npx openspec archive add-greeting --yes            # merges deltas into openspec/specs/
```

## Re-verification (P0-03 validation, 2026-07-22)

The §Repro sequence was re-run against the pinned `@fission-ai/openspec@1.6.0`,
this time populating the change with the **committed P0-03 toy fixture bundle**
(`fixtures/toy-repo/openspec/changes/add-greeting/`) rather than hand-authored
scratch artifacts. Confirmed independently:

- Custom schema (with the `oracles` artifact, `requires: [design]`) → `schema validate` passes.
- Fixture bundle → `status` reports 5/5 artifacts done, and `validate --strict --json` returns `valid` (1 passed, 0 failed).
- `archive` merges both requirements into `openspec/specs/greeting/spec.md` with the `[REQ-greeting-basic-1]` / `[REQ-greeting-default-2]` bracketed headings preserved.

So the toy fixture is validated against OpenSpec's *real* delta grammar, not
just Crucible's own regexes — the end-to-end spike claim holds on checked-in
artifacts. The scratch project remains disposable (built in `/tmp`, not part of
this repo).
