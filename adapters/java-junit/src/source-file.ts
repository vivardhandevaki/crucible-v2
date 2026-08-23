// Ground a discovered JUnit class in Java source (design phase-3.md §2). The
// returned path becomes approval-hash input, so this module is intentionally
// conservative: configured roots only, project-contained regular files only,
// and a lexical declaration check that ignores comments and literals.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface GroundTargetFileOptions {
  /** Project root; returned paths are relative to this directory. */
  root: string;
  /** Binary class name. Inner classes are grounded to their outermost type. */
  className: string;
  /** Absolute or project-relative roots reported by the build tool model. */
  sourceRoots: readonly string[];
}

/** Return a verified repo-relative Java source path, or undefined. */
export function groundTargetFile(options: GroundTargetFileOptions): string | undefined {
  const root = realpathIfPresent(options.root);
  if (root === undefined) return undefined;

  const outerClass = options.className.split('$', 1)[0]!;
  const parts = outerClass.split('.');
  const simpleName = parts.pop();
  if (simpleName === undefined || !isJavaIdentifier(simpleName)) return undefined;
  if (parts.some((part) => !isJavaIdentifier(part))) return undefined;
  const sourceRel = join(...parts, `${simpleName}.java`);

  for (const configuredRoot of options.sourceRoots) {
    const sourceRoot = resolve(options.root, configuredRoot);
    const candidate = join(sourceRoot, sourceRel);
    if (!existsSync(candidate)) continue;

    let canonical: string;
    try {
      canonical = realpathSync(candidate);
      if (!statSync(canonical).isFile() || !isContained(root, canonical)) continue;
    } catch {
      continue;
    }

    let text: string;
    try {
      text = readFileSync(canonical, 'utf8');
    } catch {
      continue;
    }
    if (!declaresType(text, simpleName)) continue;
    return relative(root, canonical).split(sep).join('/');
  }
  return undefined;
}

function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isJavaIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

/**
 * A small lexer sufficient for declaration grounding. It replaces comments,
 * quoted strings/chars, and text blocks with spaces, preserving token gaps,
 * then looks for a Java type-declaration keyword followed by the exact name.
 */
function declaresType(source: string, simpleName: string): boolean {
  const code = stripCommentsAndLiterals(source);
  const escaped = simpleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:class|interface|enum|record)\\s+${escaped}\\b`).test(code);
}

function stripCommentsAndLiterals(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const pair = source.slice(i, i + 2);
    if (pair === '//') {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) return out + ' '.repeat(source.length - i);
      out += ' '.repeat(end - i) + '\n';
      i = end + 1;
      continue;
    }
    if (pair === '/*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return out + ' '.repeat(source.length - i);
      const hidden = source.slice(i, end + 2).replace(/[^\n]/g, ' ');
      out += hidden;
      i = end + 2;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end < 0) return out + ' '.repeat(source.length - i);
      out += source.slice(i, end + 3).replace(/[^\n]/g, ' ');
      i = end + 3;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i++] === quote) break;
      }
      out += source.slice(start, i).replace(/[^\n]/g, ' ');
      continue;
    }
    out += source[i++];
  }
  return out;
}
