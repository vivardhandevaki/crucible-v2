import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_BUNDLE_NAMES, schemaBundleFile, type SchemaBundleName } from '@crucible/schemas';
import { loadSchemaBundle } from './schema-bundle.js';
import { CHANGE_TYPES, schemaForType } from './changetype.js';
import { isCrucibleError } from '../util/errors.js';

describe('shipped bundles — integrity', () => {
  it('ships exactly one bundle per change type, names matching', () => {
    expect([...SCHEMA_BUNDLE_NAMES].sort()).toEqual(CHANGE_TYPES.map(schemaForType).sort());
  });

  it.each(SCHEMA_BUNDLE_NAMES)('%s validates fully (shape + templates + graph)', (name) => {
    const bundle = loadSchemaBundle(schemaBundleFile(name));
    expect(bundle.name).toBe(name); // the pinned schema name matches the dir
    expect(bundle.artifacts.length).toBeGreaterThan(0);
  });

  it('the feature bundle carries the full artifact chain incl. specs + oracles', () => {
    const feature = loadSchemaBundle(schemaBundleFile('crucible'));
    const ids = feature.artifacts.map((a) => a.id);
    expect(ids).toContain('specs');
    expect(ids).toContain('oracles');
  });

  it('the refactor bundle permits NO spec delta (no specs artifact)', () => {
    const refactor = loadSchemaBundle(schemaBundleFile('crucible-refactor'));
    expect(refactor.artifacts.map((a) => a.id)).not.toContain('specs');
  });

  it('the bugfix bundle carries an oracles artifact (the reproduction oracle)', () => {
    const bugfix = loadSchemaBundle(schemaBundleFile('crucible-bugfix'));
    expect(bugfix.artifacts.map((a) => a.id)).toContain('oracles');
  });
});

describe('loadSchemaBundle — fail-closed on a malformed bundle', () => {
  let dir: string;
  const schemaPath = () => join(dir, 'schema.yaml');
  const writeSchema = (yaml: string) => writeFileSync(schemaPath(), yaml);
  const touchTemplate = (name: string) => {
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', name), '# template\n');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crucible-sb-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const expectExit3 = (act: () => void) => {
    try {
      act();
      expect.unreachable('expected a fail-closed throw');
    } catch (err) {
      expect(isCrucibleError(err) && err.exit).toBe(3);
    }
  };

  it('a valid hand-authored bundle loads', () => {
    touchTemplate('proposal.md');
    writeSchema(
      'name: mini\nversion: 1\ndescription: ok\nartifacts:\n  - id: proposal\n    generates: proposal.md\n    description: p\n    template: proposal.md\n',
    );
    expect(loadSchemaBundle(schemaPath()).name).toBe('mini');
  });

  it('unparseable YAML → exit 3', () => {
    writeSchema('name: : :\n  - [broken\n');
    expectExit3(() => loadSchemaBundle(schemaPath()));
  });

  it('an unknown top-level key → exit 3 (strict)', () => {
    touchTemplate('proposal.md');
    writeSchema(
      'name: mini\nversion: 1\ndescription: ok\nsurprise: true\nartifacts:\n  - id: proposal\n    generates: proposal.md\n    description: p\n    template: proposal.md\n',
    );
    expectExit3(() => loadSchemaBundle(schemaPath()));
  });

  it('a missing template file → exit 3', () => {
    writeSchema(
      'name: mini\nversion: 1\ndescription: ok\nartifacts:\n  - id: proposal\n    generates: proposal.md\n    description: p\n    template: proposal.md\n',
    );
    expectExit3(() => loadSchemaBundle(schemaPath()));
  });

  it('a requires entry naming an unknown artifact → exit 3', () => {
    touchTemplate('proposal.md');
    writeSchema(
      'name: mini\nversion: 1\ndescription: ok\nartifacts:\n  - id: proposal\n    generates: proposal.md\n    description: p\n    template: proposal.md\n    requires: [ghost]\n',
    );
    expectExit3(() => loadSchemaBundle(schemaPath()));
  });

  it('a dependency cycle → exit 3', () => {
    touchTemplate('a.md');
    touchTemplate('b.md');
    writeSchema(
      'name: mini\nversion: 1\ndescription: ok\nartifacts:\n' +
        '  - id: a\n    generates: a.md\n    description: a\n    template: a.md\n    requires: [b]\n' +
        '  - id: b\n    generates: b.md\n    description: b\n    template: b.md\n    requires: [a]\n',
    );
    expectExit3(() => loadSchemaBundle(schemaPath()));
  });
});
