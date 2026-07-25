// Schemas workspace — programmatic paths to the shipped change-type bundles
// (P2-07; charter §Change Types; design phase-2.md §4).
//
// Crucible ships three SIBLING OpenSpec schema bundles, one per change type:
// `crucible` (feature, the default), `crucible-bugfix`, and `crucible-refactor`.
// They are plain files (schema.yaml + templates/) that `crucible init` (P2-12)
// installs by COPYING into a target repo's `openspec/schemas/<name>/` — never via
// OpenSpec's generator, which rejects Crucible's custom `oracles` artifact id
// (spike-notes §"What the schema format permits"). `propose` then passes the
// bundle name to `openspec new change --schema <name>` and the change's
// `.openspec.yaml` pins it thereafter (that pin IS the recorded change type).
//
// This module computes paths only; it never parses or mutates a bundle. The
// bundle DATA under `crucible*/` is author-controlled and validated by core's
// `changetype/` TCB (the schema-bundle zod schema), the same split fixtures uses.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/index.ts (or dist/index.js) → workspace root.
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The three shipped bundle directory names, in canonical (type) order. */
export const SCHEMA_BUNDLE_NAMES = ['crucible', 'crucible-bugfix', 'crucible-refactor'] as const;
export type SchemaBundleName = (typeof SCHEMA_BUNDLE_NAMES)[number];

/** Absolute path to a shipped bundle directory (schema.yaml + templates/). */
export function schemaBundleDir(name: SchemaBundleName): string {
  return join(workspaceRoot, name);
}

/** Absolute path to a shipped bundle's `schema.yaml`. */
export function schemaBundleFile(name: SchemaBundleName): string {
  return join(schemaBundleDir(name), 'schema.yaml');
}
