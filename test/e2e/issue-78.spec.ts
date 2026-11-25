/// <reference lib="dom" />

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { saveLive } from "./helpers.ts";

const MYSTERY_SECRET = "MYSTERY_SECRET_DO_NOT_LEAK_77";

async function login(page: Page, options: { readonly manualSubmit?: boolean } = {}): Promise<void> {
  await page.goto("/admin");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  if (options.manualSubmit === true) await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function startWar(page: Page, firstTap: number, secondTap: number): Promise<void> {
  await page.goto("/admin/tap-wars");
  const form = page.locator("[data-tap-wars-pair]");
  await expect(form).toBeVisible();
  const selects = form.locator("[data-tap-wars-selector]");
  const firstValue = await selects
    .nth(0)
    .locator(`option[data-tap-number="${firstTap}"]`)
    .getAttribute("value");
  const secondValue = await selects
    .nth(1)
    .locator(`option[data-tap-number="${secondTap}"]`)
    .getAttribute("value");
  if (firstValue === null || secondValue === null) throw new Error("Expected fixture competitors.");
  await selects.nth(0).selectOption(firstValue);
  await selects.nth(1).selectOption(secondValue);
  // "What guests see" shows the real banner for the chosen pair before the war starts.
  const guest = page.locator("[data-tap-wars-guest-preview]");
  await expect(guest.locator('[data-tap-wars-tap="1"]')).toHaveText(`Tap ${firstTap}`);
  await expect(guest.locator('[data-tap-wars-tap="2"]')).toHaveText(`Tap ${secondTap}`);
  await expect(guest.locator("[data-tap-wars-status]")).toHaveText("TAP WARS! Vote below");
  await page.getByRole("button", { name: "Start Tap War" }).click();
  await expect(page.getByRole("heading", { name: "Current Tap War" })).toBeVisible();
}

async function publicWar(page: Page): Promise<{
  readonly id: string;
  readonly side1: {
    readonly tapId: string;
    readonly title: string;
    readonly voteCount: number;
    readonly isCardParticipant: boolean;
  };
  readonly side2: {
    readonly tapId: string;
    readonly title: string;
    readonly voteCount: number;
    readonly isCardParticipant: boolean;
  };
  readonly totalVotes: number;
  readonly status: "active" | "paused" | "completed";
}> {
  const response = await page.request.get("/api/public/tap-wars");
  expect(response.ok()).toBe(true);
  const value = (await response.json()) as { tapWars: unknown };
  if (typeof value.tapWars !== "object" || value.tapWars === null)
    throw new Error("Expected public war.");
  return value.tapWars as {
    readonly id: string;
    readonly side1: {
      readonly tapId: string;
      readonly title: string;
      readonly voteCount: number;
      readonly isCardParticipant: boolean;
    };
    readonly side2: {
      readonly tapId: string;
      readonly title: string;
      readonly voteCount: number;
      readonly isCardParticipant: boolean;
    };
    readonly totalVotes: number;
    readonly status: "active" | "paused" | "completed";
  };
}

async function publicMainProjection(page: Page): Promise<{
  readonly text: string;
  readonly attributes: string;
}> {
  return page.locator("main").evaluate((node) => ({
    text: node.textContent ?? "",
    attributes: [node, ...node.querySelectorAll("*")]
      .flatMap((element) =>
        [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`),
      )
      .join(" "),
  }));
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

test("Tap Wars votes live-update stable cards, pause safely, and publish a frozen result", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin);
  await closeCurrentWar(admin);
  await startWar(admin, 4, 5);

  const page = await context.newPage();
  await page.goto("/");
  const war = await publicWar(page);
  const banner = page.locator("[data-tap-wars]");
  await expect(banner).toBeVisible();
  await expect(banner).not.toContainText(/0 votes/u);
  await expect(page.locator("[data-tap-wars-participant]")).toHaveCount(2);
  for (const viewport of [
    { width: 800, height: 900 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await banner.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const bar = node.querySelector("[data-tap-wars-meter]")?.getBoundingClientRect();
      const labels = [...node.querySelectorAll("[data-tap-wars-label]")].map((label) =>
        label.getBoundingClientRect(),
      );
      const [first, second] = labels;
      return {
        overflow: node.scrollWidth > node.clientWidth + 1,
        left: bounds.left,
        right: bounds.right,
        labelsInsideBar:
          bar !== undefined &&
          labels.length === 2 &&
          labels.every(
            (label) =>
              label.width > 0 &&
              label.left >= bar.left - 1 &&
              label.right <= bar.right + 1 &&
              label.top >= bar.top - 1 &&
              label.bottom <= bar.bottom + 1,
          ),
        labelsApart: first !== undefined && second !== undefined && first.right <= second.left + 1,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
    // Each side's name and percentage sit inside the bar, one at each end, without overlapping.
    expect(geometry.labelsInsideBar).toBe(true);
    expect(geometry.labelsApart).toBe(true);
  }
  await expect(banner.locator('[data-tap-wars-label="1"]')).toContainText(war.side1.title);
  await expect(banner.locator('[data-tap-wars-label="2"]')).toContainText("—");
  await page.setViewportSize({ width: 1280, height: 720 });
  const order = await page
    .locator("[data-tap-grid] > [data-tap-id]")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.tapId));
  await page.locator("[data-tap-grid]").evaluate((node) => {
    (window as unknown as { issue78Grid: Element }).issue78Grid = node;
  });
  const participant = page.locator(`[data-tap-id="${war.side1.tapId}"]`);
  const unrelated = page.locator('[data-tap-number="6"]');
  await participant.evaluate((node) => {
    (window as unknown as { issue78Card: Element; issue78Graphic: Element | null }).issue78Card =
      node;
    (window as unknown as { issue78Graphic: Element | null }).issue78Graphic =
      node.querySelector(".tap-graphic");
  });
  await unrelated.evaluate((node) => {
    (window as unknown as { issue78Other: Element }).issue78Other = node;
  });
  const controls = participant.locator("[data-tap-wars-card-controls]");
  await expect(controls).toHaveCount(1);
  expect(
    await controls.evaluate((node) =>
      node.previousElementSibling?.matches('[data-field="description"]'),
    ),
  ).toBe(true);

  const button = participant.getByRole("button", { name: "Vote for this tap" });
  const firstVoteResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" && candidate.url().includes("/tap-wars/"),
  );
  await button.click();
  const firstVote = await firstVoteResponse;
  expect(
    firstVote.status(),
    `Vote endpoint returned ${firstVote.status()}: ${await firstVote.text()}`,
  ).toBe(200);
  await expect(participant.locator("[data-tap-wars-vote-status]")).toHaveText("Vote counted!");
  await button.click();
  const votePath = `/api/public/tap-wars/${war.id}/votes`;
  const burst = await Promise.all(
    Array.from({ length: 4 }, () =>
      page.request.post(votePath, {
        form: { side: "1" },
        headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
      }),
    ),
  );
  expect(burst.every((response) => response.ok())).toBe(true);
  await expect.poll(async () => (await publicWar(page)).side1.voteCount).toBe(6);
  await expect(banner.locator('[data-tap-wars-percent="1"]')).toHaveText("100%");
  await expect(banner.locator('[data-tap-wars-meter-side="1"]')).toHaveAttribute("width", "100");
  await page.getByRole("button", { name: "View results" }).click();
  const dialog = page.locator("[data-tap-wars-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("6 votes");
  const extra = await page.request.post(votePath, {
    form: { side: "2" },
    headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
  });
  expect(extra.ok()).toBe(true);
  await expect.poll(async () => (await publicWar(page)).totalVotes).toBe(7);
  await expect(dialog).toContainText("1 vote");
  await expect(banner).not.toContainText(/6 votes|7 total/u);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { issue78Grid: Element }).issue78Grid ===
          document.querySelector("[data-tap-grid]") &&
        (window as unknown as { issue78Card: Element }).issue78Card ===
          document.querySelector(
            `[data-tap-id="${(window as unknown as { issue78Card: HTMLElement }).issue78Card.dataset.tapId}"]`,
          ) &&
        (window as unknown as { issue78Graphic: Element }).issue78Graphic ===
          document.querySelector(
            `[data-tap-id="${(window as unknown as { issue78Card: HTMLElement }).issue78Card.dataset.tapId}"] .tap-graphic`,
          ) &&
        (window as unknown as { issue78Other: Element }).issue78Other ===
          document.querySelector(
            `[data-tap-id="${(window as unknown as { issue78Other: HTMLElement }).issue78Other.dataset.tapId}"]`,
          ),
    ),
  ).toBe(true);
  expect(
    await page
      .locator("[data-tap-grid] > [data-tap-id]")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.tapId)),
  ).toEqual(order);

  // Disabling the original participant pauses the same competition; restoring the
  // Tap does not implicitly resume it.
  await admin.goto(`/admin/taps/${war.side1.tapId}/identity`);
  const metadata = admin
    .locator('form[action$="/update"]')
    .filter({ has: admin.getByLabel("Public display") });
  await metadata.getByLabel("Public display").selectOption("false");
  await saveLive(metadata, "Save Tap details");
  await expect.poll(async () => (await publicWar(page)).status).toBe("paused");
  await expect.poll(async () => (await publicWar(page)).side1.title).toBe("Tap Wars Amber");
  await expect(page.locator("[data-tap-wars-vote]")).toHaveCount(0);
  const pausedVote = await page.request.post(votePath, {
    form: { side: "1" },
    headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
  });
  expect(pausedVote.ok()).toBe(false);
  await metadata.getByLabel("Public display").selectOption("true");
  await saveLive(metadata, "Save Tap details");
  await expect.poll(async () => (await publicWar(page)).status).toBe("paused");
  await admin.goto("/admin/tap-wars");
  await expect(admin.getByRole("button", { name: "Resume Tap War" })).toBeVisible();
  await Promise.all([
    admin.waitForURL(
      (url) =>
        url.pathname === "/admin/tap-wars" && url.searchParams.get("notice") === "Tap War resumed.",
    ),
    admin.getByRole("button", { name: "Resume Tap War" }).click(),
  ]);
  await expect.poll(async () => (await publicWar(page)).status).toBe("active");

  // Race one legitimate vote against Stop. Either serial ordering is valid:
  // the vote is included exactly once, or it is rejected after completion.
  const stopForm = admin.locator('form[action$="/stop"]');
  const stopAction = await stopForm.getAttribute("action");
  const stopCsrf = await stopForm.locator('input[name="_csrf"]').inputValue();
  if (stopAction === null) throw new Error("Expected the Stop Tap War action.");
  const [raceVote, raceStop] = await Promise.all([
    page.request.post(votePath, {
      form: { side: "2" },
      headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
    }),
    admin.request.post(stopAction, {
      form: { _csrf: stopCsrf },
      headers: { Origin: new URL(admin.url()).origin },
      maxRedirects: 0,
    }),
  ]);
  expect(raceStop.status()).toBe(303);
  expect([200, 409]).toContain(raceVote.status());
  await expect(page.locator("[data-tap-wars-vote]")).toHaveCount(0);
  await expect(page.locator("[data-tap-wars-participant]")).toHaveCount(0);
  await expect(page.locator("[data-tap-wars]")).toContainText(/Final result/u);
  const completed = await publicWar(page);
  expect(completed.status).toBe("completed");
  expect([completed.side1.voteCount, completed.side2.voteCount]).toEqual([
    6,
    raceVote.ok() ? 2 : 1,
  ]);
  // Completion already triggers an SSE-driven navigation; wait for that page instead of racing it.
  await expect(admin.getByRole("button", { name: "Dismiss public result" })).toBeVisible();
  await admin.getByRole("button", { name: "Dismiss public result" }).click();
  await expect(page.locator("[data-tap-wars]")).toBeHidden();
  await context.close();
});

test("Tap Wars resolves the exact disabled original title without leaking a replacement", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  const page = await context.newPage();
  let tap4Id: string | undefined;

  const setTapEnabled = async (tapId: string, enabled: boolean): Promise<void> => {
    await admin.goto(`/admin/taps/${tapId}/identity`);
    const metadata = admin
      .locator('form[action$="/update"]')
      .filter({ has: admin.getByLabel("Public display") });
    await metadata.getByLabel("Public display").selectOption(enabled ? "true" : "false");
    await saveLive(metadata, "Save Tap details");
  };

  const setMysteryEnabled = async (tapId: string, enabled: boolean): Promise<void> => {
    await admin.goto(`/admin/taps/${tapId}`);
    await admin.getByLabel("Enable Mystery Tap").setChecked(enabled);
    await saveLive(admin.locator('form[action$="/mystery"]'), "Save Mystery settings");
  };

  try {
    await login(admin);
    await closeCurrentWar(admin);
    await startWar(admin, 4, 5);
    const started = await publicWar(page);
    tap4Id = started.side1.tapId;

    await setTapEnabled(tap4Id, false);
    await expect.poll(async () => (await publicWar(page)).status).toBe("paused");
    await page.goto("/");
    await expect(page.locator(`[data-tap-id="${tap4Id}"]`)).toHaveCount(0);

    await setMysteryEnabled(tap4Id, true);
    await expect.poll(async () => (await publicWar(page)).side1.title).toBe("Mystery Tap");
    const mysteryJson = await (await page.request.get("/api/public/tap-wars")).text();
    expect(mysteryJson).not.toContain("Tap Wars Amber");
    await page.goto("/");
    const mysteryMain = await publicMainProjection(page);
    expect(mysteryMain.text).not.toContain("Tap Wars Amber");
    expect(mysteryMain.attributes).not.toContain("Tap Wars Amber");

    await setMysteryEnabled(tap4Id, false);
    await expect.poll(async () => (await publicWar(page)).side1.title).toBe("Tap Wars Amber");
    await setMysteryEnabled(tap4Id, true);
    await expect.poll(async () => (await publicWar(page)).side1.title).toBe("Mystery Tap");

    await admin.goto("/admin/tap-wars");
    await admin.getByRole("button", { name: "Stop Tap War" }).click();
    await expect(admin.getByRole("heading", { name: "Published result" })).toBeVisible();
    const completed = await publicWar(page);
    expect(completed.status).toBe("completed");
    expect(completed.side1.title).toBe("Mystery Tap");
    await page.goto("/");
    const completedMain = await publicMainProjection(page);
    expect(completedMain.text).not.toContain("Tap Wars Amber");
    expect(completedMain.attributes).not.toContain("Tap Wars Amber");
    await expect(page.locator(`[data-tap-id="${tap4Id}"]`)).toHaveCount(0);
    await expect(page.locator("[data-tap-wars]")).toContainText("Mystery Tap");
  } finally {
    if (tap4Id !== undefined) {
      try {
        await closeCurrentWar(admin);
      } catch {
        // Preserve the assertion failure while making a best-effort cleanup.
      }
      try {
        await setTapEnabled(tap4Id, true);
        await setMysteryEnabled(tap4Id, false);
      } catch {
        // Preserve the assertion failure while making a best-effort cleanup.
      }
    }
    await context.close();
  }
});

test("Tap Wars remains SSR-safe without JavaScript and does not leak Mystery identity", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin);
  await closeCurrentWar(admin);
  const dashboard = (await (await admin.request.get("/api/public/dashboard")).json()) as {
    readonly taps: readonly { readonly id: string; readonly tapNumber: number }[];
  };
  const mysteryTap = dashboard.taps.find((tap) => tap.tapNumber === 3);
  if (mysteryTap === undefined) throw new Error("Expected the Mystery fixture Tap.");
  await admin.goto(`/admin/taps/${mysteryTap.id}`);
  const styleReveal = admin.getByLabel("Style", { exact: true });
  if (await styleReveal.isChecked()) {
    await styleReveal.uncheck();
    await saveLive(admin.locator('form[action$="/mystery"]'), "Save Mystery settings");
  }
  await startWar(admin, 3, 4);
  const publicPage = await adminContext.newPage();
  await publicPage.goto("/");
  const visible = await publicWar(publicPage);
  const publicProjection = await (await publicPage.request.get("/api/public/tap-wars")).text();
  expect(publicProjection).not.toContain(MYSTERY_SECRET);
  const sse = publicPage.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const source = new EventSource("/api/public/events");
        source.addEventListener(
          "open",
          () => {
            document.documentElement.dataset.issue78SseReady = "true";
          },
          { once: true },
        );
        source.addEventListener(
          "tap_wars.updated",
          (event) => {
            source.close();
            resolve((event as MessageEvent<string>).data);
          },
          { once: true },
        );
        source.addEventListener("error", () => reject(new Error("Tap Wars SSE did not open.")), {
          once: true,
        });
      }),
  );
  await publicPage.waitForFunction(
    () => document.documentElement.dataset.issue78SseReady === "true",
  );
  const eventVote = await publicPage.request.post(`/api/public/tap-wars/${visible.id}/votes`, {
    form: { side: "1" },
    headers: { Origin: new URL(publicPage.url()).origin, Accept: "application/json" },
  });
  expect(eventVote.ok()).toBe(true);
  expect(await sse).toBe('{"target":"tap-wars"}');
  const noJsContext: BrowserContext = await browser.newContext({ javaScriptEnabled: false });
  const noJs = await noJsContext.newPage();
  await noJs.goto("/");
  await expect(noJs.locator("[data-tap-wars]")).toBeVisible();
  await expect(noJs.locator("[data-tap-wars-vote]")).toHaveCount(2);
  const html = await noJs.locator("main").evaluate((node) => ({
    text: node.textContent ?? "",
    attrs: [node, ...node.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`),
    ),
  }));
  expect(html.text).not.toContain(MYSTERY_SECRET);
  expect(html.attrs.join(" ")).not.toContain(MYSTERY_SECRET);
  const form = noJs.locator("[data-tap-wars-vote]").first();
  const beforeNoJsVote = (await publicWar(noJs)).side1.voteCount;
  const responsePromise = noJs.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" && candidate.url().includes("/tap-wars/"),
  );
  await form.getByRole("button", { name: "Vote for this tap" }).click();
  expect((await responsePromise).status()).toBe(303);
  await noJs.waitForURL(/\/#tap-wars$/u);
  await expect(noJs.locator("[data-tap-wars]")).toBeVisible();
  expect((await publicWar(noJs)).side1.voteCount).toBe(beforeNoJsVote + 1);
  await admin.goto(`/admin/taps/${mysteryTap.id}/identity`);
  await admin.getByRole("button", { name: "Take off tap" }).click();
  await expect.poll(async () => (await publicWar(noJs)).status).toBe("paused");
  const pausedMystery = await publicWar(noJs);
  expect(pausedMystery.side1.title).toBe("Mystery Tap");
  const pausedProjection = await (await noJs.request.get("/api/public/tap-wars")).text();
  expect(pausedProjection).not.toContain(MYSTERY_SECRET);
  await noJs.goto("/");
  const pausedHtml = await noJs.locator("main").textContent();
  expect(pausedHtml).toContain("Mystery Tap");
  expect(pausedHtml).not.toContain(MYSTERY_SECRET);

  await admin.goto("/admin/tap-wars");
  await admin.getByRole("button", { name: "Stop Tap War" }).click();
  const completedMystery = await publicWar(noJs);
  expect(completedMystery.status).toBe("completed");
  expect(completedMystery.side1.title).toBe("Mystery Tap");
  await noJs.goto("/");
  await expect(noJs.locator("[data-tap-wars]")).toContainText("Mystery Tap");
  const completedHtml = await noJs.locator("main").textContent();
  expect(completedHtml).not.toContain(MYSTERY_SECRET);
  await expect((await noJs.request.get("/api/public/tap-wars")).text()).resolves.not.toContain(
    MYSTERY_SECRET,
  );
  await noJsContext.close();
  await closeCurrentWar(admin);
  await adminContext.close();
});

