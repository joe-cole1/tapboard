/**
 * Stylesheet guardrails; docs/architecture.md ("Architecture enforcement") describes each rule.
 * Compares every class in public/css (plus the generated /assets/css/display.css) with the
 * markup in views/, public/js and src/, checks each hand-written rule's layer and declarations,
 * and reports the violated rule and path.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { generateDisplayStylesheet } from "../src/features/display/palette.ts";

/** Class families whose modifier comes from data, such as `status-badge--<%= fill.state %>`. */
export const DYNAMIC_MODIFIER_PREFIXES: readonly string[] = [
  "display-accent-swatch--",
  "display-font-preview--",
  "health-badge--",
  "status-badge--",
  "tap-badge--",
  "tap-wars-current--",
];

/**
 * The only `!important` declarations allowed. `[hidden]` must win over every `display`, and an
 * important declaration in the base layer beats any later layer's.
 */
export const IMPORTANT_ALLOWED: readonly {
  readonly selector: string;
  readonly property: string;
}[] = [{ selector: "[hidden]", property: "display" }];

/** CSS named colours; `transparent` and `currentColor` are not literals. */
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);
/** Properties whose identifiers are names (fonts, animations, grid areas), never colours. */
const NAME_PROPERTIES =
  /^(?:font|font-family|animation|animation-name|transition|transition-property|will-change|container|container-name|view-transition-name|counter-(?:reset|increment|set)|grid-(?:area|row|column|template|template-areas)(?:-start|-end)?)$/u;
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu;
const HEX_COLOUR = /(?<![\w-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/iu;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface CssCheckInput {
  /** Hand-written stylesheets: every rule applies. */
  readonly stylesheets: readonly SourceFile[];
  /** Stylesheets built by code: they only define classes. */
  readonly generatedStylesheets: readonly SourceFile[];
  /** Eta templates: markup, and the no-inline-CSS rule. */
  readonly views: readonly SourceFile[];
  /** Browser scripts and server code that build class names. */
  readonly scripts: readonly SourceFile[];
}

export type CssRuleName =
  | "inline-style"
  | "undefined-class"
  | "unused-selector"
  | "duplicate-selector"
  | "dynamic-class"
  | "colour-literal"
  | "important"
  | "unlayered";

/** The cascade layers tokens.css declares, lowest priority first. */
export const CASCADE_LAYERS: readonly string[] = ["tokens", "base", "components", "features"];

export interface CssViolation {
  readonly rule: CssRuleName;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

export interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
  readonly line: number;
}

interface StyleRule {
  readonly selector: string;
  readonly context: string;
  readonly line: number;
  readonly declarations: readonly Declaration[];
}

interface ClassUse {
  readonly name: string;
  readonly path: string;
  readonly line: number;
}

interface Markup {
  readonly classes: ClassUse[];
  readonly dynamicPrefixes: ClassUse[];
}

const CLASS_TOKEN = /^-?[_a-zA-Z][\w-]*$/u;
const BLOCK_AT_RULES = new Set(["media", "supports", "container", "layer", "scope", "keyframes"]);

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) if (text[position] === "\n") line += 1;
  return line;
}

/** A faster `lineAt` for one text that is asked about many positions. */
function lineFinder(text: string): (index: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1)
    if (text[index] === "\n") starts.push(index + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle]! <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Index just past the string literal that opens at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
  return index + 1;
}

/** Index of the `}` that closes the block opened at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") index = skipString(text, index) - 1;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return text.length;
}

function normalizeSelector(selector: string): string {
  return selector
    .replace(/\s+/gu, " ")
    .replace(/\s*([,>+~])\s*/gu, "$1")
    .trim();
}

