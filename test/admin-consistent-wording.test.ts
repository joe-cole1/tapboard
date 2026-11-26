// #183: one date format, one label per stored value, one filter form and one Brewfather word.
import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import type { BrewfatherStatus } from "../src/features/beverages/service.ts";
import {
  ADMIN_THEME_COLORS,
  DISPLAY_PALETTES,
  displayThemeColors,
} from "../src/features/display/palette.ts";
import { beverageTypeLabel } from "../src/features/web/admin/beverage-presentation.ts";
import { brewfatherConnectionBadge } from "../src/features/web/admin/integrations.ts";
import { filterForm, timestampLabel } from "../src/features/web/admin/presentation.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { adminApp } from "./fixtures/admin-app.ts";

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

/** The text a reader sees: markup and attribute values (such as `datetime`) removed. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ");
}

function brewfather(overrides: {
  readonly configured?: boolean;
  readonly enabled?: boolean;
  readonly apiKeyConfigured?: boolean;
  readonly connectionState?: BrewfatherStatus["connectionState"];
}): BrewfatherStatus {
  return {
    configured: overrides.configured ?? true,
    account: { enabled: overrides.enabled ?? true } as BrewfatherStatus["account"] & object,
    apiKeyConfigured: overrides.apiKeyConfigured ?? true,
    connectionState: overrides.connectionState ?? "healthy",
    totalCandidates: 0,
    totalLinkedBeverages: 0,
    lastDataUpdateAt: null,
  };
}

void test("each Brewfather state has one word and tone", () => {
  const cases: [BrewfatherStatus, string, string][] = [
    [brewfather({ configured: false }), "Not configured", "muted"],
    [brewfather({ enabled: false, connectionState: "disabled" }), "Disabled", "muted"],
    [
      brewfather({ apiKeyConfigured: false, connectionState: "disconnected" }),
      "API key required",
      "degraded",
    ],
    [brewfather({ connectionState: "unknown" }), "Awaiting verification", "muted"],
    [brewfather({ connectionState: "healthy" }), "Connected", "healthy"],
    [brewfather({ connectionState: "partial" }), "Refresh incomplete", "degraded"],
    [brewfather({ connectionState: "disconnected" }), "Disconnected", "degraded"],
  ];
  for (const [status, label, tone] of cases) {
    assert.deepEqual(brewfatherConnectionBadge(status), { label, tone });
  }
});

void test("Overview, Integrations and the Brewfather page use the same Brewfather word", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const beverages = () => createBeverageService(database);
  const words = async () => {
    const overview = await admin.get("/admin/overview");
    const integrations = await admin.get("/admin/integrations");
    const page = await admin.get("/admin/integrations/brewfather");
    const card = integrations.slice(
      integrations.indexOf(">Beverage source<"),
      integrations.indexOf('href="/admin/integrations/brewfather">Open Brewfather'),
    );
    return {
      overview: /card__label">Brewfather<\/span><strong class="card__value">([^<]+)</u.exec(
        overview,
      )?.[1],
      card: /class="badge[^"]*">([^<]+)<\/span>/u.exec(card)?.[1],
      page,
    };
  };

  for (const [label, configure] of [
    ["Not configured", () => undefined],
    [
      "API key required",
      () => beverages().configureBrewfatherAccount({ userId: "brewer", enabled: true }),
    ],
    [
      "Disabled",
      () => beverages().configureBrewfatherAccount({ userId: "brewer", enabled: false }),
    ],
  ] as const) {
    configure();
    const seen = await words();
    assert.equal(seen.overview, label, `Overview for ${label}`);
    assert.equal(seen.card, label, `Integrations card for ${label}`);
    assert.match(seen.page, new RegExp(`>${label}</span>`, "u"), `Brewfather page for ${label}`);
  }
});

void test("Admin dates read as text in <time>, never as raw ISO", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  for (const path of ["/admin/logs", "/admin/logs/sessions", "/admin/system", "/admin/overview"]) {
    const html = await admin.get(path);
    assert.doesNotMatch(visibleText(html), ISO_TIMESTAMP, path);
  }
  const sessions = await admin.get("/admin/logs/sessions");
  assert.match(
    sessions,
    /<time datetime="\d{4}-\d{2}-\d{2}T[^"]+">[A-Z][a-z]{2} \d{1,2}, \d{4}, /u,
  );
  assert.equal(timestampLabel("2026-11-26T04:18:00.000Z", "UTC"), "Nov 26, 2026, 4:18 AM UTC");
});

void test("stored beverage types read as words in selects and text", async (context) => {
  assert.equal(beverageTypeLabel("kombucha"), "Kombucha");
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const html = await admin.get("/admin/beverages/new");
  assert.match(html, /<option value="kombucha">Kombucha<\/option>/u);
  assert.match(html, /<input name="alcohol"/u);
  assert.match(html, />Alcohol warmth<input name="alcohol"/u);
});

void test("a filter form offers Clear only while filtered and marks the current choice", () => {
  const options = [
    { value: "all", label: "All" },
    { value: "retired", label: "Retired" },
  ];
  const build = (q: string, state: string) =>
    filterForm({
      action: "/admin/taps",
      label: "Filter Taps",
      search: { value: q, placeholder: "Tap" },
      selects: [{ name: "state", label: "Show", value: state, defaultValue: "all", options }],
    });
  assert.equal(build("", "all").clearHref, null);
  assert.equal(build("ipa", "all").clearHref, "/admin/taps");
  assert.equal(build("", "retired").clearHref, "/admin/taps");
  assert.deepEqual(
    build("", "retired").selects[0]!.options.map((option) => option.selected),
    [false, true],
  );
});

void test("every list filter renders one Apply button and the same form", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  for (const path of [
    "/admin/taps",
    "/admin/beverages",
    "/admin/keg-room",
    "/admin/keg-room/kegs",
    "/admin/logs",
    "/admin/integrations/telemetry",
  ]) {
    const html = await admin.get(path);
    const forms = html.match(/<form class="form filter-form"[\s\S]*?<\/form>/gu) ?? [];
    assert.equal(forms.length, 1, path);
    const form = forms.join("");
    assert.match(form, /method="get"/u, path);
    assert.match(form, /role="search" aria-label="[^"]+"/u, path);
    assert.deepEqual(form.match(/<button[^>]*>[^<]*<\/button>/gu), [
      '<button class="button button--secondary button--small" type="submit">Apply</button>',
    ]);
  }
  assert.doesNotMatch(await admin.get("/admin/taps"), />Clear<\/a>/u);
  assert.match(await admin.get("/admin/taps?state=retired"), /href="\/admin\/taps">Clear<\/a>/u);
});

void test("theme-color follows each layout's real background", () => {
  assert.deepEqual(ADMIN_THEME_COLORS, [
    { color: DISPLAY_PALETTES.admin_light!.background, media: "(prefers-color-scheme: light)" },
    { color: DISPLAY_PALETTES.admin_dark!.background, media: "(prefers-color-scheme: dark)" },
  ]);
  assert.deepEqual(displayThemeColors("warm_pub"), [
    { color: DISPLAY_PALETTES.warm_pub!.background, media: null },
  ]);
  assert.deepEqual(
    displayThemeColors("auto").map((item) => item.color),
    [DISPLAY_PALETTES.light_minimal!.background, DISPLAY_PALETTES.modern_dark!.background],
  );
});

void test("Admin and public pages carry the favicon and theme-color, and the icon is served", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  for (const path of ["/admin/overview", "/"]) {
    const html = await admin.get(path);
    assert.match(
      html,
      /<link rel="icon" href="\/assets\/svg\/favicon.svg" type="image\/svg\+xml" \/>/u,
    );
    assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}"/u);
  }
  const icon = await admin.get("/assets/svg/favicon.svg");
  assert.match(icon, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/u);
});

void test("sidebar group labels are not headings, so each page's <h1> comes first", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const html = await admin.get("/admin/overview");
  const headings = [...html.matchAll(/<h([1-6])\b/gu)].map((match) => match[1]);
  assert.equal(headings[0], "1");
  assert.equal(headings.filter((level) => level === "1").length, 1);
  assert.match(html, /<ul aria-labelledby="[^"]+">/u);
});

void test("the Integrations Brewfather card does not call a switched-off account available", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database, {
    secretKey: Buffer.alloc(32, 7).toString("base64url"),
  });
  await admin.post("/admin/integrations/brewfather", { userId: "brewer", apiKey: "test-key" });
  await admin.post("/admin/integrations/brewfather/enabled", { enabled: "true" });
  assert.match(await admin.get("/admin/integrations"), /Beverage data is available for linking\./u);
  await admin.post("/admin/integrations/brewfather/enabled", { enabled: "false" });
  const card = await admin.get("/admin/integrations");
  assert.match(card, />Disabled<\/span>/u);
  assert.match(card, /Sync is off\. Linked beverages keep their last Brewfather data\./u);
  assert.doesNotMatch(card, /available for linking/u);
});
