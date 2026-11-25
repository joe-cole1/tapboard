/// <reference lib="dom" />

import { expect, test, type Browser, type Page } from "@playwright/test";

import { closeCurrentWar, saveLive, signIn, startWar } from "./helpers.ts";

/** Signs in with JavaScript off, where the PIN form is submitted with its button. */
async function signInWithoutJavaScript(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function adminPage(browser: Browser, javaScriptEnabled: boolean) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  if (javaScriptEnabled) await signIn(page);
  else await signInWithoutJavaScript(page);
  return { context, page };
}

/** The first Filled Keg page that still has its Featured switch. */
async function openActiveFill(page: Page): Promise<void> {
  await page.goto("/admin/keg-room");
  const hrefs = await page
    .locator('a[href^="/admin/keg-room/fills/"]:not([href$="/new"])')
    .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute("href")!))]);
  for (const href of hrefs) {
    await page.goto(href);
    if (await page.getByRole("switch", { name: "Featured" }).count()) return;
  }
  throw new Error("Expected a Filled Keg that has not ended.");
}

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? "with JavaScript" : "without JavaScript";

  test(`Filled Keg Featured switch saves ${mode}`, async ({ browser }) => {
    const { context, page } = await adminPage(browser, javaScriptEnabled);
    await openActiveFill(page);
    const featured = page.getByRole("switch", { name: "Featured" });
    const original = await featured.getAttribute("aria-checked");
    const flipped = original === "true" ? "false" : "true";
    const path = new URL(page.url()).pathname;
    try {
      await page.setViewportSize({ width: 1280, height: 400 });
      await featured.scrollIntoViewIfNeeded();
      const scrolled = await page.evaluate(() => window.scrollY);
      await featured.click();
      await expect(featured).toHaveAttribute("aria-checked", flipped);
      if (javaScriptEnabled) {
        await expect(page.locator("[data-autosave-status]").first()).toHaveText("Saved");
        expect(new URL(page.url()).search).toBe("");
        expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
      } else {
        await expect(page).toHaveURL(/\?notice=/u);
      }
      await page.goto(path);
      await expect(featured).toHaveAttribute("aria-checked", flipped);
    } finally {
      await page.goto(path);
      if ((await featured.getAttribute("aria-checked")) !== original) {
        await featured.click();
        await expect(featured).toHaveAttribute("aria-checked", original!);
      }
      await context.close();
    }
  });

  test(`System Session lifetimes save ${mode}`, async ({ browser }) => {
    const { context, page } = await adminPage(browser, javaScriptEnabled);
    await page.goto("/admin/system");
    const form = page.locator('form[action="/admin/system/session-policy"]');
    const inactivity = form.getByLabel("Inactivity timeout (minutes)");
    const absolute = Number(await form.getByLabel("Absolute lifetime (minutes)").inputValue());
    const original = await inactivity.inputValue();
    const changed = String(Number(original) < absolute ? Number(original) + 1 : absolute - 1);
    const save = form.getByRole("button", { name: "Save session lifetimes" });
    try {
      if (javaScriptEnabled) await expect(save).toBeHidden();
      else await expect(save).toBeVisible();
      await inactivity.fill(changed);
      await saveLive(form, "Save session lifetimes");
      if (javaScriptEnabled) await expect(page).toHaveURL(/\/admin\/system$/u);
      else await expect(page).toHaveURL(/\/admin\/system\?notice=/u);
      await page.goto("/admin/system");
      await expect(inactivity).toHaveValue(changed);
    } finally {
      await page.goto("/admin/system");
      await inactivity.fill(original);
      await saveLive(form, "Save session lifetimes");
      await page.goto("/admin/system");
      await expect(inactivity).toHaveValue(original);
      await context.close();
    }
  });
}

test("System and Logs settings save live with no Save buttons", async ({ browser }) => {
  const { context, page } = await adminPage(browser, true);
  await page.goto("/admin/system");
  for (const name of ["Save calculation defaults", "Save units", "Save session lifetimes"]) {
    await expect(page.getByRole("button", { name })).toBeHidden();
  }
  // The PIN change stays an explicit action.
  await expect(
    page.getByRole("button", { name: "Change PIN and sign out all sessions" }),
  ).toBeVisible();

  const calculation = page.locator('form[action="/admin/system/calculation"]');
  const serving = calculation.getByLabel("Default serving size (mL)");
  const originalServing = await serving.inputValue();
  const retentionForm = page.locator('form[action="/admin/logs/retention"]');
  const activity = retentionForm.getByLabel("Activity Log (days)");
  let originalActivity: string | undefined;
  try {
    await serving.fill(originalServing === "360" ? "375" : "360");
    await saveLive(calculation, "Save calculation defaults");
    await expect(page).toHaveURL(/\/admin\/system$/u);
    await page.reload();
    await expect(serving).toHaveValue(originalServing === "360" ? "375" : "360");

    // An invalid value is reported on its field and isn't saved.
    await serving.fill("0");
    await serving.blur();
    await expect(calculation.locator("[data-autosave-status]")).toHaveAttribute(
      "data-autosave-state",
      "error",
    );
    await expect(serving).toHaveAttribute("aria-invalid", "true");

    await page.goto("/admin/logs/retention");
    await expect(page.getByRole("button", { name: "Save retention settings" })).toBeHidden();
    originalActivity = await activity.inputValue();
    const nextActivity = String(
      Number(originalActivity) < 3650 ? Number(originalActivity) + 1 : 3649,
    );
    await activity.fill(nextActivity);
    await saveLive(retentionForm, "Save retention settings");
    await page.reload();
    await expect(activity).toHaveValue(nextActivity);
  } finally {
    await page.goto("/admin/system");
    await serving.fill(originalServing);
    await saveLive(calculation, "Save calculation defaults");
    if (originalActivity !== undefined) {
      await page.goto("/admin/logs/retention");
      await activity.fill(originalActivity);
      await saveLive(retentionForm, "Save retention settings");
    }
    await context.close();
  }
});

test("the Tap Wars Mystery switch saves live and redraws what guests see", async ({ browser }) => {
  const { context, page } = await adminPage(browser, true);
  await closeCurrentWar(page);
  await startWar(page);
  const mystery = page.getByRole("switch", { name: "Mystery Tap for both Taps" });
  const description = page.locator("#tap-wars-mystery-status");
  try {
    await expect(mystery).toHaveAttribute("aria-checked", "false");
    const before = page.url();
    await mystery.click();
    await expect(mystery).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("[data-tap-wars-mystery] [data-autosave-status]")).toHaveText(
      "Mystery Tap is on for both Tap War Taps.",
    );
    await expect(description).toContainText("Guests see “Mystery Tap” instead of either beer.");
    await expect(page.locator('[data-war-public-title="1"]')).toHaveText("Mystery Tap");
    expect(page.url()).toBe(before);

    await mystery.click();
    await expect(mystery).toHaveAttribute("aria-checked", "false");
    await expect(description).toContainText("Guests see both beers.");
    await expect(page.locator('[data-war-public-title="1"]')).not.toHaveText("Mystery Tap");
    await page.reload();
    await expect(mystery).toHaveAttribute("aria-checked", "false");
  } finally {
    await page.goto("/admin/tap-wars");
    if ((await mystery.getAttribute("aria-checked")) === "true") {
      await mystery.click();
      await expect(mystery).toHaveAttribute("aria-checked", "false");
    }
    await closeCurrentWar(page);
    await context.close();
  }
});
