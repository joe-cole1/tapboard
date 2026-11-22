/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

import { closeCurrentWar, colours, signIn, startWar } from "./helpers.ts";

// #181 gave buttons one API: `.button` plus --primary, --secondary, --danger and --small, on
// Admin and public pages alike. Before it, `.secondary` and `a.button` were defined only under
// `.admin-shell`, so the same markup looked different in Admin and on the public pages.

test("the Tap Wars guest preview shows View results as guests see it", async ({ page }) => {
  await signIn(page);
  await closeCurrentWar(page);
  await startWar(page);
  try {
    const preview = page.getByRole("region", { name: "What guests see" });
    const adminButton = preview.getByRole("button", { name: "View results" });
    const admin = await colours(adminButton, ["--accent", "--on-accent"]);
    expect(admin.background).toBe(admin["--accent"]);
    expect(admin.color).toBe(admin["--on-accent"]);
    // The preview opens the same results dialog, and its Close button matches the guests' too.
    await adminButton.click();
    const close = page.getByRole("dialog").getByRole("button", { name: "Close Tap Wars results" });
    const closeLook = await colours(close, ["--accent", "--on-accent"]);
    expect(closeLook.background).toBe(closeLook["--accent"]);
    expect(closeLook.color).toBe(closeLook["--on-accent"]);
    await close.click();

    await page.goto("/");
    const publicButton = page.getByRole("button", { name: "View results" });
    const guests = await colours(publicButton, ["--accent", "--on-accent"]);
    expect(guests.background).toBe(guests["--accent"]);
    expect(guests.color).toBe(guests["--on-accent"]);
  } finally {
    await closeCurrentWar(page);
  }
});

test("the public Settings link is a secondary button", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("banner").getByRole("link", { name: "Settings" });
  const resting = await colours(link, ["--surface-raised", "--text", "--border"]);
  expect(resting.background).toBe(resting["--surface-raised"]);
  expect(resting.color).toBe(resting["--text"]);
  expect(resting.border).toBe(resting["--border"]);
  await link.hover();
  const hovered = await colours(link, ["--accent-strong", "--surface-raised"]);
  expect(hovered.border).toBe(hovered["--accent-strong"]);
  expect(hovered.background).not.toBe(hovered["--surface-raised"]);
});

test("a neutral button drops its border on hover, like every plain .button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const toggle = page.getByRole("button", { name: "Hide menu" });
  await toggle.hover();
  const hovered = await colours(toggle, ["--accent-hover"]);
  expect(hovered.background).toBe(hovered["--accent-hover"]);
  expect(hovered.border).toBe("rgba(0, 0, 0, 0)");
});

// On main, `.admin-shell a.button.primary` and `a.button.secondary` came after the link hover
// rules at the same specificity, so primary and secondary links never changed on hover.
test("primary and secondary links hover like the matching buttons", async ({ page }) => {
  await signIn(page);
  const exit = page.getByRole("link", { name: "Exit Admin" });
  await exit.hover();
  const secondary = await colours(exit, ["--accent-strong", "--surface-raised"]);
  expect(secondary.border).toBe(secondary["--accent-strong"]);
  expect(secondary.background).not.toBe(secondary["--surface-raised"]);

  await page.goto("/admin/beverages");
  const add = page.getByRole("link", { name: "Add beverage" }).first();
  await add.hover();
  const primary = await colours(add, ["--accent-hover", "--on-accent-hover"]);
  expect(primary.background).toBe(primary["--accent-hover"]);
  expect(primary.color).toBe(primary["--on-accent-hover"]);
});

test("a summary with .button renders like a button with .button", async ({ page }) => {
  await signIn(page);
  await page.locator("main").evaluate((main) => {
    main.insertAdjacentHTML(
      "afterbegin",
      '<p><button class="button button--secondary" type="button" data-probe="button">Same</button></p>' +
        '<details><summary class="button button--secondary" data-probe="summary">Same</summary></details>',
    );
  });
  const look = (probe: string): Promise<Record<string, string>> =>
    page.locator(`[data-probe="${probe}"]`).evaluate((node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        display: style.display,
        padding: style.padding,
        border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        radius: style.borderRadius,
        background: style.backgroundColor,
        color: style.color,
        weight: style.fontWeight,
        size: `${Math.round(box.width)}x${Math.round(box.height)}`,
      };
    });
  expect(await look("summary")).toEqual(await look("button"));
  await page.locator('[data-probe="summary"]').hover();
  const summaryHover = await look("summary");
  await page.locator('[data-probe="button"]').hover();
  expect(summaryHover).toEqual(await look("button"));
});
