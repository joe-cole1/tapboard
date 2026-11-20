import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import {
  readOpenTelemetryEpochForTap,
  readTelemetryEpochFlowState,
} from "../src/features/telemetry/repositories/detector.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { validateExternalTelemetryPayload } from "../src/features/telemetry/telemetry-validation.ts";
import type { TelemetrySource } from "../src/features/telemetry/types.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";

const origin = Date.parse("2026-11-20T10:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Quiet 100 ms, hard timeout 500 ms, minimum pour 10 ml; fast scale settings.
const config = {
  ...DEFAULT_DETECTOR_CONFIG,
  baselineSamples: 2,
  baselineSpanMs: 50,
  baselineBandMl: 2,
  candidateLossMl: 10,
  candidateSamples: 2,
  candidateSampleWindowMs: 50,
  candidateLookbackMs: 500,
  arbitrationMs: 0,
  arbitrationMinimumMl: 1,
  meaningfulFlowMl: 1,
  quietPeriodMs: 100,
  hardTimeoutMs: 500,
  minimumPourMl: 10,
  settledSamples: 1,
  settledSpanMs: 0,
  settledBandMl: 2,
  jumpStableSamples: 1,
  jumpStableSpanMs: 0,
  cooldownMs: 100,
  historyMs: 500,
};

function harness(roles: { readonly scale: boolean; readonly meter: boolean }) {
  let now = origin;
  let nextId = 1;
  const ids = () => uuid(nextId++);
  const clock = () => new Date(now);
  const database = openDatabase(":memory:");
  const completed: (string | undefined)[] = [];
  const committed: { readonly tapIds: readonly string[]; readonly inTransaction: boolean }[] = [];
  const faults = { pourCompleted: false };
  const detector = new DetectorService(database, {
    idFactory: ids,
    now: clock,
    onPourCompleted: (_db, pour) => {
      if (faults.pourCompleted) throw new Error("Injected pour-completed hook failure");
      completed.push(pour.effectKey);
    },
    onPoursCommitted: (tapIds) => {
      // BEGIN fails inside an open transaction.
      let inTransaction = false;
      try {
        database.execute("BEGIN");
        database.execute("ROLLBACK");
      } catch {
        inTransaction = true;
      }
      committed.push({ tapIds, inTransaction });
    },
  });
  const machineKeyService = createMachineKeyService(database, { idFactory: ids, now: clock });
  const tapService = createTapService(database, {
    extensionPort: detector,
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
    authorityExtensionPort: detector,
    acceptedExtensionPort: detector,
    idGenerator: ids,
    clock,
  });
  const tap = tapService.createTap({ tapNumber: 1, name: "One" });
  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19_000, currentTareG: 4_000 });
  const beverage = beverageService.createCustomBeverage({
    name: "Test beer",
    beverageType: "beer",
    fg: 1.0,
  });
  const fill = fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const scale = telemetryService.createSource({ name: "scale" }).source;
  const meter = telemetryService.createSource({ name: "meter" }).source;
  telemetryService.setTapAuthority(tap.id, {
    levelSourceId: roles.scale ? scale.id : null,
    conditionSourceId: null,
    flowSourceId: roles.meter ? meter.id : null,
  });
  detector.setTapOverride(tap.id, config);
  tapService.assignFill(tap.id, { fillId: fill.id });

  // `lagMs` is how far the device clock runs behind the server when the reading arrives.
  const send = (source: TelemetrySource, at: number, id: string, reading: object, lagMs = 0) => {
    now = origin + at + lagMs;
    return telemetryService.ingestSingle(
      source,
      1,
      validateExternalTelemetryPayload({
        client_sample_id: id,
        measured_at: new Date(origin + at).toISOString(),
        readings: [reading],
      }),
    );
  };
  return {
    database,
    detector,
    tapService,
    telemetryService,
    tap,
    fill,
    scale,
    meter,
    completed,
    committed,
    faults,
    flow: (at: number, counterMl: number, id = `flow-${at}`, lagMs = 0) =>
      send(meter, at, id, { metric: "dispensed_volume", value: counterMl, unit: "ml" }, lagMs),
    level: (at: number, volumeMl: number, id = `level-${at}`) =>
      send(scale, at, id, { metric: "remaining_volume", value: volumeMl, unit: "ml" }),
    due: (at: number) => {
      now = origin + at;
      return detector.processDue(new Date(origin + at));
    },
    set: (at: number) => {
      now = origin + at;
    },
    pours: () =>
      database
        .prepare<[], { readonly canonical_volume_ml: number; readonly effect_key: string }>(
          "SELECT canonical_volume_ml, effect_key FROM pours ORDER BY completed_at",
        )
        .all()
        .map((pour) => pour.canonical_volume_ml),
    flowState: () =>
      readTelemetryEpochFlowState(database, readOpenTelemetryEpochForTap(database, tap.id)!.id),
    close: () => database.close(),
  };
}

