// Adapter wire types — the canonical machine form of the adapter protocol
// (architecture.md §7: "The TypeScript types in adapters/types.ts are the
// canonical machine form after P1-11"). Charter §Bindings & the Adapter Protocol
// + §Adapter Manifest & Transport are authoritative; this file is their zod-
// backed restatement.
//
// The core NEVER interprets a `target` string (it is opaque, minted in the
// runner's native scheme) and never imports a test framework — it only speaks
// this one JSON schema. Every field below is validated at the trust boundary
// (architecture.md §4: "zod at every trust boundary: adapter JSON").

import { z } from 'zod';

/** The two verbs every adapter honors (`scope` is optional, unused in v2.0). */
export type AdapterVerb = 'resolve' | 'run';

// ─── resolve ────────────────────────────────────────────────────────────────
// Batch dry-run collection: does each target exist / collect? No execution.

/** A single `resolve` result: `found` (with the resolved file) or `missing`. */
export const resolveResultSchema = z.strictObject({
  target: z.string().min(1),
  status: z.enum(['found', 'missing']),
  // The envelope preserves this optional field so the conformance runner can
  // attribute grounding defects independently. The client below the transport
  // boundary still rejects found-without-file and missing-with-file fail-closed.
  targetFile: z.string().optional(),
});
export type ResolveResult = z.infer<typeof resolveResultSchema>;

// ─── run ──────────────────────────────────────────────────────────────────
// Execute targets; the normalized result schema is the ONLY shape core parses
// (charter §Bindings & the Adapter Protocol).

/** The normalized run statuses. `skip` is coerced to fail at the join layer. */
export const RUN_STATUSES = ['pass', 'fail', 'error', 'skip'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** One normalized `run` result (charter's normalized result schema, exactly). */
export const runResultSchema = z.strictObject({
  target: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  message: z.string().optional(),
  location: z.string().optional(),
  duration_ms: z.number().optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

// ─── envelope ────────────────────────────────────────────────────────────
// Every verb responds with `{ "results": [...] }` on stdout (stub adapter.ts
// header; charter transport). The two envelopes are validated separately so a
// resolve-only status can never masquerade as a run status and vice versa.

export const resolveEnvelopeSchema = z.strictObject({
  results: z.array(resolveResultSchema),
});
export const runEnvelopeSchema = z.strictObject({
  results: z.array(runResultSchema),
});

// ─── ORC join (charter §Bindings & the Adapter Protocol) ─────────────────────
// Core joins normalized run results back to oracle IDs via the binding table.
// `skip` maps to fail for oracle targets (invariant 4); any non-`pass` target
// fails its oracle (multi-target oracles: all must pass).

/** The verdict for a single oracle after joining + skip→fail coercion. */
export type OracleVerdict = 'pass' | 'fail';

/** One oracle's joined result: its verdict + the per-target evidence, in binding order. */
export interface OracleResult {
  /** The oracle id, e.g. `ORC-greeting-001`. */
  oracleId: string;
  /** The requirement the oracle judges, carried through for rendering. */
  requirement: string;
  /** `pass` iff every bound target ran `pass`; else `fail` (fail-closed). */
  status: OracleVerdict;
  /** Per-target normalized results, in the oracle binding's target order. */
  targets: RunResult[];
}
