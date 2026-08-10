// Managed, portable skill surfaces. They teach procedure only; the pinned CLI
// remains the sole authority for artifacts, seals, preconditions, and verdicts.

import { join } from 'node:path';
import type { FrameworkPin } from '../framework/pin.js';
import { invalidInputError } from '../util/errors.js';

export const MANAGED_SKILL_NAMES = [
  'crucible',
  'propose',
  'approve',
  'implement',
  'verify',
  'review',
  'amend',
  'escalate',
  'override',
  'archive',
  'status',
  'why',
] as const;

export type ManagedSkillName = (typeof MANAGED_SKILL_NAMES)[number];

export function renderManagedSkill(name: ManagedSkillName): string {
  const launcher = 'node .crucible/bin/crucible.mjs';
  const procedure =
    name === 'crucible'
      ? [
          `Run \`${launcher} --json session status <change>\` before recommending an action.`,
          'Display only actions returned by the CLI; conversation history and checkpoints have no authority.',
        ]
      : name === 'propose'
        ? [
            `Run \`${launcher} --json session propose start <change> "<intent>" --type <type>\`.`,
            'Write only returned instruction paths, then run the returned next command. Use session revise before approval.',
            'Never invoke an OpenSpec skill or executable directly; this pinned CLI owns the packaged runtime.',
          ]
        : name === 'implement'
          ? [
              `Run \`${launcher} --json session implement start <change>\`.`,
              'Write tasks first, run tasks-ready, then implement only from the returned handoff. Never edit sealed files.',
            ]
          : name === 'review'
            ? [
                'Use this skill only from a fresh Codex conversation that did not author the implementation.',
                'Run ' +
                  launcher +
                  ' --json session review start <change>, read the returned work order, and write only its caller-minted verdict file.',
                'Run the returned session review finish command and stop on red. Never invoke a Codex child process, another child agent, or a headless review command.',
              ]
            : name === 'amend'
              ? [
                  'Run ' + launcher + ' --json session amend start <change> "<resolution>".',
                  'Write only returned artifact or bound-test paths, then run the returned next command until finish is green.',
                  'Stop for the human-only session amend seal command. Never invoke a child agent, a headless amend command, or a sandbox fallback.',
                ]
              : [
                  'Run ' + launcher + ' ' + name + ' <change> and stop on its exit status.',
                  'This guided wrapper cannot bypass preconditions, validation, approval hashes, or target-branch CI.',
                ];
  return [
    '---',
    `name: ${name}`,
    `description: Crucible ${name} workflow helper; delegates all decisions to the pinned project CLI.`,
    '---',
    '',
    '# Crucible',
    '',
    ...procedure,
    '',
  ].join('\n');
}

export function validateManagedSkill(content: string, expectedName: ManagedSkillName): void {
  const match = /^---\nname: ([a-z][a-z0-9-]*)\ndescription: (.+)\n---\n/.exec(content);
  if (match === null || match[1] !== expectedName || (match[2]?.trim().length ?? 0) === 0) {
    throw invalidInputError(
      'INVALID_SKILL_METADATA',
      `Managed skill ${expectedName} has invalid portable metadata.`,
      'Restore the shipped skill assets and re-run `crucible init`.',
    );
  }
  if (!content.includes('node .crucible/bin/crucible.mjs')) {
    throw invalidInputError(
      'INVALID_SKILL_METADATA',
      `Managed skill ${expectedName} does not delegate to the pinned project launcher.`,
      'Restore the shipped skill assets and re-run `crucible init`.',
    );
  }
}

export function renderPinnedLauncher(pin: FrameworkPin, frameworkRoot: string): string {
  const cliPath = join(frameworkRoot, 'core', 'dist', 'cli', 'bin.js');
  return `#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const expected = ${JSON.stringify(pin)};
const frameworkRoot = ${JSON.stringify(frameworkRoot)};
const cliPath = ${JSON.stringify(cliPath)};
const recover = 'Re-run crucible init from the pinned Crucible checkout.';
const fail = (exit, message) => { process.stderr.write('error: ' + message + '\\nhint: ' + recover + '\\n'); process.exit(exit); };
let projectPin;
try { projectPin = JSON.parse(readFileSync('.crucible/framework.lock.json', 'utf8')); } catch { fail(2, 'Missing or unreadable .crucible/framework.lock.json.'); }
if (!projectPin || projectPin.version !== 1 || projectPin.repository !== expected.repository || projectPin.commit !== expected.commit) fail(3, 'Framework pin is malformed or mismatched.');
let remote = ''; let head = '';
try { remote = execFileSync('git', ['-C', frameworkRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(); head = execFileSync('git', ['-C', frameworkRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { fail(2, 'Pinned Crucible checkout is unavailable.'); }
const match = /github\\.com[:/]([A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+?)(?:\\.git)?$/.exec(remote);
if (!match || match[1] !== expected.repository || head !== expected.commit) fail(3, 'Pinned Crucible checkout repository or HEAD does not match framework.lock.json.');
if (!existsSync(cliPath)) fail(2, 'Pinned Crucible CLI build is missing.');
const child = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = child.status ?? 4;
`;
}
