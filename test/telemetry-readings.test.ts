import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createHealthService, listHealthCheckStates } from "../src/features/health/index.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import {
  TELEMETRY_METRICS,
  type TelemetryMetricDefinition,
} from "../src/features/telemetry/metrics.ts";
import {
  computeSemanticPayloadDigest,
  normalizeExternalTelemetrySample,
} from "../src/features/telemetry/normalization.ts";
import {
  readOpenTelemetryEpochForTap,
  readTelemetryEpochState,
} from "../src/features/telemetry/repositories/detector.ts";
import { registerTelemetryRoutes } from "../src/features/telemetry/routes.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import {
  validateExternalBatchTelemetryPayload,
  validateExternalTelemetryPayload,
} from "../src/features/telemetry/telemetry-validation.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { createLogger } from "../src/shared/logging.ts";

const origin = Date.parse("2026-11-19T10:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (ms: number) => new Date(origin + ms).toISOString();

interface ContractFixture {
  readonly tapId: string;
  readonly digests: readonly { readonly body: unknown; readonly digest: string }[];
  readonly errors: readonly {
    readonly batch?: true;
    readonly body: unknown;
    readonly code?: string;
    readonly details?: unknown;
  }[];
}

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/telemetry-v1-contract.json", import.meta.url), "utf8"),
) as ContractFixture;

function digestOf(body: unknown, tapId = contract.tapId): string {
  return computeSemanticPayloadDigest(
    normalizeExternalTelemetrySample(validateExternalTelemetryPayload(body)),
    tapId,
  );
}

function rejection(validate: () => unknown): { readonly code: string; readonly details: unknown } {
  try {
    validate();
  } catch (error) {
    assert.ok(error instanceof ApplicationError, String(error));
    return { code: error.code, details: error.details };
  }
  assert.fail("expected a validation error");
}

function reasonFor(body: unknown) {
  return rejection(() => validateExternalTelemetryPayload(body)).details as {
    readonly field: string;
    readonly reason: string;
  };
}

// --- Wire contract ---

void test("digests for every legacy payload shape match the values recorded before readings", () => {
  assert.equal(contract.digests.length, 30);
  for (const { body, digest } of contract.digests) {
    assert.equal(digestOf(body), digest, JSON.stringify(body));
  }
});

void test("legacy payload rejections keep their exact pre-readings 400 bodies", () => {
  assert.ok(contract.errors.length >= 30);
  for (const expected of contract.errors) {
    const actual = rejection(() =>
      expected.batch
        ? validateExternalBatchTelemetryPayload(expected.body)
        : validateExternalTelemetryPayload(expected.body),
    );
    assert.deepEqual(
      actual,
      { code: expected.code, details: expected.details },
      JSON.stringify(expected.body),
    );
  }
});

void test("the legacy and readings forms of the same sample normalize and hash identically", () => {
  const legacy = {
    client_sample_id: "same",
    measured_at: at(0),
    measurement: { kind: "total_weight", value: 12.5, unit: "kg" },
    temperature: { value: 38, unit: "f" },
  };
  const readings = {
    client_sample_id: "same",
    measured_at: at(0),
    readings: [
      { metric: "temperature", value: 38, unit: "f" },
      { metric: "total_weight", value: 12.5, unit: "kg" },
    ],
  };
  assert.deepEqual(
    normalizeExternalTelemetrySample(validateExternalTelemetryPayload(readings)),
    normalizeExternalTelemetrySample(validateExternalTelemetryPayload(legacy)),
  );
  assert.equal(digestOf(readings), digestOf(legacy));
});

