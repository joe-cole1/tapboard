import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createApplication } from "../src/application.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { validateUpdateDisplaySettingsInput } from "../src/features/display/display-validation.ts";
import { readDisplaySettings } from "../src/features/display/repository.ts";
import { createDisplaySettingsService } from "../src/features/display/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { ML_PER_US_FL_OZ } from "../src/features/forecasting/forecast.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { insertCompletedPourIdempotently } from "../src/features/telemetry/repositories/detector.ts";
import { timestampLabel } from "../src/features/web/admin/presentation.ts";
import { timeZoneGroups } from "../src/features/web/admin/system.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import {
  DISPLAY_TIME_ZONE_MIGRATION_NAME,
  DISPLAY_TIME_ZONE_SCHEMA_VERSION,
  MIGRATIONS,
  initializeSchema,
} from "../src/infrastructure/database/migrations.ts";
import { ADMIN_SESSION_COOKIE } from "../src/infrastructure/http/security/cookie.ts";
import { createLogger } from "../src/shared/logging.ts";
import { isTimeZone } from "../src/shared/time-zone.ts";
import { adminApp } from "./fixtures/admin-app.ts";

const NEW_YORK = "America/New_York";
const ORIGIN = "http://tapboard.test";

void test("Admin dates end with the zone's short name, and UTC reads as before", () => {
  const at = "2026-11-26T04:18:00.000Z";
  assert.equal(timestampLabel(at, "UTC"), "Nov 26, 2026, 4:18 AM UTC");
  assert.equal(timestampLabel(at, NEW_YORK), "Nov 25, 2026, 11:18 PM EST");
  assert.equal(timestampLabel(at, "Europe/Berlin"), "Nov 26, 2026, 5:18 AM GMT+1");
  assert.equal(timestampLabel("2026-11-26T05:00:00.000Z", NEW_YORK), "Nov 26, 2026, 12:00 AM EST");
  assert.equal(timestampLabel("2026-11-26T17:00:00.000Z", NEW_YORK), "Nov 26, 2026, 12:00 PM EST");
  assert.equal(timestampLabel(null, NEW_YORK), "Never");
  assert.equal(timestampLabel("not a time", NEW_YORK), "Unknown");
});

void test("Admin dates name the daylight-saving side of a repeated or skipped hour", () => {
  // Nov 1, 2026: 1:30 AM happens twice in New York.
  assert.equal(timestampLabel("2026-11-01T05:30:00.000Z", NEW_YORK), "Nov 1, 2026, 1:30 AM EDT");
  assert.equal(timestampLabel("2026-11-01T06:30:00.000Z", NEW_YORK), "Nov 1, 2026, 1:30 AM EST");
  // Mar 8, 2026: the minute after 1:59 AM EST is 3:00 AM EDT.
  assert.equal(timestampLabel("2026-03-08T06:59:00.000Z", NEW_YORK), "Mar 8, 2026, 1:59 AM EST");
  assert.equal(timestampLabel("2026-03-08T07:00:00.000Z", NEW_YORK), "Mar 8, 2026, 3:00 AM EDT");
});

const displayInput = (timeZone: unknown) => ({
  expectedRevision: 1,
  tapboardName: "Board",
  theme: "modern_dark",
  font: "system",
  accent: "amber",
  unitSystem: "us",
  showServingTemperature: false,
  layoutMode: "scroll",
  timeZone,
});

void test("the display time zone accepts UTC and Intl's zones only", () => {
  // Intl's own list has no UTC entry, so UTC is allowed by name.
  assert.equal(Intl.supportedValuesOf("timeZone").includes("UTC"), false);
  for (const zone of ["UTC", NEW_YORK, "Europe/Berlin", "America/Port-au-Prince"]) {
    assert.equal(validateUpdateDisplaySettingsInput(displayInput(zone)).timeZone, zone);
  }
  for (const zone of ["Mars/Base", "", "utc", "america/new_york", 5, null]) {
    assert.throws(
      () => validateUpdateDisplaySettingsInput(displayInput(zone)),
      (error: { details?: { field?: string } }) => error.details?.field === "timeZone",
    );
  }
  const { timeZone: _omitted, ...missing } = displayInput(NEW_YORK);
  assert.throws(
    () => validateUpdateDisplaySettingsInput(missing),
    (error: { details?: { field?: string } }) => error.details?.field === "body",
  );
  assert.equal(isTimeZone("Asia/Calcutta"), true);
});

