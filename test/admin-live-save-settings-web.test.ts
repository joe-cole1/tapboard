import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { TapWarService } from "../src/features/tap-wars/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { tapWarMysteryState } from "../src/features/web/admin/tap-wars.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { adminApp } from "./fixtures/admin-app.ts";

function seed(database: DatabaseConnection) {
  const beverages = createBeverageService(database);
  const kegs = createKegService(database);
  const fills = createFillService(database);
  const taps = createTapService(database);
  let kegNumber = 0;
  const fill = (name: string) => {
    const beverage = beverages.createCustomBeverage({ name });
    const keg = kegs.createKeg({ kegNumber: ++kegNumber, capacityMl: 19000 });
    return fills.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  };
  return { fills, taps, fill };
}

/** The value a rendered hidden or text input carries. */
function inputValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "u").exec(html);
  assert.ok(match, `input ${name}`);
  return match[1]!;
}

/** The `<form>` that posts to `action`, or "" when the page has none. */
function form(html: string, action: string): string {
  return new RegExp(`<form[^>]*action="${action}"[\\s\\S]*?</form>`, "u").exec(html)?.[0] ?? "";
}

void test("Filled Keg › Featured is a one-click switch that saves live", async (context) => {
  const database = openDatabase(":memory:");
  const { fills, fill } = seed(database);
  const active = fill("Featured Pale");
  const admin = await adminApp(context, database);
  const path = `/admin/fills/${active.id}/featured`;

  const page = await admin.get(`/admin/keg-room/fills/${active.id}`);
  const featured = form(page, path);
  assert.match(featured, /data-autosave="submit"/u);
  assert.match(featured, /role="switch" aria-checked="false"/u);
  assert.match(featured, /name="featured" value="true"/u);

  const saved = await admin.autosave(path, {
    updatedAt: fills.getFill(active.id).updatedAt,
    featured: "true",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, { featured: true });
  assert.equal(saved.body.revision, fills.getFill(active.id).updatedAt);
  assert.equal(fills.getFill(active.id).featured, true);
  assert.match(await admin.get(`/admin/keg-room/fills/${active.id}`), /aria-checked="true"/u);

  const invalid = await admin.autosave(path, { featured: "maybe" });
  assert.equal(invalid.status, 422);
  assert.ok((invalid.body.fields as Record<string, string>).featured);
  assert.equal(fills.getFill(active.id).featured, true);

  // Without JavaScript the same switch posts the opposite value and lands back on the page.
  assert.match(await admin.post(path, { featured: "false" }), /notice=/u);
  assert.equal(fills.getFill(active.id).featured, false);

  // An ended Filled Keg can't be featured: the live save answers 409 and changes nothing.
  await fills.kickFill(active.id, { reason: null });
  const ended = await admin.autosave(path, { featured: "true" });
  assert.equal(ended.status, 409);
  assert.equal(fills.getFill(active.id).featured, false);
});

void test("Tap Wars › Mystery Tap saves live for both Taps", async (context) => {
  const database = openDatabase(":memory:");
  const { taps, fill } = seed(database);
  const assign = (tapNumber: number, name: string) => {
    const tap = taps.createTap({ tapNumber });
    return taps.assignFill(tap.id, { fillId: fill(name).id }).assignment;
  };
  const one = assign(1, "War Amber");
  const two = assign(2, "War Lager");
  const admin = await adminApp(context, database);
  await admin.post("/admin/tap-wars/start", {
    competitor1AssignmentId: one.id,
    competitor2AssignmentId: two.id,
  });
  const war = new TapWarService(database).getCurrentUnfinished();
  assert.ok(war);
  const path = `/admin/tap-wars/${war.id}/mystery`;
  const state = () =>
    tapWarMysteryState({ tapWarsService: new TapWarService(database), tapService: taps })?.map(
      (side) => side.enabled,
    );

  assert.match(form(await admin.get("/admin/tap-wars"), path), /data-autosave="submit"/u);
  const on = await admin.autosave(path, { enabled: "true" });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.resource, { enabled: true });
  assert.equal(on.body.message, "Mystery Tap is on for both Tap War Taps.");
  assert.deepEqual(state(), [true, true]);

  const invalid = await admin.autosave(path, { enabled: "yes" });
  assert.equal(invalid.status, 422);
  assert.ok((invalid.body.fields as Record<string, string>).enabled);
  assert.deepEqual(state(), [true, true]);

  // A war that is no longer current answers 409 with the switch as it stands.
  const stale = await admin.autosave(
    "/admin/tap-wars/00000000-0000-4000-8000-000000000000/mystery",
    { enabled: "false" },
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, {
    enabled: true,
    blockedTapNumber: null,
    onlyTapNumber: null,
  });
  assert.deepEqual(state(), [true, true]);

  assert.match(await admin.post(path, { enabled: "false" }), /notice=/u);
  assert.deepEqual(state(), [false, false]);
});

