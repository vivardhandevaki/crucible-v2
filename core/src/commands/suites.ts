// Declared ordinary suites are configured project commands, separate from the
// adapter-governed oracle protocol. Their output is intentionally not trusted as
// a verdict: only the process outcome becomes a compact, attributable input to
// verify's machine report.

import { spawn } from 'node:child_process';
import type { DeclaredSuiteResult } from '../verifyx/report.js';

/** Run configured suites in sorted name order so report order is byte-stable. */
export async function runDeclaredSuites(
  root: string,
  suites: Record<string, string>,
): Promise<DeclaredSuiteResult[]> {
  const results: DeclaredSuiteResult[] = [];
  for (const [name, command] of Object.entries(suites).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    results.push(await runSuite(root, name, command));
  }
  return results;
}

function runSuite(root: string, name: string, command: string): Promise<DeclaredSuiteResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: 'ignore',
    });
    child.once('error', (error) =>
      resolve({ name, status: 'fail', message: `could not start: ${error.message}` }),
    );
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ name, status: 'pass' });
      else if (signal !== null) resolve({ name, status: 'fail', message: `signal ${signal}` });
      else resolve({ name, status: 'fail', message: `exit ${code ?? 'unknown'}` });
    });
  });
}
