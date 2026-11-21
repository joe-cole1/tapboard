/** A small, strict XML reader for untrusted recipe files. It reads elements and text only:
 * attributes are skipped, and DTDs, entity declarations and unknown entities are rejected,
 * so no external fetch and no entity expansion is possible. */
export interface XmlElement {
  readonly name: string;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

export class XmlSyntaxError extends Error {}

export const MAX_XML_DEPTH = 32;
export const MAX_XML_ELEMENTS = 20_000;

const NAME = /[A-Za-z_][-A-Za-z0-9_.:]*/y;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function fail(reason: string): never {
  throw new XmlSyntaxError(reason);
}

function decodeText(raw: string): string {
  if (raw.includes("<")) fail("unescaped_lt");
  return raw.replace(/&(#x?[0-9a-fA-F]{1,16}|[^;&\s#]{0,12});?/gu, (match, body: string) => {
    if (!match.endsWith(";")) fail("bad_entity");
    if (Object.hasOwn(ENTITIES, body)) return ENTITIES[body]!;
    const numeric = /^#(?:x([0-9a-fA-F]{1,16})|([0-9]{1,16}))$/u.exec(body);
    if (!numeric) fail("unknown_entity");
    const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]);
    if (
      code === 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd)
    )
      fail("bad_char_ref");
    return String.fromCodePoint(code);
  });
}

interface OpenElement {
  name: string;
  children: XmlElement[];
  text: string;
}

export function parseXml(source: string): XmlElement {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let elements = 0;
  let root: XmlElement | null = null;
  const stack: OpenElement[] = [];

  const skipMarkup = (): boolean => {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) fail("unclosed_comment");
      index = end + 3;
      return true;
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end < 0) fail("unclosed_instruction");
      index = end + 2;
      return true;
    }
    return false;
  };

  const readName = (): string => {
    NAME.lastIndex = index;
    const match = NAME.exec(source);
    if (!match) fail("bad_name");
    index += match[0].length;
    return match[0];
  };

  // Skip attributes; quoted values may contain ">".
  const readTagEnd = (): boolean => {
    for (;;) {
      while (/\s/u.test(source[index] ?? "")) index++;
      const char = source[index];
      if (char === undefined) fail("unclosed_tag");
      if (char === ">") {
        index++;
        return false;
      }
      if (char === "/" && source[index + 1] === ">") {
        index += 2;
        return true;
      }
      readName();
      while (/\s/u.test(source[index] ?? "")) index++;
      if (source[index] !== "=") fail("bad_attribute");
      index++;
      while (/\s/u.test(source[index] ?? "")) index++;
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail("bad_attribute");
      const end = source.indexOf(quote, index + 1);
      if (end < 0) fail("unclosed_attribute");
      decodeText(source.slice(index + 1, end));
      index = end + 1;
    }
  };

  const close = (element: OpenElement): void => {
    const done: XmlElement = {
      name: element.name,
      children: element.children,
      text: element.text,
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(done);
    else root = done;
  };

  while (index < source.length) {
    const current = stack.at(-1);
    if (source[index] !== "<") {
      const end = source.indexOf("<", index);
      const raw = source.slice(index, end < 0 ? source.length : end);
      if (current) current.text += decodeText(raw);
      else if (raw.trim() !== "") fail("text_outside_root");
      index = end < 0 ? source.length : end;
      continue;
    }
    if (skipMarkup()) continue;
    if (source.startsWith("<![CDATA[", index)) {
      if (!current) fail("cdata_outside_root");
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) fail("unclosed_cdata");
      current.text += source.slice(index + 9, end);
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!", index)) fail("declaration_not_allowed");
    if (source.startsWith("</", index)) {
      index += 2;
      const name = readName();
      while (/\s/u.test(source[index] ?? "")) index++;
      if (source[index] !== ">") fail("bad_close_tag");
      index++;
      const open = stack.pop();
      if (!open || open.name !== name) fail("mismatched_tag");
      close(open);
      continue;
    }
    index++;
    if (root !== null) fail("multiple_roots");
    const name = readName();
    elements++;
    if (elements > MAX_XML_ELEMENTS) fail("too_many_elements");
    if (stack.length >= MAX_XML_DEPTH) fail("too_deep");
    const element: OpenElement = { name, children: [], text: "" };
    if (readTagEnd()) {
      stack.push(element);
      close(stack.pop()!);
    } else stack.push(element);
  }
  if (stack.length > 0) fail("unclosed_element");
  if (root === null) fail("no_root");
  return root;
}
