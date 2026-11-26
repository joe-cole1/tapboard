import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createApplication } from "../src/application.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createDisplaySettingsService } from "../src/features/display/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { ML_PER_US_FL_OZ } from "../src/features/forecasting/forecast.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { insertCompletedPourIdempotently } from "../src/features/telemetry/repositories/detector.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { ADMIN_SESSION_COOKIE } from "../src/infrastructure/http/security/cookie.ts";
import { createLogger } from "../src/shared/logging.ts";

const ORIGIN = "http://tapboard.test";
const POUR_COUNT = 30;

async function fixture(context: TestContext) {
  const directory = mkdtempSync("/tmp/tapboard-fill-pours-");
  const databasePath = join(directory, "tapboard.sqlite3");
  const database = openDatabase(databasePath);
  await createAuthService(database, { canonicalOrigin: ORIGIN }).resetOperatorPin("1234");
  const beverages = createBeverageService(database);
  const taps = createTapService(database, { extensionPort: new DetectorService(database) });
  const fills = createFillService(database, {
    beverageService: beverages,
    assignmentPort: taps.asFillAssignmentPort(),
  });
  const beverage = beverages.createCustomBeverage({ name: "Pour Ale", beverageType: "beer" });
  const keg = createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19_000 });
  const fill = fills.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const tap = taps.createTap({ tapNumber: 1, enabled: true });
  taps.assignFill(tap.id, { fillId: fill.id });
  const assignment = taps.getTap(tap.id).activeAssignment!;
  const epoch = database
    .prepare<[string], { id: string }>("SELECT id FROM telemetry_epochs WHERE fill_id = ?")
    .get(fill.id)!;
  const completedAt: string[] = [];
  for (let index = 0; index < POUR_COUNT; index += 1) {
    const at = new Date(Date.UTC(2026, 7, 1, 12, index)).toISOString();
    completedAt.push(at);
    insertCompletedPourIdempotently(database, {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      effectKey: `pour-${index}`,
      fillId: fill.id,
      tapId: tap.id,
      assignmentId: assignment.id,
      epochId: epoch.id,
      detectorSessionId: `session-${index}`,
      canonicalVolumeMl: 12 * ML_PER_US_FL_OZ,
      startedAt: at,
      completedAt: at,
      createdAt: at,
    });
  }
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
  const session = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]!)
    .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  assert.ok(session);
  return {
    base,
    cookie: session,
    database,
    fillPath: `/admin/keg-room/fills/${fill.id}`,
    newestFirst: completedAt.toReversed(),
  };
}

function pourSection(html: string): string {
  const start = html.indexOf('id="pour-history"');
  assert.notEqual(start, -1, "the Filled Keg page has a pour history section");
  return html.slice(start, html.indexOf("</section>", start));
}

const datetimes = (section: string) =>
  [...section.matchAll(/<time datetime="([^"]+)"/gu)].map((match) => match[1]);
const olderHref = (section: string) =>
  /href="([^"]+)">Older pours</u.exec(section)?.[1]?.replaceAll("&amp;", "&");

void test("the Filled Keg page pages through every pour, newest first, in readable form", async (context) => {
  const f = await fixture(context);
  const get = (path: string) =>
    fetch(`${f.base}${path}`, { headers: { cookie: f.cookie }, redirect: "manual" });

  const unauthenticated = await fetch(`${f.base}${f.fillPath}`, { redirect: "manual" });
  assert.equal(unauthenticated.status, 303);

  const first = await get(f.fillPath);
  assert.equal(first.status, 200);
  const firstSection = pourSection(await first.text());
  const firstTimes = datetimes(firstSection);
  assert.equal(firstTimes.length, 25);
  assert.match(firstSection, /12\.0 fl oz/u);
  assert.match(firstSection, /Aug 1, 2026, 12:29 PM UTC/u);
  // Visible text carries no ISO timestamps or gallon volumes; ISO stays in datetime.
  const visible = firstSection.replace(/<[^>]*>/gu, " ");
  assert.doesNotMatch(visible, /\d{4}-\d{2}-\d{2}T/u);
  assert.doesNotMatch(visible, /gal\b/u);

  const next = olderHref(firstSection);
  assert.ok(next, "a full first page links to older pours");
  const second = await get(next);
  assert.equal(second.status, 200);
  const secondSection = pourSection(await second.text());
  assert.equal(olderHref(secondSection), undefined);
  assert.match(secondSection, /Newest pours/u);
  assert.deepEqual([...firstTimes, ...datetimes(secondSection)], f.newestFirst);

  const invalid = await get(`${f.fillPath}?pours=not-a-cursor`);
  assert.equal(invalid.status, 200);
  const invalidSection = pourSection(await invalid.text());
  assert.match(invalidSection, /no longer valid/u);
  assert.deepEqual(datetimes(invalidSection), firstTimes);

  const display = createDisplaySettingsService(f.database);
  const current = display.getSettings();
  display.updateSettings({
    tapboardName: current.tapboardName,
    theme: current.theme,
    font: current.font,
    accent: current.accent,
    unitSystem: "metric",
    showServingTemperature: current.showServingTemperature,
    layoutMode: current.layoutMode,
    timeZone: current.timeZone,
    expectedRevision: current.revision,
  });
  const metricSection = pourSection(await (await get(f.fillPath)).text());
  assert.match(metricSection, /355 mL/u);
  assert.doesNotMatch(metricSection, /fl oz/u);
});
