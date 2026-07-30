// A small, dependency-free, fail-closed XML reader — just enough of XML 1.0 to
// read JUnit test reports (Surefire's `TEST-*.xml`, Gradle's equivalent):
// elements, attributes, self-closing tags, comments, CDATA, character/entity
// references, and the XML declaration. It is deliberately NOT a general XML
// engine (no namespaces resolution, no DTD entity expansion, no processing
// instructions beyond the leading `<?xml?>`).
//
// Why hand-rolled rather than a dependency: this parse sits on the adapter's
// verdict path (a report we misread is a wrong pass/fail), and the packaged
// adapter's bytes are content-hash-pinned (design phase-3.md §3, P3-06) — every
// bundled dependency widens that hash surface. A focused reader we fully test
// (including malformed inputs) is the smaller, more auditable TCB.
//
// Fail-closed posture (invariant 3): anything structurally malformed —
// unterminated tag/quote/comment/CDATA, mismatched close tag, missing root,
// content outside the root — throws `XmlParseError`. A report that cannot be
// parsed is never silently treated as an empty (all-passing) suite.

/** A parsed element node: its tag name, attributes, and ordered children. */
export interface XmlElement {
  type: 'element';
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** A run of character data (text or CDATA), already entity-decoded. */
export interface XmlText {
  type: 'text';
  text: string;
}

export type XmlNode = XmlElement | XmlText;

/** Thrown on any structurally malformed input (fail-closed, invariant 3). */
export class XmlParseError extends Error {
  override readonly name = 'XmlParseError';
}

/**
 * Parse `input` into its single root element. Throws `XmlParseError` on any
 * malformed structure or if there is not exactly one root element.
 */
export function parseXml(input: string): XmlElement {
  const parser = new Parser(input);
  return parser.parseDocument();
}

// ─── Tree accessors (used by surefire.ts) ────────────────────────────────────

/** All descendant elements (any depth) whose tag name is `name`, in document order. */
export function findElements(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement): void => {
    for (const child of el.children) {
      if (child.type === 'element') {
        if (child.name === name) out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** An attribute value, or `undefined` if the element has no such attribute. */
export function attr(el: XmlElement, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : undefined;
}

/** The concatenated character data directly and transitively inside `el`. */
export function textOf(el: XmlElement): string {
  let out = '';
  for (const child of el.children) {
    if (child.type === 'text') out += child.text;
    else out += textOf(child);
  }
  return out;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parseDocument(): XmlElement {
    this.skipProlog();
    if (this.src[this.pos] !== '<') {
      throw new XmlParseError(
        this.pos >= this.src.length
          ? 'no root element found'
          : `unexpected content before root element at offset ${this.pos}`,
      );
    }
    const root = this.parseElement();
    this.skipMisc();
    if (this.pos < this.src.length) {
      throw new XmlParseError(
        `unexpected trailing content after root element at offset ${this.pos}`,
      );
    }
    return root;
  }

  /** Skip the leading `<?xml?>` declaration plus any comments/whitespace before the root. */
  private skipProlog(): void {
    this.skipWhitespace();
    if (this.src.startsWith('<?', this.pos)) {
      const end = this.src.indexOf('?>', this.pos);
      if (end < 0) throw new XmlParseError('unterminated XML declaration');
      this.pos = end + 2;
    }
    this.skipMisc();
  }

  /** Skip inter-element whitespace, comments, and DOCTYPE declarations. */
  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.src.startsWith('<!--', this.pos)) {
        this.skipComment();
      } else if (this.src.startsWith('<!', this.pos)) {
        // A DOCTYPE (or other markup declaration) — skip to its closing '>'.
        const end = this.src.indexOf('>', this.pos);
        if (end < 0) throw new XmlParseError('unterminated markup declaration');
        this.pos = end + 1;
      } else {
        return;
      }
    }
  }

  private skipComment(): void {
    const end = this.src.indexOf('-->', this.pos);
    if (end < 0) throw new XmlParseError('unterminated comment');
    this.pos = end + 3;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && isWhitespace(this.src[this.pos]!)) this.pos++;
  }

