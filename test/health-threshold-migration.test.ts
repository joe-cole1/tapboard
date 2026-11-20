import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import {
  HEALTH_THRESHOLD_CHECKS_SCHEMA_VERSION,
  MIGRATIONS,
} from "../src/infrastructure/database/migrations.ts";

const T = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-20T11:00:00.000Z";
const TAP = "t1111111-1111-4111-8111-111111111111";
const INCIDENT = "i1111111-1111-4111-8111-111111111111";
const TRANSITION_1 = "r1111111-1111-4111-8111-111111111111";
const TRANSITION_2 = "r2222222-2222-4222-8222-222222222222";

function databasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-thresholds-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tapboard.sqlite3");
}

const all = (database: DatabaseExecutor, sql: string) => database.prepare(sql).all();

/** Every row of every table, by table name, in a stable order. */
function snapshot(database: DatabaseExecutor): Record<string, unknown[]> {
  const tables = database
    .prepare<[], { readonly name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [name, all(database, `SELECT * FROM "${name}" ORDER BY 1, 2`)]),
  );
}

function seedHealthHistory(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO taps (id, tap_number, name, enabled, created_at, updated_at)
    VALUES ('${TAP}', 1, 'One', 1, '${T}', '${T}');
    INSERT INTO health_check_state
      (tap_id, check_id, state, severity, reason_code, evidence_json, condition_started_at,
       last_observation_at, revision, evaluated_at, updated_at)
    VALUES
      ('${TAP}', 'serving_temperature', 'active', 'warning', 'temperature_out_of_range',
       '{"temperatureC":9}', '${T}', '${T2}', 3, '${T2}', '${T2}'),
      ('${TAP}', 'low_keg', 'healthy', 'none', 'above_threshold', '{}', NULL, NULL, 1, '${T}', '${T}');
    INSERT INTO health_incidents
      (id, tap_id, check_id, opened_at, current_severity, max_severity, open_reason_code,
       open_evidence_json, revision, updated_at)
    VALUES ('${INCIDENT}', '${TAP}', 'serving_temperature', '${T}', 'warning', 'warning',
            'temperature_out_of_range', '{"temperatureC":9}', 1, '${T}');
    INSERT INTO health_incident_transitions
      (id, incident_id, transition_kind, state, severity, reason_code, evidence_json, occurred_at,
       created_at)
    VALUES ('${TRANSITION_1}', '${INCIDENT}', 'opened', 'active', 'warning',
            'temperature_out_of_range', '{}', '${T}', '${T}');
    INSERT INTO health_tap_overrides (tap_id, revision, serving_temperature_normal_max_c, updated_at)
    VALUES ('${TAP}', 1, 6, '${T}');
  `);
}

void test("v30 databases upgrade to v31 with health history unchanged", (context) => {
  const path = databasePath(context);
  const v30 = openDatabase(path, {
    migrations: MIGRATIONS.slice(0, HEALTH_THRESHOLD_CHECKS_SCHEMA_VERSION - 1),
  });
  let before: Record<string, unknown[]>;
  try {
    seedHealthHistory(v30);
    // The fixed check list still holds before the upgrade.
    assert.throws(
      () =>
        v30.execute(
          `INSERT INTO health_check_state (tap_id, check_id, state, severity, revision, evaluated_at, updated_at) VALUES ('${TAP}', 'serving_pressure', 'healthy', 'none', 1, '${T}', '${T}')`,
        ),
      /CHECK constraint failed/,
    );
    before = snapshot(v30);
  } finally {
    v30.close();
  }

  const upgraded = openDatabase(path);
  try {
    assert.equal(
      upgraded.pragma<number>("user_version", { simple: true }),
      HEALTH_THRESHOLD_CHECKS_SCHEMA_VERSION,
    );
    const after = snapshot(upgraded);
    assert.deepEqual(after.health_threshold_global_config, []);
    assert.deepEqual(after.health_threshold_tap_overrides, []);
    delete after.health_threshold_global_config;
    delete after.health_threshold_tap_overrides;
    assert.deepEqual(after, before);
    assert.deepEqual(all(upgraded, "PRAGMA foreign_key_check"), []);

    // Any well-formed check ID is accepted now; malformed ones are not.
    upgraded.execute(`
      INSERT INTO health_check_state (tap_id, check_id, state, severity, revision, evaluated_at, updated_at)
      VALUES ('${TAP}', 'serving_pressure', 'healthy', 'none', 1, '${T}', '${T}'),
             ('${TAP}', 'a_future_check', 'healthy', 'none', 1, '${T}', '${T}');
    `);
    assert.throws(
      () =>
        upgraded.execute(
          `INSERT INTO health_check_state (tap_id, check_id, state, severity, revision, evaluated_at, updated_at) VALUES ('${TAP}', 'Bad-ID', 'healthy', 'none', 1, '${T}', '${T}')`,
        ),
      /CHECK constraint failed/,
    );
    // The rebuilt transitions still belong to their incident and stay append-only.
    upgraded.execute(`
      INSERT INTO health_incident_transitions
        (id, incident_id, transition_kind, evidence_json, occurred_at, created_at)
      VALUES ('${TRANSITION_2}', '${INCIDENT}', 'resolved', '{}', '${T2}', '${T2}');
    `);
    assert.throws(
      () =>
        upgraded.execute(
          `INSERT INTO health_incident_transitions (id, incident_id, transition_kind, evidence_json, occurred_at, created_at) VALUES ('r3333333-3333-4333-8333-333333333333', 'i9999999-9999-4999-8999-999999999999', 'opened', '{}', '${T}', '${T}')`,
        ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => upgraded.execute(`UPDATE health_incident_transitions SET state = 'healthy'`),
      /append-only/,
    );
  } finally {
    upgraded.close();
  }

  // The upgraded file validates as canonical when reopened.
  openDatabase(path).close();
});

void test("threshold config rows enforce range order and go with their Tap override", () => {
  const database = openDatabase(":memory:");
  try {
    seedHealthHistory(database);
    const global = (values: string) =>
      database.execute(
        `INSERT INTO health_threshold_global_config (check_id, enabled, normal_min, normal_max, critical_min, critical_max, duration_ms) VALUES ${values}`,
      );
    global("('serving_pressure', 1, 70, 120, 35, 200, 900000)");
    for (const values of [
      "('a_check', 1, 70, 120, 80, 200, 900000)",
      "('b_check', 1, 120, 70, 35, 200, 900000)",
      "('c_check', 2, 70, 120, 35, 200, 900000)",
      "('d_check', 1, 70, 120, 35, 200, 0)",
      "('Bad-ID', 1, 70, 120, 35, 200, 900000)",
    ]) {
      assert.throws(() => global(values), /CHECK constraint failed/);
    }
    const override = (values: string) =>
      database.execute(
        `INSERT INTO health_threshold_tap_overrides (tap_id, check_id, enabled, normal_min, normal_max, critical_min, critical_max, duration_ms) VALUES ${values}`,
      );
    override(`('${TAP}', 'serving_pressure', NULL, NULL, 110, NULL, NULL, NULL)`);
    assert.throws(
      () => override(`('${TAP}', 'other_check', NULL, NULL, NULL, NULL, NULL, NULL)`),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => override(`('${TAP}', 'other_check', NULL, 120, 110, NULL, NULL, NULL)`),
      /CHECK constraint failed/,
    );
    database.execute(`DELETE FROM health_tap_overrides WHERE tap_id = '${TAP}'`);
    assert.deepEqual(all(database, "SELECT * FROM health_threshold_tap_overrides"), []);
  } finally {
    database.close();
  }
});
