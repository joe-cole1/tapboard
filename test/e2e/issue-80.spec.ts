/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

const CALCULATION_FIELDS = ["fallbackFg", "servingSizeMl"] as const;
const RETENTION_FIELDS = [
  "activityDays",
  "rawSeconds",
  "receiptSeconds",
  "reconnectSeconds",
  "outboxDays",
] as const;
type SavedSettings = Record<
  (typeof CALCULATION_FIELDS)[number] | (typeof RETENTION_FIELDS)[number],
  string
>;

async function login(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function readFields(page: Page, fields: readonly string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field] = await page.locator(`input[name="${field}"]`).inputValue();
  }
  return values;
}

async function readSettings(page: Page): Promise<SavedSettings> {
  await page.goto("/admin/system");
  const calculation = await readFields(page, CALCULATION_FIELDS);
  await page.goto("/admin/logs/retention");
  return { ...calculation, ...(await readFields(page, RETENTION_FIELDS)) } as SavedSettings;
}

async function restoreSettings(page: Page, original: SavedSettings): Promise<void> {
  await page.goto("/admin/system");
  if (new URL(page.url()).pathname === "/admin/login") {
    await login(page);
    await page.goto("/admin/system");
  }
  await page.locator('input[name="fallbackFg"]').fill(original.fallbackFg);
  await page.locator('input[name="servingSizeMl"]').fill(original.servingSizeMl);
  await page.getByRole("button", { name: "Save calculation defaults" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Calculation defaults saved." }),
  ).toBeVisible();
  await page.goto("/admin/logs/retention");
  for (const field of RETENTION_FIELDS) {
    await page.locator(`input[name="${field}"]`).fill(original[field]);
  }
  await page.getByRole("button", { name: "Save retention settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Retention settings saved." }),
  ).toBeVisible();
  expect(await readSettings(page)).toEqual(original);
}

test("Issue 80 System and Logs support no-JS save, Activity filtering, selected/self revoke and private mobile layout", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const selectedContext = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const selectedPage = await selectedContext.newPage();
  let original: SavedSettings | undefined;
  let restoreNeeded = false;
  try {
    await login(page);
    await page.goto("/admin/simulator");
    const simulation = page.getByRole("switch", { name: "Enable simulation" });
    if ((await simulation.getAttribute("aria-checked")) === "true") {
      await simulation.click();
      await expect(page).toHaveURL(/\/admin\/simulator/u);
    }
    await page.goto("/admin/system");
    await expect(page.getByRole("heading", { name: "System", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
    original = await readSettings(page);

    await login(selectedPage);
    await selectedPage.goto("/admin/logs/sessions");
    const selectedArticle = selectedPage.getByRole("article").filter({
      has: selectedPage.getByRole("heading", { name: "This session", exact: true }),
    });
    const selectedAction = await selectedArticle.locator("form").getAttribute("action");
    expect(selectedAction).toMatch(/^\/admin\/logs\/sessions\/[0-9a-f-]{36}\/revoke$/u);

    await page.goto("/admin/system");
    // Keep gravity unchanged so shared serving fixtures retain their telemetry epochs.
    const servingSize = original.servingSizeMl === "360" ? "375" : "360";
    restoreNeeded = true;
    await page.getByLabel("Default serving size (mL)").fill(servingSize);
    await page.getByRole("button", { name: "Save calculation defaults" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Calculation defaults saved." }),
    ).toBeVisible();
    await expect(page.getByLabel("Default serving size (mL)")).toHaveValue(servingSize);
    await expect(page.getByLabel("Fallback final gravity")).toHaveValue(original.fallbackFg);

    await page.goto("/admin/logs/retention");
    const activityDays = String(
      Number(original.activityDays) < 3650
        ? Number(original.activityDays) + 1
        : Number(original.activityDays) - 1,
    );
    await page.getByLabel("Activity Log (days)").fill(activityDays);
    await page.getByRole("button", { name: "Save retention settings" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Retention settings saved." }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/logs\/retention\?/u);
    await expect(page.getByLabel("Activity Log (days)")).toHaveValue(activityDays);

    await page.goto("/admin/logs");
    await page.getByLabel("Activity category").selectOption("admin");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/\/admin\/logs\?category=admin$/u);
    const rows = page.locator("#activity tbody tr");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(50);
    for (const row of await rows.all()) await expect(row.locator("td").nth(1)).toHaveText("Admin");

    const currentCookies = await context.cookies();
    const selectedCookies = await selectedContext.cookies();
    const currentToken = currentCookies.find((cookie) => cookie.name === "tapboard_admin_session");
    const selectedToken = selectedCookies.find(
      (cookie) => cookie.name === "tapboard_admin_session",
    );
    const selectedCsrf = selectedCookies.find((cookie) => cookie.name === "tapboard_admin_csrf");
    expect(currentToken).toBeDefined();
    expect(selectedToken).toBeDefined();
    expect(selectedCsrf).toBeDefined();
    for (const path of [
      "/admin/system",
      "/admin/logs/retention",
      "/admin/logs/sessions",
      "/admin/logs?category=admin",
    ]) {
      await page.goto(path);
      const html = await page.content();
      for (const privateValue of [
        "PRIVATE_MAINTENANCE_NOTE",
        "PRIVATE_DISABLED_NOTE",
        "PRIVATE_RETIRED_NOTE",
        "PRIVATE_BREWFATHER_USER",
        "PRIVATE_BREWFATHER_API_KEY",
        "LIVE_MYSTERY_SECRET_77",
        "ISSUE_79_PRIVATE_HA_TOKEN",
        "ISSUE_79_PRIVATE_HEADER_SECRET",
        "https://issue-79-private.invalid/webhook-secret",
        currentToken!.value,
        selectedToken!.value,
        selectedCsrf!.value,
      ]) {
        expect(html, path).not.toContain(privateValue);
      }
      expect(html).not.toMatch(/session_digest|csrf_digest|details_json/u);
      for (const width of [390, 800, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `${path} at ${width}px`,
        ).toBe(true);
      }
    }

    await page.goto("/admin/logs/sessions");
    const selectedForm = page.locator(`form[action="${selectedAction!}"]`);
    await selectedForm.getByRole("switch", { name: "Confirm revocation", exact: true }).check();
    await selectedForm.getByRole("button", { name: "Revoke session", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Session revoked.");
    await expect(page).toHaveURL(/\/admin\/logs\/sessions\?/u);
    await selectedPage.goto("/admin/logs/sessions");
    await expect(selectedPage).toHaveURL(/\/admin\/login$/u);

    await restoreSettings(page, original);
    restoreNeeded = false;
    await page.goto("/admin/logs/sessions");
    const currentArticle = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "This session", exact: true }),
    });
    await currentArticle
      .getByRole("switch", { name: "Confirm revocation of this session" })
      .check();
    await currentArticle.getByRole("button", { name: "Revoke this session", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/login\?notice=/u);
    await page.goto("/admin/system");
    await expect(page).toHaveURL(/\/admin\/login$/u);
  } finally {
    try {
      if (restoreNeeded && original !== undefined) await restoreSettings(page, original);
    } finally {
      await Promise.all([context.close(), selectedContext.close()]);
    }
  }
});
