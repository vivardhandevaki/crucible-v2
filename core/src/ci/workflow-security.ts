import { parse as parseYaml } from 'yaml';

export interface WorkflowSecurityViolation {
  code:
    | 'malformed-workflow'
    | 'candidate-checkout'
    | 'indirect-candidate-load'
    | 'candidate-artifact-reuse'
    | 'candidate-execution'
    | 'candidate-action-execution';
  job: string;
  step: number;
  message: string;
}

export interface WorkflowSecurityReport {
  supported: boolean;
  privileged_candidate_execution: boolean;
  violations: WorkflowSecurityViolation[];
}

interface WorkflowStep {
  uses?: unknown;
  run?: unknown;
  with?: unknown;
  'working-directory'?: unknown;
}

/**
 * Inspect privileged GitHub workflow shapes without executing them. The rule is
 * deliberately conservative: once candidate-controlled material enters a
 * pull_request_target job, shell or local-action execution is unsupported.
 */
export function inspectWorkflowSecurity(text: string, source: string): WorkflowSecurityReport {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    return unsupported([
      {
        code: 'malformed-workflow',
        job: '(workflow)',
        step: 0,
        message: `${source}: malformed workflow YAML — ${messageOf(cause)}`,
      },
    ]);
  }
  if (!isRecord(raw)) {
    return unsupported([
      {
        code: 'malformed-workflow',
        job: '(workflow)',
        step: 0,
        message: `${source}: workflow root must be a mapping`,
      },
    ]);
  }
  if (!workflowEvents(raw.on).includes('pull_request_target')) {
    return { supported: true, privileged_candidate_execution: false, violations: [] };
  }
  if (!isRecord(raw.jobs)) {
    return unsupported([
      {
        code: 'malformed-workflow',
        job: '(workflow)',
        step: 0,
        message: `${source}: privileged workflow has no jobs mapping`,
      },
    ]);
  }

  const violations: WorkflowSecurityViolation[] = [];
  for (const [jobName, job] of Object.entries(raw.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    let candidateMaterial = false;
    for (const [index, rawStep] of job.steps.entries()) {
      if (!isRecord(rawStep)) continue;
      const step = rawStep as WorkflowStep;
      const uses = typeof step.uses === 'string' ? step.uses : '';
      const run = typeof step.run === 'string' ? step.run : '';
      const withText = stringify(step.with);
      const location = index + 1;

      if (uses.startsWith('actions/checkout@') && candidateReference(`${withText}\n${run}`)) {
        candidateMaterial = true;
        violations.push({
          code: 'candidate-checkout',
          job: jobName,
          step: location,
          message: 'pull_request_target checks out a candidate head/merge repository or ref',
        });
        continue;
      }

      if (isArtifactDownload(uses)) {
        candidateMaterial = true;
        violations.push({
          code: 'candidate-artifact-reuse',
          job: jobName,
          step: location,
          message: 'pull_request_target downloads an artifact that may contain candidate bytes',
        });
        continue;
      }

      if (run && indirectCandidateLoad(run)) {
        candidateMaterial = true;
        violations.push({
          code: 'indirect-candidate-load',
          job: jobName,
          step: location,
          message: 'privileged shell step fetches or loads candidate-controlled code or scripts',
        });
        continue;
      }

      if (candidateMaterial && run) {
        violations.push({
          code: 'candidate-execution',
          job: jobName,
          step: location,
          message: 'privileged shell step executes after candidate-controlled material was loaded',
        });
      } else if (candidateMaterial && uses.startsWith('./')) {
        violations.push({
          code: 'candidate-action-execution',
          job: jobName,
          step: location,
          message:
            'privileged job executes a local action after candidate-controlled material was loaded',
        });
      } else if (candidateReference(`${uses}\n${withText}\n${run}`)) {
        violations.push({
          code: 'indirect-candidate-load',
          job: jobName,
          step: location,
          message: 'privileged step consumes a candidate-controlled repository, ref, or payload',
        });
      }
    }
  }

  return violations.length === 0
    ? { supported: true, privileged_candidate_execution: false, violations: [] }
    : unsupported(violations);
}

function workflowEvents(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return isRecord(value) ? Object.keys(value) : [];
}

function candidateReference(value: string): boolean {
  return /pull_request\.(?:head|number)|refs\/pull\/|\/merge\b|head\.repo|head\.sha/i.test(value);
}

function indirectCandidateLoad(command: string): boolean {
  return (
    /\bgh\s+pr\s+checkout\b/i.test(command) ||
    /\bgit\s+(?:fetch|checkout|clone)\b[\s\S]*(?:refs\/pull\/|pull_request\.|head\.sha|head\.repo)/i.test(
      command,
    ) ||
    /\b(?:curl|wget|source|bash|sh)\b[\s\S]*(?:pull_request\.|head\.sha|head\.repo|refs\/pull\/)/i.test(
      command,
    ) ||
    /(?:pull_request\.|head\.sha|head\.repo|refs\/pull\/)[\s\S]*\|\s*(?:bash|sh)\b/i.test(command)
  );
}

function isArtifactDownload(uses: string): boolean {
  return /(?:^|\/)download-artifact@/i.test(uses) || /action-download-artifact@/i.test(uses);
}

function unsupported(violations: WorkflowSecurityViolation[]): WorkflowSecurityReport {
  return { supported: false, privileged_candidate_execution: true, violations };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