test("a replacement assignment cannot inherit votes or resume the original competition", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin);
  await closeCurrentWar(admin);
  await startWar(admin, 4, 5);
  const page = await context.newPage();
  await page.goto("/");
  const started = await publicWar(page);
  const vote = await page.request.post(`/api/public/tap-wars/${started.id}/votes`, {
    form: { side: "1" },
    headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
  });
  expect(vote.ok()).toBe(true);

  await admin.goto(`/admin/taps/${started.side1.tapId}/identity`);
  await admin.getByRole("button", { name: "Take off tap" }).click();
  await expect.poll(async () => (await publicWar(page)).status).toBe("paused");
  const assignment = admin.locator('form[action$="/assign"]');
  const replacementValue = await assignment
    .locator("option")
    .filter({ hasText: "Tap Wars Amber" })
    .getAttribute("value");
  if (replacementValue === null) throw new Error("Expected the released Tap Wars Fill.");
  await assignment.getByLabel("Available Filled Keg").selectOption(replacementValue);
  await assignment.getByRole("button", { name: "Assign Fill" }).click();

  const paused = await publicWar(page);
  expect(paused.status).toBe("paused");
  expect(paused.side1.title).toBe("Tap Wars Amber");
  expect(paused.side1.voteCount).toBe(1);
  expect(paused.side1.isCardParticipant).toBe(false);
  await page.goto("/");
  await expect(page.locator(`[data-tap-id="${started.side1.tapId}"]`)).not.toHaveAttribute(
    "data-tap-wars-participant",
    /.+/u,
  );
  await admin.goto("/admin/tap-wars");
  await expect(admin.getByRole("button", { name: "Resume Tap War" })).toHaveCount(0);
  await admin.getByRole("button", { name: "Stop Tap War" }).click();
  const completed = await publicWar(page);
  expect(completed.status).toBe("completed");
  expect(completed.side1.title).toBe("Tap Wars Amber");
  expect(completed.side1.voteCount).toBe(1);
  await closeCurrentWar(admin);
  await context.close();
});

