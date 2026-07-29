import { describe, expect, it } from 'vitest';
import type { NotifyEvent } from './types.js';
import type { NotifyRuntime } from './runtime.js';
import { createNotifier } from './dispatcher.js';
import { parseNotifyConfig } from './config.js';

// The notify dispatcher (charter §Notify Hooks; design phase-2.md §8) fans one
// NotifyEvent out to the configured hooks — terminal / desktop / webhook / github
// — filtered by each hook's `on:` kinds. It is CONVENIENCE (invariant 11): a
// malformed config or a throwing hook is LOGGED, never thrown to the caller. The
// side-effecting edges live behind an injected `NotifyRuntime` so the dispatcher
// core stays deterministic (invariant 12); these tests drive a recording fake.

interface Calls {
  log: string[];
  terminal: string[];
  desktop: { title: string; body: string }[];
  webhook: { url: string; headers: Record<string, string>; body: string }[];
  github: { target?: string; title: string; body: string }[];
}

function recordingRuntime(over: Partial<NotifyRuntime> = {}): {
  runtime: NotifyRuntime;
  calls: Calls;
} {
  const calls: Calls = { log: [], terminal: [], desktop: [], webhook: [], github: [] };
  const runtime: NotifyRuntime = {
    log: (m) => calls.log.push(m),
    terminal: (l) => calls.terminal.push(l),
    desktop: (n) => {
      calls.desktop.push(n);
    },
    webhook: (r) => {
      calls.webhook.push(r);
    },
    github: (r) => {
      calls.github.push(r);
    },
    ...over,
  };
  return { runtime, calls };
}

const ESC: NotifyEvent = { kind: 'escalation', change: 'add-greeting', summary: 'ambiguous fee' };
const OVR: NotifyEvent = { kind: 'override', change: 'add-greeting', summary: '2am prod fix' };
const VER: NotifyEvent = {
  kind: 'verify',
  change: 'add-greeting',
  summary: 'FAIL — tier standard',
};

