// The crucible command program: name, version, global flags, and the verb
// registrations. Every P1 verb has a dedicated real registration
// (commands/*.cli.ts) — propose (P1-09), approve (P1-07), verify (P1-12),
// implement (P1-13), and status (P1-14) — plus the P2 verbs as they land:
// escalate (P2-04), override (P2-06), and amend (P2-05). The fail-closed stub loop
// archive (P2-01) — plus the P2 verbs as they land. The fail-closed stub loop
// remains for any P1 verb not yet wired (invariant 3: a stub never pretends success).

import { Command } from 'commander';
import { internalError } from '../util/errors.js';
import { registerAdapter } from '../commands/adapter-add.cli.js';
import { registerAmend } from '../commands/amend.cli.js';
import { registerCi } from '../commands/ci.cli.js';
import { registerApprove } from '../commands/approve.cli.js';
import { registerArchive } from '../commands/archive.cli.js';
import { registerFramework } from '../commands/framework.cli.js';
import { registerCiReview } from '../commands/ci-review.cli.js';
import { registerDoctor } from '../commands/doctor.cli.js';
import { registerEscalate } from '../commands/escalate.cli.js';
import { registerImplement } from '../commands/implement.cli.js';
import { registerInit } from '../commands/init.cli.js';
import { registerOverride } from '../commands/override.cli.js';
import { registerPropose } from '../commands/propose.cli.js';
import { registerReview } from '../commands/review.cli.js';
import { registerRoute } from '../commands/route.cli.js';
import { registerStatus } from '../commands/status.cli.js';
import { registerSession } from '../commands/session.cli.js';
import { registerVerify } from '../commands/verify.cli.js';
import { registerWhy } from '../commands/why.cli.js';

// Placeholder until the version is sourced from package metadata in a later
// task; kept off package.json imports because that file sits outside rootDir.
const CRUCIBLE_VERSION = '0.0.0';

/** The tracer-bullet verbs Phase 1 delivers (phase-0-1.md §Phase 1 scope). */
export const P1_VERBS = ['propose', 'approve', 'implement', 'verify', 'status'] as const;

export type P1Verb = (typeof P1_VERBS)[number];

const VERB_SUMMARY: Record<P1Verb, string> = {
  propose: 'Draft a change bundle (spec + oracles) for approval',
  approve: 'Seal an approved bundle by hashing its artifacts',
  implement: 'Generate tasks and implement against an approved bundle',
  verify: 'Run lint, oracles, and hash checks; report green/red',
  status: 'Show the change phase and the next command to run',
};

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('crucible')
    .description('Crucible — humans approve artifacts, not code.')
    .version(CRUCIBLE_VERSION, '-v, --version')
    // --json plumbing: parseable everywhere; consumed by status/verify and by
    // the runner's error formatter (runner.ts).
    .option('--json', 'emit machine-readable JSON output')
    // --config-from: read enforcement config (crucible.yaml) from this directory
    // instead of the working tree. The CI template points this at the
    // target-branch checkout so the rules that judge a PR are main's rules, never
    // the PR's (charter §The Target-Branch Rule). Convenience config is always
    // read from the working tree and is unaffected. Consumed by verify (P1-12).
    .option(
      '--config-from <dir>',
      'read crucible.yaml from this directory (CI target-branch rule)',
    );

  // Every P1 verb has a dedicated registration below; the stub loop only fires if
  // a verb is added to P1_VERBS before it is wired (fail-closed, invariant 3).
  const WIRED: readonly P1Verb[] = ['propose', 'approve', 'verify', 'implement', 'status'];
  for (const verb of P1_VERBS) {
    if (WIRED.includes(verb)) continue;
    program
      .command(verb)
      .description(VERB_SUMMARY[verb])
      .action(() => {
        throw internalError(
          'NOT_IMPLEMENTED',
          `\`crucible ${verb}\` is not implemented in this build.`,
          'This command lands in a later Phase 1 task (docs/tasks/phase-0-1.md).',
        );
      });
  }

  registerAdapter(program);
  registerAmend(program);
  registerApprove(program);
  registerArchive(program);
  registerCiReview(program);
  registerCi(program);
  registerDoctor(program);
  registerFramework(program);
  registerEscalate(program);
  registerImplement(program);
  registerInit(program);
  registerOverride(program);
  registerPropose(program);
  registerReview(program);
  registerRoute(program);
  registerSession(program);
  registerStatus(program);
  registerVerify(program);
  registerWhy(program);

  return program;
}
