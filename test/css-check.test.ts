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
.status-badge--healthy, .status-badge--muted { color: green; }
.is-open:not(.card) [data-x="a.b"] { display: block; }
@media (max-width: 40rem) { .card { padding: 0; } }
.script-made { color: red; }
.toggled { color: blue; }
`;

void test("markup that uses every rule, and only defined classes, passes", () => {
  assert.deepEqual(
    check({
      stylesheets: files({ "public/css/app.css": cleanStylesheet }),
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
      stylesheets: files({ "public/css/app.css": ".card { padding: 0; }" }),
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
      stylesheets: files({ "public/css/app.css": ".card { padding: 0; }" }),
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
      stylesheets: files({
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
      stylesheets: files({
        "public/css/app.css": [
          ".card { padding: 0; }",
          "@media (max-width: 40rem) { .card { padding: 1rem; } }",
          ".card , .card--wide { margin: 0; }",
          "/* a comment */ .card {",
          "  color: red;",
          "}",
        ].join("\n"),
        "public/css/other.css": ".card { color: blue; }",
      }),
      views: files({ "views/page.eta": '<div class="card card--wide"></div>' }),
    }),
    [{ rule: "duplicate-selector", path: "public/css/app.css", line: 4 }],
  );
});

void test("a class built from data needs an allowed modifier family", () => {
  assert.deepEqual(
    check({
      stylesheets: files({ "public/css/app.css": ".card { padding: 0; } .card--a { margin: 0; }" }),
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

void test("selectors are parsed with their context and without attribute values", () => {
  const rules = parseStylesheet(
    '@font-face { font-family: X; }\n@media print { .a > .b[data-c=".d"] { color: red; } }\n@keyframes k { from { opacity: 0; } }',
  );
  assert.deepEqual(rules, [{ selector: '.a>.b[data-c=".d"]', context: "@media print", line: 2 }]);
  assert.deepEqual(selectorClasses(rules[0]!.selector), ["a", "b"]);
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
    write("public/css/app.css", ".card { padding: 0; }\n");
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
