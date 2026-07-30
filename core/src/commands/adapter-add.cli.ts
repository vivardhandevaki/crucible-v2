// CLI edge for the explicit post-init adapter lifecycle command.

import type { Command } from 'commander';

import { addAdapter } from './adapter-add.js';

export function registerAdapter(program: Command): void {
  const adapter = program.command('adapter').description('Manage committed, hash-pinned adapters');
  adapter
    .command('add <manifest> <executable>')
    .description('Install and pin a new adapter package (manifest + packaged executable)')
    .action((manifestPath: string, executablePath: string) => {
      const report = addAdapter({ root: process.cwd(), manifestPath, executablePath });
      for (const action of report.actions) {
        process.stdout.write(`  ${action.kind}  ${action.relpath}\n`);
      }
      process.stdout.write(`\nPinned ${report.adapter}.\n`);
    });
}
