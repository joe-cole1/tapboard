import assert from "node:assert/strict";
import { test } from "node:test";

import { createEventEnvelope } from "../src/features/events/envelope.ts";
import {
  DEFAULT_HEALTH_CONFIG,
  THRESHOLD_HEALTH_CHECKS,
  mergeHealthConfig,
} from "../src/features/health/config.ts";
import { evaluateHealthCheck } from "../src/features/health/engine.ts";
import {
  listHealthCheckStates,
  listHealthIncidents,
  readHealthGlobalConfig,
} from "../src/features/health/repository.ts";
import { createHealthService } from "../src/features/health/service.ts";
import {
  THRESHOLD_HEALTH_CHECK_IDS,
  type HealthEvaluation,
  type HealthEvaluationInput,
} from "../src/features/health/types.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createOutboundService } from "../src/features/outbound/service.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { TELEMETRY_METRICS } from "../src/features/telemetry/metrics.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { validateExternalTelemetryPayload } from "../src/features/telemetry/telemetry-validation.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const MINUTE = 60_000;
const enabledPressure = mergeHealthConfig(DEFAULT_HEALTH_CONFIG, {
  serving_pressure: { enabled: true },
});

function input(
  valueKpa: number | null,
  nowMs: number,
  previous?: HealthEvaluation,
  measuredAtMs = nowMs,
): HealthEvaluationInput {
  return {
    nowMs,
    authorityChangedAtMs: null,
    temperatureAuthorityChangedAtMs: NOW - 60 * MINUTE,
    latestConditionMeasurements:
      valueKpa === null
        ? {}
        : {
            pressure: {
              measurementId: `m-${measuredAtMs}`,
              measuredAtMs,
              receivedAtMs: measuredAtMs,
              value: valueKpa,
            },
          },
    ...(previous === undefined ? {} : { previous: { timers: previous.nextTimers } }),
  };
}

void test("every condition metric except temperature has exactly one threshold check", () => {
  const conditionMetrics = Object.entries(TELEMETRY_METRICS)
    .filter(([, definition]) => definition.role === "condition")
    .map(([metric]) => metric)
    .filter((metric) => metric !== "temperature")
    .sort();
  const checkedMetrics = THRESHOLD_HEALTH_CHECK_IDS.map(
    (id) => THRESHOLD_HEALTH_CHECKS[id].metric,
  ).sort();
  assert.deepEqual(checkedMetrics, conditionMetrics);
  for (const id of THRESHOLD_HEALTH_CHECK_IDS) {
    assert.equal(DEFAULT_HEALTH_CONFIG[id].enabled, false, `${id} is opt-in`);
  }
});

void test("a threshold check reports normal, out-of-range, warning and critical states", () => {
  const disabled = evaluateHealthCheck("serving_pressure", input(80, NOW));
  assert.equal(disabled.state, "not_configured");
  assert.equal(disabled.reason, "check_disabled");

  const normal = evaluateHealthCheck("serving_pressure", input(80, NOW), enabledPressure);
  assert.deepEqual(
    { state: normal.state, severity: normal.severity, reason: normal.reason },
    { state: "healthy", severity: "none", reason: "threshold_normal" },
  );
  assert.equal(normal.evidence.metric, "pressure");
  assert.equal(normal.evidence.value, 80);

  // Low pressure must persist for the configured duration before the check is active.
  const low = evaluateHealthCheck("serving_pressure", input(50, NOW), enabledPressure);
  assert.deepEqual(
    { state: low.state, severity: low.severity, reason: low.reason },
    { state: "degraded", severity: "info", reason: "threshold_out_of_range" },
  );
  assert.equal(low.nextTimers.thresholdOutsideSinceMs, NOW);
  assert.equal(low.nextTimers.temperatureOutsideSinceMs, null);
  const stillLow = evaluateHealthCheck(
    "serving_pressure",
    input(50, NOW + 4 * MINUTE, low),
    enabledPressure,
  );
  const lowLonger = evaluateHealthCheck(
    "serving_pressure",
    input(50, NOW + 8 * MINUTE, stillLow),
    enabledPressure,
  );
  const lowLongest = evaluateHealthCheck(
    "serving_pressure",
    input(50, NOW + 12 * MINUTE, lowLonger),
    enabledPressure,
  );
  const warning = evaluateHealthCheck(
    "serving_pressure",
    input(50, NOW + 15 * MINUTE, lowLongest),
    enabledPressure,
  );
  assert.deepEqual(
    { state: warning.state, severity: warning.severity, reason: warning.reason },
    { state: "active", severity: "warning", reason: "threshold_out_of_range" },
  );
  assert.equal(warning.incidentKey, "serving_pressure");
  assert.equal(warning.evidence.outOfRangeDurationMs, 15 * MINUTE);

  const critical = evaluateHealthCheck(
    "serving_pressure",
    input(300, NOW + 16 * MINUTE, warning),
    enabledPressure,
  );
  assert.deepEqual(
    { state: critical.state, severity: critical.severity, reason: critical.reason },
    { state: "active", severity: "critical", reason: "threshold_critical" },
  );

  // A reading gap longer than the freshness window restarts the out-of-range timer.
  const afterGap = evaluateHealthCheck(
    "serving_pressure",
    input(50, NOW + 30 * MINUTE, critical),
    enabledPressure,
  );
  assert.equal(afterGap.state, "degraded");
  assert.equal(afterGap.reason, "threshold_continuity_reset");

  const stale = evaluateHealthCheck(
    "serving_pressure",
    input(80, NOW + 10 * MINUTE, undefined, NOW),
    enabledPressure,
  );
  assert.equal(stale.reason, "threshold_stale");
  const missing = evaluateHealthCheck("serving_pressure", input(null, NOW), enabledPressure);
  assert.equal(missing.reason, "threshold_invalid");
  const noAuthority = evaluateHealthCheck(
    "serving_pressure",
    { ...input(80, NOW), temperatureAuthorityChangedAtMs: null },
    enabledPressure,
  );
  assert.equal(noAuthority.state, "not_configured");
  assert.equal(noAuthority.reason, "no_authority");
});

