import { describe, expect, it } from 'vitest';
import { parseCiAuthorityManifest, serializeCiAuthorityManifest } from './ci-authority-manifest.js';

const manifest = {
  version: 1 as const,
  lane: 'governed' as const,
  changes: ['add-greeting'],
  base_sha: '1111111111111111111111111111111111111111',
  head_sha: '2222222222222222222222222222222222222222',
  snapshot_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('CI authority manifest — strict handoff', () => {
  it('round-trips canonical bytes and rejects unknown or malformed fields', () => {
    const text = serializeCiAuthorityManifest(manifest);
    expect(parseCiAuthorityManifest(text, 'manifest.json')).toEqual(manifest);
    expect(() =>
      parseCiAuthorityManifest(text.replace('}', ',"extra":true}'), 'manifest.json'),
    ).toThrow(/invalid/i);
    expect(() =>
      parseCiAuthorityManifest(
        text.replace('\"base_sha\":\"111', '\"base_sha\":\"XYZ'),
        'manifest.json',
      ),
    ).toThrow(/invalid/i);
  });

  it('rejects non-canonical change order and an empty governed lane', () => {
    expect(() =>
      parseCiAuthorityManifest(
        JSON.stringify({ ...manifest, changes: ['z-change', 'a-change'] }),
        'manifest.json',
      ),
    ).toThrow(/sorted/i);
    expect(() =>
      parseCiAuthorityManifest(JSON.stringify({ ...manifest, changes: [] }), 'manifest.json'),
    ).toThrow(/governed/i);
  });
});
