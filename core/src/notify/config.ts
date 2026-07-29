// Notify config — the shape of the `notify` block in `.crucible/settings.yaml` /
// `local.yaml` (charter §Configuration & Reviewer Law; design phase-2.md §8).
//
// The convenience loader (config/convenience.ts) parses `notify` only as a loose
// record — it never fails a gate (invariant 7). This module gives that record its
// STRUCTURE: four known hooks (terminal / desktop / webhook / github), each keyed
// by name, each firing on all three event kinds unless an `on:` list narrows it.
//
// Parsing here is TOLERANT and NEVER throws (invariant 11): the notify block sits
// downstream of every enforcement write, so a typo must not be able to block an
// escalation or an override. An unknown key, a malformed hook value, or a bad
// `on:` kind becomes a *warning string* (the dispatcher logs it) and the offending
// hook is simply skipped. The load-bearing artifact is always the blocker; a
// broken announcement channel can only ever silence a convenience surface.

import { z } from 'zod';
import type { NotifyEventKind } from './types.js';

/** The three event kinds a hook may fire on (charter: escalations, overrides, verify). */
export const NOTIFY_KINDS: readonly NotifyEventKind[] = ['escalation', 'override', 'verify'];

/** The known hook names, in the fixed order the dispatcher fans them out. */
export const HOOK_ORDER = ['terminal', 'desktop', 'webhook', 'github'] as const;
export type HookName = (typeof HOOK_ORDER)[number];

/** A hook after validation + normalization: which kinds fire it, plus its params. */
export interface NormalizedHook {
  name: HookName;
  /** The event kinds this hook fires on (a subset of NOTIFY_KINDS). */
  kinds: Set<NotifyEventKind>;
  /** webhook params, present only for `name: 'webhook'`. */
  webhook?: { url: string; headers: Record<string, string> };
  /** github params, present only for `name: 'github'`. */
  github?: { target?: string };
}

/** The outcome of parsing the `notify` block: the enabled hooks + any warnings. */
export interface ParsedNotify {
  hooks: NormalizedHook[];
  /** Human-readable lines for config problems — the dispatcher logs these. */
  warnings: string[];
}

const kindSchema = z.enum(['escalation', 'override', 'verify']);
const onSchema = z.array(kindSchema).nonempty().optional();

// A bare `true`/`false` toggles the hook; an object may narrow `on:`.
const toggleSchema = z.union([z.boolean(), z.strictObject({ on: onSchema })]);

// A webhook is a url string (fires on all kinds) or an object with url/headers/on.
// The url is only required to be a non-empty string here; a genuinely bad URL is
// caught at delivery time by the live runtime and logged (still never a throw).
const webhookSchema = z.union([
  z.string().min(1),
  z.strictObject({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    on: onSchema,
  }),
]);

// github is a toggle, or a target string (an issue/PR ref the announcement lands
// on), or an object with an optional target + on.
const githubSchema = z.union([
  z.boolean(),
  z.string().min(1),
  z.strictObject({ target: z.string().min(1).optional(), on: onSchema }),
]);

function resolveKinds(on: NotifyEventKind[] | undefined): Set<NotifyEventKind> {
  return new Set(on ?? NOTIFY_KINDS);
}

/**
 * Parse the raw `notify` record into normalized hooks + warnings. Total and
 * tolerant: it never throws. Unknown keys and malformed values are collected as
 * warnings and the hook is skipped; a `false`/omitted toggle disables the hook.
 */
export function parseNotifyConfig(raw: Record<string, unknown>): ParsedNotify {
  const hooks: NormalizedHook[] = [];
  const warnings: string[] = [];
  const known = new Set<string>(HOOK_ORDER);

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push(`notify: unknown hook '${key}' ignored (known: ${HOOK_ORDER.join(', ')}).`);
    }
  }

  for (const name of HOOK_ORDER) {
    if (!(name in raw)) continue;
    const hook = parseHook(name, raw[name], warnings);
    if (hook) hooks.push(hook);
  }

  return { hooks, warnings };
}

function parseHook(name: HookName, value: unknown, warnings: string[]): NormalizedHook | undefined {
  switch (name) {
    case 'terminal':
    case 'desktop':
      return parseToggle(name, value, warnings);
    case 'webhook':
      return parseWebhook(value, warnings);
    case 'github':
      return parseGithub(value, warnings);
  }
}

function parseToggle(
  name: 'terminal' | 'desktop',
  value: unknown,
  warnings: string[],
): NormalizedHook | undefined {
  const parsed = toggleSchema.safeParse(value);
  if (!parsed.success) return warn(warnings, name, parsed.error);
  if (parsed.data === false) return undefined; // explicitly disabled
  const on = parsed.data === true ? undefined : parsed.data.on;
  return { name, kinds: resolveKinds(on) };
}

function parseWebhook(value: unknown, warnings: string[]): NormalizedHook | undefined {
  const parsed = webhookSchema.safeParse(value);
  if (!parsed.success) return warn(warnings, 'webhook', parsed.error);
  if (typeof parsed.data === 'string') {
    return {
      name: 'webhook',
      kinds: resolveKinds(undefined),
      webhook: { url: parsed.data, headers: {} },
    };
  }
  return {
    name: 'webhook',
    kinds: resolveKinds(parsed.data.on),
    webhook: { url: parsed.data.url, headers: parsed.data.headers ?? {} },
  };
}

function parseGithub(value: unknown, warnings: string[]): NormalizedHook | undefined {
  const parsed = githubSchema.safeParse(value);
  if (!parsed.success) return warn(warnings, 'github', parsed.error);
  if (parsed.data === false) return undefined; // explicitly disabled
  if (parsed.data === true) return { name: 'github', kinds: resolveKinds(undefined), github: {} };
  if (typeof parsed.data === 'string') {
    return { name: 'github', kinds: resolveKinds(undefined), github: { target: parsed.data } };
  }
  const github = parsed.data.target !== undefined ? { target: parsed.data.target } : {};
  return { name: 'github', kinds: resolveKinds(parsed.data.on), github };
}

function warn(warnings: string[], name: HookName, error: z.ZodError): undefined {
  const detail = error.issues.map((i) => i.message).join('; ');
  warnings.push(`notify: '${name}' hook config is invalid and was skipped — ${detail}.`);
  return undefined;
}
