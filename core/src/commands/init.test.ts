import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_REVIEW_TEMPLATE_PATH, CI_TEMPLATE_PATH, JAVA_JUNIT_CI_TEMPLATE_PATH } from '@crucible/ci-templates';
import { SCHEMA_BUNDLE_NAMES } from '@crucible/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_PIN_RELPATH, loadFrameworkPin, type FrameworkPin } from '../framework/pin.js';
import { isCrucibleError } from '../util/errors.js';
import {
  GITIGNORE_LINES,
  MANAGED_BLOCK_FILES,
  init,
  MANAGED_SKILL_NAMES,
  type ConfirmOverwrite,
  type InitAnswers,
  type InitReport,
} from './init.js';
import { detectAnswers } from './init.cli.js';

// TCB: init WRITES the files a project is then governed by (enforcement config,
// schema bundles, rubric, role prompts, CI workflow). Two properties are pinned
// here: a fresh repo gets a complete setup, asserted file-by-file; and a re-run
// never silently overwrites — identical files stay `unchanged`, a real conflict
// is routed through the injected `confirmOverwrite` (design phase-2.md §7).

const ANSWERS: InitAnswers = {
  adapter: 'stub',
  runners: ['stub'],
  paths: ['**/*.ts'],
  unitCommand: 'npm test',
};

const FRAMEWORK_PIN: FrameworkPin = {
  version: 1,
  repository: 'vivardhandevaki/crucible-v2',
  commit: 'a'.repeat(40),
};

