import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_REVIEW_TEMPLATE_PATH, renderCiTemplateForAdapter } from '@crucible/ci-templates';
import { TOY_REPO_ROOT } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealBundle, serializeApproval } from '../artifacts/approval.js';
import { loadEnforcementConfig } from '../config/enforcement.js';
import { FRAMEWORK_PIN_RELPATH } from '../framework/pin.js';
import { classifyCiAuthority } from './ci-authority.js';

const CHANGE = 'add-greeting';
const CHANGE_REL = join('openspec', 'changes', CHANGE);
const PIN_A = '1111111111111111111111111111111111111111';
const PIN_B = '2222222222222222222222222222222222222222';
let base: string;
let head: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'crucible-ci-authority-base-'));
  head = mkdtempSync(join(tmpdir(), 'crucible-ci-authority-head-'));
  cpSync(TOY_REPO_ROOT, base, { recursive: true });
  cpSync(TOY_REPO_ROOT, head, { recursive: true });
  writePin(base, PIN_A);
  writePin(head, PIN_A);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(head, { recursive: true, force: true });
});

describe('classifyCiAuthority — fail-closed PR authority lanes (P4-25)', () => {
  it('accepts a sealed governed bundle and returns its active change', () => {
    writeApproval(head);

    expect(classify()).toEqual({ lane: 'governed', changes: [CHANGE] });
  });

  it('rejects a governed bundle without its committed approval seal', () => {
    expect(() => classify()).toThrow(/approval/i);
  });

  it('accepts a framework-pin bootstrap only with congruent managed workflows', () => {
    writePin(head, PIN_B);
    writeManagedWorkflows(head);

    expect(
      classify([
        FRAMEWORK_PIN_RELPATH,
        '.github/workflows/crucible.yml',
        '.github/workflows/crucible-review.yml',
      ]),
    ).toEqual({ lane: 'framework-bootstrap', changes: [] });
  });

  it('rejects a framework bootstrap when a managed workflow is absent or drifted', () => {
    writePin(head, PIN_B);

    expect(() => classify([FRAMEWORK_PIN_RELPATH])).toThrow(/workflow/i);
  });

  it('rejects direct product edits and mixed bootstrap/governed changes', () => {
    writeApproval(head);

    expect(() => classify(['src/greeting.ts'])).toThrow(/classified/i);
    expect(() => classify([join(CHANGE_REL, 'design.md'), FRAMEWORK_PIN_RELPATH])).toThrow(
      /mixed/i,
    );
  });

  it('rejects unsafe path spellings and duplicate changed paths', () => {
    expect(() => classify(['../src/greeting.ts'])).toThrow(/path/i);
    expect(() => classify(['src/greeting.ts', 'src/greeting.ts'])).toThrow(/duplicate/i);
  });
});

function classify(
  changedPaths: readonly string[] = [join(CHANGE_REL, 'design.md')],
): ReturnType<typeof classifyCiAuthority> {
  return classifyCiAuthority({
    baseRoot: base,
    headRoot: head,
    config: loadEnforcementConfig(base),
    changedPaths,
  });
}

function writePin(root: string, commit: string): void {
  const path = join(root, FRAMEWORK_PIN_RELPATH);
  mkdirSync(join(root, '.crucible'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, repository: 'owner/framework', commit }) + '\n');
}

function writeManagedWorkflows(root: string): void {
  const workflowDir = join(root, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, 'crucible.yml'), renderCiTemplateForAdapter('stub', 'required'));
  writeFileSync(
    join(workflowDir, 'crucible-review.yml'),
    readFileSync(CI_REVIEW_TEMPLATE_PATH, 'utf8'),
  );
}

function writeApproval(root: string): void {
  const files = [
    join(CHANGE_REL, 'design.md'),
    join(CHANGE_REL, 'oracles.md'),
    join(CHANGE_REL, 'proposal.md'),
    join(CHANGE_REL, 'specs', 'greeting', 'spec.md'),
  ];
  const approval = sealBundle(root, files, {
    version: 1,
    change: CHANGE,
    approved_by: 'ada@example.com',
    approved_at: '2026-08-15T00:00:00Z',
  });
  writeFileSync(join(root, CHANGE_REL, 'approval.yaml'), serializeApproval(approval), 'utf8');
}
