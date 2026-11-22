import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkCss,
  expressionOutcomes,
  parseStylesheet,
  readCheckout,
  selectorClasses,
  type CssCheckInput,
  type SourceFile,
} from "../scripts/check-css.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = fileURLToPath(new URL("../scripts/check-css.ts", import.meta.url));

function files(entries: Readonly<Record<string, string>>): SourceFile[] {
  return Object.entries(entries).map(([path, text]) => ({ path, text }));
}

/** Stylesheets in a cascade layer; the wrapper starts on line 1, so line numbers hold. */
function layered(entries: Readonly<Record<string, string>>): SourceFile[] {
  return files(
    Object.fromEntries(
      Object.entries(entries).map(([path, text]) => [path, `@layer components { ${text}\n}`]),
    ),
  );
}

function check(input: Partial<CssCheckInput>): { rule: string; path: string; line: number }[] {
  return checkCss({
    stylesheets: [],
    generatedStylesheets: [],
    views: [],
    scripts: [],
    ...input,
  }).map(({ rule, path, line }) => ({ rule, path, line }));
}

const cleanStylesheet = `
.card { padding: 1rem; }
.card__title, .card--wide { margin: 0; }
.status-badge { border: 1px solid; }
.status-badge--healthy, .status-badge--muted { color: var(--success); }
.is-open:not(.card) [data-x="a.b"] { display: block; }
@media (max-width: 40rem) { .card { padding: 0; } }
.script-made { color: var(--danger); }
.toggled { color: var(--secondary); }
`;

void test("markup that uses every rule, and only defined classes, passes", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({ "public/css/app.css": cleanStylesheet }),
      generatedStylesheets: files({ "display.css": ".generated-shell{--x:1}" }),
      views: files({
        "views/page.eta": [
          '<main class="generated-shell"><article class="card <%= it.wide ? "card--wide" : "" %>">',
          '<h2 class="card__title<% if (it.open) { %> is-open<% } %>" data-preview-style="x">',
          '<span class="status-badge status-badge--<%= it.state %>"></span>',
          '<span class="status-badge status-badge--<%= it.ok === "yes" ? "healthy" : "muted" %>"></span>',
          '<input name="style" value="<%= it.beverage.style === null ? "" : it.beverage.style %>" />',
          "</h2></article></main>",
        ].join("\n"),
      }),
      scripts: files({
        "public/js/app.js":
          'element.className = "script-made";\nelement.classList.toggle("toggled", open);\n',
      }),
    }),
    [],
  );
});

void test("a style attribute or a <style> element in a view fails", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({ "public/css/app.css": ".card { padding: 0; }" }),
      views: files({
        "views/a.eta": '<div class="card" style="color: red"></div>',
        "views/b.eta": '<style>.card { color: red; }</style>\n<p class="card"></p>',
      }),
    }),
    [
      { rule: "inline-style", path: "views/a.eta", line: 1 },
      { rule: "inline-style", path: "views/b.eta", line: 1 },
    ],
  );
});

void test("a class used in markup that no stylesheet defines fails", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({ "public/css/app.css": ".card { padding: 0; }" }),
      views: files({
        "views/page.eta": '<div class="card">\n<p class="card__missing"></p></div>',
      }),
      scripts: files({
        "public/js/app.js":
          'node.className = flag ? "card" : "card--missing";\nsvgElement("rect", { class: "card-rect" });\n',
        "src/types.ts": 'readonly className: "card" | "card-part";\n',
      }),
    }),
    [
      { rule: "undefined-class", path: "public/js/app.js", line: 1 },
      { rule: "undefined-class", path: "public/js/app.js", line: 2 },
      { rule: "undefined-class", path: "src/types.ts", line: 1 },
      { rule: "undefined-class", path: "views/page.eta", line: 2 },
    ],
  );
});

