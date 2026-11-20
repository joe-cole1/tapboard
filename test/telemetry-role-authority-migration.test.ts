import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import {
  MIGRATIONS,
  TELEMETRY_ROLE_AUTHORITY_SCHEMA_VERSION,
} from "../src/infrastructure/database/migrations.ts";

const T = "2026-11-19T10:00:00.000Z";
const T2 = "2026-11-19T11:00:00.000Z";
const KEY1 = "k1111111-1111-4111-8111-111111111111";
const KEY2 = "k2222222-2222-4222-8222-222222222222";
const SCALE = "s1111111-1111-4111-8111-111111111111";
const PROBE = "s2222222-2222-4222-8222-222222222222";
const TAP1 = "t1111111-1111-4111-8111-111111111111";
const TAP2 = "t2222222-2222-4222-8222-222222222222";
const TAP3 = "t3333333-3333-4333-8333-333333333333";

function databasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-role-authority-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tapboard.sqlite3");
}

function seedV27(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
    VALUES ('${KEY1}', 'pub_key_11111111', x'${"00".repeat(32)}', 'Key 1', '${T}'),
           ('${KEY2}', 'pub_key_22222222', x'${"11".repeat(32)}', 'Key 2', '${T}');
    INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
    VALUES ('${SCALE}', 'Scale', '${KEY1}', '${T}', '${T}'),
           ('${PROBE}', 'Probe', '${KEY2}', '${T}', '${T}');
    INSERT INTO taps (id, tap_number, name, enabled, created_at, updated_at)
    VALUES ('${TAP1}', 1, 'One', 1, '${T}', '${T}'),
           ('${TAP2}', 2, 'Two', 1, '${T}', '${T}'),
           ('${TAP3}', 3, 'Three', 1, '${T}', '${T}');
    INSERT INTO tap_telemetry_authority (tap_id, source_id, changed_at)
    VALUES ('${TAP1}', '${SCALE}', '${T}'), ('${TAP2}', '${PROBE}', '${T2}');
  `);
}

const all = (database: DatabaseExecutor, sql: string) => database.prepare(sql).all();

void test("v27 Tap authority upgrades to the same source for both roles", (context) => {
  const path = databasePath(context);
  const v27 = openDatabase(path, {
    migrations: MIGRATIONS.slice(0, TELEMETRY_ROLE_AUTHORITY_SCHEMA_VERSION - 1),
  });
  try {
    seedV27(v27);
  } finally {
    v27.close();
  }

  // Pinned to v28: later migrations add roles (v29 adds `flow`).
  const v28 = { migrations: MIGRATIONS.slice(0, TELEMETRY_ROLE_AUTHORITY_SCHEMA_VERSION) };
  const upgraded = openDatabase(path, v28);
  try {
    assert.equal(
      upgraded.pragma<number>("user_version", { simple: true }),
      TELEMETRY_ROLE_AUTHORITY_SCHEMA_VERSION,
    );
    // Every existing authority keeps its source and changed_at for both roles; a Tap without
    // authority stays without.
    assert.deepEqual(
      all(
        upgraded,
        "SELECT tap_id, role, source_id, changed_at FROM tap_telemetry_authority ORDER BY tap_id, role",
      ),
      [
        { tap_id: TAP1, role: "condition", source_id: SCALE, changed_at: T },
        { tap_id: TAP1, role: "level", source_id: SCALE, changed_at: T },
        { tap_id: TAP2, role: "condition", source_id: PROBE, changed_at: T2 },
        { tap_id: TAP2, role: "level", source_id: PROBE, changed_at: T2 },
      ],
    );
    assert.deepEqual(all(upgraded, "PRAGMA foreign_key_check"), []);

    // Roles are split per Tap: one source per role, and only the known roles.
    upgraded.execute(
      `UPDATE tap_telemetry_authority SET source_id = '${PROBE}' WHERE tap_id = '${TAP1}' AND role = 'condition'`,
    );
    assert.throws(
      () =>
        upgraded.execute(
          `INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at) VALUES ('${TAP1}', 'level', '${PROBE}', '${T}')`,
        ),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        upgraded.execute(
          `INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at) VALUES ('${TAP3}', 'flow', '${PROBE}', '${T}')`,
        ),
      /CHECK constraint failed/,
    );

    // The recreated disabled-source guards still protect the rebuilt table.
    assert.throws(
      () =>
        upgraded.execute(
          `UPDATE telemetry_sources SET disabled_at = '${T2}' WHERE id = '${PROBE}'`,
        ),
      /telemetry sources with Tap authority cannot be disabled/,
    );
    upgraded.execute(`DELETE FROM tap_telemetry_authority WHERE source_id = '${PROBE}'`);
    upgraded.execute(`UPDATE telemetry_sources SET disabled_at = '${T2}' WHERE id = '${PROBE}'`);
    assert.throws(
      () =>
        upgraded.execute(
          `INSERT INTO tap_telemetry_authority (tap_id, role, source_id, changed_at) VALUES ('${TAP3}', 'condition', '${PROBE}', '${T}')`,
        ),
      /disabled telemetry sources cannot be Tap authority/,
    );
    assert.throws(
      () =>
        upgraded.execute(
          `UPDATE tap_telemetry_authority SET source_id = '${PROBE}' WHERE tap_id = '${TAP1}' AND role = 'level'`,
        ),
      /disabled telemetry sources cannot be Tap authority/,
    );

    // Deleting an unused Tap cascades to its authority.
    upgraded.execute(`DELETE FROM taps WHERE id = '${TAP1}'`);
    assert.deepEqual(all(upgraded, "SELECT tap_id FROM tap_telemetry_authority"), []);
  } finally {
    upgraded.close();
  }

  // The upgraded file validates as canonical when reopened.
  openDatabase(path, v28).close();
});

void test("a v28 database with the old single-source authority table is rejected", (context) => {
  const path = databasePath(context);
  const database = openDatabase(path);
  database.execute(`
    DROP TRIGGER trg_telemetry_sources_no_disable_with_authority;
    DROP TABLE tap_telemetry_authority;
    CREATE TABLE tap_telemetry_authority (
      tap_id TEXT PRIMARY KEY REFERENCES taps(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES telemetry_sources(id) ON DELETE RESTRICT,
      changed_at TEXT NOT NULL
    );
  `);
  database.close();
  assert.throws(() => openDatabase(path), /Incompatible SQLite schema/);
});
