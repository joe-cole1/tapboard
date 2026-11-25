import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { readSystemActivityPageRows } from "../src/features/system/repository.ts";
import { createTapService } from "../src/features/taps/service.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { adminApp } from "./fixtures/admin-app.ts";

const SECRET = "SECRET_MYSTERY_BEER_NEVER_PUBLIC";

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
  return { taps, fill };
}

/** "What guests see": everything before the Start section (the banner nests its own section). */
function guestSection(html: string): string {
  const start = html.indexOf('aria-labelledby="tap-wars-guest-preview-title"');
  const end = html.indexOf('aria-labelledby="tap-wars-start-title"');
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

void test("Tap Wars previews a matchup before it starts, through the public projection only", async (context) => {
  const database = openDatabase(":memory:");
  const { taps, fill } = seed(database);
  const assign = (tapNumber: number, name: string) => {
    const tap = taps.createTap({ tapNumber });
    return { tap, assignment: taps.assignFill(tap.id, { fillId: fill(name).id }).assignment };
  };
  const mystery = assign(1, SECRET);
  const open = assign(2, "Open Pale Ale");
  taps.updateAssignmentMystery(mystery.tap.id, {
    ...taps.getAssignmentMystery(mystery.tap.id),
    enabled: true,
  });
  const admin = await adminApp(context, database);
  const page = (query = "") => admin.get(`/admin/tap-wars${query}`);

  // Nothing chosen: guests see nothing, and Start waits for a pair.
  const empty = await page();
  assert.match(guestSection(empty), /Guests don't see a Tap War/u);
  assert.match(empty, /data-tap-wars-guest-preview hidden/u);
  assert.match(empty, /data-tap-wars-start-submit disabled/u);
  assert.doesNotMatch(empty, /Server validation remains authoritative/u);

  // A chosen pair renders the real banner at 0 votes. The Mystery side shows only its public
  // title, so the hidden beverage name appears nowhere on the page.
  const pair = `?side1=${mystery.assignment.id}&side2=${open.assignment.id}`;
  const previewed = await page(pair);
  const guest = guestSection(previewed);
  assert.match(guest, /data-tap-wars-status>TAP WARS! Vote below</u);
  assert.match(guest, /data-tap-wars-side="1">Mystery Tap</u);
  assert.match(guest, /data-tap-wars-side="2">Open Pale Ale</u);
  assert.match(guest, /data-tap-wars-message>No votes yet</u);
  assert.doesNotMatch(previewed, new RegExp(SECRET, "u"));
  assert.doesNotMatch(previewed, /data-tap-wars-guest-preview hidden/u);
  // The pair travels to the Start form, whose token never sits in the GET form.
  assert.match(
    previewed,
    new RegExp(`name="competitor1AssignmentId" value="${mystery.assignment.id}"`, "u"),
  );
  assert.match(
    previewed,
    new RegExp(`name="competitor2AssignmentId" value="${open.assignment.id}"`, "u"),
  );
  assert.doesNotMatch(previewed, /data-tap-wars-start-submit disabled/u);
  const getForm = /<form[^>]*method="get"[^>]*data-tap-wars-pair>[\s\S]*?<\/form>/u.exec(
    previewed,
  )?.[0];
  assert.ok(getForm);
  assert.doesNotMatch(getForm, /_csrf/u);
  assert.match(getForm, new RegExp(`value="${mystery.assignment.id}" [^>]*selected`, "u"));

  // The same Tap twice, or an assignment that isn't eligible, previews nothing.
  const duplicate = await page(`?side1=${open.assignment.id}&side2=${open.assignment.id}`);
  assert.match(duplicate, /data-tap-wars-pair-status aria-live="polite">Choose two different/u);
  assert.match(duplicate, /data-tap-wars-start-submit disabled/u);
  const unknown = await page(`?side1=${open.assignment.id}&side2=not-an-assignment`);
  assert.match(unknown, /data-tap-wars-guest-preview hidden/u);
  assert.match(unknown, /name="competitor1AssignmentId" value=""/u);
});

void test("the Tap's History tab lists its Fills and only its own Activity, and forms return to their tab", async (context) => {
  const database = openDatabase(":memory:");
  const { taps, fill } = seed(database);
  const tap = taps.createTap({ tapNumber: 3 });
  const other = taps.createTap({ tapNumber: 4 });
  taps.assignFill(tap.id, { fillId: fill("First Saison").id });
  taps.unassign(tap.id);
  taps.assignFill(tap.id, { fillId: fill("Second Stout").id });
  taps.assignFill(other.id, { fillId: fill("Other Tap Lager").id });
  const admin = await adminApp(context, database);

  const history = await admin.get(`/admin/taps/${tap.id}/history`);
  const fills = /<section aria-labelledby="fill-history-heading">[\s\S]*?<\/section>/u.exec(
    history,
  )?.[0];
  assert.ok(fills);
  // Newest first: the Fill on tap now, then the one taken off.
  assert.ok(fills.indexOf("Second Stout") < fills.indexOf("First Saison"));
  assert.match(fills, /Second Stout[\s\S]*?On tap now/u);
  assert.match(fills, /First Saison[\s\S]*?Taken off tap/u);
  assert.doesNotMatch(fills, /Other Tap Lager/u);

  // Activity is filtered to this Tap's own entries.
  const own = readSystemActivityPageRows(database, { tapId: tap.id });
  assert.ok(own.length > 0);
  assert.ok(own.every((item) => item.entityType === "tap" && item.entityId === tap.id));
  const activity = /<section aria-labelledby="tap-activity-heading">[\s\S]*?<\/section>/u.exec(
    history,
  )?.[0];
  assert.ok(activity);
  assert.equal(activity.match(/<tr>/gu)?.length, own.length + 1);

  // Each form returns to the tab it lives on.
  assert.match(
    await admin.post(`/admin/taps/${tap.id}/maintenance`, { maintenanceType: "line_cleaned" }),
    new RegExp(`^/admin/taps/${tap.id}/maintenance\\?notice=`, "u"),
  );
  assert.match(
    await admin.post(`/admin/taps/${tap.id}/authority`, {
      levelSourceId: "",
      conditionSourceId: "",
      flowSourceId: "",
    }),
    new RegExp(`^/admin/taps/${tap.id}/sensors\\?`, "u"),
  );
  assert.match(
    await admin.post(`/admin/taps/${tap.id}/display`, { showAbv: "hide" }),
    new RegExp(`^/admin/taps/${tap.id}\\?notice=`, "u"),
  );
  const maintenance = await admin.get(`/admin/taps/${tap.id}/maintenance`);
  assert.match(maintenance, /<td data-label="Type">Line cleaned<\/td>/u);
});

void test("every Tap setting saves live as JSON, keeping the Tap's revision current", async (context) => {
  const database = openDatabase(":memory:");
  const { taps, fill } = seed(database);
  const tap = taps.createTap({ tapNumber: 7 });
  taps.assignFill(tap.id, { fillId: fill("Live Lager").id });
  const admin = await adminApp(context, database);
  const revision = () => taps.getTap(tap.id).updatedAt;
  const path = (action: string) => `/admin/taps/${tap.id}/${action}`;

  // A metric switch posts one field; the answer has every metric's choice and the new revision.
  const metric = await admin.autosave(path("display"), { updatedAt: revision(), showAbv: "hide" });
  assert.equal(metric.status, 200);
  assert.deepEqual(metric.body.resource, {
    showAbv: "hide",
    showIbu: "inherit",
    showOg: "inherit",
    showFg: "inherit",
    showSrm: "inherit",
  });
  assert.equal(metric.body.revision, revision());
  // A stale revision is a conflict, never a silent overwrite.
  const stale = await admin.autosave(path("display"), {
    updatedAt: "2000-01-01T00:00:00.000Z",
    showAbv: "show",
  });
  assert.equal(stale.status, 409);

  // Mystery Tap saves its whole form.
  const mystery = await admin.autosave(path("mystery"), {
    updatedAt: revision(),
    enabled: "true",
    revealStyle: "true",
    revealAbv: "false",
  });
  assert.equal(mystery.status, 200);
  assert.equal(mystery.body.revision, revision());
  const saved = taps.getAssignmentMystery(tap.id);
  assert.equal(saved.enabled, true);
  assert.equal(saved.revealStyle, true);
  assert.equal(saved.revealAbv, false);

  // Tap details: a new number still needs the acknowledgement, which the answer then clears.
  const details = {
    tapNumber: "8",
    enabled: "true",
    gasType: "CO2",
    servingPressureKpa: "",
    lineLengthMm: "",
    lineDiameterMm: "",
    notes: "",
  };
  const blocked = await admin.autosave(path("update"), {
    updatedAt: revision(),
    ...details,
    acknowledgeTelemetryEndpointImpact: "false",
  });
  assert.equal(blocked.status, 422);
  assert.ok(Object.hasOwn(blocked.body.fields as object, "acknowledgeTelemetryEndpointImpact"));
  assert.equal(taps.getTap(tap.id).tapNumber, 7);
  const renumbered = await admin.autosave(path("update"), {
    updatedAt: revision(),
    ...details,
    acknowledgeTelemetryEndpointImpact: "true",
  });
  assert.equal(renumbered.status, 200);
  assert.deepEqual(renumbered.body.resource, { acknowledgeTelemetryEndpointImpact: false });
  assert.equal(taps.getTap(tap.id).tapNumber, 8);
  assert.equal(taps.getTap(tap.id).gasType, "CO2");
  // The name still saves on its own, with its revision check.
  const named = await admin.autosave(path("update"), { updatedAt: revision(), name: "Live Tap" });
  assert.equal(named.status, 200);
  assert.equal(taps.getTap(tap.id).name, "Live Tap");

  // Sensors and the overrides answer with their own message or "Saved."
  const sources = await admin.autosave(path("authority"), {
    updatedAt: revision(),
    levelSourceId: "",
    conditionSourceId: "",
    flowSourceId: "",
  });
  assert.equal(sources.status, 200);
  assert.equal(sources.body.message, "Telemetry sources updated.");
  for (const action of ["detector-config", "health-config"]) {
    const cleared = await admin.autosave(path(action), { updatedAt: revision() });
    assert.equal(cleared.status, 200, action);
    assert.equal(cleared.body.message, "Saved.", action);
  }
});