/** The declarations of the block between `open` and `close`, skipping any nested block. */
function parseDeclarations(
  text: string,
  open: number,
  close: number,
  line: (index: number) => number,
): Declaration[] {
  const declarations: Declaration[] = [];
  let start = open + 1;
  let depth = 0;
  for (let index = open + 1; index <= close; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = skipString(text, index) - 1;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "{") {
      index = closingBrace(text, index);
      start = index + 1;
    } else if ((char === ";" && depth === 0) || index === close) {
      const raw = text.slice(start, index);
      const colon = raw.indexOf(":");
      if (colon > 0) {
        const value = raw.slice(colon + 1).trim();
        const important = /!\s*important$/iu.test(value);
        declarations.push({
          property: raw.slice(0, colon).trim(),
          value: important ? value.replace(/\s*!\s*important$/iu, "") : value,
          important,
          line: line(start + raw.length - raw.trimStart().length),
        });
      }
      start = index + 1;
    }
  }
  return declarations;
}

/** Every style rule with its at-rule context. Comments are blanked so line numbers hold. */
export function parseStylesheet(css: string): StyleRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
  const line = lineFinder(text);
  const rules: StyleRule[] = [];
  const contexts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = skipString(text, index) - 1;
    } else if (char === ";") {
      start = index + 1;
    } else if (char === "}") {
      contexts.pop();
      start = index + 1;
    } else if (char === "{") {
      const prelude = text.slice(start, index);
      const head = prelude.trim();
      const atRule = /^@([\w-]+)/u.exec(head)?.[1];
      if (atRule !== undefined && BLOCK_AT_RULES.has(atRule)) {
        contexts.push(head.replace(/\s+/gu, " "));
        start = index + 1;
        continue;
      }
      const close = closingBrace(text, index);
      if (atRule === undefined) {
        const offset = start + prelude.length - prelude.trimStart().length;
        rules.push({
          selector: normalizeSelector(head),
          context: contexts.join(" "),
          line: line(offset),
          declarations: parseDeclarations(text, index, close, line),
        });
      }
      index = close;
      start = index + 1;
    }
  }
  return rules;
}

/** Class names a selector mentions, ignoring attribute values and strings. */
export function selectorClasses(selector: string): string[] {
  const bare = selector.replace(/"[^"]*"|'[^']*'/gu, "").replace(/\[[^\]]*\]/gu, "");
  return [...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((match) => match[1]!);
}

/** Index of the top-level `target` character in `text`, outside strings and brackets. */
function topLevel(text: string, target: "?" | ":", from = 0): number {
  let depth = 0;
  let pending = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") index = skipString(text, index) - 1;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (depth > 0) continue;
    else if (char === "?") {
      // Optional chaining and nullish coalescing are not conditionals.
      if (text[index + 1] === "." || text[index + 1] === "?" || text[index - 1] === "?") continue;
      if (target === "?") return index;
      pending += 1;
    } else if (char === ":" && target === ":") {
      if (pending === 0) return index;
      pending -= 1;
    }
  }
  return -1;
}

function stripParentheses(expression: string): string {
  let result = expression.trim();
  while (result.startsWith("(") && closingParenthesis(result) === result.length - 1)
    result = result.slice(1, -1).trim();
  return result;
}

