/// <reference lib="dom" />

import { expect, test } from "@playwright/test";

test("the vessel graphic stays the focus of a tap card in short and mid-width windows", async ({
  page,
}) => {
  // 930x680 and 700x600 used to squeeze three fitted rows until the graphic collapsed to nothing.
  for (const viewport of [
    { width: 930, height: 680 },
    { width: 700, height: 600 },
    { width: 800, height: 900 },
    { width: 1280, height: 720 },
    { width: 1100, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator(".tap-card").first()).toBeVisible();
    const graphics = await page.locator(".tap-card").evaluateAll((cards) =>
      cards.map((card) => {
        const cardBounds = card.getBoundingClientRect();
        const graphic = card.querySelector(".tap-graphic")!.getBoundingClientRect();
        return {
          height: graphic.height,
          inside: graphic.top >= cardBounds.top - 1 && graphic.bottom <= cardBounds.bottom + 1,
        };
      }),
    );
    const label = `${viewport.width}x${viewport.height}`;
    expect(graphics.length, label).toBeGreaterThan(0);
    for (const graphic of graphics) {
      expect(graphic.height, label).toBeGreaterThanOrEqual(90);
      expect(graphic.inside, label).toBe(true);
    }
  }
});
