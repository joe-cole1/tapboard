import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { registerTelemetryRoutes } from "../src/features/telemetry/routes.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { validateExternalTelemetryPayload } from "../src/features/telemetry/telemetry-validation.ts";
import type { TelemetryRollupSeries } from "../src/features/telemetry/types.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { createLogger } from "../src/shared/logging.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const origin = Date.parse("2026-11-19T10:00:00.000Z");
const at = (ms: number) => new Date(origin + ms).toISOString();
const MINUTE = 60_000;

function harness() {
  let now = origin;
  let nextId = 1;
  const ids = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const clock = () => new Date(now);
  const database = openDatabase(":memory:");
  const machineKeyService = createMachineKeyService(database, { idFactory: ids, now: clock });
  const tapService = createTapService(database, { idFactory: ids, now: clock });
  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    idGenerator: ids,
    clock,
  });
  const tap = tapService.createTap({ tapNumber: 1, name: "One" });
  const scale = telemetryService.createSource({ name: "scale" }).source;
  const probe = telemetryService.createSource({ name: "probe" }).source;
  const spare = telemetryService.createSource({ name: "spare probe" }).source;
  const assign = (conditionSourceId: string) =>
    telemetryService.setTapAuthority(tap.id, {
      levelSourceId: scale.id,
      conditionSourceId,
      flowSourceId: null,
    });
  assign(probe.id);
  const send = (
    measuredMs: number,
    readings: readonly Record<string, unknown>[],
    from = probe,
    receivedMs = measuredMs,
  ) => {
    now = origin + receivedMs;
    const result = telemetryService.ingestSingle(
      from,
      1,
      validateExternalTelemetryPayload({ measured_at: at(measuredMs), readings }),
    );
    assert.equal(result.outcome, "accepted", JSON.stringify(result));
  };
  const temperature = (value: number) => [{ metric: "temperature", value, unit: "c" }];
  const series = (resolution: "hourly" | "daily", metric = "temperature"): TelemetryRollupSeries =>
    telemetryService.getTapRollups(tap.id, {
      metric,
      resolution,
      from: at(-DAY),
      to: at(30 * DAY),
    });
  const count = (table: string) =>
    database.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
  return {
    database,
    telemetryService,
    tap,
    scale,
    probe,
    spare,
    assign,
    send,
    temperature,
    series,
    count,
    set: (ms: number) => {
      now = origin + ms;
    },
  };
}

void test("rollups record min, max, mean, last and count for a known series", () => {
  const h = harness();
  h.send(0, h.temperature(3));
  h.send(20 * MINUTE, h.temperature(5));
  h.send(40 * MINUTE, h.temperature(4));
  h.send(HOUR + 10 * MINUTE, h.temperature(6));

  const hourly = h.series("hourly");
  assert.equal(hourly.unit, "c");
  assert.deepEqual(hourly.buckets, [
    {
      start: at(0),
      min: 3,
      max: 5,
      mean: 4,
      last: 4,
      lastMeasuredAt: at(40 * MINUTE),
      count: 3,
    },
    {
      start: at(HOUR),
      min: 6,
      max: 6,
      mean: 6,
      last: 6,
      lastMeasuredAt: at(HOUR + 10 * MINUTE),
      count: 1,
    },
  ]);
  assert.deepEqual(h.series("daily").buckets, [
    {
      start: "2026-11-19T00:00:00.000Z",
      min: 3,
      max: 6,
      mean: 4.5,
      last: 6,
      lastMeasuredAt: at(HOUR + 10 * MINUTE),
      count: 4,
    },
  ]);
  // Readings are rolled up per metric, in canonical units.
  h.send(2 * HOUR, [{ metric: "total_weight", value: 2, unit: "kg" }], h.scale);
  assert.deepEqual(
    h.series("hourly", "total_weight").buckets.map(({ min, max, count }) => ({ min, max, count })),
    [{ min: 2000, max: 2000, count: 1 }],
  );
  assert.equal(h.series("hourly").buckets.length, 2);
});

void test("a late sample updates the bucket it was measured in without replacing a newer last", () => {
  const h = harness();
  h.send(0, h.temperature(3));
  h.send(40 * MINUTE, h.temperature(4));
  h.send(HOUR + 10 * MINUTE, h.temperature(6));

  // A replacement probe delivers a buffered reading from earlier in the first hour.
  h.assign(h.spare.id);
  h.send(30 * MINUTE, h.temperature(1), h.spare, HOUR + 20 * MINUTE);

  const [first, second] = h.series("hourly").buckets;
  assert.deepEqual(first, {
    start: at(0),
    min: 1,
    max: 4,
    mean: 2.6666666666666665,
    last: 4,
    lastMeasuredAt: at(40 * MINUTE),
    count: 3,
  });
  assert.equal(second!.count, 1);
  const [day] = h.series("daily").buckets;
  assert.equal(day!.min, 1);
  assert.equal(day!.count, 4);
  assert.equal(day!.last, 6);
});