void test("the time zone select lists UTC first, then every zone under its region", () => {
  const groups = timeZoneGroups(NEW_YORK);
  assert.deepEqual(groups[0], {
    label: "UTC",
    options: [{ value: "UTC", label: "UTC", selected: false }],
  });
  const america = groups.find((group) => group.label === "America");
  assert.ok(america);
  assert.deepEqual(
    america.options.find((option) => option.value === NEW_YORK),
    { value: NEW_YORK, label: "New York", selected: true },
  );
  assert.equal(
    america.options.find((option) => option.value === "America/North_Dakota/New_Salem")?.label,
    "North Dakota / New Salem",
  );
  const options = groups.flatMap((group) => group.options);
  assert.equal(options.length, Intl.supportedValuesOf("timeZone").length + 1);
  assert.equal(options.filter((option) => option.selected).length, 1);
});

void test("v31 databases upgrade to v32 with UTC and every display setting unchanged", () => {
  const database = openDatabase(":memory:", {
    migrations: MIGRATIONS.slice(0, DISPLAY_TIME_ZONE_SCHEMA_VERSION - 1),
  });
  try {
    database
      .prepare<[number, string, string, string, string]>(
        "UPDATE display_settings SET revision = ?, tapboard_name = ?, theme = ?, unit_system = ?, updated_at = ? WHERE id = 1",
      )
      .run(7, "Garage Taproom", "warm_pub", "metric", "2026-11-20T10:00:00.000Z");
    const before = database.prepare("SELECT * FROM display_settings").get();
    initializeSchema(database, MIGRATIONS);
    assert.equal(
      database
        .prepare<[number], { readonly name: string }>(
          "SELECT name FROM schema_migrations WHERE version = ?",
        )
        .get(DISPLAY_TIME_ZONE_SCHEMA_VERSION)?.name,
      DISPLAY_TIME_ZONE_MIGRATION_NAME,
    );
    assert.deepEqual(database.prepare("SELECT * FROM display_settings").get(), {
      ...(before as object),
      time_zone: "UTC",
    });
    const settings = readDisplaySettings(database);
    assert.equal(settings.timeZone, "UTC");
    assert.equal(settings.revision, 7);
    // The column checks only the format; the application checks the name.
    for (const bad of ["", "New York", "America/New_York;", "x".repeat(65)]) {
      assert.throws(
        () => database.prepare("UPDATE display_settings SET time_zone = ? WHERE id = 1").run(bad),
        /CHECK constraint/u,
      );
    }
    // A well-formed name this runtime does not know reads as UTC.
    database.prepare("UPDATE display_settings SET time_zone = 'Mars/Base' WHERE id = 1").run();
    assert.equal(readDisplaySettings(database).timeZone, "UTC");
    initializeSchema(database, MIGRATIONS);
  } finally {
    database.close();
  }
});

void test("a Fill created without a date is dated today in the display time zone", () => {
  // 9 PM Eastern on Nov 20 is already Nov 21 in UTC.
  const now = () => new Date("2026-11-21T02:00:00.000Z");
  for (const [timeZone, expected] of [
    [undefined, "2026-11-21"],
    ["UTC", "2026-11-21"],
    [NEW_YORK, "2026-11-20"],
  ] as const) {
    const database = openDatabase(":memory:");
    try {
      const beverageService = createBeverageService(database);
      const fills = createFillService(database, {
        beverageService,
        now,
        ...(timeZone === undefined ? {} : { timeZone: () => timeZone }),
      });
      const beverage = beverageService.createCustomBeverage({ name: "Ale", beverageType: "beer" });
      const keg = createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19_000 });
      const fill = fills.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
      assert.equal(fill.fillDate, expected, timeZone);
      const dated = createKegService(database).createKeg({ kegNumber: 2, capacityMl: 19_000 });
      const explicit = fills.createFill({
        beverageId: beverage.beverage.id,
        kegId: dated.id,
        fillDate: "2026-11-01",
      });
      assert.equal(explicit.fillDate, "2026-11-01");
    } finally {
      database.close();
    }
  }
});

