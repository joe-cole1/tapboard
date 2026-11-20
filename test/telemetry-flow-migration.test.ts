import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import {
  MIGRATIONS,
  TELEMETRY_FLOW_SCHEMA_VERSION,
} from "../src/infrastructure/database/migrations.ts";

const T = "2026-11-20T10:00:00.000Z";
const T2 = "2026-11-20T11:00:00.000Z";
const KEY1 = "k1111111-1111-4111-8111-111111111111";
const KEY2 = "k2222222-2222-4222-8222-222222222222";
const SCALE = "s1111111-1111-4111-8111-111111111111";
const PROBE = "s2222222-2222-4222-8222-222222222222";
const TAP1 = "t1111111-1111-4111-8111-111111111111";
const TAP2 = "t2222222-2222-4222-8222-222222222222";

function databasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-flow-"));
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

void test("v28 databases upgrade to v29 with every row unchanged and no flow state", (context) => {
  const path = databasePath(context);
  const v28 = openDatabase(path, {
    migrations: MIGRATIONS.slice(0, TELEMETRY_FLOW_SCHEMA_VERSION - 1),
  });
  let before: Record<string, unknown[]>;
  try {
    v28.execute(`
      INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
      VALUES ('${KEY1}', 'pub_key_11111111', x'${"00".repeat(32)}', 'Key 1', '${T}'),
             ('${KEY2}', 'pub_key_22222222', x'${"11".repeat(32)}', 'Key 2', '${T}');
      INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
      VALUES ('${SCALE}', 'Scale', '${KEY1}', '${T}', '${T}'),
             ('${PROBE}', 'Probe', '${KEY2}', '${T}', '${T}');
      INSERT INTO taps (id, tap_number, name, enabled, created_at, updated_at)
      VALUES ('${TAP1}', 1, 'One', 1, '${T}', '${T}'),
             ('${TAP2}', 2, 'Two', 1, '${T}', '${T}');
      INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at)
      VALUES ('${TAP1}', 'level', '${SCALE}', '${T}'),
             ('${TAP1}', 'condition', '${PROBE}', '${T2}'),
             ('${TAP2}', 'level', '${PROBE}', '${T}'),
             ('${TAP2}', 'condition', '${PROBE}', '${T}');
    `);
    before = snapshot(v28);
  } finally {
    v28.close();
  }

  const upgraded = openDatabase(path);
  try {
    assert.equal(
      upgraded.pragma<number>("user_version", { simple: true }),
      TELEMETRY_FLOW_SCHEMA_VERSION,
    );
    const after = snapshot(upgraded);
    assert.deepEqual(after.telemetry_epoch_flow_state, []);
    delete after.telemetry_epoch_flow_state;
    assert.deepEqual(after, before);
    assert.deepEqual(all(upgraded, "PRAGMA foreign_key_check"), []);

    // The new role is accepted; unknown roles still are not.
    upgraded.execute(
      `INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at) VALUES ('${TAP1}', 'flow', '${PROBE}', '${T2}')`,
    );
    assert.throws(
      () =>
        upgraded.execute(
          `INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at) VALUES ('${TAP2}', 'recorded', '${PROBE}', '${T}')`,
        ),
      /CHECK constraint failed/,
    );
    // The recreated disabled-source guard covers the flow role too.
    assert.throws(
      () =>
        upgraded.execute(
          `UPDATE telemetry_sources SET disabled_at = '${T2}' WHERE id = '${PROBE}'`,
        ),
      /telemetry sources with Tap authority cannot be disabled/,
    );
  } finally {
    upgraded.close();
  }

  // The upgraded file validates as canonical when reopened.
  openDatabase(path).close();
});

void test("flow state rows keep a pour's columns together", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
      VALUES ('${KEY1}', 'pub_key_11111111', x'${"00".repeat(32)}', 'Key 1', '${T}');
      INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
      VALUES ('${SCALE}', 'Meter', '${KEY1}', '${T}', '${T}');
    `);
    const insert = (values: string) =>
      database.execute(
        `INSERT INTO telemetry_epoch_flow_state (epoch_id, source_id, counter_ml, counter_at_epoch_ms, pour_session_id, pour_start_counter_ml, pour_started_at_epoch_ms, pour_last_flow_at_epoch_ms, updated_at) VALUES ('missing-epoch', '${SCALE}', ${values}, '${T}')`,
      );
    // A pour without its start counter, a counter below its pour's start, or a counter without
    // its time is invalid.
    assert.throws(() => insert("10, 1, 'pour', NULL, 1, 1"), /CHECK constraint failed/);
    assert.throws(() => insert("10, 1, 'pour', 20, 1, 1"), /CHECK constraint failed/);
    assert.throws(() => insert("10, NULL, NULL, NULL, NULL, NULL"), /CHECK constraint failed/);
    assert.throws(() => insert("-1, 1, NULL, NULL, NULL, NULL"), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});
