// Surefire / JUnit XML normalization — the adapter's verdict surface. Maven's
// Surefire and Gradle's JUnit plugin both emit the same broad `TEST-*.xml`
// dialect (a `<testsuite>` of `<testcase>` elements, each optionally carrying a
// `<failure>`, `<error>`, or `<skipped>` child); this module reads that into the
// normalized per-method result the wire speaks (design phase-3.md §2 run path).
//
// It is shared across build tools on purpose (P3-05 unifies Gradle onto it): the
// XML shape is the same, only the report *location* differs, which is the
// build-tool driver's concern, not this parser's.
//
// Fail-closed (invariant 3): a broken report, or a `<testcase>` missing its
// name/classname, throws — a report we cannot read is never a silent green.

import { attr, findElements, parseXml, textOf, type XmlElement } from './xml.js';

/** One normalized testcase result, keyed later as `className#methodName`. */
export interface SurefireCase {
  className: string;
  methodName: string;
  status: 'pass' | 'fail' | 'error' | 'skip';
  message?: string;
  /** `File.java:line` of the top stack frame inside the test class, when present. */
  location?: string;
  /** Wall time in milliseconds, derived from the `time` seconds attribute. */
  durationMs?: number;
}

/** Thrown when a report parses as XML but is not a valid JUnit report. */
export class SurefireParseError extends Error {
  override readonly name = 'SurefireParseError';
}

/**
 * Normalize one JUnit XML report string into its testcases, in document order.
 * Throws on malformed XML (via `parseXml`) or a malformed report structure.
 */
export function parseSurefireReport(xml: string): SurefireCase[] {
  const root = parseXml(xml);
  if (root.name !== 'testsuite' && root.name !== 'testsuites') {
    throw new SurefireParseError(
      `expected a <testsuite> or <testsuites> root, found <${root.name}>`,
    );
  }
  return findElements(root, 'testcase').map(normalizeCase);
}

function normalizeCase(tc: XmlElement): SurefireCase {
  const methodName = attr(tc, 'name');
  const className = attr(tc, 'classname');
  if (methodName === undefined || methodName.length === 0) {
    throw new SurefireParseError('a <testcase> is missing its `name` attribute');
  }
  if (className === undefined || className.length === 0) {
    throw new SurefireParseError(
      `<testcase name="${methodName}"> is missing its \`classname\` attribute`,
    );
  }

  const outcome = classify(tc);
  const location = outcome.location(className);
  const durationMs = parseDurationMs(attr(tc, 'time'));

  return {
    className,
    methodName,
    status: outcome.status,
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

interface Outcome {
  status: SurefireCase['status'];
  message?: string;
  /** Lazily derive the location from the failure/error body for `className`. */
  location: (className: string) => string | undefined;
}

/** A testcase carries at most one of <error>/<failure>/<skipped>; else it passed. */
function classify(tc: XmlElement): Outcome {
  const error = firstChild(tc, 'error');
  if (error) return detailed('error', error);
  const failure = firstChild(tc, 'failure');
  if (failure) return detailed('fail', failure);
  const skipped = firstChild(tc, 'skipped');
  if (skipped) {
    const message = messageOf(skipped);
    return {
      status: 'skip',
      ...(message !== undefined ? { message } : {}),
      location: () => undefined,
    };
  }
  return { status: 'pass', location: () => undefined };
}

function detailed(status: 'fail' | 'error', node: XmlElement): Outcome {
  const message = messageOf(node);
  const body = textOf(node);
  return {
    status,
    ...(message !== undefined ? { message } : {}),
    location: (className: string) => locationFrom(body, className),
  };
}

/** The child's `message` attribute, or its trimmed body text, or undefined. */
function messageOf(node: XmlElement): string | undefined {
  const attrMessage = attr(node, 'message');
  if (attrMessage !== undefined) return attrMessage;
  const body = textOf(node).trim();
  return body.length > 0 ? body : undefined;
}

const FRAME = /\bat\s+([\w.$]+)\(([^)]*)\)/g;

/**
 * The first stack frame belonging to the test class itself — the top project
 * frame, skipping JUnit/JDK internals above it. Returns `File.java:line`, or
 * undefined if no frame names the test class (never guesses a location).
 */
function locationFrom(body: string, className: string): string | undefined {
  FRAME.lastIndex = 0;
  for (let m = FRAME.exec(body); m !== null; m = FRAME.exec(body)) {
    const qualified = m[1]!;
    const source = m[2]!;
    if (qualified === className || qualified.startsWith(`${className}.`)) {
      return source.length > 0 ? source : undefined;
    }
  }
  return undefined;
}

function parseDurationMs(time: string | undefined): number | undefined {
  if (time === undefined) return undefined;
  const seconds = Number.parseFloat(time);
  if (Number.isNaN(seconds)) return undefined;
  return Math.round(seconds * 1000);
}

function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  for (const child of el.children) {
    if (child.type === 'element' && child.name === name) return child;
  }
  return undefined;
}