void test("the health.transitioned envelope accepts threshold check IDs at schema_version 1", () => {
  const envelope = createEventEnvelope({
    event_type: "health.transitioned",
    occurred_at: new Date(NOW).toISOString(),
    identifiers: { tap_id: "55555555-5555-4555-8555-555555555555" },
    data: { check_id: "serving_pressure", state: "active", severity: "warning" },
  });
  assert.equal(envelope.schema_version, 1);
  assert.deepEqual(envelope.data, {
    check_id: "serving_pressure",
    state: "active",
    severity: "warning",
  });
  assert.throws(() =>
    createEventEnvelope({
      event_type: "health.transitioned",
      occurred_at: new Date(NOW).toISOString(),
      identifiers: { tap_id: "55555555-5555-4555-8555-555555555555" },
      data: { check_id: "serving_humidity", state: "active", severity: "warning" },
    }),
  );
});

function harness() {
  let now = NOW;
  let nextId = 1;
  const ids = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const clock = () => new Date(now);
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 9).toString("base64url"),
  });
  const outbound = createOutboundService(database, {
    secrets,
    now: clock,
    idFactory: () => `22222222-2222-4222-8222-${String(nextId++).padStart(12, "0")}`,
  });
  outbound.create({
    id: "11111111-1111-4111-8111-111111111111",
    label: "Events",
    transport: "webhook",
    webhookUrl: "https://example.test/events",
  });
  const health = createHealthService(database, {
    idFactory: ids,
    now: clock,
    onHealthTransition: (db, context) =>
      outbound.healthTransitioned(db, {
        tapId: context.tapId,
        checkId: context.checkId,
        previousState: context.previousState,
        previousSeverity: context.previousSeverity,
        current: {
          state: context.current.state,
          severity: context.current.severity,
          evidence: context.current.evidence,
        },
        occurredAt: context.occurredAt,
      }),
  });
  const machineKeyService = createMachineKeyService(database, { idFactory: ids, now: clock });
  const tapService = createTapService(database, {
    extensionPort: {
      onAssignmentOpened: (db, assignment) => health.onAssignmentOpened(db, assignment),
      onAssignmentClosed: (db, assignment) => health.onAssignmentClosed(db, assignment),
      onTapCreated: (db, tapId, createdAt) => health.onTapCreated(db, tapId, createdAt),
      onTapRetired: (db, tapId, retiredAt) => health.onTapRetired(db, tapId, retiredAt),
    },
    idFactory: ids,
    now: clock,
  });
  const telemetry = new TelemetryService({
    database,
    machineKeyService,
    authorityExtensionPort: {
      onAuthorityChanged: (db, event) => health.onAuthorityChanged(db, event),
    },
    acceptedExtensionPort: {
      onAcceptedSample: (db, event) => health.onAcceptedSample(db, event),
    },
    idGenerator: ids,
    clock,
  });
  const tap = tapService.createTap({ tapNumber: 1, name: "One" });
  const gauge = telemetry.createSource({ name: "gauge" }).source;
  telemetry.setTapAuthority(tap.id, {
    levelSourceId: null,
    conditionSourceId: gauge.id,
    flowSourceId: null,
  });
  const sendPsi = (minutes: number, psi: number) => {
    now = NOW + minutes * MINUTE;
    const result = telemetry.ingestSingle(
      gauge,
      1,
      validateExternalTelemetryPayload({
        measured_at: new Date(now).toISOString(),
        readings: [{ metric: "pressure", value: psi, unit: "psi" }],
      }),
    );
    assert.equal(result.outcome, "accepted");
  };
  const pressureCheck = () =>
    listHealthCheckStates(database, tap.id).find(({ checkId }) => checkId === "serving_pressure");
  const events = () =>
    database
      .prepare<[], { envelope_json: string }>(
        "SELECT envelope_json FROM outbound_events WHERE event_type = 'health.transitioned' ORDER BY created_at, id",
      )
      .all()
      .map(({ envelope_json }) => JSON.parse(envelope_json) as { data: Record<string, unknown> });
  return { database, health, tap, sendPsi, pressureCheck, events };
}

