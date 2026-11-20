import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import {
  MIGRATIONS,
  TELEMETRY_ROLLUPS_SCHEMA_VERSION,
} from "../src/infrastructure/database/migrations.ts";

const T = "2026-11-20T10:00:00.000Z";
const KEY = "k1111111-1111-4111-8111-111111111111";
const SOURCE = "s1111111-1111-4111-8111-111111111111";
const TAP = "t1111111-1111-4111-8111-111111111111";
const HOUR = 3_600_000;

function databasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-rollups-"));
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

void test("v29 databases upgrade to v30 with every row unchanged and default rollup retention", (context) => {
  const path = databasePath(context);
  const v29 = openDatabase(path, {
    migrations: MIGRATIONS.slice(0, TELEMETRY_ROLLUPS_SCHEMA_VERSION - 1),
  });
  let before: Record<string, unknown[]>;
  try {
    v29.execute(`
      INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
      VALUES ('${KEY}', 'pub_key_11111111', x'${"00".repeat(32)}', 'Key 1', '${T}');
      INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
      VALUES ('${SOURCE}', 'Probe', '${KEY}', '${T}', '${T}');
      INSERT INTO taps (id, tap_number, name, enabled, created_at, updated_at)
      VALUES ('${TAP}', 1, 'One', 1, '${T}', '${T}');
      INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at)
      VALUES ('${TAP}', 'condition', '${SOURCE}', '${T}');
      UPDATE telemetry_settings SET raw_retention_seconds = 3600 WHERE id = 1;
    `);
    before = snapshot(v29);
  } finally {
    v29.close();
  }

  const v30Migrations = MIGRATIONS.slice(0, TELEMETRY_ROLLUPS_SCHEMA_VERSION);
  const upgraded = openDatabase(path, { migrations: v30Migrations });
  try {
    assert.equal(
      upgraded.pragma<number>("user_version", { simple: true }),
      TELEMETRY_ROLLUPS_SCHEMA_VERSION,
    );
    const after = snapshot(upgraded);
    assert.deepEqual(after.telemetry_rollups_hourly, []);
    assert.deepEqual(after.telemetry_rollups_daily, []);
    assert.deepEqual(
      all(
        upgraded,
        "SELECT id, hourly_retention_days, daily_retention_days FROM telemetry_rollup_settings",
      ),
      [{ id: 1, hourly_retention_days: 30, daily_retention_days: 730 }],
    );
    delete after.telemetry_rollups_hourly;
    delete after.telemetry_rollups_daily;
    delete after.telemetry_rollup_settings;
    assert.deepEqual(after, before);
    assert.deepEqual(all(upgraded, "PRAGMA foreign_key_check"), []);
  } finally {
    upgraded.close();
  }

  // The upgraded file validates as canonical when reopened.
  openDatabase(path, { migrations: v30Migrations }).close();
});

void test("rollup rows reject buckets that are unaligned or inconsistent", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO taps (id, tap_number, name, enabled, created_at, updated_at)
      VALUES ('${TAP}', 1, 'One', 1, '${T}', '${T}');
    `);
    const insert = (table: string, values: string) =>
      database.execute(
        `INSERT INTO ${table} (tap_id, metric, bucket_start_epoch_ms, min_value, max_value, sum_value, sample_count, last_value, last_measured_at_epoch_ms) VALUES ('${TAP}', ${values})`,
      );
    insert("telemetry_rollups_hourly", `'temperature', ${HOUR}, 1, 3, 4, 2, 3, ${HOUR + 5}`);
    // Unaligned bucket, last outside min/max, last measured outside its bucket, empty bucket,
    // unregistered-looking metric name.
    for (const values of [
      `'temperature', ${HOUR + 1}, 1, 3, 4, 2, 3, ${HOUR + 5}`,
      `'temperature', ${2 * HOUR}, 1, 3, 4, 2, 9, ${2 * HOUR + 5}`,
      `'temperature', ${2 * HOUR}, 1, 3, 4, 2, 3, ${3 * HOUR}`,
      `'temperature', ${2 * HOUR}, 1, 3, 4, 0, 3, ${2 * HOUR}`,
      `'Temp-C', ${2 * HOUR}, 1, 3, 4, 2, 3, ${2 * HOUR}`,
    ]) {
      assert.throws(() => insert("telemetry_rollups_hourly", values), /CHECK constraint failed/);
    }
    assert.throws(
      () => insert("telemetry_rollups_daily", `'temperature', ${HOUR}, 1, 3, 4, 2, 3, ${HOUR}`),
      /CHECK constraint failed/,
    );
    // Rollups go with their Tap.
    database.execute(`DELETE FROM taps WHERE id = '${TAP}'`);
    assert.deepEqual(all(database, "SELECT * FROM telemetry_rollups_hourly"), []);
  } finally {
    database.close();
  }
});
