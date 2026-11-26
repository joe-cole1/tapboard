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
  for (const name of [
    "Save calculation defaults",
    "Save units and time zone",
    "Save session lifetimes",
  ]) {
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

/** The radio card for `value` in a Display choice group (the radio itself is visually hidden). */
function choice(page: Page, name: string, value: string) {
  return page.locator(
    `form[data-shared-display-form] label:has(input[name="${name}"][value="${value}"])`,
  );
}

async function checkedValue(page: Page, name: string): Promise<string> {
  return page
    .locator(`form[data-shared-display-form] input[name="${name}"]:checked`)
    .getAttribute("value") as Promise<string>;
}

/** Waits for the server redraw of the Display preview that follows a live save. */
function previewRedraw(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/admin/display/shared",
  );
}

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? "with JavaScript" : "without JavaScript";

  test(`Display Default theme saves ${mode} and the preview and public page follow`, async ({
    browser,
  }) => {
    const { context, page } = await adminPage(browser, javaScriptEnabled);
    await page.goto("/admin/display/shared");
    const form = page.locator("form[data-shared-display-form]");
    const save = form.getByRole("button", { name: "Save Default Theme" });
    const originalTheme = await checkedValue(page, "theme");
    const theme = originalTheme === "warm_pub" ? "cyberpunk" : "warm_pub";
    try {
      if (javaScriptEnabled) await expect(save).toBeHidden();
      else await expect(save).toBeVisible();
      const redraw = javaScriptEnabled ? previewRedraw(page) : undefined;
      await choice(page, "theme", theme).click();
      await saveLive(form, "Save Default Theme");
      if (javaScriptEnabled) {
        await redraw;
        await expect(form.getByRole("status")).toHaveText("Saved");
        await expect(page).toHaveURL(/\/admin\/display\/shared$/u);
      } else await expect(page).toHaveURL(/\/admin\/display\/shared\?notice=/u);
      await expect(page.locator("[data-display-preview]")).toHaveAttribute(
        "data-preview-theme",
        theme,
      );
      const guest = await context.newPage();
      await guest.goto("/");
      await expect(guest.locator("html")).toHaveAttribute("data-theme", theme);
      await guest.close();
      await page.goto("/admin/display/shared");
      expect(await checkedValue(page, "theme")).toBe(theme);
    } finally {
      await page.goto("/admin/display/shared");
      if ((await checkedValue(page, "theme")) !== originalTheme) {
        await choice(page, "theme", originalTheme).click();
        await saveLive(form, "Save Default Theme");
        await page.goto("/admin/display/shared");
        expect(await checkedValue(page, "theme")).toBe(originalTheme);
      }
      await context.close();
    }
  });

  test(`Display Tap-card metrics save ${mode} and the preview follows`, async ({ browser }) => {
    const { context, page } = await adminPage(browser, javaScriptEnabled);
    await page.goto("/admin/display/shared");
    const form = page.locator('form[action="/admin/display/tap-card"]');
    const srm = form.getByRole("switch", { name: "SRM", exact: true });
    const previewSrm = page.locator('[data-display-preview] [data-metric-key="srm"]');
    const wasShown = await srm.isChecked();
    try {
      await page.setViewportSize({ width: 1280, height: 500 });
      await srm.scrollIntoViewIfNeeded();
      const scrolled = await page.evaluate(() => window.scrollY);
      const redraw = javaScriptEnabled ? previewRedraw(page) : undefined;
      await srm.setChecked(!wasShown);
      await saveLive(form, "Save Tap-card settings");
      if (javaScriptEnabled) {
        await redraw;
        await expect(form.getByRole("status")).toHaveText("Saved");
        expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
        await expect(page).toHaveURL(/\/admin\/display\/shared$/u);
      } else await expect(page).toHaveURL(/\/admin\/display\/shared\?notice=/u);
      await expect(previewSrm).toHaveCount(wasShown ? 0 : 1);
      await page.goto("/admin/display/shared");
      await expect(srm).toBeChecked({ checked: !wasShown });
      await expect(previewSrm).toHaveCount(wasShown ? 0 : 1);
    } finally {
      await page.goto("/admin/display/shared");
      if ((await srm.isChecked()) !== wasShown) {
        await srm.setChecked(wasShown);
        await saveLive(form, "Save Tap-card settings");
        await page.goto("/admin/display/shared");
        await expect(srm).toBeChecked({ checked: wasShown });
      }
      await context.close();
    }
  });
}

test("a Units save on System makes an open Default theme form stale", async ({ browser }) => {
  const { context, page } = await adminPage(browser, true);
  const system = await context.newPage();
  await page.goto("/admin/display/shared");
  const form = page.locator("form[data-shared-display-form]");
  const originalTheme = await checkedValue(page, "theme");
  const theme = originalTheme === "warm_pub" ? "cyberpunk" : "warm_pub";
  await system.goto("/admin/system");
  const units = system.locator('form[action="/admin/system/units"]');
  const unitSystem = units.getByLabel("Units");
  const originalUnits = await unitSystem.inputValue();
  try {
    await unitSystem.selectOption(originalUnits === "us" ? "metric" : "us");
    await saveLive(units, "Save units and time zone");
    await choice(page, "theme", theme).click();
    await expect(form.getByRole("status")).toHaveText(
      "Conflict — reload to review the current value",
    );
    await page.reload();
    expect(await checkedValue(page, "theme")).toBe(originalTheme);
  } finally {
    await system.goto("/admin/system");
    if ((await unitSystem.inputValue()) !== originalUnits) {
      await unitSystem.selectOption(originalUnits);
      await saveLive(units, "Save units and time zone");
    }
    await context.close();
  }
});

test("the System time zone saves live and Admin dates follow it", async ({ browser }) => {
  const { context, page } = await adminPage(browser, true);
  await page.goto("/admin/system");
  const units = page.locator('form[action="/admin/system/units"]');
  const zone = units.getByLabel("Time zone");
  const original = await zone.inputValue();
  try {
    await zone.selectOption("America/New_York");
    await saveLive(units, "Save units and time zone");
    await page.goto("/admin/logs");
    await expect(page.getByRole("columnheader", { name: "Time", exact: true })).toBeVisible();
    await expect(page.locator("table time").first()).toHaveText(/ [AP]M E[SD]T$/u);
    await page.goto("/admin/system");
    await expect(zone).toHaveValue("America/New_York");
  } finally {
    await page.goto("/admin/system");
    if ((await zone.inputValue()) !== original) {
      await zone.selectOption(original);
      await saveLive(units, "Save units and time zone");
    }
    await context.close();
  }
});
