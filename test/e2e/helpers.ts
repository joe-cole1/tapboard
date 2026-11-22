/// <reference lib="dom" />

import { expect, type Locator, type Page } from "@playwright/test";

/** Signs in through the JavaScript keypad, which submits once four digits are typed. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

/** The element's computed colours, and what each named role resolves to in its scope. */
export async function colours(
  locator: Locator,
  roles: readonly string[],
): Promise<Record<string, string>> {
  return locator.evaluate((node, names) => {
    const probe = document.createElement("span");
    node.parentElement!.append(probe);
    const resolved: Record<string, string> = {};
    for (const name of names) {
      probe.style.color = `var(${name})`;
      resolved[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.borderTopColor,
      ...resolved,
    };
  }, roles);
}

/** Stops a running Tap War and dismisses its published result, so the next one can start. */
export async function closeCurrentWar(page: Page): Promise<void> {
  await page.goto("/admin/tap-wars");
  const stop = page.getByRole("button", { name: "Stop Tap War" });
  if (await stop.count()) {
    await stop.click();
    await expect(page.getByRole("heading", { name: "Published result" })).toBeVisible();
  }
  const dismiss = page.getByRole("button", { name: "Dismiss public result" });
  if (await dismiss.count()) {
    await dismiss.click();
    await expect(page.getByRole("heading", { name: "Start a Tap War" })).toBeVisible();
  }
}

/** Starts a Tap War between fixture Taps 4 and 5. */
export async function startWar(page: Page): Promise<void> {
  await page.goto("/admin/tap-wars");
  const form = page.locator("[data-tap-wars-start]");
  const selects = form.locator("[data-tap-wars-selector]");
  for (const [index, tapNumber] of [4, 5].entries()) {
    const value = await selects
      .nth(index)
      .locator(`option[data-tap-number="${tapNumber}"]`)
      .getAttribute("value");
    if (value === null) throw new Error(`Expected fixture Tap ${tapNumber}.`);
    await selects.nth(index).selectOption(value);
  }
  await form.getByRole("button", { name: "Start Tap War" }).click();
  await expect(page.getByRole("heading", { name: "Current Tap War" })).toBeVisible();
}