void test("a flow-only Tap records the counter delta as one pour and derives remaining volume", () => {
  const h = harness({ scale: false, meter: true });
  try {
    // Before any flow reading the Tap waits, like a scale before its baseline.
    assert.equal(h.detector.diagnostics(h.tap.id).detector?.waitingForMeasurement, true);
    assert.equal(h.flow(1_000, 5_000).outcome, "accepted");
    const baseline = h.detector.diagnostics(h.tap.id);
    assert.equal(baseline.detector?.phase, "ready");
    assert.equal(baseline.measurement?.publicVolumeMl, 19_000);
    assert.deepEqual(h.pours(), []);

    h.flow(1_100, 5_200);
    h.flow(1_150, 5_250);
    h.flow(1_200, 5_473);
    h.due(1_299);
    assert.deepEqual(h.pours(), []);
    h.due(1_300);
    assert.deepEqual(h.pours(), [473]);
    const after = h.detector.diagnostics(h.tap.id);
    assert.equal(after.measurement?.publicVolumeMl, 19_000 - 473);
    assert.equal(after.measurement?.stabilizedVolumeMl, 19_000 - 473);
    assert.equal(after.measurement?.diagnosticCode, "ok");
    assert.equal(h.completed.length, 1);
    assert.match(h.completed[0]!, /^telemetry-pour:[^:]+:[^:]+:complete$/);

    // A second pour subtracts as well; a heartbeat refreshes the measurement time.
    h.flow(2_000, 5_673);
    h.due(2_200);
    h.flow(60_000, 5_673);
    assert.deepEqual(h.pours(), [473, 200]);
    const latest = h.detector.diagnostics(h.tap.id).measurement;
    assert.equal(latest?.publicVolumeMl, 19_000 - 673);
    assert.equal(latest?.measuredAt, new Date(origin + 60_000).toISOString());
  } finally {
    h.close();
  }
});

void test("a retried sample and repeated maintenance still record one pour", () => {
  const h = harness({ scale: false, meter: true });
  try {
    h.flow(1_000, 0, "a");
    h.flow(1_100, 300, "b");
    assert.equal(h.flow(1_100, 300, "b").duplicate, true);
    h.due(1_300);
    h.due(1_300);
    h.due(5_000);
    assert.equal(h.flow(1_100, 300, "b").duplicate, true);
    assert.deepEqual(h.pours(), [300]);
    assert.equal(h.completed.length, 1);
  } finally {
    h.close();
  }
});

