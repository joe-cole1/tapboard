/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from "@playwright/test";

// #187 moved the element defaults into the base cascade layer. Before that the generic
// `button:hover:not(:disabled)` accent fill (specificity 0,2,1) beat every one-class button
// rule, so Danger buttons turned amber on hover and the On Deck toggle's own hover never showed.
// Nothing here saves settings, so other specs see unchanged state.

async function signIn(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

/** The element's computed colours, and what each named role resolves to in its scope. */
async function colours(
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

test("Danger buttons stay red on hover", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/beverages");
  await page.locator("tbody tr").first().getByRole("link").first().click();
  const remove = page.getByRole("button", { name: "Permanently delete beverage" });
  await expect(remove).toBeEnabled();
  await remove.hover();
  const hovered = await colours(remove, ["--danger", "--on-danger", "--accent-hover"]);
  expect(hovered.background).toBe(hovered["--danger"]);
  expect(hovered.color).toBe(hovered["--on-danger"]);
  expect(hovered.background).not.toBe(hovered["--accent-hover"]);
});

test("the Admin sidebar toggle keeps its accent fill on hover", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const toggle = page.locator(".admin-sidebar-toggle");
  await expect(toggle).toBeVisible();
  const resting = await colours(toggle, ["--surface-raised"]);
  expect(resting.background).toBe(resting["--surface-raised"]);
  await toggle.hover();
  const hovered = await colours(toggle, ["--accent-hover", "--on-accent-hover"]);
  expect(hovered.background).toBe(hovered["--accent-hover"]);
  expect(hovered.color).toBe(hovered["--on-accent-hover"]);
});

test("the sign-in keypad keys keep their accent fill on hover", async ({ page }) => {
  await page.goto("/admin/login");
  const key = page.locator("[data-pin-key='5']");
  await expect(key).toBeVisible();
  const resting = await colours(key, ["--surface-raised"]);
  expect(resting.background).toBe(resting["--surface-raised"]);
  await key.hover();
  const hovered = await colours(key, ["--accent-hover", "--on-accent-hover"]);
  expect(hovered.background).toBe(hovered["--accent-hover"]);
  expect(hovered.color).toBe(hovered["--on-accent-hover"]);
});

test("the On Deck toggle shows its own hover style", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/");
  await page.locator("[data-on-deck-list]").evaluate((list) => {
    const item = list.querySelector("li");
    if (!item) throw new Error("Expected an On Deck fixture item.");
    for (let index = 0; index < 18; index += 1) list.append(item.cloneNode(true));
    window.dispatchEvent(new Event("resize"));
  });
  const toggle = page.locator("[data-on-deck-toggle]");
  await expect(toggle).toBeVisible();
  await toggle.hover();
  const hovered = await colours(toggle, ["--text", "--accent-strong"]);
  expect(hovered.background).toBe("rgba(0, 0, 0, 0)");
  expect(hovered.color).toBe(hovered["--text"]);
  expect(hovered.border).toBe(hovered["--accent-strong"]);
});

test("named accent swatches take their colour from the generated stylesheet", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/display/shared");
  const swatch = (name: string): Promise<string> =>
    page
      .locator(`.display-accent-swatch--${name}`)
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await swatch("amber")).toBe("rgb(251, 192, 45)");
  expect(await swatch("blue")).toBe("rgb(37, 99, 235)");
  expect(
    await page
      .locator(".display-accent-swatch--custom")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundImage),
  ).toMatch(/^conic-gradient\(/u);
});
