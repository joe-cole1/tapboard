import { expect, test, type Page } from "@playwright/test";

import { closeCurrentWar, startWar } from "./helpers.ts";

/** Signs in with JavaScript off, where the PIN form is submitted with its button. */
async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function publicTitles(page: Page): Promise<readonly string[]> {
  const response = await page.request.get("/api/public/tap-wars");
  const body = (await response.json()) as {
    tapWars: { side1: { title: string }; side2: { title: string } };
  };
  return [body.tapWars.side1.title, body.tapWars.side2.title];
}

test("the Admin Tap Wars switch makes both competitors Mystery Taps and back", async ({
  browser,
}) => {
  // The switch is a plain form: it must work with JavaScript off.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await login(page);
  await closeCurrentWar(page);
  await startWar(page);
  const mysterySwitch = page.getByRole("switch", { name: "Mystery Tap for both Taps" });
  try {
    await expect(mysterySwitch).toHaveAttribute("aria-checked", "false");
    expect(await publicTitles(page)).toEqual(["Tap Wars Amber", "Tap Wars Lager"]);

    await mysterySwitch.click();
    await expect(page.getByText("Mystery Tap is on for both Tap War Taps.")).toBeVisible();
    await expect(mysterySwitch).toHaveAttribute("aria-checked", "true");
    expect(await publicTitles(page)).toEqual(["Mystery Tap", "Mystery Tap"]);
    const dashboard = await (await page.request.get("/")).text();
    expect(dashboard).not.toContain("Tap Wars Amber");
    expect(dashboard).not.toContain("Tap Wars Lager");

    await mysterySwitch.click();
    await expect(page.getByText("Mystery Tap is off for both Tap War Taps.")).toBeVisible();
    await expect(mysterySwitch).toHaveAttribute("aria-checked", "false");
    expect(await publicTitles(page)).toEqual(["Tap Wars Amber", "Tap Wars Lager"]);
  } finally {
    await page.goto("/admin/tap-wars");
    if ((await mysterySwitch.getAttribute("aria-checked")) === "true") await mysterySwitch.click();
    await closeCurrentWar(page);
    await context.close();
  }
});
