// detect — "am I applicable to this repo?" (charter §Adapter Lifecycle; design
// phase-3.md §2). Trivial by design: a build-file existence check plus a JDK
// availability probe. `init` runs this across installed adapters to auto-pick
// one; it is a CLI verb, not part of the resolve/run wire.
//
// JDK-absent is a DECLINE with a reason, not a silent applicable-anyway: a
// java-junit adapter with no JVM would fail at run time (invariant 3 — surface
// the gap up front, never as a runtime surprise). The build tool is still
// reported so `init` can tell the user which stack it saw.

/** The build tools this adapter drives (Maven now, Gradle in P3-05). */
export type BuildTool = 'maven' | 'gradle';

/** The detect verdict surfaced as JSON on stdout. */
export interface DetectResult {
  /** True iff this adapter can govern this repo (build file present AND a JDK). */
  applicable: boolean;
  /** The detected build tool, when a build file was found (even if the JDK is absent). */
  buildTool?: BuildTool;
  /** Human-readable reason, always present (why applicable, or why declined). */
  reason: string;
}

/** Injected environment probes (real ones in cli.ts; fakes in tests). */
export interface DetectDeps {
  /** Does a file with this basename exist in the project directory? */
  fileExists: (name: string) => boolean;
  /** Is a usable JDK on PATH (`java -version` succeeds)? */
  hasJdk: () => boolean;
}

/** Maven wins a pom.xml + build.gradle tie — a deterministic pick (invariant 12). */
function detectBuildTool(fileExists: DetectDeps['fileExists']): BuildTool | undefined {
  if (fileExists('pom.xml')) return 'maven';
  if (fileExists('build.gradle') || fileExists('build.gradle.kts')) return 'gradle';
  return undefined;
}

export function detect(deps: DetectDeps): DetectResult {
  const buildTool = detectBuildTool(deps.fileExists);
  if (buildTool === undefined) {
    return {
      applicable: false,
      reason: 'no pom.xml or build.gradle(.kts) found in the project directory',
    };
  }
  if (!deps.hasJdk()) {
    return {
      applicable: false,
      buildTool,
      reason: `found a ${buildTool} project, but no JDK is available (java -version failed) — install a JDK`,
    };
  }
  const buildFile = buildTool === 'maven' ? 'pom.xml' : 'build.gradle(.kts)';
  return {
    applicable: true,
    buildTool,
    reason: `found a ${buildTool} project (${buildFile}) and a usable JDK`,
  };
}
