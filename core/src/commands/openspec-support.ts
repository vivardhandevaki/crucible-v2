// The OpenSpec support window Crucible ships — the version it was verified
// against and the range it expects to stay compatible with (charter §Custom
// schemas amendment; docs/design/spike-notes.md §Repro). Schema commands are
// experimental upstream, so no semver range is trusted: Crucible pins an exact
// OpenSpec version and treats an upgrade as a deliberate, spike-reverified event.
//
// `crucible doctor` (P2-13) reads these to check a project's declared
// `@fission-ai/openspec` pin. They are a MIRROR of the authoritative `openspec`
// block in the monorepo root package.json — which does not ship inside the
// published `core` package, hence the duplication. `openspec-support.test.ts`
// guards the two from drifting apart.

/** The exact OpenSpec version Crucible was verified against (the pin target). */
export const OPENSPEC_TESTED_VERSION = '1.6.0';

/** The minor-series Crucible expects to remain compatible with. */
export const OPENSPEC_COMPATIBLE_RANGE = '1.6.x';

/**
 * Extract a `major.minor` key from an npm version/range spec (`1.6.0`,
 * `^1.6.0`, `~1.6.2`, `1.6.x` → `1.6`). Returns null when no `<int>.<int>` is
 * present. Deliberately coarse: the pin policy is an EXACT version, so
 * minor-series equality is the whole compatibility test — a real semver range
 * solver would be more machinery than the "exact pin, deliberate upgrade" policy
 * warrants.
 */
export function majorMinorOf(spec: string): string | null {
  const m = spec.match(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Whether a declared OpenSpec pin falls within the shipped compatible range. */
export function isOpenspecPinCompatible(spec: string): boolean {
  const pin = majorMinorOf(spec);
  const range = majorMinorOf(OPENSPEC_COMPATIBLE_RANGE);
  return pin !== null && range !== null && pin === range;
}
