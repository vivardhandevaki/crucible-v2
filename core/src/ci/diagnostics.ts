import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CI_TEMPLATE_PATH, REQUIRED_CI_TEMPLATE_PATH } from '@crucible/ci-templates';
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const event = z.enum(['pull_request', 'merge_group', 'pull_request_target']);
const events = z.array(event).superRefine((value, context) => {
  if (new Set(value).size !== value.length) {
    context.addIssue({ code: 'custom', message: 'events must be unique' });
  }
});

const requiredWorkflow = z.strictObject({
  kind: z.literal('required_workflow'),
  ruleset_source: z.enum(['organization', 'enterprise', 'repository']),
  enforcement: z.enum(['active', 'evaluate', 'disabled']),
  bypass_actors: z.number().int().nonnegative(),
  target_repository_id: z.number().int().positive(),
  source_repository_id: z.number().int().positive(),
  workflow_path: z.string().min(1),
  workflow_ref: z.string().min(1),
  workflow_sha: sha,
  workflow_content_sha256: sha256,
  events,
  check_name: z.string().min(1),
});

const repositoryLocal = z.strictObject({
  kind: z.literal('repository_local'),
  workflow_path: z.string().min(1),
  workflow_content_sha256: sha256,
  events,
  latest_check: z.enum(['success', 'failure', 'cancelled', 'missing', 'unknown']),
});

const githubApp = z.strictObject({
  kind: z.literal('github_app'),
  app_id: z.number().int().positive(),
  expected_source: z.boolean(),
  base_candidate_binding: z.boolean(),
  least_privilege: z.boolean(),
});

const installation = z.discriminatedUnion('kind', [
  requiredWorkflow,
  repositoryLocal,
  githubApp,
  z.strictObject({ kind: z.literal('absent') }),
]);

const observationSchema = z.strictObject({
  version: z.literal(1),
  access: z.enum(['ok', 'inaccessible']),
  repository: z.string().min(1),
  target_branch: z.string().min(1),
  target_sha: sha,
  observed_sha: sha,
  installation,
});

export type CiProtectionObservation = z.infer<typeof observationSchema>;
export type CiProtectionGrade = 'enforcement-grade' | 'advisory' | 'none';
export type CiProtectionState =
  | 'valid'
  | 'advisory'
  | 'absent'
  | 'inaccessible'
  | 'partial'
  | 'stale'
  | 'spoofable'
  | 'malformed'
  | 'unsupported';

export interface CiCapabilityResult {
  capability: string;
  status: 'pass' | 'fail' | 'advisory';
  evidence: string;
  remediation: string;
}

export interface CiProtectionReport {
  version: 1;
  grade: CiProtectionGrade;
  state: CiProtectionState;
  repository: string | null;
  target_branch: string | null;
  target_sha: string | null;
  capabilities: CiCapabilityResult[];
}

export function expectedCiTemplateHashes(): { required: string; advisory: string } {
  return {
    required: hashFile(REQUIRED_CI_TEMPLATE_PATH),
    advisory: hashFile(CI_TEMPLATE_PATH),
  };
}

/** Deterministic diagnostic: identical observations and shipped bytes produce identical output. */
export function diagnoseCiProtection(input: unknown): CiProtectionReport {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return report('none', 'malformed', null, null, null, [
      capability(
        'observation',
        'fail',
        `Malformed CI observation at ${issue?.path.join('.') || '(root)'}: ${(issue?.message || 'invalid input').replace('received undefined', 'value is missing')}.`,
        'Collect a fresh strict CI observation; do not infer protection from a check name.',
      ),
    ]);
  }
  const observation = parsed.data;
  const common = {
    repository: observation.repository,
    targetBranch: observation.target_branch,
    targetSha: observation.target_sha,
  };

  if (observation.access === 'inaccessible') {
    return report(
      'none',
      'inaccessible',
      common.repository,
      common.targetBranch,
      common.targetSha,
      [
        capability(
          'observation',
          'fail',
          'Remote rules and expected-source evidence were inaccessible.',
          'Grant read access to active ruleset evidence and collect a fresh observation.',
        ),
      ],
    );
  }
  if (observation.observed_sha !== observation.target_sha) {
    return report('none', 'stale', common.repository, common.targetBranch, common.targetSha, [
      capability(
        'freshness',
        'fail',
        `Observed target ${observation.observed_sha} does not match expected ${observation.target_sha}.`,
        'Refresh the target branch and collect protection evidence again.',
      ),
    ]);
  }

  switch (observation.installation.kind) {
    case 'absent':
      return report('none', 'absent', common.repository, common.targetBranch, common.targetSha, [
        capability(
          'installation',
          'fail',
          'No Crucible CI protection was observed.',
          'Install the advisory workflow or an organization ruleset-required workflow.',
        ),
      ]);
    case 'github_app':
      return report(
        'none',
        'unsupported',
        common.repository,
        common.targetBranch,
        common.targetSha,
        [
          capability(
            'check-source',
            'fail',
            `GitHub App ${observation.installation.app_id} is not a ratified Phase 4R transport.`,
            'Use the organization required workflow or the explicitly advisory local workflow.',
          ),
        ],
      );
    case 'repository_local':
      return diagnoseLocal(observation.installation, common);
    case 'required_workflow':
      return diagnoseRequired(observation.installation, common);
  }
}

