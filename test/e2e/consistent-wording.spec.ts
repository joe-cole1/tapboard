/// <reference lib="dom" />

// #183: every fixture page, one per template, shows dates as text, names its tables, starts its
// outline with its one <h1>, and carries the favicon and theme-color.
import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers.ts";

const SKIP = /\/logout|\/export|\/api\/|\/admin\/login|\.(csv|json|svg|png|js|css)(\?|$)/u;

/** A page's template: record ids and page numbers do not make a new one. */
function template(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, ":id")
    .replace(/([?&](page|activePage|historyPage|cursor|pours)=)[^&]*/gu, "$1n");
}

async function audit(page: Page) {
  return page.evaluate(() => {
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    return {
      iso: iso.exec(document.body.innerText)?.[0] ?? null,
      unnamedTables: [...document.querySelectorAll("table")]
        .filter(
          (table) =>
            table.querySelector("caption") === null &&
            !table.hasAttribute("aria-label") &&
            !table.hasAttribute("aria-labelledby"),
        )
        .map((table) => table.querySelector("th")?.textContent?.trim() ?? "?"),
      h1Count: headings.filter((heading) => heading.tagName === "H1").length,
      firstHeading: headings[0]?.tagName ?? null,
      favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href") ?? null,
      themeColors: document.querySelectorAll('meta[name="theme-color"]').length,
      links: [...document.querySelectorAll("a[href]")].map((link) => link.getAttribute("href")!),
    };
  });
}

test("every page shows readable dates, named tables, one h1 first, a favicon and theme-color", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const queue = ["/admin/overview", "/"];
  const templates = new Set<string>();
  const problems: string[] = [];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (templates.has(template(path))) continue;
    templates.add(template(path));
    const response = await page.goto(path);
    if (!(response?.headers()["content-type"] ?? "").includes("text/html")) continue;
    if (response?.status() !== 200) problems.push(`${path}: status ${response?.status()}`);
    const found = await audit(page);
    if (found.iso) problems.push(`${path}: shows ${found.iso}`);
    if (found.unnamedTables.length)
      problems.push(`${path}: unnamed ${found.unnamedTables.join(", ")}`);
    if (found.h1Count !== 1) problems.push(`${path}: ${found.h1Count} h1`);
    if (found.firstHeading !== "H1") problems.push(`${path}: first heading ${found.firstHeading}`);
    if (found.favicon !== "/assets/svg/favicon.svg") problems.push(`${path}: no favicon`);
    if (found.themeColors === 0) problems.push(`${path}: no theme-color`);
    for (const href of found.links) {
      const url = new URL(href, new URL(path, baseURL));
      if (url.origin !== new URL(baseURL!).origin) continue;
      const next = url.pathname + url.search;
      if (!SKIP.test(next) && !templates.has(template(next))) queue.push(next);
    }
  }
  expect(templates.size).toBeGreaterThan(40);
  expect(problems).toEqual([]);
});
