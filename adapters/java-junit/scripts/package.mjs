// Build the P3-06 single-file java-junit executable deterministically:
//   1. clean-package the shaded Launcher helper;
//   2. bundle the TS wrapper with esbuild;
//   3. alias embedded-helper.ts with the jar's base64 bytes + sha256;
//   4. copy the manifest beside the one executable.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const adapterRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helperRoot = join(adapterRoot, 'resolve-helper');
const buildRoot = mkdtempSync(join(tmpdir(), 'crucible-java-junit-build-'));
cpSync(join(helperRoot, 'pom.xml'), join(buildRoot, 'pom.xml'));
cpSync(join(helperRoot, 'src'), join(buildRoot, 'src'), { recursive: true });
const helperJar = join(buildRoot, 'target', 'resolve-helper.jar');
const packageDir = join(adapterRoot, 'package');
const stagingDir = mkdtempSync(join(tmpdir(), 'crucible-java-junit-package-'));
const stagedExecutable = join(stagingDir, 'java-junit.mjs');
const executable = join(packageDir, 'java-junit.mjs');

const maven = spawnSync('mvn', ['-q', 'clean', 'package'], {
  cwd: buildRoot,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
if (maven.error || maven.status !== 0) {
  process.stderr.write(maven.stderr || maven.stdout || String(maven.error));
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  process.exit(1);
}

const jar = readFileSync(helperJar);
const base64 = jar.toString('base64');
const sha256 = createHash('sha256').update(jar).digest('hex');

mkdirSync(packageDir, { recursive: true });

await build({
  absWorkingDir: adapterRoot,
  entryPoints: ['src/cli.ts'],
  outfile: stagedExecutable,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  charset: 'ascii',
  legalComments: 'none',
  sourcemap: false,
  plugins: [
    {
      name: 'embed-resolve-helper',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/embedded-helper\.js$/ }, () => ({
          path: 'embedded-helper',
          namespace: 'crucible',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'crucible' }, () => ({
          contents:
            `export const CRUCIBLE_EMBEDDED_HELPER_JAR = ${JSON.stringify(base64)};\n` +
            `export const CRUCIBLE_EMBEDDED_HELPER_SHA256 = ${JSON.stringify(sha256)};\n`,
          loader: 'js',
        }));
      },
    },
  ],
});

chmodSync(stagedExecutable, 0o755);
const stagedManifest = join(stagingDir, 'crucible-adapter.yaml');
copyFileSync(join(adapterRoot, 'crucible-adapter.yaml'), stagedManifest);
// Atomic file replacement keeps readers on either the old or new complete
// deterministic package even when separate test projects build concurrently.
renameSync(stagedExecutable, executable);
renameSync(stagedManifest, join(packageDir, 'crucible-adapter.yaml'));
rmSync(buildRoot, { recursive: true, force: true });
rmSync(stagingDir, { recursive: true, force: true });
