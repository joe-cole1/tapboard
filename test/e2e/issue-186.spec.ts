/// <reference lib="dom" />

import { expect, test, type Browser, type Page } from "@playwright/test";

// 36 characters with a 15-letter word: before #186 this winner pushed the banner 56 px past
// the 980 px guest preview (names made only of short words wrapped and fit).
const LONG_NAME = "Weihenstephaner Hefeweissbier Dunkel";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function closeCurrentWar(page: Page): Promise<void> {
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

async function startWar(page: Page): Promise<void> {
  await page.goto("/admin/tap-wars");
  const selects = page.locator("[data-tap-wars-selector]");
  for (const [index, tapNumber] of [4, 5].entries()) {
    const value = await selects
      .nth(index)
      .locator(`option[data-tap-number="${tapNumber}"]`)
      .getAttribute("value");
    if (value === null) throw new Error(`Expected fixture Tap ${tapNumber}.`);
    await selects.nth(index).selectOption(value);
  }
  // Without JavaScript the Start form gets the pair from the previewed page.
  const update = page.getByRole("button", { name: "Update preview" });
  if (await update.isVisible()) await update.click();
  await page.getByRole("button", { name: "Start Tap War" }).click();
  await expect(page.getByRole("heading", { name: "Current Tap War" })).toBeVisible();
}

/** Renames a fixture beverage through the Admin autosave. */
async function renameCompetitor(page: Page, from: string, to: string): Promise<void> {
  await page.goto("/admin/beverages");
  await page
    .locator("tbody tr")
    .filter({ hasText: from })
    .getByRole("link", { name: from })
    .click();
  const form = page.locator('form[action$="/update"][data-autosave="blur"]');
  await expect(form).toHaveAttribute("data-autosave-initialized", "true");
  await form.getByLabel("Name").fill(to);
  await form.getByLabel("Name").blur();
  await expect(form.locator("[data-autosave-status]")).toHaveText("Saved");
}

async function expectBannerFits(page: Page): Promise<void> {
  const fit = await page.locator("[data-tap-wars-guest-preview]").evaluate((frame) => {
    const banner = frame.querySelector("[data-tap-wars]");
    if (!(banner instanceof HTMLElement)) throw new Error("Expected the previewed banner.");
    return {
      frame: frame.clientWidth,
      frameScroll: frame.scrollWidth,
      banner: banner.clientWidth,
      bannerScroll: banner.scrollWidth,
    };
  });
  expect(fit.bannerScroll).toBeLessThanOrEqual(fit.frame);
  // Nothing spills out of the banner's own box into the frame's padding either.
  expect(fit.bannerScroll).toBeLessThanOrEqual(fit.banner);
  expect(fit.frameScroll).toBeLessThanOrEqual(fit.frame);
}

async function voteForSideOne(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  const war = (await (await page.request.get("/api/public/tap-wars")).json()) as {
    tapWars: { id: string };
  };
  const vote = await page.request.post(`/api/public/tap-wars/${war.tapWars.id}/votes`, {
    form: { side: "1" },
    headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
  });
  expect(vote.ok()).toBe(true);
  await context.close();
}

/** WCAG contrast of an element's text (or placeholder) against the colours painted behind it. */
function contrastOf(element: Element, part: "text" | "placeholder" | "border"): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const rgba = (value: string): number[] => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const over = (top: number[], bottom: number[]): number[] =>
    [0, 1, 2].map((index) => top[index]! * top[3]! + bottom[index]! * (1 - top[3]!)).concat(1);
  const ground = (node: Element | null): number[] => {
    const chain: Element[] = [];
    for (let current = node; current; current = current.parentElement) chain.unshift(current);
    return chain.reduce(
      (below, current) => {
        const colour = rgba(getComputedStyle(current).backgroundColor);
        return colour[3]! > 0 ? over(colour, below) : below;
      },
      [255, 255, 255, 1],
    );
  };
  const luminance = (colour: number[]): number =>
    colour
      .slice(0, 3)
      .map((value) => value / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const ratio = (first: number[], second: number[]): number => {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light! + 0.05) / (dark! + 0.05);
  };
  if (part === "border") {
    const outside = ground(element.parentElement);
    return ratio(over(rgba(getComputedStyle(element).borderTopColor), outside), outside);
  }
  const behind = ground(element);
  const style = getComputedStyle(element, part === "placeholder" ? "::placeholder" : null);
  return ratio(over(rgba(style.color), behind), behind);
}

