// CLI wiring for `crucible override` — binds the deterministic core (`override`)
// to its two non-deterministic edges: the wall-clock and the git identity. The
// core stays testable and reproducible (invariant 12); this shim supplies the
// live values at invocation time.
//
// `<change>` and `<reason>` are BOTH required commander arguments, so a missing
// reason is a commander usage error the shared runner maps to exit 2 (the P2-06
// acceptance: "missing reason → exit 2"); an empty-string reason is caught by the
// core with the same exit. On success it prints where the override was written and
// what happens next (human review forced + a ratchet issue on the next CI run).

import type { Command } from 'commander';
import { override, type OverrideDeps } from './override.js';

/** Register the real `override` subcommand on the program. */
export function registerOverride(program: Command): void {
  program
    .command('override')
    .description('Record a gate bypass (the 2am hatch): forces human review + a ratchet issue')
    .argument('<change>', 'the change name to override (openspec/changes/<change>/)')
    .argument('<reason>', 'why the gate is being bypassed (recorded; files a ratchet issue)')
    .action((change: string, reason: string) => {
      const result = override({ root: process.cwd(), change, reason }, liveDeps());
      process.stdout.write(`Override recorded for ${change}: ${result.path}\n`);
      process.stdout.write(`  reason: ${result.reason}\n`);
      process.stdout.write(
        '  next CI run: verify goes green-with-override, human review is forced ' +
          'regardless of tier, and a ratchet issue is filed until a retroactive proposal lands.\n',
      );
    });
}

/** The live dependencies for a real override invocation. */
function liveDeps(): OverrideDeps {
  return {
    now: () => new Date().toISOString(),
    overriddenBy: () => process.env.GIT_AUTHOR_EMAIL ?? process.env.USER ?? 'unknown',
  };
}