/** A confirm edge that must never be consulted (asserts the no-conflict path). */
const confirmNever: ConfirmOverwrite = () => {
  throw new Error('confirmOverwrite must not be called when there is no conflict');
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crucible-init-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function kindOf(report: InitReport, relpath: string): string | undefined {
  return report.actions.find((a) => a.relpath === relpath)?.kind;
}

function read(relpath: string): string {
  return readFileSync(join(scratch, relpath), 'utf8');
}

describe('init — fresh repo → complete working setup', () => {
  it('installs every surface, all created, without ever consulting confirm', async () => {
    const report = await init(
      { root: scratch, answers: ANSWERS },
      { confirmOverwrite: confirmNever },
    );

    // Enforcement config, rendered from the answers.
    expect(existsSync(join(scratch, 'crucible.yaml'))).toBe(true);
    const cy = read('crucible.yaml');
    expect(cy).toContain('stub: { runners: ["stub"], paths: ["**/*.ts"] }');
    expect(cy).toContain('unit: "npm test"');
    expect(cy).toContain('require_local_verify: true');
    expect(cy).toContain('"crucible.yaml"'); // the self-governing risk glob
    for (const glob of ['AGENTS.md', 'CLAUDE.md', '.agents/**', '.codex/**', '.claude/**']) {
      expect(cy).toContain(`"${glob}"`);
    }
    expect(read(join('.crucible', 'settings.yaml'))).toContain('provider: codex');

    // Convenience + rubric + role prompts (the .crucible TCB).
    expect(read(join('.crucible', 'settings.yaml'))).toContain('models:');
    expect(read(join('.crucible', 'rubric.yaml'))).toContain('R-001');
    for (const role of ['propose', 'implement', 'review']) {
      expect(read(join('.crucible', 'context', `${role}.md`))).toContain('# Role:');
    }

    // Schema bundles, copied verbatim from @crucible/schemas.
    for (const name of SCHEMA_BUNDLE_NAMES) {
      expect(existsSync(join(scratch, 'openspec', 'schemas', name, 'schema.yaml'))).toBe(true);
    }
    expect(read(join('openspec', 'config.yaml'))).toContain('schema: crucible');

    // The CI workflow, byte-identical to the shipped template.
    expect(read(join('.github', 'workflows', 'crucible.yml'))).toBe(
      readFileSync(CI_TEMPLATE_PATH, 'utf8'),
    );

    expect(read(join('.github', 'workflows', 'crucible-review.yml'))).toBe(
      readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8'),
    );

    // AGENTS.md is canonical; CLAUDE.md is a compatibility bridge.
    for (const file of MANAGED_BLOCK_FILES) expect(read(file)).toContain('crucible:managed');
    expect(read('AGENTS.md')).toContain('crucible propose');
    expect(read('CLAUDE.md')).toContain('Read and follow AGENTS.md');
    expect(read('CLAUDE.md')).not.toContain('crucible propose');

    // gitignore entries.
    const gi = read('.gitignore');
    for (const line of GITIGNORE_LINES) expect(gi).toContain(line);

    // Every action is a create on a fresh repo.
    expect(report.actions.every((a) => a.kind === 'created')).toBe(true);
    expect(kindOf(report, 'crucible.yaml')).toBe('created');
  });
});

describe('init — validation framework pin', () => {
  it('writes a strict repository+commit pin when a validation bootstrap is requested', async () => {
    await init(
      { root: scratch, answers: ANSWERS, frameworkPin: FRAMEWORK_PIN },
      { confirmOverwrite: confirmNever },
    );

    expect(loadFrameworkPin(join(scratch, FRAMEWORK_PIN_RELPATH))).toEqual(FRAMEWORK_PIN);
  });
});

describe('init — managed interactive skills (P4-08/P4-10)', () => {
  it('installs equivalent validated skills and a local pinned launcher without touching human instructions', async () => {
    writeFileSync(join(scratch, 'AGENTS.md'), '# Human-owned instructions\n', 'utf8');
    await init(
      { root: scratch, answers: ANSWERS, frameworkPin: FRAMEWORK_PIN },
      { confirmOverwrite: () => true },
    );

    for (const name of MANAGED_SKILL_NAMES) {
      for (const root of ['.agents', '.claude']) {
        const skill = read(join(root, 'skills', name, 'SKILL.md'));
        expect(skill).toContain(`name: ${name}`);
        expect(skill).toContain('node .crucible/bin/crucible.mjs');
        expect(skill).not.toContain('codex exec');
        expect(skill).not.toContain('claude -p');
      }
    }
    const launcher = read(join('.crucible', 'bin', 'crucible.mjs'));
    expect(launcher).toContain(FRAMEWORK_PIN.commit);
    // init.ts runs from both core/src and core/dist; the generated launcher must
    // point at the repository's one core/dist tree, never core/core/dist.
    expect(launcher).not.toContain('/core/core/dist/cli/bin.js');
    expect(read('AGENTS.md')).toContain('# Human-owned instructions');
  });
});

describe('init — idempotent re-run (diff-and-confirm, no silent overwrite)', () => {
  it('a second run changes nothing and never asks to overwrite', async () => {
    await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirmNever });
    const before = read('crucible.yaml');

    const report = await init(
      { root: scratch, answers: ANSWERS },
      { confirmOverwrite: confirmNever },
    );

    expect(report.actions.every((a) => a.kind === 'unchanged')).toBe(true);
    expect(read('crucible.yaml')).toBe(before); // byte-stable
  });

  it('a conflicting existing file is skipped when confirm says no — no silent overwrite', async () => {
    await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirmNever });
    writeFileSync(join(scratch, 'crucible.yaml'), '# hand-edited\n', 'utf8');
    const confirm = vi.fn<ConfirmOverwrite>(() => false);

    const report = await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirm });

    expect(confirm).toHaveBeenCalledWith('crucible.yaml', expect.any(String), expect.any(String));
    expect(kindOf(report, 'crucible.yaml')).toBe('skipped');
    expect(read('crucible.yaml')).toBe('# hand-edited\n'); // untouched
  });

  it('a conflicting existing file is replaced only when confirm says yes', async () => {
    await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirmNever });
    writeFileSync(join(scratch, 'crucible.yaml'), '# hand-edited\n', 'utf8');

    const report = await init(
      { root: scratch, answers: ANSWERS },
      { confirmOverwrite: () => true },
    );

    expect(kindOf(report, 'crucible.yaml')).toBe('updated');
    expect(read('crucible.yaml')).toContain('require_local_verify: true');
  });
});

