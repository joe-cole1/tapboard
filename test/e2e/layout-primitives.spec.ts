/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers.ts";

// #181 (PR 2 of 4) and #253: Admin page sections are flat, a .card frames one item and never
// another card, a card that responds to hover is a link, and every collapsible row is one
// .disclosure at least 24px tall (WCAG 2.5.8).

const LIST_PAGES = [
  "/admin/overview",
  "/admin/taps",
  "/admin/beverages",
  "/admin/beverages/new",
  "/admin/keg-room",
  "/admin/keg-room/kegs",
  "/admin/keg-room/kegs/new",
  "/admin/integrations",
  "/admin/integrations/brewfather",
  "/admin/integrations/telemetry",
  "/admin/integrations/outbound",
  "/admin/display",
  "/admin/display/shared",
  "/admin/tap-wars",
  "/admin/system",
];

// The first record link on a list page, so the detail pages are covered too.
async function firstDetailLink(page: Page, list: string, pattern: RegExp): Promise<string> {
  await page.goto(list);
  const hrefs = await page
    .locator("main a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  const href = hrefs.find((candidate) => pattern.test(candidate));
  expect(href, `a detail link on ${list}`).toBeTruthy();
  return href!;
}

type LayoutReport = {
  boxedSections: string[];
  nestedCards: number;
  hoverCardsThatAreNotLinks: number;
  shortSummaries: string[];
  pageOverflow: number;
  overflowing: string[];
};

function layoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) throw new Error("no <main>");
    const boxedSections = [...main.querySelectorAll(":scope > section:not(.card)")]
      .filter((section) => {
        const style = getComputedStyle(section);
        return style.borderLeftStyle !== "none" || style.boxShadow !== "none";
      })
      .map((section) => section.getAttribute("aria-labelledby") ?? section.id ?? "section");
    const shortSummaries = [...main.querySelectorAll("summary")]
      .filter((summary) => summary.getClientRects().length > 0)
      .filter((summary) => summary.getBoundingClientRect().height < 24)
      .map((summary) => summary.textContent?.trim().slice(0, 40) ?? "");
    const viewport = document.documentElement.clientWidth;
    const pageOverflow = document.documentElement.scrollWidth - viewport;
    // Name what sticks out: positioned elements (they can escape a scroll container) and
    // anything not inside its own scroll container.
    const scrolls = (element: Element): boolean =>
      ["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(element).overflowX);
    const overflowing =
      pageOverflow <= 0
        ? []
        : [...document.body.querySelectorAll("*")]
            .filter((element) => element.getClientRects().length > 0)
            .filter((element) => element.getBoundingClientRect().right > viewport + 1)
            .filter((element) => {
              if (["absolute", "fixed"].includes(getComputedStyle(element).position)) return true;
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (parent === document.body) return true;
                if (scrolls(parent)) return false;
              }
              return true;
            })
            .slice(0, 5)
            .map(
              (element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`,
            );
    return {
      boxedSections,
      nestedCards: main.querySelectorAll(".card .card").length,
      hoverCardsThatAreNotLinks: main.querySelectorAll(".card--link:not(a[href])").length,
      shortSummaries,
      pageOverflow,
      overflowing,
    };
  });
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`Admin sections are flat, cards hold items, disclosures are 24px (${colorScheme})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      await signIn(page);
      const pages = [
        ...LIST_PAGES,
        await firstDetailLink(page, "/admin/taps", /^\/admin\/taps\/(?!new)[^/?#]+$/u),
        await firstDetailLink(page, "/admin/beverages", /^\/admin\/beverages\/(?!new)[^/?#]+$/u),
        await firstDetailLink(
          page,
          "/admin/keg-room/kegs",
          /^\/admin\/keg-room\/kegs\/(?!new)[^/?#]+$/u,
        ),
        await firstDetailLink(
          page,
          "/admin/keg-room",
          /^\/admin\/keg-room\/fills\/(?!new)[^/?#]+$/u,
        ),
      ];
      for (const path of pages) {
        await page.goto(path);
        for (const width of [1280, 768, 375]) {
          await page.setViewportSize({ width, height: 900 });
          const report = await layoutReport(page);
          const where = `${path} at ${width}px`;
          expect(report.boxedSections, `${where}: boxed page sections`).toEqual([]);
          expect(report.nestedCards, `${where}: cards inside cards`).toBe(0);
          expect(report.hoverCardsThatAreNotLinks, `${where}: link cards that aren't links`).toBe(
            0,
          );
          expect(report.shortSummaries, `${where}: summaries under 24px`).toEqual([]);
          expect(
            report.pageOverflow,
            `${where}: horizontal page scroll from ${report.overflowing.join(", ")}`,
          ).toBeLessThanOrEqual(0);
        }
      }
    } finally {
      await context.close();
    }
  });
}

test("Overview's integration tiles open the pages they describe", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/overview");
  const section = page.getByRole("region", { name: "Connectivity and integrations" });
  await expect(section.getByRole("link", { name: /Telemetry sources/u })).toHaveAttribute(
    "href",
    "/admin/integrations/telemetry",
  );
  await expect(section.getByRole("link", { name: /^Brewfather/u })).toHaveAttribute(
    "href",
    "/admin/integrations/brewfather",
  );
  await expect(section.getByRole("link", { name: /Linked beverages/u })).toHaveAttribute(
    "href",
    "/admin/integrations/brewfather",
  );
});
