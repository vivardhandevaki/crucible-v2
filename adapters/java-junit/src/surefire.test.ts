// TCB coverage for Surefire/JUnit XML normalization (`surefire.ts`). This is the
// adapter's verdict surface: a testcase's pass/fail/skip/error is read straight
// out of these elements, so every status shape is pinned here, plus the
// fail-closed behavior on a structurally broken report.

import { describe, expect, it } from 'vitest';

import { parseSurefireReport, SurefireParseError } from './surefire.js';

const PASS_AND_SKIP_AND_FAIL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.crucible.conformance.CalculatorTest" tests="4">
  <properties><property name="x" value="y"/></properties>
  <testcase name="skippedFeature" classname="com.crucible.conformance.CalculatorTest" time="0.0">
    <skipped message="conformance skip category: intentionally disabled"/>
  </testcase>
  <testcase name="subtractsTwoNumbers" classname="com.crucible.conformance.CalculatorTest" time="0.001"/>
  <testcase name="addsTwoNumbers" classname="com.crucible.conformance.CalculatorTest" time="0.0"/>
  <testcase name="failsOnPurpose" classname="com.crucible.conformance.CalculatorTest" time="0.003">
    <failure message="intentional conformance failure: 2 + 3 != 0 ==&gt; expected: &lt;0&gt; but was: &lt;5&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: boom
	at org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:563)
	at com.crucible.conformance.CalculatorTest.failsOnPurpose(CalculatorTest.java:44)
	at java.base/java.lang.reflect.Method.invoke(Method.java:565)
]]></failure>
  </testcase>
</testsuite>`;

describe('parseSurefireReport — status normalization', () => {
  const cases = parseSurefireReport(PASS_AND_SKIP_AND_FAIL);
  const byMethod = new Map(cases.map((c) => [c.methodName, c]));

  it('returns one case per <testcase>, in document order', () => {
    expect(cases.map((c) => c.methodName)).toEqual([
      'skippedFeature',
      'subtractsTwoNumbers',
      'addsTwoNumbers',
      'failsOnPurpose',
    ]);
  });

  it('an empty testcase is a pass', () => {
    expect(byMethod.get('addsTwoNumbers')?.status).toBe('pass');
    expect(byMethod.get('subtractsTwoNumbers')?.status).toBe('pass');
  });

  it('a <skipped> child is a skip, carrying its message', () => {
    const c = byMethod.get('skippedFeature');
    expect(c?.status).toBe('skip');
    expect(c?.message).toBe('conformance skip category: intentionally disabled');
  });

  it('a <failure> child is a fail, with the (entity-decoded) message', () => {
    const c = byMethod.get('failsOnPurpose');
    expect(c?.status).toBe('fail');
    expect(c?.message).toBe(
      'intentional conformance failure: 2 + 3 != 0 ==> expected: <0> but was: <5>',
    );
  });

  it('carries className and a millisecond duration', () => {
    const c = byMethod.get('failsOnPurpose');
    expect(c?.className).toBe('com.crucible.conformance.CalculatorTest');
    expect(c?.durationMs).toBe(3);
  });

  it('extracts location from the first stack frame in the test class', () => {
    // The top project frame, not the JUnit-internal frame above it.
    expect(byMethod.get('failsOnPurpose')?.location).toBe('CalculatorTest.java:44');
  });
});

describe('parseSurefireReport — errors and edge shapes', () => {
  it('an <error> child is an error status', () => {
    const [c] = parseSurefireReport(
      '<testsuite><testcase name="m" classname="C" time="0.0"><error message="NPE" type="java.lang.NullPointerException">stack</error></testcase></testsuite>',
    );
    expect(c?.status).toBe('error');
    expect(c?.message).toBe('NPE');
  });

  it('a <skipped> with no message yields skip and no message field', () => {
    const [c] = parseSurefireReport(
      '<testsuite><testcase name="m" classname="C" time="0.0"><skipped/></testcase></testsuite>',
    );
    expect(c?.status).toBe('skip');
    expect(c?.message).toBeUndefined();
  });

  it('falls back to failure body text when there is no message attribute', () => {
    const [c] = parseSurefireReport(
      '<testsuite><testcase name="m" classname="C" time="0.0"><failure type="X">bare body text</failure></testcase></testsuite>',
    );
    expect(c?.status).toBe('fail');
    expect(c?.message).toBe('bare body text');
  });

  it('omits location when no stack frame matches the test class', () => {
    const [c] = parseSurefireReport(
      '<testsuite><testcase name="m" classname="com.acme.FooTest" time="0.0"><failure message="x">at org.junit.Thing.go(Thing.java:1)</failure></testcase></testsuite>',
    );
    expect(c?.location).toBeUndefined();
  });

  it('reads a report with zero testcases as an empty list', () => {
    expect(parseSurefireReport('<testsuite tests="0"></testsuite>')).toEqual([]);
  });
});

describe('parseSurefireReport — fails closed on malformed reports', () => {
  it('throws when the XML itself is broken', () => {
    expect(() => parseSurefireReport('<testsuite><testcase')).toThrow();
  });

  it('throws SurefireParseError when a testcase lacks a name', () => {
    expect(() =>
      parseSurefireReport('<testsuite><testcase classname="C" time="0.0"/></testsuite>'),
    ).toThrow(SurefireParseError);
  });

  it('throws SurefireParseError when a testcase lacks a classname', () => {
    expect(() =>
      parseSurefireReport('<testsuite><testcase name="m" time="0.0"/></testsuite>'),
    ).toThrow(SurefireParseError);
  });

  it('throws SurefireParseError when the root is not a testsuite(s)', () => {
    expect(() => parseSurefireReport('<notasuite/>')).toThrow(SurefireParseError);
  });
});