void test("System › Calculation defaults save live and keep the whole form", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const path = "/admin/system/calculation";
  const page = await admin.get("/admin/system");
  assert.match(form(page, path), /data-autosave="blur"/u);
  assert.match(form(page, path), /data-autosave-fallback>Save calculation defaults/u);

  const saved = await admin.autosave(path, { fallbackFg: "1.012", servingSizeMl: "355" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, { fallbackFg: 1.012, servingSizeMl: 355 });
  assert.equal(saved.body.revision, undefined);
  const after = await admin.get("/admin/system");
  assert.equal(inputValue(after, "fallbackFg"), "1.012");
  assert.equal(inputValue(after, "servingSizeMl"), "355");

  const invalid = await admin.autosave(path, { fallbackFg: "heavy", servingSizeMl: "355" });
  assert.equal(invalid.status, 422);
  assert.deepEqual(Object.keys(invalid.body.fields as object), ["fallbackFg"]);
  const outOfRange = await admin.autosave(path, { fallbackFg: "1.012", servingSizeMl: "0" });
  assert.equal(outOfRange.status, 422);
  assert.deepEqual(Object.keys(outOfRange.body.fields as object), ["servingSizeMl"]);
  const partial = await admin.autosave(path, { servingSizeMl: "300" });
  assert.equal(partial.status, 422);
  assert.equal(inputValue(await admin.get("/admin/system"), "servingSizeMl"), "355");
});