const inputValue = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`, "u").exec(html)?.[1] ?? "";

void test("System › Units and readouts saves the time zone live and without JavaScript", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const system = await admin.get("/admin/system");
  assert.match(system, /data-autosave-fields="unitSystem,showServingTemperature,timeZone"/u);
  assert.match(
    system,
    /<select name="timeZone">\s*<optgroup label="UTC">\s*<option value="UTC" selected>UTC<\/option>/u,
  );
  assert.match(system, /<optgroup label="America">/u);
  assert.match(system, /<option value="America\/New_York">New York<\/option>/u);
  assert.match(system, /data-autosave-fallback>Save units and time zone</u);

  const saved = await admin.autosave("/admin/system/units", {
    expectedDisplayRevision: inputValue(system, "expectedDisplayRevision"),
    unitSystem: "us",
    showServingTemperature: "false",
    timeZone: NEW_YORK,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.resource, {
    unitSystem: "us",
    showServingTemperature: false,
    timeZone: NEW_YORK,
  });
  assert.equal(readDisplaySettings(database).timeZone, NEW_YORK);

  const rejected = await admin.autosave("/admin/system/units", {
    expectedDisplayRevision: String(saved.body.revision),
    unitSystem: "us",
    showServingTemperature: "false",
    timeZone: "Mars/Base",
  });
  assert.equal(rejected.status, 422);
  assert.equal(readDisplaySettings(database).timeZone, NEW_YORK);

  // A page from before the field existed posts no zone and keeps the saved one.
  const older = await admin.autosave("/admin/system/units", {
    expectedDisplayRevision: String(saved.body.revision),
    unitSystem: "metric",
    showServingTemperature: "false",
  });
  assert.equal(older.status, 200);
  assert.equal(readDisplaySettings(database).timeZone, NEW_YORK);

  const page = await admin.get("/admin/system");
  assert.match(page, /<option value="America\/New_York" selected>New York<\/option>/u);
  await admin.post("/admin/system/units", {
    expectedDisplayRevision: inputValue(page, "expectedDisplayRevision"),
    unitSystem: "metric",
    timeZone: "Europe/Berlin",
  });
  assert.equal(readDisplaySettings(database).timeZone, "Europe/Berlin");
  assert.equal(readDisplaySettings(database).unitSystem, "metric");

  // A Default theme save, which posts no zone, keeps it.
  const theme = await admin.get("/admin/display/shared");
  await admin.post("/admin/display/shared", {
    expectedRevision: inputValue(theme, "expectedRevision"),
    tapboardName: "Zone Board",
    theme: "warm_pub",
    font: "system",
    accent: "theme",
    layoutMode: "scroll",
  });
  assert.equal(readDisplaySettings(database).tapboardName, "Zone Board");
  assert.equal(readDisplaySettings(database).timeZone, "Europe/Berlin");
});

/** A real server on a file database, with one Tap pouring a Fill and the zone set. */
async function fixture(context: TestContext, timeZone: string) {
  const directory = mkdtempSync("/tmp/tapboard-time-zone-");
  const databasePath = join(directory, "tapboard.sqlite3");
  const database = openDatabase(databasePath);
  await createAuthService(database, { canonicalOrigin: ORIGIN }).resetOperatorPin("1234");
  const display = createDisplaySettingsService(database);
  const current = display.getSettings();
  const { revision, updatedAt: _updatedAt, ...settings } = current;
  display.updateSettings({ ...settings, expectedRevision: revision, timeZone });
  const beverages = createBeverageService(database);
  const taps = createTapService(database, { extensionPort: new DetectorService(database) });
  const fills = createFillService(database, {
    beverageService: beverages,
    assignmentPort: taps.asFillAssignmentPort(),
  });
  const beverage = beverages.createCustomBeverage({ name: "Zone Ale", beverageType: "beer" });
  const keg = createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19_000 });
  const fill = fills.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const tap = taps.createTap({ tapNumber: 1, enabled: true });
  taps.assignFill(tap.id, { fillId: fill.id });
  const assignment = taps.getTap(tap.id).activeAssignment!;
  const epoch = database
    .prepare<[string], { id: string }>("SELECT id FROM telemetry_epochs WHERE fill_id = ?")
    .get(fill.id)!;
  // 11:30 PM EST on Nov 20 (Nov 21 in UTC).
  const pouredAt = "2026-11-21T04:30:00.000Z";
  insertCompletedPourIdempotently(database, {
    id: "00000000-0000-4000-8000-000000000001",
    effectKey: "pour-1",
    fillId: fill.id,
    tapId: tap.id,
    assignmentId: assignment.id,
    epochId: epoch.id,
    detectorSessionId: "session-1",
    canonicalVolumeMl: 12 * ML_PER_US_FL_OZ,
    startedAt: pouredAt,
    completedAt: pouredAt,
    createdAt: pouredAt,
  });
  const application = createApplication({
    config: {
      host: "127.0.0.1",
      port: 0,
      databasePath,
      shutdownGraceMs: 100,
      canonicalExternalOrigin: ORIGIN,
      trustedProxies: [],
      sessionInactivityMs: 86_400_000,
      sessionAbsoluteMs: 86_400_000,
    },
    logger: createLogger({ sink: () => undefined }),
  });
  context.after(async () => {
    try {
      await application.stop();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const address = await application.start();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: "1234" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]!)
    .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  assert.ok(cookie);
  const read = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { headers, redirect: "manual" });
    assert.equal(response.status, 200, path);
    return response.text();
  };
  return {
    tapId: tap.id,
    fillPath: `/admin/keg-room/fills/${fill.id}`,
    admin: (path: string) => read(path, { cookie }),
    visitor: (path: string) => read(path),
  };
}

void test("Admin pages and the Admin Story sections show dates in the display time zone", async (context) => {
  const f = await fixture(context, NEW_YORK);
  const fillPage = await f.admin(f.fillPath);
  assert.match(
    fillPage,
    /datetime="2026-11-21T04:30:00\.000Z">Nov 20, 2026, 11:30 PM EST<\/time>/u,
  );
  assert.doesNotMatch(fillPage, /Times are UTC/u);

  const logs = await f.admin("/admin/logs");
  assert.match(logs, /<th scope="col">Time<\/th>/u);
  assert.match(logs, /, \d{1,2}:\d{2} [AP]M EST<\/time>/u);
  assert.doesNotMatch(logs, /[AP]M UTC</u);

  const history = await f.admin(`/admin/taps/${f.tapId}/history`);
  assert.match(history, /<th scope="col">Time<\/th>/u);
  assert.match(history, /[AP]M EST</u);

  const story = await f.admin(`/taps/${f.tapId}/story`);
  assert.match(story, /<dt>Assigned<\/dt><dd><time datetime="[^"]+">[^<]+ EST<\/time>/u);
  assert.match(
    story,
    /<time datetime="2026-11-21T04:30:00\.000Z">Nov 20, 2026, 11:30 PM EST<\/time>/u,
  );
});

void test("public pages and JSON never reveal the display time zone", async (context) => {
  const f = await fixture(context, NEW_YORK);
  const zone = /America\/New_York|New_York|New York|\bE[SD]T\b/u;
  for (const path of [
    "/",
    `/taps/${f.tapId}/story`,
    "/api/public/dashboard",
    "/api/public/dashboard/header",
    "/api/public/dashboard/display",
    "/api/public/dashboard/on-deck",
    `/api/public/dashboard/taps/${f.tapId}`,
    `/api/public/taps/${f.tapId}/story`,
  ]) {
    const body = await f.visitor(path);
    assert.doesNotMatch(body, zone, path);
    assert.doesNotMatch(body, /timeZone|time_zone/u, path);
  }
});
