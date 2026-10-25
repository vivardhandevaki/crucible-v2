import { describe, expect, it } from 'vitest';
import {
  diagnoseCiProtection,
  expectedCiTemplateHashes,
  type CiProtectionObservation,
} from './diagnostics.js';

const SHA = '1'.repeat(40);
const WORKFLOW_SHA = '2'.repeat(40);
const hashes = expectedCiTemplateHashes();

function required(overrides: Partial<CiProtectionObservation> = {}): CiProtectionObservation {
  return {
    version: 1,
    access: 'ok',
    repository: 'acme/widget',
    target_branch: 'main',
    target_sha: SHA,
    observed_sha: SHA,
    installation: {
      kind: 'required_workflow',
      ruleset_source: 'organization',
      enforcement: 'active',
      bypass_actors: 0,
      target_repository_id: 10,
      source_repository_id: 20,
      workflow_path: '.github/workflows/crucible-required.yml',
      workflow_ref: 'refs/heads/main',
      workflow_sha: WORKFLOW_SHA,
      workflow_content_sha256: hashes.required,
      events: ['merge_group', 'pull_request'],
      check_name: 'Crucible deterministic verify',
    },
    ...overrides,
  };
}

describe('P4R-10D doctor --ci protection grades', () => {
  it('reports a complete expected-source organization workflow as enforcement-grade', () => {
    const report = diagnoseCiProtection(required());
    expect(report.grade).toBe('enforcement-grade');
    expect(report.state).toBe('valid');
    expect(report.capabilities.every((item) => item.status === 'pass')).toBe(true);
  });

  it('reports an exact repository-local workflow as advisory even when green', () => {
    const report = diagnoseCiProtection({
      ...required(),
      installation: {
        kind: 'repository_local',
        workflow_path: '.github/workflows/crucible.yml',
        workflow_content_sha256: hashes.advisory,
        events: ['merge_group', 'pull_request'],
        latest_check: 'success',
      },
    });
    expect(report.grade).toBe('advisory');
    expect(report.state).toBe('valid');
    expect(JSON.stringify(report)).toContain('candidate-controlled');
  });

  it('distinguishes absent and inaccessible protection', () => {
    const absent = diagnoseCiProtection({ ...required(), installation: { kind: 'absent' } });
    const inaccessible = diagnoseCiProtection({
      ...required(),
      access: 'inaccessible',
      installation: { kind: 'absent' },
    });
    expect(absent).toMatchObject({ grade: 'none', state: 'absent' });
    expect(inaccessible).toMatchObject({ grade: 'none', state: 'inaccessible' });
  });

  it('distinguishes stale, spoofable, and partial required-workflow states', () => {
    const stale = diagnoseCiProtection(required({ observed_sha: '3'.repeat(40) }));
    const spoofable = diagnoseCiProtection({
      ...required(),
      installation: {
        ...(required().installation as Extract<
          CiProtectionObservation['installation'],
          { kind: 'required_workflow' }
        >),
        ruleset_source: 'repository',
        source_repository_id: 10,
      },
    });
    const partial = diagnoseCiProtection({
      ...required(),
      installation: {
        ...(required().installation as Extract<
          CiProtectionObservation['installation'],
          { kind: 'required_workflow' }
        >),
        events: ['pull_request'],
      },
    });
    expect(stale).toMatchObject({ grade: 'none', state: 'stale' });
    expect(spoofable).toMatchObject({ grade: 'none', state: 'spoofable' });
    expect(partial).toMatchObject({ grade: 'none', state: 'partial' });
  });

  it('reports malformed observations rather than upgrading by assumption', () => {
    const report = diagnoseCiProtection({
      version: 1,
      access: 'ok',
      repository: 'acme/widget',
      surprise: true,
    });
    expect(report).toMatchObject({ version: 1, grade: 'none', state: 'malformed' });
    expect(report.capabilities[0]?.evidence).not.toContain('undefined');
  });

  it('reports the unselected GitHub App path as unsupported', () => {
    const report = diagnoseCiProtection({
      ...required(),
      installation: {
        kind: 'github_app',
        app_id: 123,
        expected_source: true,
        base_candidate_binding: true,
        least_privilege: true,
      },
    });
    expect(report).toMatchObject({ grade: 'none', state: 'unsupported' });
  });

  it('produces byte-stable machine output for identical observations', () => {
    expect(JSON.stringify(diagnoseCiProtection(required()))).toBe(
      JSON.stringify(diagnoseCiProtection(required())),
    );
  });
});