void test("System › Units save live with the display revision", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const path = "/admin/system/units";
  const revision = inputValue(await admin.get("/admin/system"), "expectedDisplayRevision");

  const saved = await admin.autosave(path, {
    expectedDisplayRevision: revision,
    unitSystem: "metric",
    showServingTemperature: "true",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, {
    unitSystem: "metric",
    showServingTemperature: true,
    timeZone: "UTC",
  });
  const page = await admin.get("/admin/system");
  assert.equal(inputValue(page, "expectedDisplayRevision"), String(saved.body.revision));
  assert.notEqual(String(saved.body.revision), revision);
  assert.match(page, /<option value="metric" selected>/u);

  const stale = await admin.autosave(path, {
    expectedDisplayRevision: revision,
    unitSystem: "us",
    showServingTemperature: "false",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.revision, saved.body.revision);
  assert.match(await admin.get("/admin/system"), /<option value="metric" selected>/u);

  const invalid = await admin.autosave(path, {
    expectedDisplayRevision: String(saved.body.revision),
    unitSystem: "imperial",
    showServingTemperature: "false",
  });
  assert.equal(invalid.status, 422);
});

void test("System › Session lifetimes save live, check the revision and never widen past absolute", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const path = "/admin/system/session-policy";
  const page = await admin.get("/admin/system");
  assert.match(form(page, path), /data-autosave-revision="expectedRevision"/u);
  const revision = inputValue(form(page, path), "expectedRevision");

  const saved = await admin.autosave(path, {
    expectedRevision: revision,
    inactivityMinutes: "20",
    absoluteMinutes: "600",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, { inactivityMinutes: 20, absoluteMinutes: 600 });
  assert.notEqual(String(saved.body.revision), revision);
  const after = form(await admin.get("/admin/system"), path);
  assert.equal(inputValue(after, "inactivityMinutes"), "20");
  assert.equal(inputValue(after, "expectedRevision"), String(saved.body.revision));

  const stale = await admin.autosave(path, {
    expectedRevision: revision,
    inactivityMinutes: "5",
    absoluteMinutes: "10",
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, { inactivityMinutes: 20, absoluteMinutes: 600 });
  assert.equal(stale.body.revision, saved.body.revision);

  const inverted = await admin.autosave(path, {
    expectedRevision: String(saved.body.revision),
    inactivityMinutes: "700",
    absoluteMinutes: "600",
  });
  assert.equal(inverted.status, 422);
  assert.deepEqual(inverted.body.fields, {
    inactivityMinutes: "Inactivity can't be longer than the absolute lifetime.",
  });
  const tooLong = await admin.autosave(path, {
    expectedRevision: String(saved.body.revision),
    inactivityMinutes: "20",
    absoluteMinutes: "525601",
  });
  assert.equal(tooLong.status, 422);
  assert.deepEqual(Object.keys(tooLong.body.fields as object), ["absoluteMinutes"]);
  const notNumber = await admin.autosave(path, {
    expectedRevision: String(saved.body.revision),
    inactivityMinutes: "soon",
    absoluteMinutes: "600",
  });
  assert.equal(notNumber.status, 422);
  assert.deepEqual(Object.keys(notNumber.body.fields as object), ["inactivityMinutes"]);
  assert.equal(inputValue(form(await admin.get("/admin/system"), path), "inactivityMinutes"), "20");
});

void test("Logs › Retention saves live as a whole form", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const path = "/admin/logs/retention";
  const page = await admin.get(path);
  assert.match(form(page, path), /data-autosave="blur"/u);
  const fields = [
    "activityDays",
    "rawSeconds",
    "receiptSeconds",
    "reconnectSeconds",
    "hourlyRollupDays",
    "dailyRollupDays",
    "outboxDays",
  ];
  const values = Object.fromEntries(fields.map((field) => [field, inputValue(page, field)]));
  const activityDays = String(Number(values.activityDays) + 1);

  const saved = await admin.autosave(path, { ...values, activityDays });
  assert.equal(saved.status, 200);
  assert.deepEqual(
    saved.body.resource,
    Object.fromEntries(fields.map((field) => [field, Number({ ...values, activityDays }[field])])),
  );
  assert.equal(inputValue(await admin.get(path), "activityDays"), activityDays);

  // Receipts must outlast raw telemetry and the reconnect horizon.
  const invalid = await admin.autosave(path, {
    ...values,
    rawSeconds: "86400",
    reconnectSeconds: "86400",
    receiptSeconds: "3600",
  });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body.fields, {
    receiptSeconds: "Keep receipts at least as long as raw telemetry and the reconnect horizon.",
  });
  assert.equal(inputValue(await admin.get(path), "receiptSeconds"), values.receiptSeconds);
  // A field out of range is reported on that field.
  const outOfRange = await admin.autosave(path, { ...values, outboxDays: "4000" });
  assert.equal(outOfRange.status, 422);
  assert.deepEqual(Object.keys(outOfRange.body.fields as object), ["outboxDays"]);
});

