// CLI wiring for `crucible override` — binds the deterministic core (`override`)
// to its non-deterministic edges: the wall-clock, the git identity, and the
// config-driven notify dispatcher (P2-15). The core stays testable and
// reproducible (invariant 12); this shim supplies the live values at invocation
// time.
//
// `<change>` and `<reason>` are BOTH required commander arguments, so a missing
// reason is a commander usage error the shared runner maps to exit 2 (the P2-06
// acceptance: "missing reason → exit 2"); an empty-string reason is caught by the
// core with the same exit. On success it prints where the override was written and
// what happens next (human review forced + a ratchet issue on the next CI run).

import type { Command } from 'commander';
import { override, type OverrideDeps } from './override.js';
import { createLiveNotifier } from '../notify/live.js';

/** Register the real `override` subcommand on the program. */
export function registerOverride(program: Command): void {
  program
    .command('override')
    .description('Record a gate bypass (the 2am hatch): forces human review + a ratchet issue')
    .argument('<change>', 'the change name to override (openspec/changes/<change>/)')
    .argument('<reason>', 'why the gate is being bypassed (recorded; files a ratchet issue)')
    .action(async (change: string, reason: string) => {
      const root = process.cwd();
      const result = await override({ root, change, reason }, liveDeps(root));
      process.stdout.write(`Override recorded for ${change}: ${result.path}\n`);
      process.stdout.write(`  reason: ${result.reason}\n`);
      process.stdout.write(
        '  next CI run: verify goes green-with-override, human review is forced ' +
          'regardless of tier, and a ratchet issue is filed until a retroactive proposal lands.\n',
      );
    });
}

/** The live dependencies for a real override invocation. */
function liveDeps(root: string): OverrideDeps {
  return {
    now: () => new Date().toISOString(),
    overriddenBy: () => process.env.GIT_AUTHOR_EMAIL ?? process.env.USER ?? 'unknown',
    // Convenience notify (invariant 11): announces the bypass on the configured
    // channels. The override.yaml on disk is the sole blocker — a broken hook is
    // swallowed by the core and cannot stop the override.
    notify: createLiveNotifier(root),
  };
}