void test("scale and flow on one Tap record exactly one pour per dispense, from the flow meter", () => {
  // The same scale trace on a scale-only Tap records its own pour...
  const control = harness({ scale: true, meter: false });
  try {
    control.level(1_000, 15_000);
    control.level(1_050, 15_000);
    control.level(1_100, 14_980);
    control.level(1_150, 14_970);
    control.due(1_300);
    assert.equal(control.pours().length, 1);
  } finally {
    control.close();
  }

  // ...but with a flow source the scale only keeps remaining volume.
  const h = harness({ scale: true, meter: true });
  try {
    h.flow(1_000, 800);
    h.level(1_000, 15_000);
    h.level(1_050, 15_000);
    h.flow(1_100, 820);
    h.level(1_100, 14_980);
    h.flow(1_150, 840);
    h.level(1_150, 14_970);
    h.due(1_300);
    h.level(1_400, 14_960);
    h.due(2_000);
    assert.deepEqual(h.pours(), [40]);
    const diagnostics = h.detector.diagnostics(h.tap.id);
    assert.equal(diagnostics.epoch?.sourceId, h.scale.id);
    assert.equal(diagnostics.measurement?.publicVolumeMl, 14_960);
  } finally {
    h.close();
  }
});

void test("ingest keeps a dispensed_volume reading only from the Tap's flow source", () => {
  const h = harness({ scale: true, meter: false });
  try {
    // The scale holds level, not flow: its flow reading is dropped and the sample rejected.
    const result = h.level(1_000, 15_000);
    assert.equal(result.outcome, "accepted");
    h.set(1_100);
    const flowFromScale = h.telemetryService.ingestSingle(
      h.scale,
      1,
      validateExternalTelemetryPayload({
        client_sample_id: "flow-from-scale",
        measured_at: new Date(origin + 1_100).toISOString(),
        readings: [{ metric: "dispensed_volume", value: 10, unit: "l" }],
      }),
    );
    assert.equal(flowFromScale.outcome, "rejected");
    assert.equal(flowFromScale.code, "telemetry.not_authoritative");
    assert.equal(h.flow(1_200, 10).code, "telemetry.not_authoritative");
  } finally {
    h.close();
  }
});

void test("changing the flow source needs a fresh baseline; other transitions carry it", () => {
  const h = harness({ scale: false, meter: true });
  try {
    h.flow(1_000, 1_000);
    const firstEpoch = h.detector.diagnostics(h.tap.id).epoch!.id;

    // A detector config change opens a new epoch but keeps the counter baseline, so flow
    // between the last reading before it and the first after it still counts.
    h.set(2_000);
    h.detector.setTapOverride(h.tap.id, { ...config, cooldownMs: 200 });
    assert.notEqual(h.detector.diagnostics(h.tap.id).epoch!.id, firstEpoch);
    assert.equal(h.flowState()?.counterMl, 1_000);
    assert.equal(h.detector.diagnostics(h.tap.id).measurement?.publicVolumeMl, 19_000);
    h.flow(3_000, 1_250);
    h.due(3_200);
    assert.deepEqual(h.pours(), [250]);

    // A new flow source starts from a fresh baseline.
    const meter2 = h.telemetryService.createSource({ name: "meter 2" }).source;
    h.set(4_000);
    const changed = h.telemetryService.setTapAuthority(h.tap.id, {
      levelSourceId: null,
      conditionSourceId: null,
      flowSourceId: meter2.id,
    });
    assert.equal(changed.requiresFreshBaseline, true);
    assert.equal(changed.authority.flow?.sourceId, meter2.id);
    assert.deepEqual(
      { ...h.flowState(), epochId: undefined, updatedAt: undefined },
      {
        epochId: undefined,
        sourceId: meter2.id,
        counterMl: null,
        counterAtMs: null,
        pour: null,
        updatedAt: undefined,
      },
    );
    // The old meter is no longer authoritative.
    assert.equal(h.flow(5_000, 9_000).code, "telemetry.not_authoritative");
  } finally {
    h.close();
  }
});

void test("a flow pour open when its epoch ends is recorded", () => {
  const h = harness({ scale: false, meter: true });
  try {
    h.flow(1_000, 0);
    h.flow(1_050, 120);
    h.set(1_080);
    h.tapService.unassign(h.tap.id);
    assert.deepEqual(h.pours(), [120]);
    assert.equal(h.detector.diagnostics(h.tap.id).epoch, null);
  } finally {
    h.close();
  }
});

