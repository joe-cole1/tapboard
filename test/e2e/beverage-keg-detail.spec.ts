/// <reference lib="dom" />

// #253 PR 3 and #258: Beverage detail as link tabs with live save and the display colour
// picker, and Keg detail with its everyday forms open and the tare behind Advanced settings,
// each with and without JavaScript.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { saveLive } from "./helpers.ts";

async function signIn(browser: Browser, javaScriptEnabled: boolean): Promise<Page> {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  if (!javaScriptEnabled) await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
  return page;
}

/** An SRM swatch: its radio is visually hidden, so a click lands on the label around it. */
function swatch(page: Page, srm: string): Locator {
  return page.locator("label.srm-swatch", {
    has: page.getByRole("radio", { name: srm, exact: true }),
  });
}

/** With JavaScript a one-click form saved in place; without it the page came back with a notice. */
async function expectSaved(page: Page, javaScriptEnabled: boolean, urlBefore: string) {
  if (javaScriptEnabled) {
    await expect(page.locator("[data-colour-picker] [data-autosave-status]")).toHaveText("Saved");
    expect(page.url()).toBe(urlBefore);
  } else await expect(page).toHaveURL(/\/presentation\?notice=/u);
}

for (const javaScriptEnabled of [true, false]) {
  const mode = javaScriptEnabled ? "on" : "off";

  test(`a new beer's tabs save live, and its colour follows SRM until picked (JavaScript ${mode})`, async ({
    browser,
  }) => {
    const page = await signIn(browser, javaScriptEnabled);
    const name = `Tabbed Amber ${mode} ${Date.now()}`;
    await page.goto("/admin/beverages/new");
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await swatch(page, "10").click();
    await page.getByRole("button", { name: "Create beverage" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

    // Six link tabs, each a real URL that names the Beverage in the breadcrumb.
    const tabs = page.getByRole("navigation", { name: `${name} pages` });
    for (const label of ["Info", "Presentation", "Current usage", "Recipe", "Sensory", "Delete"])
      await expect(tabs.getByRole("link", { name: label, exact: true })).toBeVisible();
    const info = page.url();

    // Info: identity saves live; the Save button exists only without JavaScript.
    const details = page.locator("form", {
      has: page.getByRole("spinbutton", { name: "ABV (%)" }),
    });
    await expect(details.getByRole("button", { name: "Save details" })).toBeVisible({
      visible: !javaScriptEnabled,
    });
    await details.getByRole("spinbutton", { name: "ABV (%)" }).fill("5.4");
    await saveLive(details, "Save details");
    if (!javaScriptEnabled) expect(new URL(page.url()).pathname).toBe(new URL(info).pathname);
    await page.reload();
    await expect(page.getByRole("spinbutton", { name: "ABV (%)" })).toHaveValue("5.4");

    // Presentation: open, with the swatch chosen at creation and the colour matching it.
    await tabs.getByRole("link", { name: "Presentation", exact: true }).click();
    await expect(page.locator("details.disclosure")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "10", exact: true })).toBeChecked();
    const colour = page.getByRole("textbox", { name: "Display colour", exact: true });
    const source = page.locator("[data-colour-source]");
    const reset = page.getByRole("button", { name: "Reset display colour to match SRM" });
    await expect(colour).toHaveValue("#a73d00");
    await expect(source).toHaveText("Matches SRM");
    await expect(reset).toBeHidden();

    // A swatch saves at once; the colour and the header cue follow it.
    let urlBefore = page.url();
    await swatch(page, "20").click();
    if (!javaScriptEnabled) await page.getByRole("button", { name: "Save SRM" }).click();
    await expectSaved(page, javaScriptEnabled, urlBefore);
    await expect(page.getByRole("radio", { name: "20", exact: true })).toBeChecked();
    await expect(colour).toHaveValue("#530c00");
    await expect(page.locator("[data-beverage-colour-cue] circle")).toHaveAttribute(
      "fill",
      /#530C00/iu,
    );

    // A picked colour overrides SRM, and its reset clears the override.
    urlBefore = page.url();
    await colour.fill("#336699");
    if (!javaScriptEnabled) await page.getByRole("button", { name: "Save colour" }).click();
    await expectSaved(page, javaScriptEnabled, urlBefore);
    await expect(source).toHaveText("Custom colour");
    await expect(reset).toBeVisible();
    const box = (await reset.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    urlBefore = page.url();
    await reset.click();
    await expectSaved(page, javaScriptEnabled, urlBefore);
    await expect(reset).toBeHidden();
    await expect(source).toHaveText("Matches SRM");
    await expect(colour).toHaveValue("#530c00");
    if (javaScriptEnabled) await expect(colour).toBeFocused();

    // Sensory overrides save live too.
    await tabs.getByRole("link", { name: "Sensory", exact: true }).click();
    const overrides = page.locator("form", {
      has: page.getByRole("spinbutton", { name: "Malt character" }),
    });
    await overrides.getByRole("spinbutton", { name: "Malt character" }).fill("6");
    await saveLive(overrides, "Save sensory overrides");
    await page.reload();
    await expect(page.getByRole("spinbutton", { name: "Malt character" })).toHaveValue("6");
    await page.context().close();
  });

  test(`Keg detail keeps everyday forms open and the tare behind Advanced settings (JavaScript ${mode})`, async ({
    browser,
  }) => {
    const page = await signIn(browser, javaScriptEnabled);
    // A fresh number per run, since specs share one fixture server.
    const number = String(1_000 + ((Date.now() * 2 + (javaScriptEnabled ? 1 : 0)) % 8_000));
    await page.goto("/admin/keg-room/kegs/new");
    await page.getByRole("spinbutton", { name: "Keg number" }).fill(number);
    await page.getByRole("spinbutton", { name: "Capacity (mL)" }).fill("19000");
    await page.getByRole("button", { name: "Add Keg" }).click();
    await page.getByRole("link", { name: new RegExp(`^Open Keg ${number}$`, "u") }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Keg ${number}`);
    const kegPage = new URL(page.url()).pathname;

    const label = page.locator("form", { has: page.getByRole("textbox", { name: "Label" }) });
    await label.getByRole("textbox", { name: "Label" }).fill("Spare");
    await saveLive(label, "Save label");
    const details = page.locator("form", {
      has: page.getByRole("spinbutton", { name: "Capacity (mL)" }),
    });
    await details.getByRole("spinbutton", { name: "Capacity (mL)" }).fill("18500");
    await saveLive(details, "Save details");
    expect(new URL(page.url()).pathname).toBe(kegPage);

    // Tare is expert tuning: closed until opened, and its reason travels with the change.
    const advanced = page.locator("details.disclosure", { hasText: "Advanced settings" });
    await expect(advanced).not.toHaveAttribute("open", "");
    await advanced.locator("summary").click();
    const tare = page.locator("form", { has: page.getByRole("spinbutton", { name: "Tare (g)" }) });
    await tare.getByRole("textbox", { name: "Correction reason" }).fill("Weighed empty");
    await tare.getByRole("spinbutton", { name: "Tare (g)" }).fill("4250");
    await saveLive(tare, "Save tare");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Keg ${number} — Spare`);
    await expect(page.getByRole("spinbutton", { name: "Capacity (mL)" })).toHaveValue("18500");
    await page
      .locator("details.disclosure", { hasText: "Advanced settings" })
      .locator("summary")
      .click();
    await expect(page.getByText(/→ 4250 g .* Weighed empty/u)).toBeVisible();
    await page.context().close();
  });
}
