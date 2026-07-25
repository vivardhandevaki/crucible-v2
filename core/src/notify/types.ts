// Notify hooks — the convenience announcement seam (charter §Notify Hooks; design
// phase-2.md §8). A notify dispatcher fans an event out to the configured hooks
// (terminal / desktop / webhook / github) so unattended runs are surfaced.
//
// **Hooks are convenience, never enforcement** (invariant 11): a failed webhook
// cannot unblock or block anything — the blocker is always the artifact. Callers
// therefore invoke the dispatcher fire-and-forget and swallow every failure; the
// dispatcher never throws to the caller.
//
// This file is only the CONTRACT the injected dispatcher satisfies. P2-04 (the
// first producer, `escalate`) needs a spy-able seam; the concrete `notify/`
// dispatcher — config-driven, with the real terminal/desktop/webhook/github hooks
// — is built by P2-15 against exactly this shape.

/** The events that fire notify hooks (charter: escalations, overrides, verify). */
export type NotifyEventKind = 'escalation' | 'override' | 'verify';

/** One convenience announcement. `summary` is a human-readable one-liner. */
export interface NotifyEvent {
  /** What happened — routes to the hooks configured `on:` this kind. */
  kind: NotifyEventKind;
  /** The change the event concerns (openspec/changes/<change>/). */
  change: string;
  /** A one-line human summary for terminal / desktop / chat hooks. */
  summary: string;
}

/**
 * Dispatch one notify event to the configured hooks. Injected into commands as a
 * non-deterministic edge (like the clock). It is fire-and-forget: a caller invokes
 * it and swallows any throw/rejection (invariant 11) — a broken hook must never
 * change an enforcement outcome. The concrete dispatcher (P2-15) logs its own hook
 * failures internally; this contract simply permits it to reject.
 */
export type NotifyFn = (event: NotifyEvent) => void | Promise<void>;