describe('init — additive surfaces (gitignore, managed block)', () => {
  it('gitignore preserves existing lines and appends only the missing ones', async () => {
    writeFileSync(join(scratch, '.gitignore'), 'node_modules/\n.crucible/local.yaml\n', 'utf8');

    await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: () => true });

    const gi = read('.gitignore');
    expect(gi).toContain('node_modules/'); // pre-existing, preserved
    expect(gi).toContain('.crucible/transcripts/'); // newly appended
    expect(gi).toContain('.crucible/verdicts/');
    // The already-present line is not duplicated.
    expect(gi.split('\n').filter((l) => l.trim() === '.crucible/local.yaml')).toHaveLength(1);
  });

  it('an existing human CLAUDE.md gets the block appended (confirmed), preserving its content', async () => {
    writeFileSync(join(scratch, 'CLAUDE.md'), '# My project notes\n', 'utf8');
    const confirm = vi.fn<ConfirmOverwrite>(() => true);

    const report = await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirm });

    expect(kindOf(report, 'CLAUDE.md')).toBe('updated');
    const claude = read('CLAUDE.md');
    expect(claude).toContain('# My project notes'); // human content survives
    expect(claude).toContain('Read and follow AGENTS.md');
    expect(claude).toContain('crucible:managed');
  });

  it('re-running leaves an already-installed managed block unchanged', async () => {
    await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirmNever });
    const report = await init(
      { root: scratch, answers: ANSWERS },
      { confirmOverwrite: confirmNever },
    );
    expect(kindOf(report, 'CLAUDE.md')).toBe('unchanged');
  });
});

describe('init — adapter detection (CLI edge)', () => {
  it('a Maven tree → java-junit + mvn test', () => {
    writeFileSync(join(scratch, 'pom.xml'), '<project/>\n', 'utf8');
    expect(detectAnswers(scratch)).toEqual({
      adapter: 'java-junit',
      runners: ['junit'],
      paths: ['**/*.java'],
      unitCommand: 'mvn test',
    });
  });

  it('a Gradle tree → java-junit + gradle test', () => {
    writeFileSync(join(scratch, 'build.gradle.kts'), '\n', 'utf8');
    expect(detectAnswers(scratch).unitCommand).toBe('gradle test');
  });

  it('an unrecognized tree fails instead of installing the conformance-only stub', () => {
    try {
      detectAnswers(scratch);
    } catch (error) {
      expect(isCrucibleError(error)).toBe(true);
      if (isCrucibleError(error)) {
        expect(error.exit).toBe(2);
        expect(error.code).toBe('NO_ADAPTER_DETECTED');
      }
      return;
    }
    throw new Error('expected an unrecognized tree to fail adapter detection');
  });
});

describe('init — JVM harness assets (P3-07)', () => {
  it('installs the java-junit CI variant for a JVM project', async () => {
    const javaAnswers: InitAnswers = {
      adapter: 'java-junit',
      runners: ['junit'],
      paths: ['**/*.java'],
      unitCommand: 'mvn test',
    };

    await init({ root: scratch, answers: javaAnswers }, { confirmOverwrite: confirmNever });

    expect(read(join('.github', 'workflows', 'crucible.yml'))).toBe(
      readFileSync(JAVA_JUNIT_CI_TEMPLATE_PATH, 'utf8'),
    );
  });

  it('installs a propose prompt that teaches resolvable JUnit oracle targets', async () => {
    await init({ root: scratch, answers: ANSWERS }, { confirmOverwrite: confirmNever });
    const prompt = read(join('.crucible', 'context', 'propose.md'));

    expect(prompt).toContain('com.acme.auth.LockoutTest#fifthFailureLocks');
    expect(prompt).toContain('plain `@Test`');
    expect(prompt).toContain('ParameterizedTest');
    expect(prompt).toContain('one assertion theme');
    expect(prompt).toContain('runner: junit');
  });
});
