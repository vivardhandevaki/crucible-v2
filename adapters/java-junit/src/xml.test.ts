// TCB coverage for the dependency-free XML reader (`xml.ts`). Surefire / Gradle
// JUnit report parsing is a verdict-parsing surface — a judge's pass/fail is read
// out of this tree — so it is covered thoroughly, malformed inputs included: a
// report we cannot parse must throw (fail-closed), never silently yield a wrong
// or empty verdict (invariant 3).

import { describe, expect, it } from 'vitest';

import { parseXml, findElements, attr, textOf, XmlParseError, type XmlElement } from './xml.js';

describe('parseXml — well-formed documents', () => {
  it('parses a single self-closing root with attributes', () => {
    const root = parseXml('<testcase name="m" classname="C" time="0.0"/>');
    expect(root.name).toBe('testcase');
    expect(root.attrs).toEqual({ name: 'm', classname: 'C', time: '0.0' });
    expect(root.children).toEqual([]);
  });

  it('skips the XML declaration and leading whitespace', () => {
    const root = parseXml('<?xml version="1.0" encoding="UTF-8"?>\n<a/>');
    expect(root.name).toBe('a');
  });

  it('skips comments and DOCTYPE at the top level and inside elements', () => {
    const root = parseXml('<!-- lead --><a><!-- mid --><b/></a>');
    expect(root.name).toBe('a');
    expect(findElements(root, 'b')).toHaveLength(1);
  });

  it('parses nested elements and preserves child order', () => {
    const root = parseXml('<s><t name="1"/><t name="2"/></s>');
    const ts = findElements(root, 't');
    expect(ts.map((e) => attr(e, 'name'))).toEqual(['1', '2']);
  });

  it('decodes entities in attribute values', () => {
    const root = parseXml('<f message="a &lt;0&gt; &amp; &quot;b&quot; &apos;c&apos;"/>');
    expect(attr(root, 'message')).toBe('a <0> & "b" \'c\'');
  });

  it('decodes numeric and hex character references', () => {
    const root = parseXml('<f message="line&#10;break &#x41;"/>');
    expect(attr(root, 'message')).toBe('line\nbreak A');
  });

  it('reads CDATA as verbatim text (entities NOT decoded inside)', () => {
    const root = parseXml('<failure><![CDATA[a > b && c < d]]></failure>');
    expect(textOf(root)).toBe('a > b && c < d');
  });

  it('concatenates mixed text and CDATA in document order', () => {
    const root = parseXml('<x>plain &amp; <![CDATA[<raw>]]> tail</x>');
    expect(textOf(root)).toBe('plain & <raw> tail');
  });

  it('accepts single-quoted attribute values', () => {
    const root = parseXml("<a x='y'/>");
    expect(attr(root, 'x')).toBe('y');
  });

  it('tolerates namespaced attribute names', () => {
    const root = parseXml(
      '<testsuite xmlns:xsi="http://x" xsi:noNamespaceSchemaLocation="s" name="n"/>',
    );
    expect(attr(root, 'name')).toBe('n');
    expect(attr(root, 'xsi:noNamespaceSchemaLocation')).toBe('s');
  });

  it('findElements searches descendants, not just direct children', () => {
    const root = parseXml('<suite><group><case name="deep"/></group></suite>');
    expect(findElements(root, 'case').map((e) => attr(e, 'name'))).toEqual(['deep']);
  });
});

describe('parseXml — malformed input fails closed', () => {
  const bad: Record<string, string> = {
    empty: '',
    'only whitespace': '   \n  ',
    'no root element': '<!-- just a comment -->',
    'unclosed tag': '<a>',
    'mismatched close tag': '<a></b>',
    'unterminated attribute quote': '<a x="y>',
    'attribute without quotes': '<a x=y/>',
    'text before root': 'garbage<a/>',
    'stray close tag': '</a>',
    'unterminated comment': '<a><!-- oops</a>',
    'unterminated cdata': '<a><![CDATA[ oops </a>',
    'eof inside tag': '<a name=',
    'trailing content after root': '<a/><b/>',
  };
  for (const [label, input] of Object.entries(bad)) {
    it(`throws XmlParseError on ${label}`, () => {
      expect(() => parseXml(input)).toThrow(XmlParseError);
    });
  }
});

describe('accessors', () => {
  const suite: XmlElement = parseXml(
    '<testsuite><testcase name="a"/><testcase name="b"><skipped message="why"/></testcase></testsuite>',
  );
  it('attr returns undefined for an absent attribute', () => {
    expect(attr(suite, 'nope')).toBeUndefined();
  });
  it('findElements returns [] when none match', () => {
    expect(findElements(suite, 'nonexistent')).toEqual([]);
  });
  it('textOf returns empty string for an element with no text', () => {
    expect(textOf(suite.children[0] as XmlElement)).toBe('');
  });
});