function closingParenthesis(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") index = skipString(text, index) - 1;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * The values an expression can produce: the literal strings of a (nested) conditional, or
 * `null` for any branch whose value comes from data.
 */
export function expressionOutcomes(expression: string): (string | null)[] {
  const text = stripParentheses(expression);
  const literal = /^(["'])((?:(?!\1)[^\\]|\\.)*)\1$/u.exec(text);
  if (literal !== null) return [literal[2]!];
  if (/^`[^`$]*`$/u.test(text)) return [text.slice(1, -1)];
  const union = /^(["'])[^"']*\1(?:\s*\|\s*(["'])[^"']*\2)+$/u.test(text);
  if (union) return [...text.matchAll(/["']([^"']*)["']/gu)].map((match) => match[1]!);
  const question = topLevel(text, "?");
  if (question < 0) return [null];
  const colon = topLevel(text, ":", question + 1);
  if (colon < 0) return [null];
  return [
    ...expressionOutcomes(text.slice(question + 1, colon)),
    ...expressionOutcomes(text.slice(colon + 1)),
  ];
}

/** A class attribute value split into literal text and output expressions. */
interface Template {
  readonly text: string;
  readonly expressions: readonly string[];
}

const EXPRESSION_MARK = "\u0001";

function classTokens(template: Template, path: string, line: number, markup: Markup): void {
  const tokens = template.text.split(/\s+/u).filter(Boolean);
  let next = 0;
  for (const token of tokens) {
    const marks = token.split(EXPRESSION_MARK).length - 1;
    if (marks === 0) {
      if (CLASS_TOKEN.test(token)) markup.classes.push({ name: token, path, line });
      continue;
    }
    const expressions = template.expressions.slice(next, next + marks);
    next += marks;
    const [prefix = "", ...rest] = token.split(EXPRESSION_MARK);
    const suffix = rest.join("");
    const outcomes = marks === 1 ? expressionOutcomes(expressions[0]!) : [null];
    for (const outcome of outcomes) {
      if (outcome === null) {
        if (prefix !== "") markup.dynamicPrefixes.push({ name: prefix, path, line });
        continue;
      }
      for (const name of `${prefix}${outcome}${suffix}`.split(/\s+/u).filter(Boolean))
        if (CLASS_TOKEN.test(name)) markup.classes.push({ name, path, line });
    }
  }
}

/** Reads `<% %>` (Eta) or `${ }` (template literal) expressions until the closing quote. */
function readTemplate(
  text: string,
  start: number,
  quote: string,
): { template: Template; end: number } {
  let literal = "";
  const expressions: string[] = [];
  let index = start;
  while (index < text.length && text[index] !== quote) {
    if (text.startsWith("<%", index)) {
      const close = text.indexOf("%>", index + 2);
      const end = close < 0 ? text.length : close;
      const body = text.slice(index + 2, end);
      const output = /^[=~]/u.exec(body);
      if (output !== null) {
        expressions.push(
          body
            .slice(1)
            .replace(/^-|-$|_$/gu, "")
            .trim(),
        );
        literal += EXPRESSION_MARK;
      }
      index = end + 2;
    } else if (text.startsWith("${", index)) {
      const end = closingBrace(text, index + 1);
      expressions.push(text.slice(index + 2, end).trim());
      literal += EXPRESSION_MARK;
      index = end + 1;
    } else {
      literal += text[index];
      index += 1;
    }
  }
  return { template: { text: literal, expressions }, end: index };
}

function collectClassAttributes(file: SourceFile, markup: Markup): void {
  for (const match of file.text.matchAll(/(?<![\w-])class\s*=\s*(["'])/gu)) {
    const start = match.index + match[0].length;
    const { template } = readTemplate(file.text, start, match[1]!);
    classTokens(template, file.path, lineAt(file.text, match.index), markup);
  }
}

/** The right-hand side of an assignment or property, up to the end of the statement. */
function rightHandSide(text: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") index = skipString(text, index) - 1;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) return text.slice(start, index);
      depth -= 1;
    } else if (depth === 0 && (char === ";" || char === "," || char === "\n"))
      return text.slice(start, index);
  }
  return text.slice(start);
}

function collectScriptClasses(file: SourceFile, markup: Markup): void {
  collectClassAttributes(file, markup);
  const add = (expression: string, index: number): void => {
    const line = lineAt(file.text, index);
    const value = expression.trim();
    if (value.startsWith("`")) {
      const { template } = readTemplate(value, 1, "`");
      classTokens(template, file.path, line, markup);
      return;
    }
    classTokens({ text: EXPRESSION_MARK, expressions: [value] }, file.path, line, markup);
  };
  // `element.className = …`, `{ className: … }`, `className: "a" | "b"` types, and the
  // `{ class: … }` attributes of elements a script builds.
  for (const match of file.text.matchAll(
    /\bclassName\??\s*(?:=(?!=)|:)\s*|(?<![\w.-])class:\s*/gu,
  )) {
    const start = match.index + match[0].length;
    add(rightHandSide(file.text, start).replace(/^[^"'`=]*\]\s*=\s*/u, ""), match.index);
  }
  for (const match of file.text.matchAll(
    /\bclassList\.(?:add|remove|toggle|replace|contains)\(/gu,
  )) {
    const args = rightHandSide(file.text, match.index + match[0].length);
    for (const literal of args.matchAll(/(["'`])([^"'`]*)\1/gu)) add(literal[0], match.index);
  }
  for (const match of file.text.matchAll(/setAttribute\(\s*["']class["']\s*,/gu))
    add(rightHandSide(file.text, match.index + match[0].length), match.index);
}

function inlineStyles(file: SourceFile): CssViolation[] {
  const violations: CssViolation[] = [];
  // Eta tags hold JavaScript (`it.beverage.style === null`), not markup.
  const markup = file.text.replace(/<%[\s\S]*?%>/gu, (tag) => tag.replace(/[^\n]/gu, " "));
  for (const match of markup.matchAll(/<style[\s>]|<[a-zA-Z][^>]*?(?<![\w:.-])style\s*=/gu)) {
    const element = match[0].startsWith("<style");
    violations.push({
      rule: "inline-style",
      path: file.path,
      line: lineAt(file.text, match.index),
      message: element
        ? "a <style> element; put the rules in public/css"
        : "a style attribute; use a class (the CSP is style-src 'self')",
    });
  }
  return violations;
}

/** The first colour literal in a declaration's value, ignoring strings, `url()` and grid line names. */
export function colourLiteral(
  declaration: Pick<Declaration, "property" | "value">,
): string | undefined {
  const value = declaration.value
    .replace(/"[^"]*"|'[^']*'/gu, "")
    .replace(/(?<![\w-])url\([^)]*\)/giu, "")
    .replace(/\[[^\]]*\]/gu, "");
  const literal = HEX_COLOUR.exec(value)?.[0] ?? COLOUR_FUNCTION.exec(value)?.[0];
  if (literal !== undefined) return literal;
  if (NAME_PROPERTIES.test(declaration.property.toLowerCase())) return undefined;
  return value
    .match(/(?<![\w-])[a-z]+(?![\w-])/giu)
    ?.find((word) => NAMED_COLOURS.has(word.toLowerCase()));
}

const PRINT_CONTEXT = /@media print\b/u;

function ruleViolations(sheet: SourceFile, rule: StyleRule): CssViolation[] {
  const violations: CssViolation[] = [];
  const layer = /@layer ([\w-]+)/u.exec(rule.context)?.[1];
  if (layer === undefined || !CASCADE_LAYERS.includes(layer))
    violations.push({
      rule: "unlayered",
      path: sheet.path,
      line: rule.line,
      message: `\`${rule.selector}\` is ${layer === undefined ? "not in a cascade layer" : `in an undeclared layer \`${layer}\``}; put it in @layer ${CASCADE_LAYERS.join(", ")}`,
    });
  const literalsAllowed = basename(sheet.path) === "tokens.css" || PRINT_CONTEXT.test(rule.context);
  for (const declaration of rule.declarations) {
    const allowed = IMPORTANT_ALLOWED.some(
      (entry) => entry.selector === rule.selector && entry.property === declaration.property,
    );
    if (declaration.important && !allowed)
      violations.push({
        rule: "important",
        path: sheet.path,
        line: declaration.line,
        message: `\`${declaration.property}\` in \`${rule.selector}\` is !important; let the cascade layers decide, or add it to IMPORTANT_ALLOWED`,
      });
    const literal = literalsAllowed ? undefined : colourLiteral(declaration);
    if (literal !== undefined)
      violations.push({
        rule: "colour-literal",
        path: sheet.path,
        line: declaration.line,
        message: `\`${literal}\` is a colour literal; use a palette role (src/features/display/palette.ts) or a token in tokens.css`,
      });
  }
  return violations;
}

export function checkCss(input: CssCheckInput): CssViolation[] {
  const violations: CssViolation[] = input.views.flatMap(inlineStyles);

  const markup: Markup = { classes: [], dynamicPrefixes: [] };
  for (const view of input.views) collectClassAttributes(view, markup);
  for (const script of input.scripts) collectScriptClasses(script, markup);

  const defined = new Set<string>();
  for (const sheet of [...input.stylesheets, ...input.generatedStylesheets])
    for (const rule of parseStylesheet(sheet.text))
      for (const name of selectorClasses(rule.selector)) defined.add(name);

  const used = new Set(markup.classes.map((use) => use.name));
  const prefixes = new Set(markup.dynamicPrefixes.map((use) => use.name));
  const reported = new Set<string>();
  const once = (key: string): boolean => !reported.has(key) && Boolean(reported.add(key));

  for (const use of markup.dynamicPrefixes) {
    if (DYNAMIC_MODIFIER_PREFIXES.includes(use.name) || !once(`dynamic|${use.path}|${use.name}`))
      continue;
    violations.push({
      rule: "dynamic-class",
      path: use.path,
      line: use.line,
      message: `\`${use.name}…\` is built from data; use a data-* attribute, or list a modifier family in DYNAMIC_MODIFIER_PREFIXES`,
    });
  }

  for (const use of markup.classes) {
    if (defined.has(use.name) || !once(`undefined|${use.path}|${use.name}`)) continue;
    violations.push({
      rule: "undefined-class",
      path: use.path,
      line: use.line,
      message: `\`${use.name}\` is not defined in any stylesheet; style it, remove it, or use a data-* hook`,
    });
  }

  const isUsed = (name: string): boolean =>
    used.has(name) ||
    [...prefixes].some(
      (prefix) =>
        DYNAMIC_MODIFIER_PREFIXES.includes(prefix) &&
        name.startsWith(prefix) &&
        name.length > prefix.length,
    );
  for (const sheet of input.stylesheets) {
    const selectors = new Map<string, number>();
    for (const rule of parseStylesheet(sheet.text)) {
      violations.push(...ruleViolations(sheet, rule));
      for (const name of selectorClasses(rule.selector)) {
        if (isUsed(name) || !once(`unused|${sheet.path}|${name}`)) continue;
        violations.push({
          rule: "unused-selector",
          path: sheet.path,
          line: rule.line,
          message: `\`.${name}\` is not used by any template or script; delete the rule`,
        });
      }
      const key = `${rule.context}\u0000${rule.selector}`;
      const first = selectors.get(key);
      if (first === undefined) selectors.set(key, rule.line);
      else
        violations.push({
          rule: "duplicate-selector",
          path: sheet.path,
          line: rule.line,
          message: `\`${rule.selector}\`${rule.context ? ` in ${rule.context}` : ""} is already declared at line ${first}; merge the rules`,
        });
    }
  }

  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function filesUnder(root: string, directory: string, extension: string): SourceFile[] {
  let names: string[];
  try {
    names = readdirSync(join(root, directory), { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => {
      const path = join(root, directory, name);
      return { path: relative(root, path), text: readFileSync(path, "utf8") };
    });
}

/** Reads a checkout. The display stylesheet always comes from this checkout's palette code. */
export function readCheckout(root: string): CssCheckInput {
  return {
    stylesheets: filesUnder(root, "public/css", ".css"),
    generatedStylesheets: [
      {
        path: "/assets/css/display.css",
        text: generateDisplayStylesheet("auto", "theme", "all").css,
      },
    ],
    views: filesUnder(root, "views", ".eta"),
    scripts: [...filesUnder(root, "public/js", ".js"), ...filesUnder(root, "src", ".ts")],
  };
}

// `import.meta.main` needs Node 24.2; package.json allows any Node 24.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.env.TAPBOARD_CSS_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
  const violations = checkCss(readCheckout(root));
  for (const violation of violations)
    process.stderr.write(
      `css violation: [${violation.rule}] ${violation.path}:${violation.line} ${violation.message}\n`,
    );
  if (violations.length > 0) {
    process.stderr.write(`${violations.length} CSS violation(s) found.\n`);
    process.exit(1);
  }
  process.stdout.write("CSS guardrails passed.\n");
}