void test("pressure readings raise and resolve a serving_pressure incident and its events", () => {
  const h = harness();
  const actor = { actorType: "admin" as const, actorId: "admin-1", sessionId: "session-1" };
  h.health.updateGlobalConfig({ serving_pressure: { enabled: true } }, actor);
  // Enabled with no reading yet, like serving temperature.
  assert.equal(h.pressureCheck()?.reason, "threshold_invalid");

  h.sendPsi(0, 12);
  assert.equal(h.pressureCheck()?.state, "healthy");
  assert.equal(h.pressureCheck()?.reason, "threshold_normal");

  // 4 psi is below the 5 psi critical minimum; it must last 15 minutes.
  for (const minute of [1, 4, 8, 12]) h.sendPsi(minute, 4);
  assert.equal(h.pressureCheck()?.state, "degraded");
  h.sendPsi(16, 4);
  assert.equal(h.pressureCheck()?.state, "active");
  assert.equal(h.pressureCheck()?.severity, "critical");
  const [incident] = listHealthIncidents(h.database, h.tap.id);
  assert.equal(incident?.checkId, "serving_pressure");
  assert.equal(incident?.resolvedAtMs ?? null, null);

  h.sendPsi(17, 12);
  assert.equal(h.pressureCheck()?.state, "healthy");
  assert.notEqual(listHealthIncidents(h.database, h.tap.id)[0]?.resolvedAtMs ?? null, null);

  const pressureEvents = h.events().filter(({ data }) => data.check_id === "serving_pressure");
  assert.deepEqual(
    pressureEvents.map(({ data }) => [data.state, data.severity]),
    [
      ["degraded", "info"],
      ["healthy", "none"],
      ["degraded", "info"],
      ["active", "critical"],
      ["healthy", "none"],
    ],
  );
  // Serving temperature is untouched by pressure readings.
  assert.equal(
    listHealthCheckStates(h.database, h.tap.id).find(
      ({ checkId }) => checkId === "serving_temperature",
    )?.reason,
    "check_disabled",
  );
});

void test("threshold config persists globally and per Tap with inheritance", () => {
  const h = harness();
  const actor = { actorType: "admin" as const, actorId: "admin-1", sessionId: "session-1" };
  const revision = readHealthGlobalConfig(h.database).revision;
  h.health.updateGlobalConfig({ serving_pressure: { enabled: true, normalMin: 70 } }, actor);
  const stored = readHealthGlobalConfig(h.database);
  assert.equal(stored.revision, revision + 1);
  assert.equal(stored.config.serving_pressure.normalMin, 70);
  assert.equal(stored.config.serving_pressure.enabled, true);
  assert.equal(
    stored.config.serving_pressure.normalMax,
    THRESHOLD_HEALTH_CHECKS.serving_pressure.defaults.normalMax,
  );
  assert.throws(
    () => h.health.updateGlobalConfig({ serving_pressure: { normalMin: 500 } }, actor),
    ApplicationError,
  );

  h.health.updateTapOverride(h.tap.id, { serving_pressure: { normalMax: 110 } }, actor);
  const effective = h.health.getEffectiveConfig(h.tap.id);
  assert.equal(effective.effective.serving_pressure.normalMax, 110);
  assert.equal(effective.effective.serving_pressure.normalMin, 70);
  assert.equal(effective.inheritance.serving_pressure.normalMax, "override");
  assert.equal(effective.inheritance.serving_pressure.normalMin, "default");

  h.health.updateTapOverride(h.tap.id, { serving_pressure: { normalMax: null } }, actor);
  const cleared = h.health.getEffectiveConfig(h.tap.id);
  assert.equal(cleared.override, null);
  assert.equal(
    cleared.effective.serving_pressure.normalMax,
    THRESHOLD_HEALTH_CHECKS.serving_pressure.defaults.normalMax,
  );
  assert.equal(
    h.database
      .prepare<[], { n: number }>("SELECT count(*) AS n FROM health_threshold_tap_overrides")
      .get()!.n,
    0,
  );
});