describe('parseNotifyConfig — tolerant, never throws (convenience)', () => {
  it('empty config yields no hooks and no warnings', () => {
    const parsed = parseNotifyConfig({});
    expect(parsed.hooks).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('boolean-true shorthand enables a hook for all three kinds', () => {
    const parsed = parseNotifyConfig({ terminal: true });
    expect(parsed.hooks).toHaveLength(1);
    expect(parsed.hooks[0]!.name).toBe('terminal');
    expect([...parsed.hooks[0]!.kinds].sort()).toEqual(['escalation', 'override', 'verify']);
  });

  it('boolean-false disables a hook', () => {
    const parsed = parseNotifyConfig({ terminal: false });
    expect(parsed.hooks).toHaveLength(0);
  });

  it('`on:` narrows the kinds a hook fires on', () => {
    const parsed = parseNotifyConfig({ terminal: { on: ['escalation', 'override'] } });
    expect([...parsed.hooks[0]!.kinds].sort()).toEqual(['escalation', 'override']);
  });

  it('a webhook string is the url shorthand', () => {
    const parsed = parseNotifyConfig({ webhook: 'https://hooks.example/x' });
    expect(parsed.hooks[0]).toMatchObject({ name: 'webhook' });
    expect(parsed.hooks[0]!.webhook).toEqual({ url: 'https://hooks.example/x', headers: {} });
  });

  it('a github string is the target shorthand', () => {
    const parsed = parseNotifyConfig({ github: 'owner/repo#12' });
    expect(parsed.hooks[0]).toMatchObject({ name: 'github' });
    expect(parsed.hooks[0]!.github).toEqual({ target: 'owner/repo#12' });
  });

  it('an unknown hook key is a logged warning, not a throw', () => {
    const parsed = parseNotifyConfig({ slack: '#team' });
    expect(parsed.hooks).toHaveLength(0);
    expect(parsed.warnings.join('\n')).toContain('slack');
  });

  it('a malformed hook config is a warning and the hook is skipped', () => {
    const parsed = parseNotifyConfig({ terminal: 'yes-please', webhook: { headers: {} } });
    expect(parsed.hooks).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(2);
  });

  it('an invalid `on` kind is rejected (the hook is skipped, warned)', () => {
    const parsed = parseNotifyConfig({ terminal: { on: ['ship-it'] } });
    expect(parsed.hooks).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('hooks come back in a stable order regardless of key order', () => {
    const parsed = parseNotifyConfig({ github: true, terminal: true, desktop: true });
    expect(parsed.hooks.map((h) => h.name)).toEqual(['terminal', 'desktop', 'github']);
  });
});

describe('createNotifier — config-driven dispatch per event kind', () => {
  it('fires the terminal hook with a line naming kind, change and summary', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier({ terminal: true }, runtime);
    await notify(ESC);
    expect(calls.terminal).toHaveLength(1);
    const line = calls.terminal[0]!;
    expect(line).toContain('add-greeting');
    expect(line).toContain('ambiguous fee');
    expect(line.toLowerCase()).toContain('escalation');
  });

  it('routes an event only to hooks whose `on:` includes its kind', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier({ terminal: { on: ['escalation'] } }, runtime);
    await notify(OVR);
    await notify(VER);
    expect(calls.terminal).toHaveLength(0);
    await notify(ESC);
    expect(calls.terminal).toHaveLength(1);
  });

  it('dispatches override and verify events too (all three kinds)', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier({ terminal: true }, runtime);
    await notify(OVR);
    await notify(VER);
    expect(calls.terminal).toHaveLength(2);
    expect(calls.terminal[0]!.toLowerCase()).toContain('override');
    expect(calls.terminal[1]!.toLowerCase()).toContain('verify');
  });

  it('the webhook hook posts a JSON body carrying the event fields', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier(
      { webhook: { url: 'https://hooks.example/x', headers: { 'x-token': 't' } } },
      runtime,
    );
    await notify(ESC);
    expect(calls.webhook).toHaveLength(1);
    const req = calls.webhook[0]!;
    expect(req.url).toBe('https://hooks.example/x');
    expect(req.headers).toEqual({ 'x-token': 't' });
    expect(JSON.parse(req.body)).toMatchObject({
      kind: 'escalation',
      change: 'add-greeting',
      summary: 'ambiguous fee',
    });
  });

  it('the desktop hook gets a title and body', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier({ desktop: true }, runtime);
    await notify(OVR);
    expect(calls.desktop).toHaveLength(1);
    expect(calls.desktop[0]!.body).toContain('2am prod fix');
  });

  it('the github hook forwards the configured target', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier({ github: 'owner/repo#7' }, runtime);
    await notify(ESC);
    expect(calls.github).toHaveLength(1);
    expect(calls.github[0]!.target).toBe('owner/repo#7');
  });

  it('fans one event out to every matching hook', async () => {
    const { runtime, calls } = recordingRuntime();
    const notify = createNotifier(
      { terminal: true, desktop: true, webhook: 'https://h/x' },
      runtime,
    );
    await notify(ESC);
    expect(calls.terminal).toHaveLength(1);
    expect(calls.desktop).toHaveLength(1);
    expect(calls.webhook).toHaveLength(1);
  });

  it('logs config warnings once at build time (unknown / malformed keys)', () => {
    const { runtime, calls } = recordingRuntime();
    createNotifier({ slack: '#team' }, runtime);
    expect(calls.log.join('\n')).toContain('slack');
  });
});

describe('createNotifier — fire-and-forget: a hook failure never throws (invariant 11)', () => {
  it('a throwing hook is logged, and the dispatch still resolves', async () => {
    const { runtime, calls } = recordingRuntime({
      webhook: () => {
        throw new Error('webhook down');
      },
    });
    const notify = createNotifier({ webhook: 'https://h/x' }, runtime);
    await expect(notify(ESC)).resolves.toBeUndefined();
    expect(calls.log.join('\n')).toContain('webhook down');
  });

  it('an async-rejecting hook is swallowed too', async () => {
    const { runtime, calls } = recordingRuntime({
      webhook: () => Promise.reject(new Error('timeout')),
    });
    const notify = createNotifier({ webhook: 'https://h/x' }, runtime);
    await expect(notify(ESC)).resolves.toBeUndefined();
    expect(calls.log.join('\n')).toContain('timeout');
  });

  it('one failing hook does not stop the others from firing', async () => {
    const { runtime, calls } = recordingRuntime({
      webhook: () => {
        throw new Error('boom');
      },
    });
    const notify = createNotifier({ webhook: 'https://h/x', terminal: true }, runtime);
    await notify(ESC);
    expect(calls.terminal).toHaveLength(1); // terminal still fired
  });

  it('even a throwing log sink cannot make the dispatcher throw', async () => {
    const runtime: NotifyRuntime = {
      log: () => {
        throw new Error('stderr gone');
      },
      terminal: () => {
        throw new Error('tty gone');
      },
      desktop: () => {},
      webhook: () => {},
      github: () => {},
    };
    const notify = createNotifier({ terminal: true }, runtime);
    await expect(notify(ESC)).resolves.toBeUndefined();
  });
});
