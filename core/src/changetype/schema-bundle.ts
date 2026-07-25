// Schema-bundle loader + validator — the structural gate on a shipped OpenSpec
// change-type bundle (design phase-2.md §4; spike-notes §"What the schema format
// permits").
//
// A Crucible bundle is a directory with a `schema.yaml` (name / version /
// description / artifacts[] / optional apply) and a `templates/` dir. OpenSpec
// treats templates as prompt material, not validators (spike D-templates), and
// its own `schema validate` accepts our custom `oracles` artifact id — but
// OpenSpec's validity is not Crucible's. This module is the Crucible-side check:
// the same three shipped bundles are the seed of every future Crucible project,
// so a malformed one is a TCB defect that must fail closed at exit 3 (invariant 3)
// rather than be copied into a repo by `crucible init` / `doctor` (P2-12/13).
//
// It checks more than the shape: every `template:` file must exist, every
// `requires:` / `apply.requires:` entry must name a declared artifact, and the
// dependency graph must be acyclic. Pure but for reading the named files
// (deterministic, invariant 12) — it spawns nothing and never writes.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { invalidInputError } from '../util/errors.js';

/** One artifact declaration in a bundle's `schema.yaml`. */
const artifactSchema = z.strictObject({
  id: z.string().min(1),
  generates: z.string().min(1),
  description: z.string().min(1),
  template: z.string().min(1),
  instruction: z.string().optional(),
  requires: z.array(z.string().min(1)).default([]),
});

/** The optional `apply:` block (the implement phase's tracked artifact). */
const applySchema = z.strictObject({
  requires: z.array(z.string().min(1)),
  tracks: z.string().min(1),
  instruction: z.string().optional(),
});

/** A whole `schema.yaml`. Strict — an unknown key fails closed (invariant 3). */
export const schemaBundleSchema = z.strictObject({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
  artifacts: z.array(artifactSchema).min(1),
  apply: applySchema.optional(),
});
export type SchemaBundle = z.infer<typeof schemaBundleSchema>;

/**
 * Load + fully validate a bundle from its `schema.yaml` path: zod shape, then
 * cross-file integrity (templates exist, requires resolve, graph is acyclic).
 * Any defect → exit 3 (fail-closed), naming the bundle and the exact problem.
 */
export function loadSchemaBundle(schemaYamlPath: string): SchemaBundle {
  const bundleDir = dirname(schemaYamlPath);

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(schemaYamlPath, 'utf8'));
  } catch (cause) {
    throw fail(schemaYamlPath, `is not valid YAML — ${messageOf(cause)}`);
  }

  const result = schemaBundleSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    throw fail(schemaYamlPath, `${where}: ${issue.message}`);
  }
  const bundle = result.data;

  const ids = new Set(bundle.artifacts.map((a) => a.id));
  if (ids.size !== bundle.artifacts.length) {
    throw fail(schemaYamlPath, 'duplicate artifact id');
  }

  for (const artifact of bundle.artifacts) {
    const templatePath = join(bundleDir, 'templates', artifact.template);
    if (!existsSync(templatePath)) {
      throw fail(
        schemaYamlPath,
        `artifact ${artifact.id} references template ${artifact.template}, which does not exist at templates/${artifact.template}`,
      );
    }
    for (const dep of artifact.requires) {
      if (!ids.has(dep)) {
        throw fail(
          schemaYamlPath,
          `artifact ${artifact.id} requires ${dep}, which is not a declared artifact`,
        );
      }
    }
  }

  if (bundle.apply) {
    for (const dep of bundle.apply.requires) {
      if (!ids.has(dep)) {
        throw fail(schemaYamlPath, `apply.requires names ${dep}, which is not a declared artifact`);
      }
    }
  }

  assertAcyclic(bundle, schemaYamlPath);
  return bundle;
}

/** Depth-first cycle detection over the `requires` graph (OpenSpec checks this too). */
function assertAcyclic(bundle: SchemaBundle, source: string): void {
  const deps = new Map(bundle.artifacts.map((a) => [a.id, a.requires] as const));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, stack: string[]): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw fail(source, `dependency cycle: ${[...stack, id].join(' → ')}`);
    }
    state.set(id, 'visiting');
    for (const dep of deps.get(id) ?? []) visit(dep, [...stack, id]);
    state.set(id, 'done');
  };

  for (const artifact of bundle.artifacts) visit(artifact.id, []);
}

function fail(source: string, detail: string): never {
  throw invalidInputError(
    'INVALID_SCHEMA_BUNDLE',
    `${source}: ${detail}`,
    'This is a shipped Crucible schema bundle; a defect here is a build bug (docs/design/phase-2.md §4).',
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
