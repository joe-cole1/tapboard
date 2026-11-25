/// <reference lib="dom" />

// #253 PR 4: blockers that link to their fix, inline copy-then-type confirmation, and adding a
// Telemetry source on its own page, each with and without JavaScript.
import { expect, test, type Browser, type Page } from "@playwright/test";

async function signIn(browser: Browser, javaScriptEnabled: boolean): Promise<Page> {
  const context = await browser.newContext({ javaScriptEnabled });
  if (javaScriptEnabled) await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  if (!javaScriptEnabled) await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
  return page;
}

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? "on" : "off";

  test(`Tap deletion confirms inline, with a copy icon only when it works (JavaScript ${mode})`, async ({
    browser,
  }) => {
    const page = await signIn(browser, javaScriptEnabled);
    await page.goto("/admin/taps");
    await page.getByRole("link", { name: "Open Tap 6 — Fixture Tap 6" }).click();
    await page.getByRole("link", { name: "Identity", exact: true }).click();
    const deletion = page.locator("section", {
      has: page.getByRole("heading", { name: "Permanent deletion" }),
    });
    const value = "Tap 6 — Fixture Tap 6";
    const input = deletion.getByRole("textbox", { name: `Type "${value}" to confirm` });
    await expect(input).toBeVisible();
    await expect(deletion.locator(".confirm-prompt__value")).toHaveText(value);
    await expect(deletion.locator("input[readonly]")).toHaveCount(0);
    const copy = deletion.getByRole("button", { name: `Copy ${value}` });
    if (javaScriptEnabled) {
      await copy.click();
      await expect(deletion.locator("[data-copy-status]")).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
      await expect(input).toHaveValue("");
    } else {
      await expect(copy).toBeHidden();
    }
    await page.context().close();
  });

  test(`a blocked action links to its fix, and Add source opens a page (JavaScript ${mode})`, async ({
    browser,
  }) => {
    const page = await signIn(browser, javaScriptEnabled);
    await page.goto("/admin/integrations/telemetry");
    await page.getByRole("link", { name: "Private fixture source" }).first().click();
    const disable = page.locator("section", {
      has: page.getByRole("heading", { name: "Disable source" }),
    });
    await expect(disable).toContainText("Tap 1 uses this source, so it can't be disabled.");
    await expect(disable.getByRole("button", { name: "Disable source" })).toHaveCount(0);
    await expect(page.getByText("Key label")).toHaveCount(0);
    await disable.getByRole("link", { name: "Change Tap 1's sensors" }).click();
    await expect(page).toHaveURL(/\/admin\/taps\/[^/]+\/sensors$/u);

    await page.goto("/admin/integrations/telemetry");
    await page.getByRole("link", { name: "Add source" }).click();
    await expect(page).toHaveURL(/\/admin\/integrations\/telemetry\/new$/u);
    await expect(page.getByRole("textbox", { name: "Key label" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Source name" }).fill(`E2E added source ${mode}`);
    await page.getByRole("button", { name: "Create source and show key" }).click();
    await expect(page.getByRole("heading", { name: "Telemetry key created" })).toBeVisible();
    await expect(page.locator("#machine-key")).toHaveText(/^tbk_/u);
    await page.context().close();
  });
}