void test("readings form accepts temperature alone and several readings in one sample", () => {
  const temperatureOnly = validateExternalTelemetryPayload({
    measured_at: at(0),
    readings: [{ metric: "temperature", value: 4.5, unit: "c" }],
  });
  assert.deepEqual(temperatureOnly.readings, [{ metric: "temperature", value: 4.5, unit: "c" }]);

  const batch = validateExternalBatchTelemetryPayload({
    samples: [
      {
        tap_number: 2,
        measured_at: at(0),
        readings: [
          { metric: "fill_percentage", value: 50, unit: "percent" },
          { metric: "temperature", value: 40, unit: "f" },
        ],
      },
    ],
  });
  assert.equal(batch.samples[0]?.tap_number, 2);
  assert.equal(batch.samples[0]?.readings.length, 2);
});

void test("readings form rejects mixed forms, unknown metrics and units, repeats, and bounds", () => {
  const base = { measured_at: at(0) };
  const level = { metric: "total_weight", value: 1, unit: "g" };

  for (const mixed of [
    { ...base, measurement: { kind: "total_weight", value: 1, unit: "g" }, readings: [level] },
    { ...base, temperature: { value: 4, unit: "c" }, readings: [level] },
  ]) {
    assert.deepEqual(reasonFor(mixed), {
      field: "body",
      reason: "must use either 'measurement' (with optional 'temperature') or 'readings', not both",
    });
  }

  const unknown = reasonFor({ ...base, readings: [{ metric: "humidity", value: 1, unit: "x" }] });
  assert.equal(unknown.field, "body.readings[0].metric");
  assert.match(unknown.reason, /^'humidity' is not a registered metric; use one of 'total_weight'/);

  // A metric name outside the registry's format is never echoed back.
  const hostile = reasonFor({
    ...base,
    readings: [{ metric: "<script>alert(1)</script>", value: 1, unit: "g" }],
  });
  assert.equal(hostile.field, "body.readings[0].metric");
  assert.doesNotMatch(hostile.reason, /script/);

  assert.deepEqual(
    reasonFor({ ...base, readings: [level, { metric: "temperature", value: 4, unit: "k" }] }),
    { field: "body.readings[1].unit", reason: "must be one of 'c', 'f' for 'temperature'" },
  );
  assert.deepEqual(reasonFor({ ...base, readings: [level, level] }), {
    field: "body.readings[1].metric",
    reason: "repeats 'total_weight'; a sample carries each metric at most once",
  });
  assert.deepEqual(
    reasonFor({
      ...base,
      readings: [level, { metric: "fill_percentage", value: 5, unit: "percent" }],
    }),
    {
      field: "body.readings[1].metric",
      reason:
        "'fill_percentage' is a second keg-level reading after 'total_weight'; a sample carries at most one",
    },
  );
  assert.deepEqual(
    reasonFor({ ...base, readings: [{ metric: "fill_percentage", value: 101, unit: "percent" }] }),
    { field: "body.readings[0].value", reason: "must be between 0 and 100 for 'fill_percentage'" },
  );
  assert.deepEqual(reasonFor({ ...base, readings: [] }), {
    field: "body.readings",
    reason: "must contain between 1 and 4 readings",
  });
  assert.deepEqual(reasonFor({ ...base, readings: { metric: "temperature" } }), {
    field: "body.readings",
    reason: "must be an array",
  });
  assert.deepEqual(reasonFor({ ...base, readings: [{ ...level, extra: true }] }), {
    field: "body.readings[0]",
    reason: "contains unknown key: extra",
  });
});

void test("the OpenAPI readings schemas list exactly the registered metrics, units, and bounds", () => {
  type Schema = Readonly<Record<string, unknown>>;
  const document = JSON.parse(
    readFileSync(new URL("../openapi/telemetry-v1.json", import.meta.url), "utf8"),
  ) as { readonly components: { readonly schemas: Readonly<Record<string, Schema>> } };
  const schemas = document.components.schemas;
  const resolve = (schema: Schema): Schema => {
    const ref = schema.$ref;
    return typeof ref === "string" ? schemas[ref.replace("#/components/schemas/", "")]! : schema;
  };
  const unitsOf = (schema: Schema): readonly string[] => {
    const resolved = resolve(schema);
    return typeof resolved.const === "string" ? [resolved.const] : (resolved.enum as string[]);
  };
  const documented = (schemas.Reading!.oneOf as Schema[]).map((entry) => {
    const properties = resolve(entry).properties as Readonly<Record<string, Schema>>;
    return {
      metric: properties.metric!.const,
      units: unitsOf(properties.unit!),
      min: properties.value!.minimum,
      max: properties.value!.maximum,
    };
  });
  assert.deepEqual(
    documented,
    Object.entries(TELEMETRY_METRICS).map(([metric, definition]) => ({
      metric,
      units: Object.keys(definition.units),
      min: definition.min,
      max: definition.max,
    })),
  );
  assert.equal(schemas.Readings!.maxItems, Object.keys(TELEMETRY_METRICS).length);
});

