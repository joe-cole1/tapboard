/// <reference lib="dom" />

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { signIn } from "./helpers.ts";

// #181 (PR 4 of 4) and #253: tables never scroll sideways. Below the width a table needs, each
// row stacks, and stacked rows still expose their column headers to assistive technology.
// Row actions are at least 24px (WCAG 2.5.8), and "Open" carries its row's name (WCAG 2.5.3).

const PAGES = [
  "/admin/overview",
  "/admin/taps",
  "/admin/taps/new",
  "/admin/beverages",
  "/admin/beverages/new",
  "/admin/keg-room",
  "/admin/keg-room/kegs",
  "/admin/keg-room/kegs/new",
  "/admin/keg-room/fills/new",
  "/admin/integrations",
  "/admin/integrations/brewfather",
  "/admin/integrations/telemetry",
  "/admin/integrations/outbound",
  "/admin/display",
  "/admin/display/shared",
  "/admin/tap-wars",
  "/admin/system",
  "/admin/simulator",
];
const DETAILS: readonly [string, RegExp][] = [
  ["/admin/taps", /^\/admin\/taps\/(?!new)[^/?#]+$/u],
  ["/admin/beverages", /^\/admin\/beverages\/(?!new)[^/?#]+$/u],
  ["/admin/keg-room/kegs", /^\/admin\/keg-room\/kegs\/(?!new)[^/?#]+$/u],
  ["/admin/keg-room", /^\/admin\/keg-room\/fills\/(?!new)[^/?#]+$/u],
  ["/admin/integrations/telemetry", /^\/admin\/integrations\/telemetry-sources\/[^/?#]+$/u],
  ["/admin/integrations/outbound", /^\/admin\/integrations\/outbound\/(?!new)[^/?#]+$/u],
];
// 375, 768 and 1280px, just below 40, 48 and 60rem, and 1024px, where the sidebar leaves a wide
// screen less room than a tablet.
const WIDTHS = [1280, 1024, 959, 768, 767, 639, 375];

type LayoutReport = { pageOverflow: number; scrollers: string[]; wideTables: string[] };

function layoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const describe = (element: Element): string =>
      `${element.tagName.toLowerCase()}${[...element.classList].map((name) => `.${name}`).join("")}`;
    const scrollers = [...document.body.querySelectorAll("*")]
      .filter((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowX))
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map(describe);
    const wideTables = [...document.querySelectorAll("main table")]
      .filter(
        (table) =>
          table.getBoundingClientRect().right >
          table.parentElement!.getBoundingClientRect().right + 1,
      )
      .map((table) => table.querySelector("caption")?.textContent?.trim() ?? describe(table));
    return { pageOverflow: root.scrollWidth - root.clientWidth, scrollers, wideTables };
  });
}

type AxNode = {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  childIds?: string[];
  backendDOMNodeId?: number;
};

type TableReport = {
  name: string;
  stacked: boolean;
  problems: string[];
  openLinks: { name: string; rowName: string }[];
};

/** Reads each table as Chromium's accessibility tree exposes it, not as the markup says. */
async function tableReports(page: Page, cdp: CDPSession, where: string): Promise<TableReport[]> {
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const role = (node: AxNode): string => node.role?.value ?? "";
  // Exposed children: ignored nodes (such as a bare <tbody>) pass their children through.
  const children = (node: AxNode): AxNode[] =>
    (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      if (!child) return [];
      return child.ignored ? children(child) : [child];
    });
  const descendants = (node: AxNode): AxNode[] =>
    children(node).flatMap((child) => [child, ...descendants(child)]);
  const rowsOf = (node: AxNode): AxNode[] =>
    children(node).flatMap((child) =>
      role(child) === "row" ? [child] : role(child) === "rowgroup" ? rowsOf(child) : [],
    );

  // What sighted users see: header texts, each cell's drawn label, and the row layout.
  const dom = await page.evaluate(() =>
    // A table inside a closed <details> is not rendered, so it is not in the tree either.
    [...document.querySelectorAll("main table")]
      .filter((table) => table.checkVisibility())
      .map((table) => ({
        headers: [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? ""),
        labels: [...table.querySelectorAll("tbody tr")].map((row) =>
          [...row.children].map((cell) => cell.getAttribute("data-label")),
        ),
        stacked: getComputedStyle(table.querySelector("tbody tr")!).display === "grid",
      })),
  );

  const tables = nodes.filter((node) => !node.ignored && role(node) === "table");
  expect(tables.length, `${where}: tables in the accessibility tree`).toBe(dom.length);
  return tables.map((table, index) => {
    const { headers, labels, stacked } = dom[index]!;
    const name = table.name?.value ?? `table ${index + 1}`;
    const problems: string[] = [];
    const rows = rowsOf(table);
    const headerRow = rows.find((row) =>
      children(row).every((cell) => role(cell) === "columnheader"),
    );
    const bodyRows = rows.filter((row) => row !== headerRow);
    if (headers.length > 0) {
      const exposed = headerRow ? children(headerRow).map((cell) => cell.name?.value ?? "") : [];
      if (exposed.join("|") !== headers.join("|"))
        problems.push(`column headers exposed as [${exposed.join(", ")}]`);
    }
    if (bodyRows.length !== labels.length)
      problems.push(`${bodyRows.length} rows exposed for ${labels.length}`);
    const openLinks: TableReport["openLinks"] = [];
    bodyRows.forEach((row, rowIndex) => {
      const cells = children(row);
      const roles = cells.map(role);
      if (roles.some((cellRole) => !["cell", "rowheader", "gridcell"].includes(cellRole)))
        problems.push(`row ${rowIndex + 1} exposes [${roles.join(", ")}]`);
      if (headers.length > 0 && cells.length !== headers.length)
        problems.push(
          `row ${rowIndex + 1} has ${cells.length} cells for ${headers.length} headers`,
        );
      // A drawn "label:" must name the column the cell belongs to.
      (labels[rowIndex] ?? []).forEach((label, column) => {
        if (label !== null && headers.length > 0 && label !== headers[column])
          problems.push(`row ${rowIndex + 1} labels "${headers[column]}" as "${label}"`);
      });
      const rowHeader = cells.find((cell) => role(cell) === "rowheader");
      const rowName = rowHeader
        ? (descendants(rowHeader).find((node) => role(node) === "link")?.name?.value ?? "")
        : "";
      for (const link of descendants(row).filter((node) => role(node) === "link")) {
        const linkName = link.name?.value ?? "";
        if (/^Open\b/u.test(linkName)) openLinks.push({ name: linkName, rowName });
      }
    });
    return { name, stacked, problems, openLinks };
  });
}

/** Buttons and button links in table rows that are under 24 × 24px. */
function smallRowActions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("main table tbody :is(button, .button)")]
      .filter((element) => element.checkVisibility({ visibilityProperty: true }))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width < 24 || rect.height < 24)
      .map(
        ({ element, rect }) =>
          `"${element.textContent?.trim()}" ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      ),
  );
}

async function detailPages(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const [list, pattern] of DETAILS) {
    await page.goto(list);
    const hrefs = await page
      .locator("main a[href]")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    const href = hrefs.find((candidate) => pattern.test(candidate));
    if (href) found.push(href);
  }
  return found;
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`Admin tables stack instead of scrolling and keep their headers (${colorScheme})`, async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    try {
      await signIn(page);
      const pages = [...PAGES, ...(await detailPages(page))];
      let tablesChecked = 0;
      let stackedChecked = 0;
      const openLinkPages = new Set<string>();
      for (const path of pages) {
        await page.goto(path);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          const where = `${path} at ${width}px`;
          const layout = await layoutReport(page);
          expect(layout.pageOverflow, `${where}: horizontal page scroll`).toBeLessThanOrEqual(0);
          expect(layout.scrollers, `${where}: elements that scroll sideways`).toEqual([]);
          expect(layout.wideTables, `${where}: tables wider than their container`).toEqual([]);
          expect(await smallRowActions(page), `${where}: row actions under 24px`).toEqual([]);
          for (const table of await tableReports(page, cdp, where)) {
            tablesChecked += 1;
            if (table.stacked) stackedChecked += 1;
            expect(table.problems, `${where}: ${table.name}`).toEqual([]);
            if (width === 375)
              expect(table.stacked, `${where}: ${table.name} stacks on a phone`).toBe(true);
            for (const link of table.openLinks) {
              openLinkPages.add(path);
              expect(link.rowName, `${where}: ${link.name} has a row name`).not.toBe("");
              expect(link.name, `${where}: Open names its row`).toContain(link.rowName);
            }
          }
        }
      }
      expect(stackedChecked, "stacked tables checked").toBeGreaterThan(20);
      expect(tablesChecked - stackedChecked, "unstacked tables checked").toBeGreaterThan(20);
      expect([...openLinkPages].sort()).toEqual([
        "/admin/keg-room",
        "/admin/keg-room/kegs",
        "/admin/taps",
      ]);
    } finally {
      await context.close();
    }
  });
}

test("Taps, Kegs and Keg Room stack below 60rem, and also beside the sidebar on a narrow screen", async ({
  page,
}) => {
  await signIn(page);
  const stacked = async (path: string, width: number): Promise<boolean[]> => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path);
    return page
      .locator("main table tbody tr:first-child")
      .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).display === "grid"));
  };
  for (const path of ["/admin/taps", "/admin/keg-room/kegs", "/admin/keg-room"]) {
    expect(await stacked(path, 1280), `${path} at 1280px`).not.toContain(true);
    expect(await stacked(path, 959), `${path} at 959px`).not.toContain(false);
    expect(await stacked(path, 1024), `${path} at 1024px beside the sidebar`).not.toContain(false);
  }
  // A narrower table stays a table on a tablet.
  expect(await stacked("/admin/system", 767)).toEqual([false]);
  expect(await stacked("/admin/system", 639)).toEqual([true]);
});

test("the On Deck drag handle appears only when the script that drives it runs", async ({
  browser,
}) => {
  for (const javaScriptEnabled of [false, true]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    try {
      await page.goto("/admin/login");
      await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
      if (!javaScriptEnabled) await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/admin\/overview$/u);
      await page.goto("/admin/keg-room");
      // An earlier spec may have taken the fixture's Filled Keg off the queue; put it back.
      const putOnDeck = page
        .locator("tr[data-fill-id]")
        .filter({ hasText: "E2E Pale Ale" })
        .getByRole("button", { name: "Put On Deck" });
      if ((await putOnDeck.count()) > 0) {
        await putOnDeck.click();
        await page.goto("/admin/keg-room");
      }
      const onDeck = page.getByRole("table", { name: "On Deck Filled Kegs" });
      await expect(onDeck.getByRole("button", { name: "Move up" }).first()).toBeVisible();
      const handle = onDeck.getByRole("button", { name: /^Drag to reorder/u }).first();
      const help = page.getByText("Drag the handle to reorder", { exact: false });
      if (javaScriptEnabled) {
        await expect(handle).toBeVisible();
        await expect(help).toBeVisible();
      } else {
        await expect(handle).toBeHidden();
        await expect(help).toBeHidden();
      }
    } finally {
      await context.close();
    }
  }
});
