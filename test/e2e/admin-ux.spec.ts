/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

// Admin UX pass (#192 PR): accent circles, theme cards, the hideable sidebar and the
// label/value lists. Nothing here saves settings, so other specs see unchanged state.

async function signIn(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

test("accent circles keep their own colour on hover and theme cards drive the preview", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/admin/display/shared");
  const rose = page.locator(".display-accent-swatch--rose");
  const before = await rose.evaluate((node) => getComputedStyle(node).backgroundColor);
  await rose.hover();
  // The circles once took the accent hover colour from the generic button rule.
  expect(await rose.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(before);

  await page.getByText("Cyberpunk", { exact: true }).click();
  await expect(page.locator("[data-display-preview]")).toHaveAttribute(
    "data-preview-theme",
    "cyberpunk",
  );
  await expect(page.locator("[data-display-stylesheet]")).toHaveAttribute(
    "href",
    /theme=cyberpunk/u,
  );

  // The custom colour input appears only while Custom is chosen.
  const customColor = page.locator("[data-accent-custom-color]");
  await expect(customColor).toBeHidden();
  await page.getByText("Custom", { exact: true }).click();
  await expect(customColor).toBeVisible();
  expect(await page.locator("[style]").count()).toBe(0);
});

test("Hide menu removes the sidebar on desktop and Menu brings it back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  const sidebar = page.locator("[data-admin-sidebar]");
  const menu = page.locator("[data-admin-menu-toggle]");
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "Hide menu" }).click();
  await expect(sidebar).toBeHidden();
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  // The choice is remembered across pages.
  await page.goto("/admin/taps");
  await expect(sidebar).toBeHidden();
  await menu.click();
  await expect(sidebar).toBeVisible();
  await expect(menu).toBeHidden();
});

test("label/value lists put each value beside its label, and stack on phones", async ({ page }) => {
  await signIn(page);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/display");
    const rows = await page.locator(".key-value-list dt").evaluateAll((terms) =>
      terms.map((term) => {
        const value = term.nextElementSibling!.getBoundingClientRect();
        const label = term.getBoundingClientRect();
        return {
          sameLine: Math.abs(value.top - label.top) < 2,
          valueLeft: value.left,
          labelLeft: label.left,
        };
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (width === 1280) {
        expect(row.sameLine).toBe(true);
        expect(row.valueLeft).toBeGreaterThan(row.labelLeft);
      } else {
        // Stacked, and never indented under the label.
        expect(row.sameLine).toBe(false);
        expect(Math.abs(row.valueLeft - row.labelLeft)).toBeLessThan(2);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