// --- Ingest ---

function harness() {
  let now = origin;
  let nextId = 1;
  const ids = () => uuid(nextId++);
  const clock = () => new Date(now);
  const database = openDatabase(":memory:");
  const detector = new DetectorService(database, { idFactory: ids, now: clock });
  const health = createHealthService(database, { idFactory: ids, now: clock });
  const machineKeyService = createMachineKeyService(database, { idFactory: ids, now: clock });
  const tapService = createTapService(database, {
    extensionPort: {
      onAssignmentOpened: (db, context) => {
        detector.onAssignmentOpened(db, context);
        health.onAssignmentOpened(db, context);
      },
      onAssignmentClosed: (db, context) => {
        detector.onAssignmentClosed(db, context);
        health.onAssignmentClosed(db, context);
      },
      onTapCreated: (db, tapId, createdAt) => health.onTapCreated(db, tapId, createdAt),
      onTapRetired: (db, tapId, retiredAt) => health.onTapRetired(db, tapId, retiredAt),
    },
    idFactory: ids,
    now: clock,
  });
  const kegService = createKegService(database, { idFactory: ids, now: clock });
  const beverageService = createBeverageService(database, { idFactory: ids, now: clock });
  const fillService = createFillService(database, {
    beverageService,
    assignmentPort: tapService.asFillAssignmentPort(),
    idFactory: ids,
    now: clock,
  });
  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    authorityExtensionPort: {
      onAuthorityChanged: (db, event) => {
        detector.onAuthorityChanged(db, event);
        health.onAuthorityChanged(db, event);
      },
    },
    acceptedExtensionPort: {
      onAcceptedSample: (db, event) => {
        detector.onAcceptedSample(db, event);
        health.onAcceptedSample(db, event);
      },
    },
    idGenerator: ids,
    clock,
  });
  health.updateGlobalConfig(
    { serving_temperature: { enabled: true } },
    { actorType: "admin", actorId: "admin-1", sessionId: "session-1" },
  );
  const tap = tapService.createTap({ tapNumber: 1, name: "One" });
  const source = telemetryService.createSource({ name: "scale" }).source;
  telemetryService.setTapAuthority(tap.id, {
    levelSourceId: source.id,
    conditionSourceId: source.id,
  });
  const assign = () => {
    const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19_000, currentTareG: 4_000 });
    const beverage = beverageService.createCustomBeverage({
      name: "Test beer",
      beverageType: "beer",
      fg: 1.0,
    });
    const fill = fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
    tapService.assignFill(tap.id, { fillId: fill.id });
  };
  const send = (ms: number, body: Record<string, unknown>, from = source) => {
    now = origin + ms;
    return telemetryService.ingestSingle(
      from,
      1,
      validateExternalTelemetryPayload({ measured_at: at(ms), ...body }),
    );
  };
  const rows = <T>(sql: string, ...params: unknown[]) =>
    database.prepare<unknown[], T>(sql).all(...params);
  const temperatureCheck = () =>
    listHealthCheckStates(database, tap.id).find(
      ({ checkId }) => checkId === "serving_temperature",
    );
  return {
    database,
    detector,
    health,
    telemetryService,
    tap,
    source,
    assign,
    send,
    rows,
    temperatureCheck,
    set: (ms: number) => {
      now = origin + ms;
    },
  };
}