async function useDisplayStylesheet(page: Page, theme: string, accent: string): Promise<void> {
  await page.evaluate(
    async ([themeName, accentName]) => {
      const current = document.querySelector<HTMLLinkElement>("link[data-display-stylesheet]");
      if (current === null) throw new Error("Expected the display stylesheet.");
      const url = new URL(current.href);
      url.searchParams.set("theme", themeName!);
      url.searchParams.set("accent", accentName!);
      const next = current.cloneNode() as HTMLLinkElement;
      next.href = url.href;
      await new Promise((resolve, reject) => {
        next.addEventListener("load", resolve);
        next.addEventListener("error", reject);
        current.after(next);
      });
      current.remove();
    },
    [theme, accent],
  );
}

test("the Tap Wars guest preview fits at 980 px, active and with a long published winner (#186)", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 980, height: 900 } });
  const admin = await context.newPage();
  await login(admin);
  await closeCurrentWar(admin);
  await renameCompetitor(admin, "Tap Wars Amber", LONG_NAME);
  try {
    await startWar(admin);
    await admin.goto("/admin/tap-wars");
    await expectBannerFits(admin);

    await voteForSideOne(browser);
    await admin.getByRole("button", { name: "Stop Tap War" }).click();
    await expect(admin.getByRole("heading", { name: "Published result" })).toBeVisible();
    await expect(admin.locator("[data-tap-wars-guest-preview] [data-tap-wars-status]")).toHaveText(
      `TAP WARS WINNER — ${LONG_NAME}!`,
    );
    await expectBannerFits(admin);
  } finally {
    await closeCurrentWar(admin);
    await renameCompetitor(admin, LONG_NAME, "Tap Wars Amber");
    await context.close();
  }
});

test("Tap Wars banner and badge text stays readable on its accent tint in every failing pairing (#186)", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin);
  await closeCurrentWar(admin);
  await startWar(admin);
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("[data-tap-wars]")).toBeVisible();
    // Measured below 4.5:1 before #186: the banner tint and badge used colours computed
    // against the plain surface only.
    for (const [theme, accent] of [
      ["hop_garden", "blue"],
      ["chalkboard", "orange"],
      ["cyberpunk", "theme"],
      ["cyberpunk", "cyan"],
      ["light_minimal", "blue"],
      ["light_minimal", "theme"],
      ["copper_kettle", "blue"],
      ["modern_dark", "blue"],
    ] as const) {
      await useDisplayStylesheet(page, theme, accent);
      for (const selector of [
        "[data-tap-wars-status]",
        "[data-tap-wars-message]",
        "[data-tap-wars-card-badge]",
      ]) {
        const ratio = await page
          .locator(selector)
          .first()
          .evaluate(contrastOf, "text" as const);
        expect(ratio, `${theme}/${accent} ${selector}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    await closeCurrentWar(admin);
    await context.close();
  }
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`Admin text fields have a 3:1 border and a 4.5:1 placeholder in the ${colorScheme} scheme (#186)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await login(page);
    for (const path of ["/admin/keg-room", "/admin/taps/new", "/admin/integrations/telemetry"]) {
      await page.goto(path);
      const fields = page.locator(
        "main :is(input:not([type=hidden], [type=checkbox], [type=radio], [type=color]), select, textarea):visible",
      );
      expect(await fields.count(), path).toBeGreaterThan(0);
      for (const field of await fields.all()) {
        const name = `${path} ${await field.evaluate((node) => node.outerHTML.slice(0, 80))}`;
        expect(await field.evaluate(contrastOf, "border" as const), name).toBeGreaterThanOrEqual(3);
        if (await field.getAttribute("placeholder")) {
          expect(
            await field.evaluate(contrastOf, "placeholder" as const),
            name,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    await context.close();
  });
}

test("disabled buttons and form controls look unavailable on public and Admin pages (#186)", async ({
  page,
}) => {
  await login(page);
  for (const path of ["/", "/admin/overview"]) {
    await page.goto(path);
    const styles = await page.evaluate(() => {
      const host = document.querySelector("main") ?? document.body;
      return ["button", "input", "select", "textarea"].map((tag) => {
        const [enabled, disabled] = [false, true].map((isDisabled) => {
          const control = document.createElement(tag) as HTMLButtonElement;
          control.disabled = isDisabled;
          host.append(control);
          const { opacity, cursor } = getComputedStyle(control);
          control.remove();
          return { opacity: Number(opacity), cursor };
        });
        return { tag, enabled: enabled!, disabled: disabled! };
      });
    });
    for (const { tag, enabled, disabled } of styles) {
      expect(enabled.opacity, `${path} ${tag}`).toBe(1);
      expect(disabled.opacity, `${path} ${tag}`).toBeLessThan(0.7);
      expect(disabled.cursor, `${path} ${tag}`).toBe("not-allowed");
    }
  }
});