void test("a selector class nothing uses fails", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({
        "public/css/app.css": ".card { padding: 0; }\n\n.card .forgotten { margin: 0; }\n",
      }),
      views: files({ "views/page.eta": '<div class="card"></div>' }),
    }),
    [{ rule: "unused-selector", path: "public/css/app.css", line: 3 }],
  );
});

void test("the same selector declared twice in one context of one file fails", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({
        "public/css/app.css": [
          ".card { padding: 0; }",
          "@media (max-width: 40rem) { .card { padding: 1rem; } }",
          ".card , .card--wide { margin: 0; }",
          "/* a comment */ .card {",
          "  color: var(--danger);",
          "}",
        ].join("\n"),
        "public/css/other.css": ".card { color: var(--secondary); }",
      }),
      views: files({ "views/page.eta": '<div class="card card--wide"></div>' }),
    }),
    [{ rule: "duplicate-selector", path: "public/css/app.css", line: 4 }],
  );
});

void test("a class built from data needs an allowed modifier family", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({
        "public/css/app.css": ".card { padding: 0; } .card--a { margin: 0; }",
      }),
      views: files({ "views/page.eta": '<div class="card card--<%= it.kind %>"></div>' }),
    }),
    [
      { rule: "unused-selector", path: "public/css/app.css", line: 1 },
      { rule: "dynamic-class", path: "views/page.eta", line: 1 },
    ],
  );
});

void test("conditional expressions yield their literal branches", () => {
  assert.deepEqual(expressionOutcomes('a === "x" ? "one" : b ? (c ? "two" : "") : "three"'), [
    "one",
    "two",
    "",
    "three",
  ]);
  assert.deepEqual(expressionOutcomes('a?.b ?? c ? d.state : "muted"'), [null, "muted"]);
  assert.deepEqual(expressionOutcomes("`static`"), ["static"]);
});

void test("selectors are parsed with their context, declarations and no attribute values", () => {
  const rules = parseStylesheet(
    '@font-face { font-family: X; }\n@media print { .a > .b[data-c=".d"] { color: red; } }\n@keyframes k { from { opacity: 0; } }\n.c {\n  content: "a;b";\n  margin: 0 !important\n}',
  );
  assert.deepEqual(rules, [
    {
      selector: '.a>.b[data-c=".d"]',
      context: "@media print",
      line: 2,
      declarations: [{ property: "color", value: "red", important: false, line: 2 }],
    },
    {
      selector: "from",
      context: "@keyframes k",
      line: 3,
      declarations: [{ property: "opacity", value: "0", important: false, line: 3 }],
    },
    {
      selector: ".c",
      context: "",
      line: 4,
      declarations: [
        { property: "content", value: '"a;b"', important: false, line: 5 },
        { property: "margin", value: "0", important: true, line: 6 },
      ],
    },
  ]);
  assert.deepEqual(selectorClasses(rules[0]!.selector), ["a", "b"]);
});

void test("a colour literal outside tokens.css, the generated palettes and print fails", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({
        "public/css/tokens.css": ":root { --unknown: #a855f7; --scrim: rgb(0 0 0 / 60%); }",
        "public/css/app.css": [
          ".a { color: #a855f7; }",
          ".b {",
          "  box-shadow: 0 -0.4rem 1rem rgb(0 0 0 / 22%);",
          "}",
          ".c { --tint: Red; }",
          ".d { color: transparent; border-color: currentColor; white-space: nowrap; }",
          '.e { background: url("#a.svg"), url(#b) var(--surface); content: "#fff tan"; }',
          ".f { background: color-mix(in srgb, var(--accent) 12%, transparent); font-family: Tan; }",
          "@media print { .a { color: #111; } }",
          ".g { background: conic-gradient(var(--danger), hsl(0 0% 50%)); }",
          "@keyframes pulse { to { color: #fff; } }",
          ".i { grid-template-columns: [tan-start] 1fr [red] auto; }",
        ].join("\n"),
      }),
      generatedStylesheets: files({ "display.css": ".h{--x:#fff;background:#000}" }),
      views: files({ "views/page.eta": '<p class="a b c d e f g h i"></p>' }),
    }),
    [
      { rule: "colour-literal", path: "public/css/app.css", line: 1 },
      { rule: "colour-literal", path: "public/css/app.css", line: 3 },
      { rule: "colour-literal", path: "public/css/app.css", line: 5 },
      { rule: "colour-literal", path: "public/css/app.css", line: 10 },
      { rule: "colour-literal", path: "public/css/app.css", line: 11 },
    ],
  );
});

