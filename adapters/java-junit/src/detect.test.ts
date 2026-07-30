// detect: "am I applicable to this repo?" (design phase-3.md §2). Pure over an
// injected filesystem view + JDK probe, so every branch — Maven, Gradle, no
// build file, JDK absent — is exercised without touching a real disk or JVM.

import { describe, expect, it } from 'vitest';

import { detect, type DetectDeps } from './detect.js';

function deps(files: string[], hasJdk: boolean): DetectDeps {
  const present = new Set(files);
  return { fileExists: (name) => present.has(name), hasJdk: () => hasJdk };
}

describe('detect', () => {
  it('detects Maven from pom.xml with a JDK present', () => {
    const r = detect(deps(['pom.xml'], true));
    expect(r).toMatchObject({ applicable: true, buildTool: 'maven' });
    expect(r.reason).toMatch(/pom\.xml/);
  });

  it('detects Gradle from build.gradle', () => {
    expect(detect(deps(['build.gradle'], true))).toMatchObject({
      applicable: true,
      buildTool: 'gradle',
    });
  });

  it('detects Gradle from a Kotlin build.gradle.kts', () => {
    expect(detect(deps(['build.gradle.kts'], true))).toMatchObject({
      applicable: true,
      buildTool: 'gradle',
    });
  });

  it('prefers Maven when both pom.xml and build.gradle are present', () => {
    // A deterministic pick (invariant 12); Maven wins the tie.
    expect(detect(deps(['pom.xml', 'build.gradle'], true)).buildTool).toBe('maven');
  });

  it('declines when no build file is present', () => {
    const r = detect(deps([], true));
    expect(r.applicable).toBe(false);
    expect(r.buildTool).toBeUndefined();
    expect(r.reason).toMatch(/pom\.xml|build\.gradle/);
  });

  it('declines when a build file is present but the JDK is absent', () => {
    // JDK-absent detect declines with a reason — never a runtime surprise.
    const r = detect(deps(['pom.xml'], false));
    expect(r.applicable).toBe(false);
    expect(r.buildTool).toBe('maven');
    expect(r.reason).toMatch(/jdk|java/i);
  });
});