  /** Parse one element starting at a '<'. Returns once its close tag is consumed. */
  private parseElement(): XmlElement {
    this.expect('<');
    const name = this.readName();
    if (name.length === 0) throw new XmlParseError(`empty tag name at offset ${this.pos}`);
    const attrs = this.parseAttributes();

    if (this.src.startsWith('/>', this.pos)) {
      this.pos += 2;
      return { type: 'element', name, attrs, children: [] };
    }
    this.expect('>');

    const children = this.parseChildren(name);
    return { type: 'element', name, attrs, children };
  }

  private parseAttributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      this.skipWhitespace();
      const c = this.src[this.pos];
      if (c === undefined) throw new XmlParseError('unexpected end of input inside a tag');
      if (c === '>' || c === '/') return attrs;

      const attrName = this.readName();
      if (attrName.length === 0) {
        throw new XmlParseError(`malformed attribute at offset ${this.pos}`);
      }
      this.skipWhitespace();
      this.expect('=');
      this.skipWhitespace();
      const quote = this.src[this.pos];
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(
          `attribute \`${attrName}\` value is not quoted at offset ${this.pos}`,
        );
      }
      this.pos++;
      const end = this.src.indexOf(quote, this.pos);
      if (end < 0) throw new XmlParseError(`unterminated value for attribute \`${attrName}\``);
      attrs[attrName] = decodeEntities(this.src.slice(this.pos, end));
      this.pos = end + 1;
    }
  }

  /** Parse an element's content until its matching `</name>` close tag. */
  private parseChildren(name: string): XmlNode[] {
    const children: XmlNode[] = [];
    for (;;) {
      if (this.pos >= this.src.length) {
        throw new XmlParseError(`unterminated element \`${name}\` (reached end of input)`);
      }
      if (this.src.startsWith('</', this.pos)) {
        this.pos += 2;
        const close = this.readName();
        this.skipWhitespace();
        this.expect('>');
        if (close !== name) {
          throw new XmlParseError(
            `mismatched close tag: expected </${name}> but found </${close}>`,
          );
        }
        return children;
      }
      if (this.src.startsWith('<!--', this.pos)) {
        this.skipComment();
        continue;
      }
      if (this.src.startsWith('<![CDATA[', this.pos)) {
        const end = this.src.indexOf(']]>', this.pos);
        if (end < 0) throw new XmlParseError('unterminated CDATA section');
        pushText(children, this.src.slice(this.pos + '<![CDATA['.length, end));
        this.pos = end + 3;
        continue;
      }
      if (this.src[this.pos] === '<') {
        children.push(this.parseElement());
        continue;
      }
      // Character data up to the next markup.
      const next = this.src.indexOf('<', this.pos);
      const end = next < 0 ? this.src.length : next;
      pushText(children, decodeEntities(this.src.slice(this.pos, end)));
      this.pos = end;
    }
  }

  private readName(): string {
    const start = this.pos;
    while (this.pos < this.src.length && isNameChar(this.src[this.pos]!)) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private expect(ch: string): void {
    if (this.src[this.pos] !== ch) {
      throw new XmlParseError(
        `expected '${ch}' at offset ${this.pos} but found ` +
          (this.pos < this.src.length ? `'${this.src[this.pos]!}'` : 'end of input'),
      );
    }
    this.pos++;
  }
}

function pushText(children: XmlNode[], text: string): void {
  if (text.length === 0) return;
  const last = children[children.length - 1];
  if (last && last.type === 'text') last.text += text;
  else children.push({ type: 'text', text });
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isNameChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '_' ||
    c === '-' ||
    c === '.' ||
    c === ':'
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** Decode the five XML predefined entities plus numeric/hex character references. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    // An unknown named entity is left verbatim rather than thrown: report text
    // carries user assertion messages, and a stray literal `&word;` there must
    // not fail a verdict parse. The five predefined entities are what matter.
    return named ?? match;
  });
}