void test("each daily row equals the aggregate of its hourly rows", () => {
  const h = harness();
  const values = [4.2, 3.9, 5.1, 2.7, 6.3, 4.4, 3.3, 5.8];
  values.forEach((value, index) => h.send(index * 50 * MINUTE, h.temperature(value)));

  const hourly = h.series("hourly").buckets;
  const daily = h.series("daily").buckets;
  assert.ok(hourly.length > 1);
  for (const day of daily) {
    const dayStart = Date.parse(day.start);
    const hours = hourly.filter(
      ({ start }) => Date.parse(start) >= dayStart && Date.parse(start) < dayStart + DAY,
    );
    const lastHour = hours.reduce((latest, hour) =>
      hour.lastMeasuredAt > latest.lastMeasuredAt ? hour : latest,
    );
    assert.equal(day.min, Math.min(...hours.map(({ min }) => min)));
    assert.equal(day.max, Math.max(...hours.map(({ max }) => max)));
    assert.equal(
      day.count,
      hours.reduce((sum, { count }) => sum + count, 0),
    );
    assert.ok(
      Math.abs(
        day.mean * day.count - hours.reduce((sum, { mean, count }) => sum + mean * count, 0),
      ) < 1e-9,
    );
    assert.equal(day.last, lastHour.last);
    assert.equal(day.lastMeasuredAt, lastHour.lastMeasuredAt);
  }
});

void test("pruning honors the hourly and daily horizons separately", () => {
  const h = harness();
  const settings = h.telemetryService.getSettings();
  assert.equal(settings.hourlyRollupRetentionDays, 30);
  assert.equal(settings.dailyRollupRetentionDays, 730);
  h.send(0, h.temperature(4));

  h.set(30 * DAY);
  assert.equal(h.telemetryService.pruneTelemetry().prunedRollupsCount, 0);
  assert.equal(h.count("telemetry_rollups_hourly"), 1);

  h.set(30 * DAY + HOUR);
  assert.equal(h.telemetryService.pruneTelemetry().prunedRollupsCount, 1);
  assert.equal(h.count("telemetry_rollups_hourly"), 0);
  assert.equal(h.count("telemetry_rollups_daily"), 1);

  h.set(731 * DAY);
  assert.equal(h.telemetryService.pruneTelemetry().prunedRollupsCount, 1);
  assert.equal(h.count("telemetry_rollups_daily"), 0);

  const updated = h.telemetryService.updateSettings({
    hourlyRollupRetentionDays: 2,
    dailyRollupRetentionDays: 10,
  });
  assert.equal(updated.hourlyRollupRetentionDays, 2);
  assert.equal(updated.dailyRollupRetentionDays, 10);
  assert.equal(h.telemetryService.getSettings().dailyRollupRetentionDays, 10);
  for (const invalid of [
    { hourlyRollupRetentionDays: 0 },
    { hourlyRollupRetentionDays: 366 },
    { dailyRollupRetentionDays: 3651 },
    { dailyRollupRetentionDays: 1.5 },
  ]) {
    assert.throws(() => h.telemetryService.updateSettings(invalid), ApplicationError);
  }
});

void test("rollup rows stay bounded over a long simulated run", () => {
  const h = harness();
  h.telemetryService.updateSettings({ hourlyRollupRetentionDays: 2, dailyRollupRetentionDays: 10 });
  let maxHourly = 0;
  let maxDaily = 0;
  for (let hour = 0; hour < 60 * 24; hour += 1) {
    const ms = hour * HOUR;
    h.send(ms, [
      { metric: "temperature", value: 3 + (hour % 5), unit: "c" },
      { metric: "pressure", value: 80 + (hour % 7), unit: "kpa" },
    ]);
    if (hour % 24 === 23) {
      h.telemetryService.pruneTelemetry();
      maxHourly = Math.max(maxHourly, h.count("telemetry_rollups_hourly"));
      maxDaily = Math.max(maxDaily, h.count("telemetry_rollups_daily"));
    }
  }
  // Two metrics: at most one row per metric per bucket inside each horizon, plus the bucket
  // currently filling.
  assert.ok(maxHourly <= 2 * (2 * 24 + 1), `hourly rows ${maxHourly}`);
  assert.ok(maxDaily <= 2 * (10 + 1), `daily rows ${maxDaily}`);
  assert.ok(maxHourly >= 2 * 2 * 24, "hourly history fills its horizon");
});