void test("a meter whose clock runs behind the server still records whole pours", () => {
  const h = harness({ scale: false, meter: true });
  try {
    // Each reading arrives 2 s after its measured time, far longer than the 100 ms quiet
    // period, and each step (6 ml) is below the 10 ml minimum pour.
    const lagMs = 2_000;
    h.flow(1_000, 0, "lag-0", lagMs);
    for (let step = 1; step <= 5; step += 1) {
      const at = 1_000 + step * 50;
      h.flow(at, step * 6, `lag-${step}`, lagMs);
      h.due(at + lagMs + 25);
    }
    assert.deepEqual(h.pours(), []);
    h.due(1_250 + lagMs + 100);
    assert.deepEqual(h.pours(), [30]);
  } finally {
    h.close();
  }
});

void test("changing only the level source keeps the flow baseline", () => {
  const h = harness({ scale: true, meter: true });
  try {
    h.flow(1_000, 1_000);
    h.level(1_000, 15_000);
    h.set(2_000);
    h.telemetryService.setTapAuthority(h.tap.id, {
      levelSourceId: null,
      conditionSourceId: null,
      flowSourceId: h.meter.id,
    });
    // Now flow-only: the baseline carries over and remaining volume is known at once.
    assert.equal(h.flowState()?.counterMl, 1_000);
    assert.equal(h.detector.diagnostics(h.tap.id).measurement?.publicVolumeMl, 19_000);
    h.flow(3_000, 1_150);
    h.due(3_200);
    assert.deepEqual(h.pours(), [150]);
    assert.equal(h.detector.diagnostics(h.tap.id).measurement?.publicVolumeMl, 19_000 - 150);
  } finally {
    h.close();
  }
});

void test("maintenance reports a closed flow pour's Tap after its transaction commits", () => {
  const h = harness({ scale: false, meter: true });
  try {
    h.flow(1_000, 0);
    h.flow(1_100, 300);
    assert.deepEqual(h.due(1_150), []);
    assert.deepEqual(h.committed, []);
    assert.deepEqual(h.due(1_300), [h.tap.id]);
    assert.deepEqual(h.pours(), [300]);
    assert.deepEqual(h.committed, [{ tapIds: [h.tap.id], inTransaction: false }]);
    // Nothing more is due, and a pour closed by a reading is ingest's to report.
    assert.deepEqual(h.due(5_000), []);
    h.flow(6_000, 400);
    h.flow(6_200, 500);
    assert.deepEqual(h.pours(), [300, 100]);
    assert.equal(h.committed.length, 1);
  } finally {
    h.close();
  }
});

void test("maintenance reports a closed scale pour's Tap", () => {
  const h = harness({ scale: true, meter: false });
  try {
    h.level(1_000, 15_000);
    h.level(1_050, 15_000);
    h.level(1_100, 14_980);
    h.level(1_150, 14_970);
    assert.deepEqual(h.due(1_300), [h.tap.id]);
    assert.equal(h.pours().length, 1);
    assert.deepEqual(h.committed, [{ tapIds: [h.tap.id], inTransaction: false }]);
  } finally {
    h.close();
  }
});

void test("maintenance reports nothing for a discarded pour or a rolled-back run", () => {
  const h = harness({ scale: false, meter: true });
  try {
    // Below the 10 ml minimum: discarded, not recorded.
    h.flow(1_000, 0);
    h.flow(1_100, 5);
    assert.deepEqual(h.due(1_300), []);
    assert.deepEqual(h.pours(), []);

    h.flow(2_000, 305);
    h.faults.pourCompleted = true;
    assert.throws(() => h.due(2_200), /Injected pour-completed hook failure/);
    assert.deepEqual(h.pours(), []);
    assert.deepEqual(h.committed, []);

    // The rolled-back pour is still open, so the next run records and reports it once.
    h.faults.pourCompleted = false;
    assert.deepEqual(h.due(2_200), [h.tap.id]);
    assert.deepEqual(h.pours(), [300]);
    assert.deepEqual(h.committed, [{ tapIds: [h.tap.id], inTransaction: false }]);
  } finally {
    h.close();
  }
});