void test("a rule outside a declared cascade layer fails", () => {
  assert.deepEqual(
    check({
      stylesheets: files({
        "public/css/app.css": [
          "@layer tokens, base, components, features;",
          ".a { margin: 0; }",
          "@layer base { .b { margin: 0; } }",
          "@media (max-width: 40rem) { @layer features { .c { margin: 0; } } .d { margin: 0; } }",
          "@layer feature { .e { margin: 0; } }",
          "@keyframes k { to { opacity: 0; } }",
        ].join("\n"),
      }),
      views: files({ "views/page.eta": '<p class="a b c d e"></p>' }),
    }),
    [
      { rule: "unlayered", path: "public/css/app.css", line: 2 },
      { rule: "unlayered", path: "public/css/app.css", line: 4 },
      { rule: "unlayered", path: "public/css/app.css", line: 5 },
      { rule: "unlayered", path: "public/css/app.css", line: 6 },
    ],
  );
});

void test("!important outside the allow-list fails", () => {
  assert.deepEqual(
    check({
      stylesheets: layered({
        "public/css/tokens.css":
          "[hidden] { display: none !important; }\n.a { position: absolute !important; }",
        "public/css/app.css": [
          ".b { margin: 0 !important; padding: 0; }",
          ".c {",
          "  display: block!important;",
          "}",
          "[hidden] { opacity: 0 !IMPORTANT; }",
          '.d { content: "!important"; }',
        ].join("\n"),
      }),
      views: files({ "views/page.eta": '<p class="a b c d"></p>' }),
    }),
    [
      { rule: "important", path: "public/css/app.css", line: 1 },
      { rule: "important", path: "public/css/app.css", line: 3 },
      { rule: "important", path: "public/css/app.css", line: 5 },
      { rule: "important", path: "public/css/tokens.css", line: 2 },
    ],
  );
});

void test("classes defined only by the generated display stylesheet count as defined", () => {
  const generated = readCheckout(repositoryRoot).generatedStylesheets.flatMap((sheet) =>
    parseStylesheet(sheet.text).flatMap((rule) => selectorClasses(rule.selector)),
  );
  assert.ok(generated.includes("admin-shell"));
  assert.ok(generated.includes("display-preview"));
});

void test("the repository's stylesheets and markup pass every CSS rule", () => {
  assert.deepEqual(checkCss(readCheckout(repositoryRoot)), []);
});

void test("the command reports each violation and exits non-zero", () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "tapboard-css-"));
  const write = (path: string, contents: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  try {
    write("public/css/app.css", "@layer components { .card { padding: 0; } }\n");
    write("views/page.eta", '<div class="card admin-shell"></div>\n');
    const clean = spawnSync(process.execPath, [checker], {
      encoding: "utf8",
      env: { ...process.env, TAPBOARD_CSS_ROOT: root },
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /CSS guardrails passed\./u);

    write("views/page.eta", '<div class="card" style="color: red"></div>\n');
    const failing = spawnSync(process.execPath, [checker], {
      encoding: "utf8",
      env: { ...process.env, TAPBOARD_CSS_ROOT: root },
    });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /css violation: \[inline-style\] views\/page\.eta:1 /u);
    assert.match(failing.stderr, /1 CSS violation\(s\) found\./u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