function epochState(h: ReturnType<typeof harness>) {
  const epoch = readOpenTelemetryEpochForTap(h.database, h.tap.id);
  assert.ok(epoch);
  return readTelemetryEpochState(h.database, epoch.id);
}

void test("a temperature-only sample is stored and updates health and the display, not epochs or status", () => {
  const h = harness();
  try {
    h.assign();
    const level = h.send(1_000, {
      client_sample_id: "level-1",
      readings: [
        { metric: "remaining_volume", value: 15_000, unit: "ml" },
        { metric: "temperature", value: 3, unit: "c" },
      ],
    });
    assert.equal(level.outcome, "accepted");
    const levelId = level.acceptedMeasurementId!;
    const stateAfterLevel = epochState(h);
    const statusAfterLevel = h.rows("SELECT * FROM telemetry_source_tap_status");
    assert.equal(h.health.servingTemperatureC(h.tap.id), 3);
    assert.equal(h.temperatureCheck()?.evidence.temperatureC, 3);

    const temperature = h.send(2_000, {
      client_sample_id: "temp-1",
      readings: [{ metric: "temperature", value: 4.5, unit: "c" }],
    });
    assert.equal(temperature.outcome, "accepted");
    assert.equal(temperature.duplicate, false);

    const stored = h.rows<{ primary_kind: string | null; temperature_c: number | null }>(
      "SELECT primary_kind, temperature_c FROM telemetry_measurements WHERE id = ?",
      temperature.acceptedMeasurementId,
    );
    assert.deepEqual(stored, [{ primary_kind: null, temperature_c: 4.5 }]);
    assert.deepEqual(
      h.rows(
        "SELECT metric, value FROM telemetry_readings WHERE measurement_id = ?",
        temperature.acceptedMeasurementId,
      ),
      [{ metric: "temperature", value: 4.5 }],
    );
    // The scale's status and the detector's epoch are untouched.
    assert.deepEqual(h.rows("SELECT * FROM telemetry_source_tap_status"), statusAfterLevel);
    assert.deepEqual(epochState(h), stateAfterLevel);
    assert.equal(epochState(h)?.lastMeasurementId, levelId);
    // Health and the public display read the newest temperature.
    assert.equal(h.health.servingTemperatureC(h.tap.id), 4.5);
    assert.equal(h.temperatureCheck()?.evidence.temperatureC, 4.5);
    assert.equal(h.temperatureCheck()?.reason, "temperature_normal");
  } finally {
    h.database.close();
  }
});

void test("a readings sample retries idempotently, conflicts on change, and dedupes across forms", () => {
  const h = harness();
  try {
    const body = {
      client_sample_id: "retry-1",
      readings: [
        { metric: "total_weight", value: 20, unit: "kg" },
        { metric: "temperature", value: 4, unit: "c" },
      ],
    };
    const first = h.send(1_000, body);
    assert.equal(first.outcome, "accepted");
    assert.deepEqual(h.rows("SELECT metric, value FROM telemetry_readings ORDER BY metric"), [
      { metric: "temperature", value: 4 },
      { metric: "total_weight", value: 20_000 },
    ]);

    const retry = h.send(1_000, body);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.acceptedMeasurementId, first.acceptedMeasurementId);

    const legacyRetry = h.send(1_000, {
      client_sample_id: "retry-1",
      measurement: { kind: "total_weight", value: 20_000, unit: "g" },
      temperature: { value: 39.2, unit: "f" },
    });
    assert.equal(legacyRetry.duplicate, true);

    const changed = h.send(1_000, {
      client_sample_id: "retry-1",
      readings: [{ metric: "total_weight", value: 20, unit: "kg" }],
    });
    assert.equal(changed.outcome, "rejected");
    assert.equal(changed.code, "telemetry.idempotency_conflict");
    assert.equal(h.rows("SELECT id FROM telemetry_measurements").length, 1);
  } finally {
    h.database.close();
  }
});

