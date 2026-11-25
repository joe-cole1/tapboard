/// <reference lib="dom" />

// #253 Tap detail and Tap Wars: public-card switches with a reset beside the preview, one
// Advanced settings disclosure, and a Tap Wars matchup preview before a war starts, each with
// and without JavaScript.
import { expect, test, type Browser, type Page } from "@playwright/test";

import { closeCurrentWar } from "./helpers.ts";

async function signIn(browser: Browser, javaScriptEnabled: boolean): Promise<Page> {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  if (!javaScriptEnabled) await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
  return page;
}

async function openTap(page: Page, tapNumber: number): Promise<void> {
  await page.goto("/admin/taps");
  await page.getByRole("link", { name: new RegExp(`^Open Tap ${tapNumber}\\b`, "u") }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Tap ${tapNumber}`);
}

for (const javaScriptEnabled of [true, false]) {
  test(`a public-card switch saves an override and its reset clears it (JavaScript ${
    javaScriptEnabled ? "on" : "off"
  })`, async ({ browser }) => {
    const page = await signIn(browser, javaScriptEnabled);
    await openTap(page, 5);
    const abv = page
      .getByRole("list", { name: "On the public card" })
      .getByRole("switch", { name: /^ABV /u });
    const reset = page.getByRole("button", { name: "Reset ABV to Display default" });
    const styleLine = page.locator('[data-display-preview] [data-field="style-line"]');
    const status = page.locator("#card-metrics-status");
    await expect(abv).toHaveAttribute("aria-checked", "true");
    await expect(abv).toContainText("Display default");
    await expect(reset).toBeHidden();
    await expect(styleLine).toContainText("%");
    // With JavaScript the switch saves in place: no navigation, no jump to the top.
    await page.setViewportSize({ width: 1280, height: 500 });
    await abv.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const urlBefore = page.url();
    try {
      await abv.click();
      if (javaScriptEnabled) {
        await expect(status).toHaveText("Saved");
        expect(page.url()).toBe(urlBefore);
        expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
      } else await expect(page).toHaveURL(/\?notice=/u);
      await expect(abv).toHaveAttribute("aria-checked", "false");
      await expect(abv).toContainText("This Tap only");
      await expect(styleLine).not.toContainText("%");
      await expect(reset).toBeVisible();
      const box = (await reset.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
    } finally {
      if (await reset.isVisible()) await reset.click();
    }
    await expect(abv).toHaveAttribute("aria-checked", "true");
    await expect(abv).toContainText("Display default");
    await expect(reset).toBeHidden();
    await expect(styleLine).toContainText("%");
    if (javaScriptEnabled) {
      // Focus moves from the vanished reset to its switch, and a reload shows the saved state.
      await expect(abv).toBeFocused();
      await page.reload();
      await expect(abv).toHaveAttribute("aria-checked", "true");
    }
    await page.context().close();
  });
}

test("the Tap page is five tabs that work without JavaScript, each with open everyday forms", async ({
  browser,
}) => {
  const page = await signIn(browser, false);
  await openTap(page, 5);
  const tabs = page.getByRole("navigation", { name: /pages$/u }).getByRole("link");
  await expect(tabs).toHaveText(["Public card", "Identity", "Sensors", "Maintenance", "History"]);
  // Public card: the preview and its display options first.
  await expect(tabs.nth(0)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-display-preview]")).toBeVisible();
  await expect(page.getByLabel("Enable Mystery Tap")).toBeVisible();
  await expect(page.getByLabel("Tap name")).toHaveCount(0);
  // The metric switches sit side by side on a wide screen.
  const switches = page.getByRole("list", { name: "On the public card" }).getByRole("switch");
  const [first, second] = [
    await switches.nth(0).boundingBox(),
    await switches.nth(1).boundingBox(),
  ];
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(4);
  expect(second!.x).toBeGreaterThan(first!.x);

  await page.getByRole("link", { name: "Identity", exact: true }).click();
  await expect(page).toHaveURL(/\/identity$/u);
  await expect(page.getByLabel("Tap name")).toBeVisible();
  await expect(page.getByLabel("Gas type")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assignment" })).toBeVisible();
  await expect(page.locator(".admin-breadcrumbs__trail")).toContainText("Tap 5");

  await page.getByRole("link", { name: "Maintenance", exact: true }).click();
  await expect(page.getByLabel("Maintenance type")).toBeVisible();

  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fill history" })).toBeVisible();
  await expect(page.getByRole("table", { name: /Filled Kegs on this Tap/u })).toContainText(
    "Tap Wars Lager",
  );
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();

  await page.getByRole("link", { name: "Sensors", exact: true }).click();
  await expect(page.getByLabel(/^Level source/u)).toBeVisible();
  const detector = page.getByRole("heading", { name: "Pour detector" });
  await expect(detector).toBeHidden();
  await page
    .locator("summary")
    .filter({ hasText: /^Advanced settings/u })
    .click();
  await expect(detector).toBeVisible();
  await expect(page.getByRole("heading", { name: "Health rules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manual rebaseline" })).toBeVisible();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.context().close();
});

async function choosePair(page: Page): Promise<void> {
  const selects = page.locator("[data-tap-wars-selector]");
  for (const [index, tapNumber] of [4, 5].entries()) {
    const value = await selects
      .nth(index)
      .locator(`option[data-tap-number="${tapNumber}"]`)
      .getAttribute("value");
    if (value === null) throw new Error(`Expected fixture Tap ${tapNumber}.`);
    await selects.nth(index).selectOption(value);
  }
}

test("Tap Wars previews the chosen matchup as the selects change", async ({ browser }) => {
  const page = await signIn(browser, true);
  await closeCurrentWar(page);
  await page.goto("/admin/tap-wars");
  const guest = page.locator("[data-tap-wars-guest-preview]");
  const start = page.getByRole("button", { name: "Start Tap War" });
  await expect(page.getByRole("button", { name: "Update preview" })).toBeHidden();
  await expect(start).toBeDisabled();
  await choosePair(page);
  await expect(guest).toBeVisible();
  await expect(guest.locator("[data-tap-wars-status]")).toHaveText("TAP WARS! Vote below");
  await expect(guest.locator('[data-tap-wars-side="1"]')).toHaveText("Tap Wars Amber");
  await expect(guest.locator('[data-tap-wars-side="2"]')).toHaveText("Tap Wars Lager");
  await expect(guest.locator("[data-tap-wars-message]")).toHaveText("No votes yet");
  await expect(start).toBeEnabled();
  // The same Tap on both sides clears the preview and blocks Start.
  const second = page.locator('[data-tap-wars-selector="2"]');
  await second.selectOption(await page.locator('[data-tap-wars-selector="1"]').inputValue());
  await expect(page.getByText("Choose two different Taps.")).toBeVisible();
  await expect(guest).toBeHidden();
  await expect(start).toBeDisabled();
  expect(page.url()).not.toContain("_csrf");
  await page.context().close();
});

test("without JavaScript, Update preview reloads with the pair and no CSRF token in the URL", async ({
  browser,
}) => {
  const page = await signIn(browser, false);
  await closeCurrentWar(page);
  await page.goto("/admin/tap-wars");
  const start = page.getByRole("button", { name: "Start Tap War" });
  await expect(start).toBeDisabled();
  await choosePair(page);
  await page.getByRole("button", { name: "Update preview" }).click();
  await expect(page).toHaveURL(/[?&]side1=[^&]+&side2=[^&]+$/u);
  expect(page.url()).not.toContain("_csrf");
  const guest = page.locator("[data-tap-wars-guest-preview]");
  await expect(guest.locator('[data-tap-wars-tap="1"]')).toHaveText("Tap 4");
  await expect(guest.locator('[data-tap-wars-tap="2"]')).toHaveText("Tap 5");
  await expect(start).toBeEnabled();
  await page.context().close();
});
