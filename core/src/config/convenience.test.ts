import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_YAML_PATH } from '@crucible/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCrucibleError } from '../util/errors.js';
import { loadConvenienceConfig, mergeConvenience, parseConvenienceFile } from './convenience.js';

function exitOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (isCrucibleError(err)) return err.exit;
    throw err;
  }
  throw new Error('expected the call to throw a CrucibleError');
}

describe('parseConvenienceFile', () => {
  it('parses models and notify', () => {
    const cfg = parseConvenienceFile(
      'models: { propose: opus }\nnotify: { slack: "#x" }',
      'inline',
    );
    expect(cfg.models.propose).toBe('opus');
    expect(cfg.notify.slack).toBe('#x');
  });

  it('treats an empty/absent file as an empty config, not an error', () => {
    const cfg = parseConvenienceFile('', 'inline');
    expect(cfg.models).toEqual({});
    expect(cfg.notify).toEqual({});
  });

  it('loads the committed settings.yaml fixture', () => {
    const text = readFileSync(SETTINGS_YAML_PATH, 'utf8');
    const cfg = parseConvenienceFile(text, SETTINGS_YAML_PATH);
    expect(cfg.models.review).toBe('claude-opus-4-8');
    expect(cfg.notify.slack).toBe('#team-crucible');
  });

  it('rejects an unknown top-level key (typo must not silently no-op)', () => {
    expect(exitOf(() => parseConvenienceFile('modles: { propose: opus }', 'inline'))).toBe(3);
  });

  it('rejects a non-string model id', () => {
    expect(exitOf(() => parseConvenienceFile('models: { propose: 5 }', 'inline'))).toBe(3);
  });
});

describe('mergeConvenience — local overrides settings', () => {
  it('local wins per key; settings-only keys survive', () => {
    const settings = parseConvenienceFile(
      'models: { propose: opus, review: opus }\nnotify: { slack: "#team" }',
      'settings',
    );
    const local = parseConvenienceFile(
      'models: { propose: sonnet }\nnotify: { desktop: true }',
      'local',
    );
    const merged = mergeConvenience(settings, local);
    expect(merged.models.propose).toBe('sonnet'); // local wins
    expect(merged.models.review).toBe('opus'); // settings-only survives
    expect(merged.notify.slack).toBe('#team'); // settings-only survives
    expect(merged.notify.desktop).toBe(true); // local-only added
  });
});

describe('loadConvenienceConfig — file merge order', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crucible-conv-'));
    mkdirSync(join(root, '.crucible'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deep-merges local over settings from the .crucible directory', () => {
    writeFileSync(
      join(root, '.crucible', 'settings.yaml'),
      'models: { propose: opus, review: opus }\n',
    );
    writeFileSync(join(root, '.crucible', 'local.yaml'), 'models: { propose: sonnet }\n');
    const cfg = loadConvenienceConfig(root);
    expect(cfg.models.propose).toBe('sonnet');
    expect(cfg.models.review).toBe('opus');
  });

  it('returns an empty config when neither file exists', () => {
    const cfg = loadConvenienceConfig(root);
    expect(cfg.models).toEqual({});
    expect(cfg.notify).toEqual({});
  });

  it('works when only settings.yaml exists (no personal local.yaml)', () => {
    writeFileSync(join(root, '.crucible', 'settings.yaml'), 'notify: { slack: "#team" }\n');
    const cfg = loadConvenienceConfig(root);
    expect(cfg.notify.slack).toBe('#team');
  });
});

// Invariant 7 / architecture.md §1: enforcement code paths never read
// convenience config. The structural guarantee is that config/enforcement.ts
// imports nothing from config/convenience. Proven by scanning its source.
describe('module boundary — enforcement never imports convenience', () => {
  it('config/enforcement.ts has zero imports referencing convenience', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'enforcement.ts'), 'utf8');
    const importSpecifiers = [
      ...src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    expect(importSpecifiers.length).toBeGreaterThan(0); // sanity: we found imports
    for (const spec of importSpecifiers) {
      expect(spec, `enforcement.ts must not import ${spec}`).not.toContain('convenience');
    }
  });
});
