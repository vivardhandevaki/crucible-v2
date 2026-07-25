#!/usr/bin/env node
// Layering lint — PLACEHOLDER (P0-02).
//
// Enforces the dependency direction from docs/design/architecture.md §1:
//
//   cli → commands → { artifacts, hash, lint, tier, verifyx, substrate,
//                      adapters, config, state } → util
//
// Rules checked here:
//   1. A module may not import "upward" (from a lower layer index toward cli).
//   2. `substrate` and `adapters` may not import each other.
//
// It statically scans relative imports in core/src. Today core/ holds only a
// scaffold barrel, so this passes vacuously — that is intended. The real,
// hardened enforcement moves into the core `lint/` module in Phase 1; this
// script is the documented placeholder the task (P0-02) calls for. It is
// deterministic (no wall-clock, no randomness) per invariant 12.
//
// Exit codes: 0 = clean, 1 = layering violation(s) found.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_SRC = join(ROOT, 'core', 'src');

// Lower index = closer to the CLI entry point; imports may only go to a
// strictly higher index (further down the stack) or stay within the same layer.
const LAYER_ORDER = [
  ['cli'],
  ['commands'],
  ['artifacts', 'hash', 'lint', 'tier', 'changetype', 'verifyx', 'substrate', 'adapters', 'config', 'state'],
  ['util'],
];

const layerIndexOf = (dir) => LAYER_ORDER.findIndex((layer) => layer.includes(dir));

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // core/src not present yet → nothing to scan
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g;

const files = walk(CORE_SRC);
const violations = [];

for (const file of files) {
  const rel = relative(CORE_SRC, file);
  const sourceDir = rel.split(sep)[0];
  const sourceLayer = layerIndexOf(sourceDir);
  if (sourceLayer === -1) continue; // barrel / root file, not layered

  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1];
    // Resolve the first meaningful path segment of the import target.
    const parts = spec.split('/').filter((p) => p && p !== '.' && p !== '..');
    // Count leading "../" to know if the import escapes the source layer dir.
    const upHops = spec.split('/').filter((p) => p === '..').length;
    if (upHops === 0) continue; // same-directory import, same layer
    const targetDir = parts[0];
    const targetLayer = layerIndexOf(targetDir);
    if (targetLayer === -1) continue;

    if (targetLayer < sourceLayer) {
      violations.push(`${rel}: imports upward into '${targetDir}' (${spec})`);
    }
    if (
      (sourceDir === 'substrate' && targetDir === 'adapters') ||
      (sourceDir === 'adapters' && targetDir === 'substrate')
    ) {
      violations.push(`${rel}: '${sourceDir}' must not import '${targetDir}' (${spec})`);
    }
  }
}

if (violations.length > 0) {
  console.error('Layering violations (architecture.md §1):');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`layering lint (placeholder): ${files.length} file(s) scanned, no violations.`);
