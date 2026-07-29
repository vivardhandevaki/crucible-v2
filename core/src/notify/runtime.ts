// Notify runtime — the side-effecting edges the dispatcher drives (design
// phase-2.md §8). The dispatcher core is deterministic (invariant 12); every real
// I/O — the stderr sink, the terminal announcement, the desktop popup, the webhook
// POST, the `gh` call — is behind this interface so tests inject a recording fake
// and the core never touches a terminal, a network, or a subprocess.
//
// Each edge MAY throw/reject; the dispatcher wraps every call and logs the failure
// (invariant 11 — a broken hook cannot change any outcome). `log` is the failure
// sink (stderr), kept separate from `terminal` (the announcement channel) so a
// convenience announcement never lands on stdout, which is reserved for report
// JSON.

import { spawn } from 'node:child_process';

/** The non-deterministic edges a notifier delivers through. */
export interface NotifyRuntime {
  /** Diagnostic / failure sink (stderr). Must itself be robust; the dispatcher
   *  still guards it, but it should not throw. */
  log: (message: string) => void;
  /** The terminal announcement channel (stderr — stdout is report JSON). */
  terminal: (line: string) => void;
  /** A desktop notification. */
  desktop: (n: { title: string; body: string }) => void | Promise<void>;
  /** A webhook POST. */
  webhook: (req: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }) => void | Promise<void>;
  /** A GitHub announcement (issue comment on `target`, else a new issue). */
  github: (req: { target?: string; title: string; body: string }) => void | Promise<void>;
}

/**
 * The live runtime: real stderr, `fetch`, and subprocess edges. Every method may
 * throw — the dispatcher catches and logs. Desktop shells the OS notifier
 * (`notify-send` / `osascript`) rather than pulling a native dependency; github
 * shells `gh` (no token plumbing in core — design §3). Both fail closed to a
 * logged skip when the tool is absent.
 */
export function liveNotifyRuntime(): NotifyRuntime {
  return {
    log: (message) => process.stderr.write(message + '\n'),
    terminal: (line) => process.stderr.write(line + '\n'),

    desktop: async ({ title, body }) => {
      if (process.platform === 'darwin') {
        await run('osascript', [
          '-e',
          `display notification ${osaQuote(body)} with title ${osaQuote(title)}`,
        ]);
      } else if (process.platform === 'linux') {
        await run('notify-send', [title, body]);
      } else if (process.platform === 'win32') {
        await run('powershell', [
          '-NoProfile',
          '-Command',
          `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') > $null; ` +
            `[System.Windows.Forms.MessageBox]::Show(${psQuote(body)}, ${psQuote(title)})`,
        ]);
      } else {
        throw new Error(`no desktop notifier for platform '${process.platform}'`);
      }
    },

    webhook: async ({ url, headers, body }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      if (!res.ok) throw new Error(`webhook ${url} responded HTTP ${res.status}`);
    },

    github: async ({ target, title, body }) => {
      // Convenience announcement via the ambient `gh` CLI. With a target, comment
      // on that issue/PR; without one, open an issue. Local runs only (the ratchet
      // issue that gates a merge is filed by the CI template, not this hook).
      if (target) {
        await run('gh', ['issue', 'comment', target, '--body', body]);
      } else {
        await run('gh', ['issue', 'create', '--title', title, '--body', body]);
      }
    },
  };
}

/** Spawn a command, resolving on exit 0 and rejecting (with captured stderr)
 *  otherwise — including a spawn error (e.g. the tool is not installed). */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => reject(new Error(`${cmd} could not run — ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${cmd} exited ${code ?? 'null'}${stderr ? ` — ${stderr.trim()}` : ''}`));
    });
  });
}

function osaQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
