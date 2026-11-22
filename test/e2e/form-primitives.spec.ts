/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers.ts";

// #181 (PR 3 of 4) and #253: Admin forms use flat fieldsets and one switch. Every checkbox,
// radio and switch is at least a 24px target (WCAG 2.5.8), switches keep 3:1 non-text
// contrast (WCAG 1.4.11) in both Admin schemes, and both switch hosts submit without
// JavaScript.

const PAGES = [
  "/admin/taps/new",
  "/admin/beverages/new",
  "/admin/keg-room/fills/new",
  "/admin/keg-room/kegs/new",
  "/admin/integrations/brewfather",
  "/admin/integrations/telemetry",
  "/admin/integrations/outbound/new?transport=webhook",
  "/admin/integrations/outbound/new?transport=home_assistant",
  "/admin/display/shared",
  "/admin/display/this-display",
  "/admin/tap-wars",
  "/admin/simulator",
  "/admin/system",
];

const DETAILS: readonly [string, RegExp][] = [
  ["/admin/taps", /^\/admin\/taps\/(?!new)[^/?#]+$/u],
  ["/admin/beverages", /^\/admin\/beverages\/(?!new)[^/?#]+$/u],
  ["/admin/keg-room/kegs", /^\/admin\/keg-room\/kegs\/(?!new)[^/?#]+$/u],
  ["/admin/keg-room", /^\/admin\/keg-room\/fills\/(?!new)[^/?#]+$/u],
  ["/admin/integrations/telemetry", /^\/admin\/integrations\/telemetry-sources\/[^/?#]+$/u],
];

async function detailPages(page: Page): Promise<string[]> {
  const paths: string[] = [];
  for (const [list, pattern] of DETAILS) {
    await page.goto(list);
    const hrefs = await page
      .locator("main a[href]")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    const href = hrefs.find((candidate) => pattern.test(candidate));
    expect(href, `a detail link on ${list}`).toBeTruthy();
    paths.push(href!);
  }
  return paths;
}

type FormReport = { smallTargets: string[]; boxedFieldsets: string[] };

/** Opens every disclosure, then measures checkbox, radio and switch targets and fieldsets. */
function formReport(page: Page): Promise<FormReport> {
  return page.evaluate(() => {
    for (const details of document.querySelectorAll("main details")) {
      (details as HTMLDetailsElement).open = true;
    }
    const rendered = (element: Element): boolean =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const smallTargets: string[] = [];
    const controls = document.querySelectorAll(
      'main :is(input[type="checkbox"], input[type="radio"], [role="switch"])',
    );
    for (const control of controls) {
      if (!rendered(control)) continue;
      let box = control.getBoundingClientRect();
      // A visually hidden radio (a picker card) is operated through its label.
      if (box.width < 4 || box.height < 4) {
        const label = control.closest("label");
        if (label) box = label.getBoundingClientRect();
      }
      if (box.width < 23.5 || box.height < 23.5) {
        const name =
          control.getAttribute("name") ?? control.textContent?.trim().slice(0, 40) ?? "control";
        smallTargets.push(`${name} ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    }
    const boxedFieldsets = [...document.querySelectorAll("main fieldset")]
      .filter(rendered)
      .filter((fieldset) => {
        const style = getComputedStyle(fieldset);
        return (["Top", "Right", "Bottom", "Left"] as const).some(
          (side) =>
            style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" &&
            Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
        );
      })
      .map((fieldset) => fieldset.querySelector("legend")?.textContent?.trim() ?? "fieldset");
    return { smallTargets, boxedFieldsets };
  });
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`Admin checkboxes, radios and switches are 24px; fieldsets are flat (${colorScheme})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      await signIn(page);
      for (const path of [...PAGES, ...(await detailPages(page))]) {
        await page.goto(path);
        const report = await formReport(page);
        expect(report.smallTargets, `${path}: targets under 24px`).toEqual([]);
        expect(report.boxedFieldsets, `${path}: boxed fieldsets`).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });

  test(`switches keep 3:1 contrast on and off (${colorScheme})`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      await signIn(page);
      const states = new Set<string>();
      for (const path of [
        "/admin/display/shared",
        "/admin/system",
        "/admin/integrations/outbound/new?transport=webhook",
      ]) {
        await page.goto(path);
        const switches = await page.locator("main .switch__control").evaluateAll((controls) => {
          const rgb = (colour: string): number[] => {
            const probe = document.createElement("i");
            probe.style.color = colour;
            document.body.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return (value.match(/[\d.]+/gu) ?? []).map(Number);
          };
          const luminance = ([r, g, b]: number[]): number => {
            const channel = (value: number): number => {
              const c = value / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
          };
          const ratio = (a: number[], b: number[]): number => {
            const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (light! + 0.05) / (dark! + 0.05);
          };
          const opaque = (colour: number[]): boolean => colour.length < 4 || colour[3]! > 0;
          // The colour the switch sits on: the nearest ancestor that paints a background.
          const ground = (element: Element): number[] => {
            for (let node = element.parentElement; node; node = node.parentElement) {
              const colour = rgb(getComputedStyle(node).backgroundColor);
              if (opaque(colour)) return colour;
            }
            return rgb(getComputedStyle(document.body).backgroundColor);
          };
          return controls
            .filter((control) => control.getClientRects().length > 0)
            .map((control) => {
              const style = getComputedStyle(control);
              const on =
                (control as HTMLInputElement).checked === true ||
                control.parentElement?.getAttribute("aria-checked") === "true";
              const behind = ground(control);
              const fill = rgb(style.backgroundColor);
              const track = opaque(fill) ? fill : behind;
              return {
                on,
                border: ratio(rgb(style.borderTopColor), behind),
                track: ratio(track, behind),
                thumb: ratio(rgb(style.getPropertyValue("--thumb").trim()), track),
              };
            });
        });
        expect(switches.length, `${path}: switches`).toBeGreaterThan(0);
        for (const [index, control] of switches.entries()) {
          states.add(control.on ? "on" : "off");
          const where = `${path} switch ${index + 1} (${control.on ? "on" : "off"})`;
          expect(control.border, `${where}: track outline`).toBeGreaterThanOrEqual(3);
          expect(control.thumb, `${where}: thumb against track`).toBeGreaterThanOrEqual(3);
          if (control.on) expect(control.track, `${where}: track fill`).toBeGreaterThanOrEqual(3);
        }
      }
      expect([...states].sort(), "both states were measured").toEqual(["off", "on"]);
    } finally {
      await context.close();
    }
  });
}

test("both switch hosts submit without JavaScript", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin\/overview$/u);

    // A checkbox switch saves with its form.
    await page.goto("/admin/display/shared");
    const srm = page.getByRole("switch", { name: "SRM", exact: true });
    const wasShown = await srm.isChecked();
    await srm.setChecked(!wasShown);
    await page.getByRole("button", { name: "Save Tap-card settings" }).click();
    await page.goto("/admin/display/shared");
    await expect(srm).toBeChecked({ checked: !wasShown });
    await srm.setChecked(wasShown);
    await page.getByRole("button", { name: "Save Tap-card settings" }).click();
    await page.goto("/admin/display/shared");
    await expect(srm).toBeChecked({ checked: wasShown });

    // A button switch submits its own form.
    await page.goto("/admin/system");
    const simulation = page.getByRole("switch", { name: "Enable simulation" });
    await expect(simulation).toHaveAttribute("aria-checked", "false");
    await simulation.click();
    await page.goto("/admin/system");
    await expect(simulation).toHaveAttribute("aria-checked", "true");
    await simulation.click();
    await page.goto("/admin/system");
    await expect(simulation).toHaveAttribute("aria-checked", "false");
  } finally {
    await context.close();
  }
});
