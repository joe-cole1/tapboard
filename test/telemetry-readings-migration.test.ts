import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import {
  MIGRATIONS,
  TELEMETRY_READINGS_SCHEMA_VERSION,
} from "../src/infrastructure/database/migrations.ts";

const T = "2026-11-19T10:00:00.000Z";
const KEY = "k1111111-1111-4111-8111-111111111111";
const SOURCE = "s1111111-1111-4111-8111-111111111111";
const TAP1 = "t1111111-1111-4111-8111-111111111111";
const TAP2 = "t2222222-2222-4222-8222-222222222222";
const KEG = "k2222222-2222-4222-8222-222222222222";
const BEVERAGE = "b1111111-1111-4111-8111-111111111111";
const FILL = "f1111111-1111-4111-8111-111111111111";
const ASSIGNMENT = "a1111111-1111-4111-8111-111111111111";
const M1 = "m1111111-1111-4111-8111-111111111111";
const M2 = "m2222222-2222-4222-8222-222222222222";
const M3 = "m3333333-3333-4333-8333-333333333333";

function databasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-readings-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tapboard.sqlite3");
}

function seedV26(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
    VALUES ('${KEY}', 'pub_key_11111111', x'${"00".repeat(32)}', 'Key 1', '${T}');
    INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
    VALUES ('${SOURCE}', 'Scale', '${KEY}', '${T}', '${T}');
    INSERT INTO taps (id, tap_number, name, enabled, created_at, updated_at)
    VALUES ('${TAP1}', 1, 'One', 1, '${T}', '${T}'), ('${TAP2}', 2, 'Two', 1, '${T}', '${T}');
    INSERT INTO tap_telemetry_authority (tap_id, source_id, changed_at)
    VALUES ('${TAP1}', '${SOURCE}', '${T}'), ('${TAP2}', '${SOURCE}', '${T}');
    INSERT INTO kegs (id, keg_number, capacity_ml, current_tare_g, created_at, updated_at)
    VALUES ('${KEG}', 1, 19000, 4000, '${T}', '${T}');
    INSERT INTO beverages (id, ownership_type, created_at, updated_at)
    VALUES ('${BEVERAGE}', 'custom', '${T}', '${T}');
    INSERT INTO fills (id, beverage_id, keg_id, fill_date, created_at, updated_at)
    VALUES ('${FILL}', '${BEVERAGE}', '${KEG}', '2026-11-19', '${T}', '${T}');
    INSERT INTO tap_assignment_lifecycles (id, tap_id, fill_id, assigned_at, created_at)
    VALUES ('${ASSIGNMENT}', '${TAP1}', '${FILL}', '${T}', '${T}');

    INSERT INTO telemetry_measurements (id, source_id, tap_id, measured_at, measured_at_epoch_ms, received_at, normalization_version, primary_kind, total_mass_g, remaining_volume_ml, fill_percentage, temperature_c, captured_assignment_id, captured_fill_id, created_at) VALUES
      ('${M1}', '${SOURCE}', '${TAP1}', '2026-11-19T10:01:00.000Z', 1795082460000, '2026-11-19T10:01:01.000Z', 1, 'total_weight', 15000, NULL, NULL, 4.5, '${ASSIGNMENT}', '${FILL}', '2026-11-19T10:01:01.000Z'),
      ('${M2}', '${SOURCE}', '${TAP1}', '2026-11-19T10:02:00.000Z', 1795082520000, '2026-11-19T10:02:01.000Z', 1, 'remaining_volume', NULL, 9000, NULL, NULL, '${ASSIGNMENT}', '${FILL}', '2026-11-19T10:02:01.000Z'),
      ('${M3}', '${SOURCE}', '${TAP2}', '2026-11-19T10:03:00.000Z', 1795082580000, '2026-11-19T10:03:01.000Z', 1, 'fill_percentage', NULL, NULL, 50, 3, NULL, NULL, '2026-11-19T10:03:01.000Z');

    INSERT INTO telemetry_source_tap_status (source_id, tap_id, latest_measurement_id, latest_measured_at, latest_measured_at_epoch_ms, latest_received_at, normalization_version, primary_kind, total_mass_g, remaining_volume_ml, fill_percentage, temperature_c, captured_assignment_id, captured_fill_id, updated_at) VALUES
      ('${SOURCE}', '${TAP1}', '${M2}', '2026-11-19T10:02:00.000Z', 1795082520000, '2026-11-19T10:02:01.000Z', 1, 'remaining_volume', NULL, 9000, NULL, NULL, '${ASSIGNMENT}', '${FILL}', '2026-11-19T10:02:01.000Z'),
      ('${SOURCE}', '${TAP2}', NULL, '2026-11-19T09:00:00.000Z', 1795078800000, '2026-11-19T09:00:01.000Z', 1, 'fill_percentage', NULL, NULL, 40, 2.5, NULL, NULL, '2026-11-19T09:00:01.000Z');

    INSERT INTO telemetry_ingest_receipts (id, source_id, tap_id, identity_kind, client_sample_id, measured_at_epoch_ms, payload_digest, normalization_version, outcome, outcome_code, accepted_measurement_id, measured_at, received_at, processed_at)
    VALUES ('r1111111-1111-4111-8111-111111111111', '${SOURCE}', '${TAP1}', 'client_sample_id', 'sample-1', 1795082460000, '${"a".repeat(64)}', 1, 'accepted', 'telemetry.accepted', '${M1}', '2026-11-19T10:01:00.000Z', '2026-11-19T10:01:01.000Z', '2026-11-19T10:01:01.000Z');
  `);
}

const all = (database: DatabaseExecutor, sql: string) => database.prepare(sql).all();

void test("v26 telemetry upgrades to v27 readings without losing rows or status pointers", (context) => {
  const path = databasePath(context);
  const v26 = openDatabase(path, {
    migrations: MIGRATIONS.slice(0, TELEMETRY_READINGS_SCHEMA_VERSION - 1),
  });
  let measurements: unknown[];
  let statuses: unknown[];
  let receipts: unknown[];
  try {
    seedV26(v26);
    measurements = all(v26, "SELECT * FROM telemetry_measurements ORDER BY id");
    statuses = all(v26, "SELECT * FROM telemetry_source_tap_status ORDER BY tap_id");
    receipts = all(v26, "SELECT * FROM telemetry_ingest_receipts ORDER BY id");
  } finally {
    v26.close();
  }

  const v27 = { migrations: MIGRATIONS.slice(0, TELEMETRY_READINGS_SCHEMA_VERSION) };
  const upgraded = openDatabase(path, v27);
  try {
    assert.equal(upgraded.pragma<number>("user_version", { simple: true }), 27);
    assert.deepEqual(
      all(upgraded, "SELECT * FROM telemetry_measurements ORDER BY id"),
      measurements,
    );
    // Dropping the old table fired ON DELETE SET NULL; the migration restores the pointers.
    assert.deepEqual(
      all(upgraded, "SELECT * FROM telemetry_source_tap_status ORDER BY tap_id"),
      statuses,
    );
    assert.deepEqual(
      all(upgraded, "SELECT * FROM telemetry_ingest_receipts ORDER BY id"),
      receipts,
    );
    assert.deepEqual(
      all(
        upgraded,
        "SELECT measurement_id, metric, value FROM telemetry_readings ORDER BY measurement_id, metric",
      ),
      [
        { measurement_id: M1, metric: "temperature", value: 4.5 },
        { measurement_id: M1, metric: "total_weight", value: 15000 },
        { measurement_id: M2, metric: "remaining_volume", value: 9000 },
        { measurement_id: M3, metric: "fill_percentage", value: 50 },
        { measurement_id: M3, metric: "temperature", value: 3 },
      ],
    );
    assert.deepEqual(
      all(
        upgraded,
        "SELECT tap_id, metric, value, measurement_id, captured_assignment_id, measured_at_epoch_ms FROM telemetry_source_tap_readings ORDER BY tap_id, metric",
      ),
      [
        {
          tap_id: TAP1,
          metric: "remaining_volume",
          value: 9000,
          measurement_id: M2,
          captured_assignment_id: ASSIGNMENT,
          measured_at_epoch_ms: 1795082520000,
        },
        {
          tap_id: TAP2,
          metric: "fill_percentage",
          value: 40,
          measurement_id: null,
          captured_assignment_id: null,
          measured_at_epoch_ms: 1795078800000,
        },
        {
          tap_id: TAP2,
          metric: "temperature",
          value: 2.5,
          measurement_id: null,
          captured_assignment_id: null,
          measured_at_epoch_ms: 1795078800000,
        },
      ],
    );
    assert.deepEqual(all(upgraded, "PRAGMA foreign_key_check"), []);
    assert.deepEqual(
      all(upgraded, "PRAGMA temp.table_list").filter((row) =>
        (row as { name: string }).name.includes("v27"),
      ),
      [],
    );

    // The recreated triggers still guard the rebuilt table.
    assert.throws(
      () => upgraded.execute("UPDATE telemetry_measurements SET total_mass_g = 1"),
      /telemetry measurements are immutable/,
    );
    assert.throws(
      () => upgraded.execute("UPDATE telemetry_readings SET value = 1"),
      /telemetry readings are immutable/,
    );
    assert.throws(
      () =>
        upgraded.execute(
          `UPDATE telemetry_source_tap_status SET latest_measurement_id = '${M3}' WHERE tap_id = '${TAP1}'`,
        ),
      /telemetry status references inconsistent context/,
    );
    // A sample with no level reading is now storable; a level value without its kind is not.
    upgraded.execute(`
      INSERT INTO telemetry_measurements (id, source_id, tap_id, measured_at, measured_at_epoch_ms, received_at, normalization_version, primary_kind, temperature_c, created_at)
      VALUES ('m4444444-4444-4444-8444-444444444444', '${SOURCE}', '${TAP2}', '${T}', 1795082400000, '${T}', 1, NULL, 4, '${T}');
    `);
    assert.throws(
      () =>
        upgraded.execute(`
          INSERT INTO telemetry_measurements (id, source_id, tap_id, measured_at, measured_at_epoch_ms, received_at, normalization_version, primary_kind, total_mass_g, created_at)
          VALUES ('m5555555-5555-4555-8555-555555555555', '${SOURCE}', '${TAP2}', '${T}', 1795082400000, '${T}', 1, NULL, 10, '${T}');
        `),
      /CHECK constraint failed/,
    );
    // Raw pruning cascades to readings.
    upgraded.execute(`DELETE FROM telemetry_measurements WHERE id = '${M1}'`);
    assert.deepEqual(
      all(upgraded, `SELECT metric FROM telemetry_readings WHERE measurement_id = '${M1}'`),
      [],
    );
  } finally {
    upgraded.close();
  }

  // The upgraded file validates as canonical v27 when reopened.
  openDatabase(path, v27).close();
});

void test("a fresh database and a v27 database missing a readings object are told apart", (context) => {
  const v27 = { migrations: MIGRATIONS.slice(0, TELEMETRY_READINGS_SCHEMA_VERSION) };
  const fresh = openDatabase(":memory:", v27);
  try {
    assert.equal(fresh.pragma<number>("user_version", { simple: true }), 27);
    assert.deepEqual(all(fresh, "PRAGMA foreign_key_check"), []);
  } finally {
    fresh.close();
  }

  const path = databasePath(context);
  const database = openDatabase(path, v27);
  database.execute("DROP TRIGGER trg_telemetry_readings_no_update");
  database.close();
  assert.throws(() => openDatabase(path, v27), /Incompatible SQLite schema/);
});
