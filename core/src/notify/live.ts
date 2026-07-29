// Live notifier wiring — the one helper the command CLIs call to get a real,
// config-driven `NotifyFn` (design phase-2.md §8). It reads the convenience
// `notify` block from the working tree and binds it to the live runtime.
//
// Crucially it NEVER throws (invariant 11): the notifier is built inside every
// producer's `liveDeps()` — escalate, override, amend, verify — *before* that
// command does its load-bearing work, so a malformed convenience file must not be
// able to abort an escalation or an override. A read/parse failure here is
// downgraded to a logged warning and an empty (no-op) notifier; the command
// proceeds and its artifact is written. (A command that separately needs the
// convenience config for its own routing still surfaces a malformed file loudly on
// that path — this helper only governs the announcement channel.)

import { loadConvenienceConfig } from '../config/convenience.js';
import { createNotifier } from './dispatcher.js';
import { liveNotifyRuntime } from './runtime.js';
import type { NotifyFn } from './types.js';

/** Build the live, config-driven notifier for a command run rooted at `root`. */
export function createLiveNotifier(root: string): NotifyFn {
  const runtime = liveNotifyRuntime();
  let notifyConfig: Record<string, unknown> = {};
  try {
    notifyConfig = loadConvenienceConfig(root).notify;
  } catch (err) {
    // Convenience-never-enforcement: a broken settings/local file disables the
    // announcement channel; it must never block the command that fired the event.
    runtime.log(
      `notify: convenience config could not be read — announcements disabled for this run (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  return createNotifier(notifyConfig, runtime);
}