void test("the rollup query validates its input", () => {
  const h = harness();
  const reject = (query: unknown) =>
    assert.throws(() => h.telemetryService.getTapRollups(h.tap.id, query), ApplicationError);
  reject({});
  reject({ metric: "co2_ppm" });
  reject({ metric: "temperature", resolution: "minutely" });
  reject({ metric: "temperature", from: "yesterday" });
  reject({ metric: "temperature", from: at(HOUR), to: at(0) });
  reject({ metric: "temperature", extra: "1" });
  // A window the 1000-bucket cap would truncate is rejected, not silently cut.
  reject({ metric: "temperature", from: at(-1001 * HOUR), to: at(0) });
  assert.doesNotThrow(() =>
    h.telemetryService.getTapRollups(h.tap.id, {
      metric: "temperature",
      from: at(-1000 * HOUR),
      to: at(0),
    }),
  );
  assert.throws(
    () =>
      h.telemetryService.getTapRollups("00000000-0000-4000-8000-999999999999", {
        metric: "temperature",
      }),
    (error: unknown) => error instanceof ApplicationError && error.category === "not_found",
  );
  // Without a window the read ends now and covers the bucket cap.
  h.send(0, h.temperature(4));
  const recent = h.telemetryService.getTapRollups(h.tap.id, { metric: "temperature" });
  assert.equal(recent.resolution, "hourly");
  assert.equal(recent.to, at(0));
  assert.equal(recent.buckets.length, 0, "the window end is exclusive");
  h.set(HOUR);
  assert.equal(
    h.telemetryService.getTapRollups(h.tap.id, { metric: "temperature" }).buckets.length,
    1,
  );
});

void test("GET /api/admin/taps/:tapId/telemetry/rollups requires an Admin session", async (context) => {
  const ORIGIN = "http://127.0.0.1:3000";
  const database = openDatabase(":memory:");
  const authService = createAuthService(database, { canonicalOrigin: ORIGIN });
  await authService.setPin("1234");
  const login = await authService.authenticate("1234");
  assert.ok(login.session);
  const machineKeyService = createMachineKeyService(database);
  const tapService = createTapService(database);
  const telemetryService = new TelemetryService({ database, machineKeyService });
  const router = new Router(createLogger({ sink: () => undefined }));
  registerTelemetryRoutes({
    router,
    telemetryService,
    detectorService: new DetectorService(database),
    authService,
  });
  const server = new HttpServer({
    router,
    logger: createLogger({ sink: () => undefined }),
    shutdownGraceMs: 250,
  });
  context.after(async () => {
    await server.stop();
    database.close();
  });
  const tap = tapService.createTap({ tapNumber: 1, name: "One" });
  const source = telemetryService.createSource({ name: "probe" }).source;
  telemetryService.setTapAuthority(tap.id, {
    levelSourceId: source.id,
    conditionSourceId: source.id,
    flowSourceId: null,
  });
  const measuredAt = new Date(Date.now() - 2 * HOUR).toISOString();
  telemetryService.ingestSingle(
    source,
    1,
    validateExternalTelemetryPayload({
      measured_at: measuredAt,
      readings: [{ metric: "temperature", value: 4, unit: "c" }],
    }),
  );
  const address = await server.start("127.0.0.1", 0);
  const url = (query: string) =>
    `http://127.0.0.1:${address.port}/api/admin/taps/${tap.id}/telemetry/rollups?${query}`;
  const cookie = `tapboard_admin_session=${login.session}`;

  assert.equal((await fetch(url("metric=temperature"))).status, 401);
  assert.equal((await fetch(url("metric=co2"), { headers: { cookie } })).status, 400);
  assert.equal(
    (await fetch(url("metric=temperature&metric=pressure"), { headers: { cookie } })).status,
    400,
  );
  const response = await fetch(url("metric=temperature&resolution=daily"), {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { rollups: TelemetryRollupSeries };
  assert.equal(body.rollups.tapId, tap.id);
  assert.equal(body.rollups.resolution, "daily");
  assert.deepEqual(
    body.rollups.buckets.map(({ min, max, count }) => ({ min, max, count })),
    [{ min: 4, max: 4, count: 1 }],
  );
});
