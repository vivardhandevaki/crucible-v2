// Notify dispatcher — turns a `notify` config block + a runtime into a `NotifyFn`
// (charter §Notify Hooks; design phase-2.md §8). It fans one NotifyEvent out to
// every configured hook whose `on:` includes the event's kind.
//
// The whole surface is CONVENIENCE (invariant 11). Two guarantees hold no matter
// what: (1) building the notifier never throws — a malformed config becomes logged
// warnings and the bad hook is dropped; (2) dispatching never throws — each hook
// runs inside a catch that logs its failure, so a down webhook or an absent
// `notify-send` cannot block the escalation / override / verify that fired it. The
// artifact on disk is always the blocker; the announcement is best-effort.

import { parseNotifyConfig, type NormalizedHook } from './config.js';
import type { NotifyRuntime } from './runtime.js';
import type { NotifyEvent, NotifyFn } from './types.js';

/**
 * Build a fire-and-forget dispatcher from the raw `notify` config record. Config
 * warnings are logged once, here, at build time. The returned function resolves
 * even when every hook fails — it is contractually incapable of throwing.
 */
export function createNotifier(
  notifyConfig: Record<string, unknown>,
  runtime: NotifyRuntime,
): NotifyFn {
  const { hooks, warnings } = parseNotifyConfig(notifyConfig ?? {});
  for (const w of warnings) safeLog(runtime, w);

  return async (event: NotifyEvent): Promise<void> => {
    const matching = hooks.filter((h) => h.kinds.has(event.kind));
    // allSettled, not all: one hook's rejection must not short-circuit the rest,
    // and the aggregate always resolves (deliverSafely never rejects anyway).
    await Promise.allSettled(matching.map((h) => deliverSafely(h, event, runtime)));
  };
}

/** Run one hook, swallowing + logging any throw/rejection (invariant 11). */
async function deliverSafely(
  hook: NormalizedHook,
  event: NotifyEvent,
  runtime: NotifyRuntime,
): Promise<void> {
  try {
    await deliver(hook, event, runtime);
  } catch (err) {
    safeLog(
      runtime,
      `notify: ${hook.name} hook failed for ${event.kind} on ${event.change} — ${message(err)}`,
    );
  }
}

/** Translate an event into the runtime call for one hook. May throw/reject —
 *  deliverSafely is the guard. */
async function deliver(
  hook: NormalizedHook,
  event: NotifyEvent,
  runtime: NotifyRuntime,
): Promise<void> {
  switch (hook.name) {
    case 'terminal':
      runtime.terminal(formatLine(event));
      return;
    case 'desktop':
      await runtime.desktop({
        title: `Crucible · ${event.kind}`,
        body: `${event.change}: ${event.summary}`,
      });
      return;
    case 'webhook':
      await runtime.webhook({
        url: hook.webhook!.url,
        headers: hook.webhook!.headers,
        body: JSON.stringify({ kind: event.kind, change: event.change, summary: event.summary }),
      });
      return;
    case 'github':
      await runtime.github({
        ...(hook.github?.target !== undefined ? { target: hook.github.target } : {}),
        title: `Crucible ${event.kind}: ${event.change}`,
        body: event.summary,
      });
      return;
  }
}

/** The one-line terminal rendering of an event. */
function formatLine(event: NotifyEvent): string {
  return `[crucible] ${event.kind.toUpperCase()} · ${event.change} — ${event.summary}`;
}

/** Log without ever throwing — even the failure sink is guarded (invariant 11). */
function safeLog(runtime: NotifyRuntime, message: string): void {
  try {
    runtime.log(message);
  } catch {
    /* the log sink itself is broken; there is nowhere left to report it. */
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
