/// <reference lib="dom" />

// #253 navigation: one menu button, the full breadcrumb, and link tabs, with and without
// JavaScript.
import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers.ts";

async function signInWithoutJavaScript(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

/** The wide-screen breadcrumb as [label, href]; the current page has no href. */
async function trail(page: Page): Promise<(readonly [string, string | null])[]> {
  return page
    .locator(".admin-breadcrumbs__trail li")
    .evaluateAll((items) =>
      items.map(
        (item) =>
          [
            (item.textContent ?? "").trim(),
            item.querySelector("a")?.getAttribute("href") ?? null,
          ] as const,
      ),
    );
}

test("Admin has one menu button at every width", async ({ page }) => {
  await signIn(page);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/admin/taps");
    const buttons = page.locator(".admin-header button:visible");
    await expect(buttons).toHaveCount(1);
    await expect(buttons).toHaveAccessibleName("Admin menu");
    await expect(page.getByRole("button", { name: /menu/iu })).toHaveCount(1);
    const box = (await buttons.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    // It is the first thing in the header, left of the brand.
    const brand = (await page.locator(".admin-brand").boundingBox())!;
    expect(box.x).toBeLessThan(brand.x);
  }
});

test("on a phone the menu button opens the drawer below the header and turns into ✕", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  const menu = page.getByRole("button", { name: "Admin menu", exact: true });
  const sidebar = page.locator("[data-admin-sidebar]");
  const openIcon = menu.locator('[data-menu-icon="open"]');
  const closeIcon = menu.locator('[data-menu-icon="close"]');
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(openIcon).toBeVisible();
  await expect(closeIcon).toBeHidden();

  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(closeIcon).toBeVisible();
  await expect(openIcon).toBeHidden();
  const header = (await page.locator(".admin-header").boundingBox())!;
  await expect(async () => {
    const drawer = (await sidebar.boundingBox())!;
    expect(drawer.x).toBeGreaterThanOrEqual(-1);
    expect(drawer.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  }).toPass();

  // The same button closes it, and focus stays on the button.
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect(sidebar).toHaveJSProperty("inert", true);

  // The backdrop closes it too.
  await menu.click();
  await page.locator("[data-admin-drawer-backdrop]").click({ position: { x: 360, y: 700 } });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
});

test("without JavaScript the menu button stays hidden and the menu always renders", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await signInWithoutJavaScript(page);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/admin/system");
      await expect(page.locator("[data-admin-menu-toggle]")).toBeHidden();
      const menu = page.getByRole("navigation", { name: "Admin", exact: true });
      await expect(menu.getByRole("link", { name: "Logs", exact: true })).toBeVisible();
      await expect(menu.getByRole("link", { name: "Simulation", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("every sub-page's breadcrumb links each ancestor, and phones link the parent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/admin/keg-room/kegs");
  const kegHref = await page
    .locator('main a[href^="/admin/keg-room/kegs/"]:not([href$="/new"])')
    .first()
    .getAttribute("href");
  await page.goto("/admin/integrations/telemetry");
  const sourceHref = await page
    .locator('main a[href^="/admin/integrations/telemetry-sources/"]')
    .first()
    .getAttribute("href");
  await page.goto("/admin/taps");
  const tapHref = await page
    .locator('main a[href^="/admin/taps/"]:not([href$="/new"])')
    .first()
    .getAttribute("href");

  const cases: readonly [string, readonly (readonly [string, string])[]][] = [
    ["/admin/overview", []],
    ["/admin/taps", []],
    [tapHref!, [["Taps", "/admin/taps"]]],
    ["/admin/taps/new", [["Taps", "/admin/taps"]]],
    ["/admin/beverages/new", [["Beverages", "/admin/beverages"]]],
    ["/admin/keg-room/kegs", [["Keg Room", "/admin/keg-room"]]],
    [
      kegHref!,
      [
        ["Keg Room", "/admin/keg-room"],
        ["Physical Kegs", "/admin/keg-room/kegs"],
      ],
    ],
    [
      "/admin/keg-room/kegs/new",
      [
        ["Keg Room", "/admin/keg-room"],
        ["Physical Kegs", "/admin/keg-room/kegs"],
      ],
    ],
    ["/admin/keg-room/fills/new", [["Keg Room", "/admin/keg-room"]]],
    ["/admin/integrations/brewfather", [["Integrations", "/admin/integrations"]]],
    [
      sourceHref!,
      [
        ["Integrations", "/admin/integrations"],
        ["Telemetry", "/admin/integrations/telemetry"],
      ],
    ],
    [
      "/admin/integrations/outbound/new?transport=webhook",
      [
        ["Integrations", "/admin/integrations"],
        ["Outbound delivery", "/admin/integrations/outbound"],
      ],
    ],
    ["/admin/display/shared", [["Display", "/admin/display"]]],
    ["/admin/logs/sessions", [["Logs", "/admin/logs"]]],
    ["/admin/simulator", []],
  ];
  for (const [path, ancestors] of cases) {
    await page.goto(path);
    const crumbs = await trail(page);
    expect(crumbs[0], path).toEqual(["Admin", "/admin/overview"]);
    expect(crumbs.slice(1, -1), path).toEqual(ancestors);
    expect(crumbs.at(-1)![1], `${path} ends at the current page`).toBeNull();
    await expect(page.locator('.admin-breadcrumbs [aria-current="page"]')).toHaveCount(1);
  }
  for (const [path, ancestors] of cases.filter(([, ancestors]) => ancestors.length > 0)) {
    await page.goto(path);
    await page.setViewportSize({ width: 375, height: 812 });
    const back = page.locator(".admin-breadcrumbs__back");
    await expect(back, path).toBeVisible();
    await expect(back).toHaveAttribute("href", ancestors.at(-1)![1]);
    await expect(back).toHaveAccessibleName(`Back to ${ancestors.at(-1)![0]}`);
    await expect(page.locator(".admin-breadcrumbs__trail")).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  // The old ways back are gone.
  for (const path of ["/admin/taps/new", kegHref!, "/admin/keg-room/fills/new"]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: /^(?:← |Back to )/u })).toHaveCount(0);
  }
});

test("tabs are real links that mark the current page, with and without JavaScript", async ({
  browser,
}) => {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    try {
      if (javaScriptEnabled) await signIn(page);
      else await signInWithoutJavaScript(page);
      for (const [start, section, tab, url] of [
        ["/admin/keg-room", "Keg Room", "History", /\/admin\/keg-room\?state=ended$/u],
        ["/admin/keg-room", "Keg Room", "Physical Kegs", /\/admin\/keg-room\/kegs$/u],
        ["/admin/integrations", "Integrations", "Telemetry", /\/admin\/integrations\/telemetry$/u],
        ["/admin/display", "Display", "This display", /\/admin\/display\/this-display$/u],
        ["/admin/logs", "Logs", "Retention", /\/admin\/logs\/retention$/u],
      ] as const) {
        await page.goto(start);
        const tabs = page.getByRole("navigation", { name: `${section} pages`, exact: true });
        await tabs.getByRole("link", { name: tab, exact: true }).click();
        await expect(page).toHaveURL(url);
        const current = page
          .getByRole("navigation", { name: `${section} pages`, exact: true })
          .locator('[aria-current="page"]');
        await expect(current).toHaveCount(1);
        await expect(current).toHaveText(tab);
      }
    } finally {
      await context.close();
    }
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the selected tab's bar keeps 3:1 contrast (${colorScheme})`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto("/admin/logs");
      const ratio = await page.locator('.tabs__link[aria-current="page"]').evaluate((link) => {
        const rgb = (colour: string): number[] => (colour.match(/[\d.]+/gu) ?? []).map(Number);
        const luminance = ([r, g, b]: number[]): number => {
          const channel = (value: number): number => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        };
        let ground = rgb(getComputedStyle(document.body).backgroundColor);
        for (let node = link.parentElement; node; node = node.parentElement) {
          const colour = rgb(getComputedStyle(node).backgroundColor);
          if (colour.length < 4 || colour[3]! > 0) {
            ground = colour;
            break;
          }
        }
        const [light, dark] = [
          luminance(rgb(getComputedStyle(link).borderBottomColor)),
          luminance(ground),
        ].sort((x, y) => y - x);
        return (light! + 0.05) / (dark! + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
    } finally {
      await context.close();
    }
  });
}
