/**
 * P4R-02's single source of truth for agent-facing workflow guidance.  These
 * files steer an agent already running in the user's tool; they deliberately
 * contain no provider launch syntax and carry no authority themselves.
 */
export const WORKFLOW_NAMES = [
  'crucible-propose',
  'crucible-implement',
  'crucible-verify',
  'crucible-amend',
  'crucible-archive',
  'crucible-submit',
  'crucible-status',
] as const;

export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

export interface RenderedWorkflow {
  codex: Record<WorkflowName, string>;
  claude: Record<WorkflowName, string>;
}

const CLI = '.crucible/bin/crucible';

/** Render the same workflow intent into each supported provider surface. */
export function renderWorkflow(): RenderedWorkflow {
  const entries = WORKFLOW_NAMES.map((name) => [name, renderOne(name)] as const);
  return {
    codex: Object.fromEntries(entries) as Record<WorkflowName, string>,
    claude: Object.fromEntries(entries) as Record<WorkflowName, string>,
  };
}

function renderOne(name: WorkflowName): string {
  const verb = name.slice('crucible-'.length);
  const command = verb === 'submit' ? `${CLI} status <change>` : `${CLI} ${verb} <change>`;
  const implementStep =
    verb === 'implement'
      ? 'For implement, do not author code until its preflight confirms the current seal; author `tasks.md` first, then code and ordinary tests.\n'
      : '';
  return `# ${name}\n\nRun this workflow in the active agent session. Do not launch, delegate to, or\nresume another agent. Conversation text and caches have no authority.\n\n1. Inspect artifact-derived state with \`${CLI} status <change> --json\`.\n2. Run only the project-local pinned CLI command appropriate for this workflow:\n   \`${command}\`.\n3. Follow the CLI's returned scaffold or instructions, authoring only files it\n   permits, then call the CLI again for validation.\n\n${implementStep}The CLI decides every transition from artifacts, bindings, seals, and verification\nevidence. If it refuses, report the exact instruction it gave; do not work around it.\n`;
}