function diagnoseLocal(
  install: z.infer<typeof repositoryLocal>,
  common: { repository: string; targetBranch: string; targetSha: string },
): CiProtectionReport {
  const expected = expectedCiTemplateHashes().advisory;
  const exact =
    install.workflow_path === '.github/workflows/crucible.yml' &&
    install.workflow_content_sha256 === expected &&
    hasExactEvents(install.events);
  const capabilities = [
    capability(
      'source',
      'advisory',
      'Repository-local workflow bytes are candidate-controlled; a green check cannot grant merge authority.',
      'Use an organization/enterprise required workflow for enforcement-grade protection.',
    ),
    capability(
      'workflow',
      exact ? 'pass' : 'fail',
      exact
        ? 'The installed advisory workflow matches the shipped path, bytes, and events.'
        : 'The local advisory workflow is absent, modified, or missing a required event.',
      'Run `crucible doctor --yes` to restore the shipped advisory workflow.',
    ),
    capability(
      'latest-check',
      'advisory',
      `Latest local check: ${install.latest_check}; this does not change the protection grade.`,
      'Treat this result only as developer feedback.',
    ),
  ];
  return report(
    exact ? 'advisory' : 'none',
    exact ? 'valid' : 'partial',
    common.repository,
    common.targetBranch,
    common.targetSha,
    capabilities,
  );
}

function diagnoseRequired(
  install: z.infer<typeof requiredWorkflow>,
  common: { repository: string; targetBranch: string; targetSha: string },
): CiProtectionReport {
  const source =
    (install.ruleset_source === 'organization' || install.ruleset_source === 'enterprise') &&
    install.source_repository_id !== install.target_repository_id;
  const ruleset = install.enforcement === 'active' && install.bypass_actors === 0;
  const workflow =
    install.workflow_path === '.github/workflows/crucible-required.yml' &&
    /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(install.workflow_ref) &&
    install.workflow_content_sha256 === expectedCiTemplateHashes().required;
  const eventSet = hasExactEvents(install.events);
  const check = install.check_name === 'Crucible deterministic verify';
  const capabilities = [
    capability(
      'source',
      source ? 'pass' : 'fail',
      source
        ? `Required workflow source repository ${install.source_repository_id} is separate from target ${install.target_repository_id}.`
        : 'Required workflow source is repository-controlled or not separate from the target.',
      'Select the workflow from a separately trusted repository in an organization/enterprise ruleset.',
    ),
    capability(
      'ruleset',
      ruleset ? 'pass' : 'fail',
      ruleset
        ? 'Ruleset is active with no configured bypass actors.'
        : `Ruleset enforcement is ${install.enforcement} with ${install.bypass_actors} bypass actor(s).`,
      'Activate the ruleset and remove bypasses from this required verification rule.',
    ),
    capability(
      'workflow-pin',
      workflow ? 'pass' : 'fail',
      workflow
        ? `Workflow ${install.workflow_path} is pinned at ${install.workflow_sha}.`
        : 'Workflow path, ref, immutable SHA, or shipped content does not match.',
      'Pin the exact shipped required workflow path and content from the trusted repository.',
    ),
    capability(
      'events',
      eventSet ? 'pass' : 'fail',
      eventSet
        ? 'Required workflow covers pull_request and merge_group only.'
        : `Observed events: ${[...install.events].sort().join(', ') || '(none)'}.`,
      'Configure pull_request and merge_group, and remove pull_request_target candidate execution.',
    ),
    capability(
      'check-source',
      check ? 'pass' : 'fail',
      check
        ? `Expected check is ${install.check_name}.`
        : `Unexpected check ${install.check_name}.`,
      'Require the stable Crucible deterministic verify job from the selected workflow source.',
    ),
  ];

  if (install.events.includes('pull_request_target')) {
    return report(
      'none',
      'unsupported',
      common.repository,
      common.targetBranch,
      common.targetSha,
      capabilities,
    );
  }
  if (!source) {
    return report(
      'none',
      'spoofable',
      common.repository,
      common.targetBranch,
      common.targetSha,
      capabilities,
    );
  }
  const valid = ruleset && workflow && eventSet && check;
  return report(
    valid ? 'enforcement-grade' : 'none',
    valid ? 'valid' : 'partial',
    common.repository,
    common.targetBranch,
    common.targetSha,
    capabilities,
  );
}

function hasExactEvents(value: readonly string[]): boolean {
  return value.length === 2 && value.includes('pull_request') && value.includes('merge_group');
}

function capability(
  name: string,
  status: CiCapabilityResult['status'],
  evidence: string,
  remediation: string,
): CiCapabilityResult {
  return { capability: name, status, evidence, remediation };
}

function report(
  grade: CiProtectionGrade,
  state: CiProtectionState,
  repository: string | null,
  targetBranch: string | null,
  targetSha: string | null,
  capabilities: CiCapabilityResult[],
): CiProtectionReport {
  return {
    version: 1,
    grade,
    state,
    repository,
    target_branch: targetBranch,
    target_sha: targetSha,
    capabilities,
  };
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
