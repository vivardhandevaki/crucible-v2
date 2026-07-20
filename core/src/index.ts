// Crucible core entry point.
//
// The layered module map (cli/ commands/ artifacts/ hash/ lint/ tier/ verifyx/
// substrate/ adapters/ config/ state/ util/) is defined in
// docs/design/architecture.md §1 and lands module-by-module across Phase 1.
// This placeholder exists only to give the workspace a compilable, testable
// surface for the P0-02 scaffold.

/** Package version marker used by the scaffold smoke test. */
export const CORE_PACKAGE = '@crucible/core';
