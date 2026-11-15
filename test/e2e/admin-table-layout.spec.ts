/// <reference lib="dom" />

import { expect, test, type Browser, type Page } from "@playwright/test";

// Admin list pages once printed a table's first column over the next one, scrolled the whole
// page sideways at phone width, and let the Keg Room's Apply button cover its Sort select.
// These checks measure the rendered boxes, so they hold for any markup that lays out correctly.

const widths = [1280, 1024, 768, 375] as const;
const listPages = [
  "/admin/taps",
  "/admin/beverages",
  "/admin/keg-room",
  "/admin/keg-room/kegs",
  "/admin/taps/new",
  "/admin/beverages/new",
] as const;

async function signIn(browser: Browser, javaScriptEnabled: boolean): Promise<Page> {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  // With JavaScript the form submits itself once the PIN is complete.
  if (!javaScriptEnabled) await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
  return page;
}

/** Content (elements and text) that is drawn outside the table cell that holds it. */
async function cellOverflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tolerance = 1;
    const problems: string[] = [];
    const isClipped = (node: Element, cell: Element): boolean => {
      // Closed <details> content and display: none still report boxes; they are not drawn.
      if (!node.checkVisibility({ visibilityProperty: true })) return true;
      for (let current: Element | null = node; current && current !== cell;) {
        const style = getComputedStyle(current);
        if (style.clip !== "auto" || style.clipPath !== "none" || style.visibility === "hidden")
          return true;
        current = current.parentElement;
      }
      return false;
    };
    const outside = (rect: DOMRect, cell: DOMRect): boolean =>
      rect.width > 0 &&
      rect.height > 0 &&
      (rect.left < cell.left - tolerance ||
        rect.right > cell.right + tolerance ||
        rect.top < cell.top - tolerance ||
        rect.bottom > cell.bottom + tolerance);
    for (const cell of document.querySelectorAll("main table tbody :is(th, td)")) {
      const cellRect = cell.getBoundingClientRect();
      const label = (text: string | null): string =>
        `${(cell.textContent ?? "").trim().replace(/\s+/gu, " ").slice(0, 40)} → ${(text ?? "").trim().slice(0, 40)}`;
      for (const element of cell.querySelectorAll("*")) {
        if (isClipped(element, cell)) continue;
        if (outside(element.getBoundingClientRect(), cellRect))
          problems.push(`element ${element.tagName.toLowerCase()}: ${label(element.textContent)}`);
      }
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || isClipped(text.parentElement!, cell)) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        if ([...range.getClientRects()].some((rect) => outside(rect, cellRect)))
          problems.push(`text: ${label(text.textContent)}`);
      }
    }
    return problems;
  });
}

/** Pairs of visible interactive controls whose boxes cover each other. */
async function overlappingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // Autofocus can scroll the page; measure from the top so the parked skip link (above the
    // viewport until focused) is not compared with content that scrolled under it.
    window.scrollTo(0, 0);
    const controls = [
      ...document.querySelectorAll(
        "a[href], button, input:not([type=hidden]), select, textarea, summary",
      ),
    ].filter((element) => element.checkVisibility({ visibilityProperty: true }));
    const describe = (element: Element): string =>
      `${element.tagName.toLowerCase()} "${(element.textContent || (element as HTMLInputElement).name || "").trim().slice(0, 30)}"`;
    const boxes = controls.map((element) => ({
      element,
      // One rect per line box, so a link that wraps is not treated as one large rectangle.
      rects: [...element.getClientRects()].filter(
        (rect) => rect.width > 1 && rect.height > 1 && rect.bottom > 0,
      ),
    }));
    const problems: string[] = [];
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const a = boxes[first]!;
        const b = boxes[second]!;
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const overlaps = a.rects.some((one) =>
          b.rects.some(
            (two) =>
              Math.min(one.right, two.right) - Math.max(one.left, two.left) > 1 &&
              Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 1,
          ),
        );
        if (overlaps) problems.push(`${describe(a.element)} overlaps ${describe(b.element)}`);
      }
    }
    return problems;
  });
}

/** Form controls that stick out of the label (the form column) that holds them. */
async function controlsOutsideLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const control of document.querySelectorAll(
      "main label :is(input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea)",
    )) {
      const label = control.closest("label")!.getBoundingClientRect();
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 || !control.checkVisibility({ visibilityProperty: true })) continue;
      if (rect.left < label.left - 1 || rect.right > label.right + 1)
        problems.push(
          `${(control as HTMLInputElement).name}: ${Math.round(rect.width)}px control in a ${Math.round(label.width)}px column`,
        );
    }
    return problems;
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? "with JavaScript" : "without JavaScript";

  for (const width of widths) {
    test(`Admin tables and forms keep content in place at ${width}px ${mode}`, async ({
      browser,
    }) => {
      const page = await signIn(browser, javaScriptEnabled);
      await page.setViewportSize({ width, height: 900 });
      for (const path of listPages) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        expect.soft(await cellOverflows(page), `${path} at ${width}px: cell overflow`).toEqual([]);
        expect.soft(await overlappingControls(page), `${path} at ${width}px: overlap`).toEqual([]);
        expect.soft(await controlsOutsideLabels(page), `${path} at ${width}px: inputs`).toEqual([]);
        expect.soft(await horizontalOverflow(page), `${path} at ${width}px: page width`).toBe(0);
      }
      await page.context().close();
    });
  }

  test(`no Admin page scrolls sideways at 375px ${mode}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await signIn(browser, javaScriptEnabled);
    await page.setViewportSize({ width: 375, height: 812 });
    // Visit one page of every route shape reachable from Admin links (ids collapse to :id).
    const queue = ["/admin/overview"];
    const seen = new Set<string>(queue);
    const overflowing: string[] = [];
    while (queue.length > 0) {
      const href = queue.shift()!;
      const response = await page.goto(href);
      // Broken links are not a layout defect (the System page's health link is tracked in #178).
      if (response?.status() !== 200) continue;
      const overflow = await horizontalOverflow(page);
      if (overflow > 0) overflowing.push(`${href} (+${overflow}px)`);
      const links = await page
        .locator("a[href]")
        .evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
      for (const link of links) {
        const url = new URL(link);
        if (url.origin !== new URL(page.url()).origin) continue;
        if (!url.pathname.startsWith("/admin") || url.pathname === "/admin/logout") continue;
        const shape = url.pathname.replace(/\/[^/]*\d[^/]*/gu, "/:id");
        if (seen.has(shape)) continue;
        seen.add(shape);
        queue.push(url.pathname + url.search);
      }
    }
    expect(seen.size, "routes visited").toBeGreaterThan(15);
    expect(overflowing).toEqual([]);
    await page.context().close();
  });
}