void test("Display › Default theme saves live, keeps System's units and shares their revision", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const path = "/admin/display/shared";
  const unitsRevision = inputValue(await admin.get("/admin/system"), "expectedDisplayRevision");
  const units = await admin.autosave("/admin/system/units", {
    expectedDisplayRevision: unitsRevision,
    unitSystem: "metric",
    showServingTemperature: "true",
  });
  assert.equal(units.status, 200);

  const theme = form(await admin.get(path), path);
  assert.match(theme, /data-autosave="blur"/u);
  assert.match(theme, /data-autosave-revision="expectedRevision"/u);
  assert.match(theme, /data-autosave-fallback>Save Default Theme/u);
  const revision = inputValue(theme, "expectedRevision");
  assert.equal(revision, String(units.body.revision));
  const values = {
    expectedRevision: revision,
    tapboardName: "Live Board",
    theme: "warm_pub",
    font: "rye",
    accent: "custom",
    accentCustom: "#3A7BD5",
    layoutMode: "rotation",
  };

  // The Custom choice saves its colour, and the answer is in the form's own shape.
  const saved = await admin.autosave(path, values);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, {
    tapboardName: "Live Board",
    theme: "warm_pub",
    font: "rye",
    accent: "custom",
    accentCustom: "#3a7bd5",
    layoutMode: "rotation",
  });
  assert.notEqual(String(saved.body.revision), revision);
  const after = await admin.get(path);
  assert.equal(inputValue(form(after, path), "expectedRevision"), String(saved.body.revision));
  assert.match(after, /data-preview-theme="warm_pub" data-preview-accent="#3a7bd5"/u);
  assert.match(await admin.get("/"), /data-theme="warm_pub"[^>]*data-accent="#3a7bd5"/u);
  // Units and serving temperature stay as System set them.
  const system = await admin.get("/admin/system");
  assert.match(system, /<option value="metric" selected>/u);
  assert.match(system, /name="showServingTemperature" value="true" checked/u);

  // Errors land on the field that caused them and change nothing.
  const current = String(saved.body.revision);
  const badColor = await admin.autosave(path, {
    ...values,
    expectedRevision: current,
    accentCustom: "blue",
  });
  assert.equal(badColor.status, 422);
  assert.deepEqual(Object.keys(badColor.body.fields as object), ["accentCustom"]);
  const blank = await admin.autosave(path, {
    ...values,
    expectedRevision: current,
    tapboardName: "  ",
  });
  assert.equal(blank.status, 422);
  assert.deepEqual(blank.body.fields, { tapboardName: "Enter a Tapboard name." });
  assert.match(await admin.get(path), /name="tapboardName" value="Live Board"/u);

  // A Units save on System moves the shared revision, so this page's next save is stale.
  const moved = await admin.autosave("/admin/system/units", {
    expectedDisplayRevision: current,
    unitSystem: "us",
    showServingTemperature: "true",
  });
  assert.equal(moved.status, 200);
  const stale = await admin.autosave(path, {
    ...values,
    expectedRevision: current,
    theme: "cyberpunk",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.revision, moved.body.revision);
  assert.deepEqual(stale.body.current, saved.body.resource);
  assert.match(await admin.get(path), /data-preview-theme="warm_pub"/u);

  // Without JavaScript the same form posts and lands back on the page.
  assert.match(
    await admin.post(path, {
      ...values,
      expectedRevision: String(moved.body.revision),
      accent: "blue",
    }),
    /notice=/u,
  );
  assert.match(await admin.get("/"), /data-accent="blue"/u);
});

void test("Display › Tap-card metrics save live and redraw the preview", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const path = "/admin/display/tap-card";
  const page = await admin.get("/admin/display/shared");
  const metrics = form(page, path);
  assert.match(metrics, /data-autosave="blur"/u);
  assert.match(metrics, /data-autosave-fallback>Save Tap-card settings/u);
  assert.doesNotMatch(page, /data-metric-key="srm"/u);
  const revision = inputValue(metrics, "expectedRevision");
  const values = {
    expectedRevision: revision,
    showAbv: "true",
    showIbu: "false",
    showOg: "true",
    showFg: "true",
    showSrm: "true",
    remainingMode: "pints",
  };

  const saved = await admin.autosave(path, values);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, {
    showAbv: true,
    showIbu: false,
    showOg: true,
    showFg: true,
    showSrm: true,
    remainingMode: "pints",
  });
  assert.notEqual(String(saved.body.revision), revision);
  // The page the preview redraws from shows the saved metrics.
  const after = await admin.get("/admin/display/shared");
  assert.match(after, /data-metric-key="srm"/u);
  assert.doesNotMatch(after, /data-metric-key="ibu"/u);
  assert.match(after, /name="showSrm" value="true" checked/u);
  assert.match(after, /<option value="pints" selected>/u);

  const current = String(saved.body.revision);
  const invalid = await admin.autosave(path, {
    ...values,
    expectedRevision: current,
    remainingMode: "barrels",
  });
  assert.equal(invalid.status, 422);
  assert.deepEqual(Object.keys(invalid.body.fields as object), ["remainingMode"]);

  const stale = await admin.autosave(path, { ...values, showSrm: "false" });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, saved.body.resource);
  assert.equal(stale.body.revision, saved.body.revision);
  assert.match(await admin.get("/admin/display/shared"), /data-metric-key="srm"/u);

  // Without JavaScript an unchecked switch posts nothing and saves as hidden.
  const { showSrm: _hidden, ...withoutSrm } = values;
  assert.match(await admin.post(path, { ...withoutSrm, expectedRevision: current }), /notice=/u);
  assert.doesNotMatch(await admin.get("/admin/display/shared"), /data-metric-key="srm"/u);
});
