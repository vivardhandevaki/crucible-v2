// P3-06 acceptance — a found JVM target may report `targetFile` only when the
// adapter can ground the outermost class in an existing source file under one
// of the build tool's configured test source roots, and that file really
// declares the expected type. A guessed-but-wrong file would leave the real
// oracle editable after approval (design phase-3.md §2; invariant 6).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { groundTargetFile } from './source-file.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-junit-source-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function source(relpath: string, text: string): void {
  const path = join(root, relpath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

describe('groundTargetFile', () => {
  it('uses configured roots and returns a repo-relative path for the declared outer class', () => {
    source(
      'custom-tests/com/acme/CheckoutTest.java',
      'package com.acme;\nfinal class CheckoutTest { class Nested {} }\n',
    );

    expect(
      groundTargetFile({
        root,
        className: 'com.acme.CheckoutTest$Nested',
        sourceRoots: [join(root, 'custom-tests')],
      }),
    ).toBe('custom-tests/com/acme/CheckoutTest.java');
  });

  it('tries configured roots in order and ignores absent candidates', () => {
    source('second/com/acme/CheckoutTest.java', 'package com.acme;\nrecord CheckoutTest() {}\n');

    expect(
      groundTargetFile({
        root,
        className: 'com.acme.CheckoutTest',
        sourceRoots: [join(root, 'first'), join(root, 'second')],
      }),
    ).toBe('second/com/acme/CheckoutTest.java');
  });

  it('returns undefined when the candidate exists but declares a different type', () => {
    source('src/test/java/com/acme/CheckoutTest.java', 'package com.acme;\nclass OtherTest {}\n');
    expect(
      groundTargetFile({
        root,
        className: 'com.acme.CheckoutTest',
        sourceRoots: [join(root, 'src/test/java')],
      }),
    ).toBeUndefined();
  });

  it('does not accept a declaration that appears only in a comment or string literal', () => {
    source(
      'src/test/java/com/acme/CheckoutTest.java',
      [
        'package com.acme;',
        '// class CheckoutTest {}',
        'class OtherTest { String decoy = "class CheckoutTest {}"; }',
        '',
      ].join('\n'),
    );
    expect(
      groundTargetFile({
        root,
        className: 'com.acme.CheckoutTest',
        sourceRoots: [join(root, 'src/test/java')],
      }),
    ).toBeUndefined();
  });

  it('refuses source roots outside the project instead of emitting an unsafe seal path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'crucible-junit-outside-'));
    try {
      const path = join(outside, 'com/acme/CheckoutTest.java');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'package com.acme; class CheckoutTest {}\n', 'utf8');
      expect(
        groundTargetFile({ root, className: 'com.acme.CheckoutTest', sourceRoots: [outside] }),
      ).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