void test("a level sample older than a newer temperature-only sample is out of order", () => {
  const h = harness();
  try {
    assert.equal(
      h.send(2_000, { readings: [{ metric: "temperature", value: 4, unit: "c" }] }).outcome,
      "accepted",
    );
    const late = h.send(1_000, {
      measurement: { kind: "remaining_volume", value: 10_000, unit: "ml" },
    });
    assert.equal(late.code, "telemetry.out_of_order");
  } finally {
    h.database.close();
  }
});

void test("the current temperature ignores readings from before the current keg", () => {
  const h = harness();
  try {
    h.send(1_000, { readings: [{ metric: "temperature", value: 4, unit: "c" }] });
    assert.equal(h.health.servingTemperatureC(h.tap.id), 4);

    h.set(2_000);
    h.assign();
    assert.equal(h.health.servingTemperatureC(h.tap.id), null);

    h.send(3_000, { readings: [{ metric: "temperature", value: 5, unit: "c" }] });
    assert.equal(h.health.servingTemperatureC(h.tap.id), 5);
  } finally {
    h.database.close();
  }
});

void test("a probe that stops reporting stops showing its temperature while weights continue", () => {
  const h = harness();
  try {
    h.assign();
    const weight = (ms: number) =>
      h.send(ms, { measurement: { kind: "remaining_volume", value: 15_000, unit: "ml" } });
    h.send(1_000, {
      measurement: { kind: "remaining_volume", value: 15_000, unit: "ml" },
      temperature: { value: 3, unit: "c" },
    });
    // Within the scale-freshness window the last temperature is still current.
    weight(60_000);
    assert.equal(h.health.servingTemperatureC(h.tap.id), 3);
    // Past it, the stale reading is neither displayed nor treated as healthy.
    weight(1_000 + 5 * 60_000);
    assert.equal(h.health.servingTemperatureC(h.tap.id), null);
    assert.equal(h.temperatureCheck()?.reason, "temperature_stale");
  } finally {
    h.database.close();
  }
});

/** Adds a temperature probe and makes it the Tap's condition source; the scale keeps level. */
function splitWithProbe(h: ReturnType<typeof harness>, ms: number) {
  h.set(ms);
  const probe = h.telemetryService.createSource({ name: "probe" }).source;
  const result = h.telemetryService.setTapAuthority(h.tap.id, {
    levelSourceId: h.source.id,
    conditionSourceId: probe.id,
  });
  return { probe, result };
}

