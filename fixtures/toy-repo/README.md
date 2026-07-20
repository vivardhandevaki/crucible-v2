# toy-repo — Crucible fixture (P0-03)

A fake project used to exercise Crucible commands before they exist and to seed
parser/lint/hash/adapter tests. Consumed programmatically via `@crucible/fixtures`
(see `../src/index.ts`); the smoke test is `../src/toy-repo.test.ts`.

> **Do not reformat.** This tree is excluded from ESLint and Prettier
> (`eslint.config.js`, `.prettierignore`) and from `tsc` (workspace `tsconfig`
> only includes `src`). Its bytes are author-controlled and sealed by the
> approval hash — a stray reformat would break hash-stability tests.

## Layout

```
tests.json                     # stub adapter's declarative test inventory (§7)
src/greeting.ts                # reference implementation of the toy feature
tests/greeting.test.ts         # oracle-bound tests (in the approval hash scope)
tests/greeting_extra.test.ts   # unbound tests backing fail/skip statuses
openspec/
  config.yaml                  # schema: crucible
  changes/add-greeting/        # the pre-written VALID change bundle
    proposal.md design.md oracles.md tasks.md
    specs/greeting/spec.md
    .openspec.yaml README.md   # OpenSpec-owned metadata, outside hash scope
bundles/invalid/               # deliberately-invalid fixtures for parser tests
  oracles/*.md spec-delta/*.md
  expected-errors.json         # machine-readable catalogue of every defect
```

## tests.json

`[{ id, file, status, message? }]` where `status ∈ pass | fail | skip | missing`.
`id` is the opaque adapter target; `file` is the `targetFile` used for hashing.
The valid bundle binds only the two `pass` targets, so the tracer path is green.
The `fail`/`skip`/`missing` entries are inventory for downstream red-path,
skip→fail, and resolve-missing tests (P1-10, P1-11, P1-12).

| id                                    | status  | bound by valid bundle |
| ------------------------------------- | ------- | --------------------- |
| `greeting::returns_hello_for_a_name`  | pass    | yes — ORC-greeting-001 |
| `greeting::defaults_to_world_when_empty` | pass | yes — ORC-greeting-002 |
| `greeting::rejects_null_bytes`        | fail    | no                    |
| `greeting::is_localized`              | skip    | no                    |
| `greeting::streams_large_input`       | missing | no                    |

## Invalid fixtures — expected error codes

Each file under `bundles/invalid/` carries exactly one defect. All are
artifact-grammar violations and must fail closed with **exit code 3** (charter
invariant #3; design §3). `expected-errors.json` is the source of truth (with
exact `line`/`locator` for drift-checking); summary:

| fixture                              | violation                              | exit | consumer |
| ------------------------------------ | -------------------------------------- | ---- | -------- |
| `oracles/bad-id.md`                  | ORC seq not 3 digits                   | 3    | P1-03    |
| `oracles/missing-fence.md`           | zero binding fences                    | 3    | P1-03    |
| `oracles/two-fences.md`              | two binding fences                     | 3    | P1-03    |
| `oracles/bad-kind.md`                | `kind` outside the enum                | 3    | P1-03    |
| `oracles/no-requirement.md`          | binding missing `requirement`          | 3    | P1-03    |
| `spec-delta/malformed-bracket-id.md` | `[REQ-…]` missing trailing `-<n>`      | 3    | P1-04    |
| `spec-delta/duplicate-req-id.md`     | REQ id reused on two headings          | 3    | P1-04    |

> Symbolic error codes (the `CrucibleError` taxonomy) are defined by P1-01/P1-03;
> until then this catalogue commits to the exit code the charter/design already
> settle (3 = artifact-grammar validation). Parser tasks may add further isolated
> snippets here as their acceptance criteria require.