// The share of its track each meter segment fills, as laid out by the browser.
async function meterShares(page: Page, segmentAttribute: string): Promise<readonly number[]> {
  return page.evaluate(
    (attribute) =>
      [1, 2].map((side) => {
        const segment = document.querySelector(`[${attribute}="${side}"]`);
        const track = segment?.closest("svg")?.getBoundingClientRect().width ?? 0;
        if (!segment || track === 0) return Number.NaN;
        return Math.round((segment.getBoundingClientRect().width / track) * 100);
      }),
    segmentAttribute,
  );
}

test("Tap Wars meters show the split without inline styles, with and without JavaScript", async ({
  browser,
}) => {
  const cspErrors: string[] = [];
  const watchCsp = (context: BrowserContext): void => {
    context.on("console", (message) => {
      if (/Content Security Policy/iu.test(message.text())) cspErrors.push(message.text());
    });
  };
  const context = await browser.newContext();
  watchCsp(context);
  const admin = await context.newPage();
  await login(admin);
  await closeCurrentWar(admin);
  await startWar(admin, 4, 5);
  const page = await context.newPage();
  await page.goto("/");
  const war = await publicWar(page);
  const noJsContext = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await context.storageState(),
  });
  watchCsp(noJsContext);
  const noJs = await noJsContext.newPage();

  for (const { vote, shares, divider } of [
    { vote: null, shares: [0, 0], divider: { x: "0", visibility: "hidden" } },
    { vote: "1", shares: [100, 0], divider: { x: "100", visibility: "hidden" } },
    { vote: "2", shares: [50, 50], divider: { x: "50", visibility: "visible" } },
  ]) {
    if (vote !== null) {
      const response = await page.request.post(`/api/public/tap-wars/${war.id}/votes`, {
        form: { side: vote },
        headers: { Origin: new URL(page.url()).origin, Accept: "application/json" },
      });
      expect(response.ok()).toBe(true);
    }
    // JavaScript on: the server-rendered meters, then live updates, keep the split.
    await expect.poll(() => meterShares(page, "data-tap-wars-meter-side")).toEqual(shares);
    await expect(page.locator("[data-tap-wars-meter-divider]")).toHaveCount(2);
    for (const line of await page.locator("[data-tap-wars-meter-divider]").all()) {
      await expect(line).toHaveAttribute("x1", divider.x);
      await expect(line).toHaveAttribute("visibility", divider.visibility);
    }
    await expect.poll(() => meterShares(admin, "data-war-meter")).toEqual(shares);
    // Admin's "What guests see" preview is the public banner and follows the votes live.
    await expect.poll(() => meterShares(admin, "data-tap-wars-meter-side")).toEqual(shares);
    await page.getByRole("button", { name: "View results" }).click();
    await expect.poll(() => meterShares(page, "data-tap-wars-dialog-meter-side")).toEqual(shares);
    await page.getByRole("button", { name: "Close Tap Wars results" }).click();

    // JavaScript off: the server-rendered markup alone carries the split.
    await noJs.goto("/");
    expect(await noJs.locator("[style], style").count()).toBe(0);
    expect(await meterShares(noJs, "data-tap-wars-meter-side")).toEqual(shares);
    await noJs.locator("[data-tap-wars-dialog]").evaluate((dialog) => {
      (dialog as HTMLDialogElement).showModal();
    });
    expect(await meterShares(noJs, "data-tap-wars-dialog-meter-side")).toEqual(shares);
    await noJs.goto("/admin/tap-wars");
    expect(await noJs.locator("[style], style").count()).toBe(0);
    expect(await meterShares(noJs, "data-war-meter")).toEqual(shares);
    expect(await meterShares(noJs, "data-tap-wars-meter-side")).toEqual(shares);
  }
  expect(cspErrors).toEqual([]);

  await closeCurrentWar(admin);
  await noJsContext.close();
  await context.close();
});