void test("a scale and a probe share one Tap: each source keeps only the readings of its role", () => {
  const h = harness();
  try {
    h.assign();
    const { probe } = splitWithProbe(h, 500);

    // The scale's weight drives the epoch; its own temperature is dropped, not stored.
    const scale = h.send(1_000, {
      client_sample_id: "scale-1",
      readings: [
        { metric: "remaining_volume", value: 15_000, unit: "ml" },
        { metric: "temperature", value: 10, unit: "c" },
      ],
    });
    assert.equal(scale.outcome, "accepted");
    assert.deepEqual(
      h.rows(
        "SELECT primary_kind, remaining_volume_ml, temperature_c FROM telemetry_measurements WHERE id = ?",
        scale.acceptedMeasurementId,
      ),
      [{ primary_kind: "remaining_volume", remaining_volume_ml: 15_000, temperature_c: null }],
    );
    assert.deepEqual(
      h.rows(
        "SELECT metric FROM telemetry_readings WHERE measurement_id = ?",
        scale.acceptedMeasurementId,
      ),
      [{ metric: "remaining_volume" }],
    );
    assert.equal(epochState(h)?.lastMeasurementId, scale.acceptedMeasurementId);
    assert.equal(h.health.servingTemperatureC(h.tap.id), null);

    // A retry of the scale sample, temperature included, is still an exact duplicate.
    const retry = h.send(1_000, {
      client_sample_id: "scale-1",
      readings: [
        { metric: "remaining_volume", value: 15_000, unit: "ml" },
        { metric: "temperature", value: 10, unit: "c" },
      ],
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.acceptedMeasurementId, scale.acceptedMeasurementId);

    // The probe's temperature is the Tap's temperature during the open epoch.
    const temperature = h.send(
      2_000,
      { readings: [{ metric: "temperature", value: 4, unit: "c" }] },
      probe,
    );
    assert.equal(temperature.outcome, "accepted");
    assert.equal(h.health.servingTemperatureC(h.tap.id), 4);
    assert.equal(h.temperatureCheck()?.evidence.temperatureC, 4);
    assert.equal(h.temperatureCheck()?.reason, "temperature_normal");
    assert.equal(epochState(h)?.lastMeasurementId, scale.acceptedMeasurementId);

    // A sample with no reading of a role its source holds is a durable rejection.
    const probeWeight = h.send(
      3_000,
      {
        client_sample_id: "probe-weight",
        measurement: { kind: "remaining_volume", value: 1, unit: "ml" },
      },
      probe,
    );
    assert.equal(probeWeight.code, "telemetry.not_authoritative");
    const probeWeightRetry = h.send(
      3_000,
      {
        client_sample_id: "probe-weight",
        measurement: { kind: "remaining_volume", value: 1, unit: "ml" },
      },
      probe,
    );
    assert.equal(probeWeightRetry.duplicate, true);
    assert.equal(probeWeightRetry.code, "telemetry.not_authoritative");
    const scaleTemperature = h.send(4_000, {
      readings: [{ metric: "temperature", value: 12, unit: "c" }],
    });
    assert.equal(scaleTemperature.code, "telemetry.not_authoritative");
    assert.equal(h.health.servingTemperatureC(h.tap.id), 4);
    assert.equal(epochState(h)?.lastMeasurementId, scale.acceptedMeasurementId);
  } finally {
    h.database.close();
  }
});

void test("changing the condition source keeps the epoch; changing the level source closes it", () => {
  const h = harness();
  try {
    h.assign();
    h.send(1_000, { measurement: { kind: "remaining_volume", value: 15_000, unit: "ml" } });
    const before = readOpenTelemetryEpochForTap(h.database, h.tap.id);
    assert.ok(before);

    const { probe, result } = splitWithProbe(h, 2_000);
    assert.equal(result.requiresFreshBaseline, false);
    assert.equal(readOpenTelemetryEpochForTap(h.database, h.tap.id)?.id, before.id);

    h.set(3_000);
    const moved = h.telemetryService.setTapAuthority(h.tap.id, {
      levelSourceId: probe.id,
      conditionSourceId: probe.id,
    });
    assert.equal(moved.requiresFreshBaseline, true);
    const after = readOpenTelemetryEpochForTap(h.database, h.tap.id);
    assert.ok(after);
    assert.notEqual(after.id, before.id);
    assert.equal(after.sourceId, probe.id);
    assert.deepEqual(
      h.rows<{ close_reason: string }>(
        "SELECT close_reason FROM telemetry_epochs WHERE id = ?",
        before.id,
      ),
      [{ close_reason: "source_changed" }],
    );
  } finally {
    h.database.close();
  }
});

void test("scale health follows the level source and serving temperature the condition source", () => {
  const h = harness();
  const check = (id: string) =>
    listHealthCheckStates(h.database, h.tap.id).find(({ checkId }) => checkId === id);
  try {
    h.assign();
    h.send(1_000, { measurement: { kind: "remaining_volume", value: 15_000, unit: "ml" } });
    const scaleBefore = check("scale_availability");
    assert.equal(scaleBefore?.state, "healthy");

    // Moving only the condition role leaves the scale check as it was.
    const { probe } = splitWithProbe(h, 2_000);
    assert.equal(check("scale_availability")?.state, "healthy");
    assert.equal(check("scale_availability")?.reason, "scale_fresh");
    assert.equal(check("serving_temperature")?.reason, "temperature_invalid");

    // With only a condition source, temperature is still checked; scale checks have no authority.
    h.set(3_000);
    h.telemetryService.setTapAuthority(h.tap.id, {
      levelSourceId: null,
      conditionSourceId: probe.id,
    });
    h.send(4_000, { readings: [{ metric: "temperature", value: 4, unit: "c" }] }, probe);
    assert.equal(check("scale_availability")?.reason, "no_authority");
    assert.equal(check("serving_temperature")?.reason, "temperature_normal");
    assert.equal(h.health.servingTemperatureC(h.tap.id), 4);
  } finally {
    h.database.close();
  }
});

void test("a newly registered metric is ingested and stored without a migration", () => {
  const metrics = TELEMETRY_METRICS as Record<string, TelemetryMetricDefinition>;
  metrics["humidity"] = {
    role: "recorded",
    canonicalUnit: "percent",
    units: { percent: (value) => value },
    min: 0,
    max: 100,
  };
  const h = harness();
  try {
    const result = h.send(1_000, {
      client_sample_id: "humid-1",
      readings: [
        { metric: "humidity", value: 55, unit: "percent" },
        { metric: "temperature", value: 4, unit: "c" },
      ],
    });
    assert.equal(result.outcome, "accepted");
    assert.deepEqual(
      h.rows(
        "SELECT metric, value FROM telemetry_readings WHERE measurement_id = ? ORDER BY metric",
        result.acceptedMeasurementId,
      ),
      [
        { metric: "humidity", value: 55 },
        { metric: "temperature", value: 4 },
      ],
    );
    assert.deepEqual(
      h.rows("SELECT metric, value FROM telemetry_source_tap_readings WHERE metric = 'humidity'"),
      [{ metric: "humidity", value: 55 }],
    );
    // The new metric is part of the sample's meaning, so it changes the digest.
    assert.notEqual(
      digestOf({
        measured_at: at(0),
        readings: [
          { metric: "humidity", value: 55, unit: "percent" },
          { metric: "temperature", value: 4, unit: "c" },
        ],
      }),
      digestOf({ measured_at: at(0), readings: [{ metric: "temperature", value: 4, unit: "c" }] }),
    );
  } finally {
    h.database.close();
    delete metrics["humidity"];
  }
});

void test("POST /api/v1/telemetry accepts a temperature-only readings sample and rejects mixed forms", async (context) => {
  const database = openDatabase(":memory:");
  const authService = createAuthService(database);
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
  const tap = tapService.createTap({ tapNumber: 3, name: "Three" });
  const { source, initialToken } = telemetryService.createSource({ name: "probe" });
  telemetryService.setTapAuthority(tap.id, {
    levelSourceId: source.id,
    conditionSourceId: source.id,
  });
  const address = await server.start("127.0.0.1", 0);
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/taps/3`, {
      method: "POST",
      headers: { authorization: `Bearer ${initialToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const accepted = await post({
    client_sample_id: "probe-1",
    measured_at: new Date().toISOString(),
    readings: [{ metric: "temperature", value: 39, unit: "f" }],
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = (await accepted.json()) as { outcome: string; duplicate: boolean };
  assert.equal(acceptedBody.outcome, "accepted");
  assert.equal(acceptedBody.duplicate, false);

  const mixed = await post({
    measured_at: new Date().toISOString(),
    measurement: { kind: "total_weight", value: 1, unit: "g" },
    readings: [{ metric: "temperature", value: 39, unit: "f" }],
  });
  assert.equal(mixed.status, 400);

  const unknown = await post({
    measured_at: new Date().toISOString(),
    readings: [{ metric: "co2_ppm", value: 400, unit: "ppm" }],
  });
  assert.equal(unknown.status, 400);
  assert.match(JSON.stringify(await unknown.json()), /'co2_ppm' is not a registered metric/);
});
