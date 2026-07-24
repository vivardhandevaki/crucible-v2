# Layering (module dependency direction)

The canonical rule lives in [`docs/design/architecture.md` §1](docs/design/architecture.md).
This file documents how it is **enforced in the toolchain** — the P0-02 task
deliverable "layering lint placeholder documented."

## The rule

```
cli → commands → { artifacts, hash, lint, tier, verifyx,
                   substrate, adapters, config, state } → util
```

- Lower layers never import upward.
- `substrate` and `adapters` never import each other.
- Nothing outside `substrate` invokes an agent; nothing outside `adapters`
  spawns an adapter process. (Not yet statically checked — see below.)

## How it is checked today (placeholder)

`npm run lint:layering` runs [`scripts/check-layering.mjs`](scripts/check-layering.mjs),
a deterministic static scan of `core/src` that flags:

1. upward imports (toward `cli`), and
2. `substrate` ↔ `adapters` cross-imports.

While `core/` holds only the scaffold barrel it passes vacuously. This is a
**placeholder**: it runs in CI so the wiring is real, but the authoritative,
fully-tested implementation moves into the core `lint/` module during Phase 1.
The agent/adapter-invocation boundary checks are deferred to that module too.

CI runs this check on every push/PR (see `.github/workflows/ci.yml`).