test("a live update with no Tap War running keeps the start form (#220)", async ({ page }) => {
  // Record the page's EventSource so the test can make it reconnect.
  await page.addInitScript(() => {
    const sources: EventSource[] = [];
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        sources.push(this);
      }
    };
    (window as unknown as { recordedSources: EventSource[] }).recordedSources = sources;
  });
  await login(page);
  await closeCurrentWar(page);
  await page.goto("/admin/tap-wars");
  const form = page.locator("[data-tap-wars-pair]");
  await expect(form).toBeVisible();
  const first = form.locator("[data-tap-wars-selector]").nth(0);
  const value = await first.locator("option[data-tap-number]").first().getAttribute("value");
  if (value === null) throw new Error("Expected a fixture competitor.");
  await first.selectOption(value);
  await page.evaluate(() => {
    (window as unknown as { notReloaded?: boolean }).notReloaded = true;
  });

  // The stream drops and reconnects; the page refreshes its war state.
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/tap-wars"),
  );
  await page.evaluate(() => {
    const sources = (window as unknown as { recordedSources: EventSource[] }).recordedSources;
    const admin = sources.filter((source) => source.url.endsWith("/api/admin/events"));
    admin.at(-1)?.dispatchEvent(new Event("error"));
  });
  await refreshed;
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded),
  ).toBe(true);
  await expect(first).toHaveValue(value);
});
