import assert from "node:assert/strict";
import test from "node:test";

import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createOutboundService, type OutboundService } from "../src/features/outbound/service.ts";
import type { OutboundDestination } from "../src/features/outbound/types.ts";
import { applyDeliveryResult, claimDue } from "../src/features/outbox/repository.ts";
import { readActivities } from "../src/features/activity/operations.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const ROOT_KEY = Buffer.alloc(32, 9).toString("base64url");
const NOW = "2026-08-17T12:00:00.000Z";
const DESTINATION = "11111111-1111-4111-8111-111111111111";
const DESTINATION_TWO = "11111111-1111-4111-8111-111111111112";
const FILL = "44444444-4444-4444-8444-444444444444";
const TAP = "55555555-5555-4555-8555-555555555555";
const ASSIGNMENT = "66666666-6666-4666-8666-666666666666";
const SECRET_SENTINEL = "SENTINEL_OUTBOUND_SECRET_MUST_NOT_ESCAPE";

function harness(): {
  readonly database: DatabaseConnection;
  readonly service: OutboundService;
  readonly secrets: ReturnType<typeof createSecretsService>;
  readonly setNow: (value: string) => void;
  readonly lifecycleCalls: string[];
} {
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, { rootKey: ROOT_KEY });
  let now = NOW;
  let sequence = 0;
  const lifecycleCalls: string[] = [];
  const service = createOutboundService(database, {
    secrets,
    now: () => new Date(now),
    idFactory: () => `22222222-2222-4222-8222-${(sequence++ + 1).toString(16).padStart(12, "0")}`,
    lifecycle: {
      onEnabled: (id) => lifecycleCalls.push(`enabled:${id}`),
      onDisabled: (id) => lifecycleCalls.push(`disabled:${id}`),
      onCredentialsChanged: (id) => lifecycleCalls.push(`credentials:${id}`),
      onRetired: (id) => lifecycleCalls.push(`retired:${id}`),
    },
  });
  return {
    database,
    service,
    secrets,
    lifecycleCalls,
    setNow: (value) => {
      now = value;
    },
  };
}

function deliveryState(database: DatabaseConnection, eventId: string): string | undefined {
  return database
    .prepare<[string], { readonly state: string }>(
      "SELECT state FROM outbound_deliveries WHERE event_id = ?",
    )
    .get(eventId)?.state;
}

function pourCompleted(eventId: string) {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: "pour.completed",
    occurred_at: NOW,
    identifiers: { tap_id: TAP, fill_id: FILL },
    data: { volume_ml: 355 },
  } as const;
}

function rowCount(database: DatabaseConnection, table: string): number {
  return database
    .prepare<[], { readonly count: number }>(`SELECT count(*) AS count FROM ${table}`)
    .get()!.count;
}

void test("destination defaults, immutable versions, safe projections, and payload format", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Discord hook",
      transport: "webhook",
      webhookUrl: "https://example.test/private-hook",
      payloadFormat: "discord",
    });
    assert.equal(created.enabled, true);
    assert.equal(created.required, false);
    assert.equal(created.subscriptions.length, 6);
    assert.equal(created.currentVersion?.versionNumber, 1);
    assert.equal(created.currentVersion?.config.transport, "webhook");
    assert.equal(
      created.currentVersion?.config.transport === "webhook" &&
        created.currentVersion.config.payloadFormat,
      "discord",
    );
    assert.equal(JSON.stringify(created).includes("private-hook"), false);
    assert.equal(JSON.stringify(created).includes("https://example.test/private-hook"), false);
    assert.equal(JSON.stringify(secrets.list()).includes("private-hook"), false);

    const edited = service.updateSettings(DESTINATION, { payloadFormat: "standard" });
    assert.equal(edited.currentVersion?.versionNumber, 2);
    assert.equal(
      edited.currentVersion?.config.transport === "webhook" &&
        edited.currentVersion.config.payloadFormat,
      "standard",
    );
    assert.equal(rowCount(database, "outbound_destination_versions"), 2);
    assert.equal(rowCount(database, "outbound_destination_configs"), 2);
    assert.equal(rowCount(database, "outbound_destination_subscriptions"), 12);

    const replacedEndpoint = "https://replacement.example.test/new-hook?token=rotated";
    const replaced = service.changeEndpoint(DESTINATION, { url: replacedEndpoint });
    assert.equal(replaced.currentVersion?.versionNumber, 3);
    assert.equal(
      secrets.revealPrivileged("outbound", replaced.currentVersion.id, "endpoint"),
      replacedEndpoint,
    );
    assert.equal(
      secrets.revealPrivileged("outbound", created.currentVersion.id, "endpoint"),
      "https://example.test/private-hook",
    );
  } finally {
    database.close();
  }
});

void test("saving unchanged settings records no new version and leaves the connection alone", () => {
  const { database, service, lifecycleCalls } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Home",
      transport: "home_assistant",
      baseUrl: "http://ha.test:8123",
      token: "token",
    });
    lifecycleCalls.length = 0;
    const before = service.get(DESTINATION)!;
    const same = service.updateSettings(DESTINATION, {
      label: "Home",
      subscriptions: [...before.subscriptions].reverse(),
    });
    assert.equal(same.currentVersion?.id, before.currentVersion?.id);
    assert.equal(same.updatedAt, before.updatedAt);
    assert.equal(rowCount(database, "outbound_destination_versions"), 1);
    assert.deepEqual(lifecycleCalls, []);

    const renamed = service.updateSettings(DESTINATION, { label: "Kitchen" });
    assert.equal(renamed.label, "Kitchen");
    assert.equal(renamed.currentVersion?.id, before.currentVersion?.id, "a label is metadata");
    const narrowed = service.updateSettings(DESTINATION, { subscriptions: ["pour.completed"] });
    assert.equal(narrowed.currentVersion?.versionNumber, 2);
    assert.deepEqual(lifecycleCalls, [`credentials:${DESTINATION}`], "only the new version");
  } finally {
    database.close();
  }
});

void test("a settings change never pauses a destination whose stored secret can't be read", () => {
  const { database, service } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Hook",
      transport: "webhook",
      webhookUrl: "https://hooks.example.test/a",
      secretHeaders: [{ name: "Authorization", value: "Bearer kept" }],
    });
    // The same database after a restart without the server key: secrets are stored but
    // unreadable, so the destination couldn't be enabled now.
    const keyless = createOutboundService(database, {
      secrets: createSecretsService(database),
      now: () => new Date(NOW),
    });
    assert.equal(
      keyless.get(DESTINATION)?.currentVersion?.config.secretHeaders[0]?.available,
      false,
    );

    const renamed = keyless.updateSettings(DESTINATION, { label: "Renamed hook" });
    assert.equal(renamed.label, "Renamed hook");
    assert.equal(renamed.enabled, true);
    assert.equal(renamed.disabledReason, null);
  } finally {
    database.close();
  }
});

void test("webhook payload options are refused for Home Assistant", () => {
  const { database, service } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Home",
      transport: "home_assistant",
      baseUrl: "http://192.168.1.35:8123",
      token: "token",
    });
    assert.throws(
      () => service.updateSettings(DESTINATION, { allowPrivateNetwork: true }),
      /allowPrivateNetwork/u,
    );
    assert.throws(
      () => service.changeEndpoint(DESTINATION, { url: "http://ha.test", token: "" }),
      ApplicationError,
    );
  } finally {
    database.close();
  }
});

void test("enabling a destination that cannot deliver is a validation error with the reason", () => {
  const { database, service } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Needs token",
      transport: "home_assistant",
      baseUrl: "http://ha.test:8123",
    });
    assert.throws(
      () => service.setEnabled(DESTINATION, true),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.category === "validation" &&
        error.clientMessage === "Home Assistant token is required before enabling",
    );
    assert.equal(service.get(DESTINATION)?.enabled, false);
  } finally {
    database.close();
  }
});

void test("malformed secret-bearing configuration fails without exposing or persisting secrets", () => {
  const { database, service, secrets } = harness();
  try {
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Invalid HA",
        transport: "home_assistant",
        baseUrl: "http://ha.test?ambiguous=1",
        token: SECRET_SENTINEL,
      }),
    );
    assert.deepEqual(service.list(), []);
    assert.equal(JSON.stringify(readActivities(database)).includes(SECRET_SENTINEL), false);
    assert.equal(JSON.stringify(secrets.list()).includes(SECRET_SENTINEL), false);

    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Plain authorization",
        transport: "webhook",
        webhookUrl: "https://example.test/hook",
        staticHeaders: [{ name: "Authorization", value: `Bearer ${SECRET_SENTINEL}` }],
      }),
    );
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Reserved slot",
        transport: "webhook",
        webhookUrl: "https://example.test/hook",
        secretHeaders: [{ name: "X-Token", slot: "token_current" }],
      }),
    );
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Divergent endpoint",
        transport: "webhook",
        webhookUrl: "https://example.test/hook",
        token: "https://different.example.test/hook",
      }),
    );
    assert.deepEqual(service.list(), []);
    assert.equal(JSON.stringify(readActivities(database)).includes(SECRET_SENTINEL), false);

    service.create({
      id: DESTINATION,
      label: "Header hook",
      transport: "webhook",
      webhookUrl: "https://example.test/hook",
      secretHeaders: [{ name: "Authorization" }],
    });
    const slot = service.get(DESTINATION)!.currentVersion!.config.secretHeaders[0]!.slot;
    assert.throws(() => service.setHeaderSecret(DESTINATION, slot, `${SECRET_SENTINEL}\n`));
    assert.equal(JSON.stringify(service.get(DESTINATION)).includes(SECRET_SENTINEL), false);
    assert.equal(JSON.stringify(readActivities(database)).includes(SECRET_SENTINEL), false);
    assert.equal(JSON.stringify(secrets.list()).includes(SECRET_SENTINEL), false);
  } finally {
    database.close();
  }
});

void test("enabled HA create connects after commit while missing-token create stays disabled", () => {
  const { database, service, lifecycleCalls } = harness();
  try {
    const configured = service.create({
      id: DESTINATION,
      label: "Configured HA",
      transport: "home_assistant",
      baseUrl: "http://ha.test:8123",
      token: "configured-token",
    });
    assert.equal(configured.enabled, true);
    assert.deepEqual(lifecycleCalls, [`enabled:${DESTINATION}`]);

    const missing = service.create({
      id: DESTINATION_TWO,
      label: "Needs token",
      transport: "home_assistant",
      baseUrl: "http://ha-two.test:8123",
      required: true,
    });
    assert.equal(missing.enabled, false);
    assert.equal(missing.disabledReason, "token_missing");
    assert.equal(missing.state, "disabled");
    assert.equal(service.connectivity().requiredDestinationIds.includes(DESTINATION_TWO), false);
    assert.deepEqual(lifecycleCalls, [`enabled:${DESTINATION}`]);
  } finally {
    database.close();
  }
});

void test("create and each reconfiguration are locally atomic", () => {
  const { database, service, secrets, lifecycleCalls } = harness();
  try {
    const oversizedHeaders = ["One", "Two", "Three", "Four"].map((suffix) => ({
      name: `X-${suffix}`,
      value: "s".repeat(1_024),
    }));
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Rolled back create",
        transport: "home_assistant",
        baseUrl: "http://ha.test:8123",
        token: "create-token",
        secretHeaders: oversizedHeaders,
      }),
    );
    for (const table of [
      "outbound_destinations",
      "outbound_destination_profiles",
      "outbound_destination_versions",
      "outbound_destination_subscriptions",
      "encrypted_secrets",
    ]) {
      assert.equal(rowCount(database, table), 0, table);
    }
    assert.equal(
      readActivities(database).some((item) => item.action === "configuration_changed"),
      false,
    );
    assert.deepEqual(lifecycleCalls, []);

    const created = service.create({
      id: DESTINATION,
      label: "Atomic HA",
      transport: "home_assistant",
      baseUrl: "http://ha.test:8123",
      token: "first-token",
      enabled: false,
      secretHeaders: [{ name: "X-Webhook-Token", slot: "webhook_token", value: "first-header" }],
    });
    const initialVersionId = created.currentVersion!.id;
    const initialVersionCount = rowCount(database, "outbound_destination_versions");
    const initialActivityCount = readActivities(database).length;
    const initialProjection = JSON.stringify(service.get(DESTINATION));

    // The new version is written before the header values, which then exceed the limit.
    assert.throws(() =>
      service.replaceHeaders(DESTINATION, { staticHeaders: [], secretHeaders: oversizedHeaders }),
    );
    assert.throws(() =>
      service.changeEndpoint(DESTINATION, {
        url: "http://replacement-ha.test:8123",
        token: "bad\ntoken",
      }),
    );
    assert.equal(service.get(DESTINATION)?.currentVersion?.id, initialVersionId);
    assert.equal(rowCount(database, "outbound_destination_versions"), initialVersionCount);
    assert.equal(JSON.stringify(service.get(DESTINATION)), initialProjection);
    assert.equal(secrets.revealPrivileged("outbound", DESTINATION, "token_current"), "first-token");
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "webhook_token"),
      "first-header",
    );
    assert.equal(readActivities(database).length, initialActivityCount);

    service.setEnabled(DESTINATION, true);
    service.setRequired(DESTINATION, true);
    service.updateSettings(DESTINATION, {
      label: "Committed HA",
      subscriptions: ["fill.assigned", "pour.completed"],
    });
    lifecycleCalls.length = 0;
    // A new origin drops the header value too, so the destination pauses until it is re-entered.
    const moved = service.changeEndpoint(DESTINATION, {
      url: "http://replacement-ha.test:8123",
      token: "rotated-token",
    });
    assert.equal(moved.enabled, false);
    assert.equal(moved.disabledReason, "secret_missing");
    assert.deepEqual(lifecycleCalls, [`disabled:${DESTINATION}`]);
    service.replaceHeaders(DESTINATION, {
      staticHeaders: [],
      secretHeaders: [{ name: "X-Webhook-Token", slot: "webhook_token", value: "rotated-header" }],
    });
    const updated = service.setEnabled(DESTINATION, true);
    assert.equal(updated.label, "Committed HA");
    assert.equal(updated.required, true);
    assert.equal(updated.enabled, true);
    assert.deepEqual(updated.subscriptions, ["fill.assigned", "pour.completed"]);
    assert.equal(updated.currentVersion?.versionNumber, 3);
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "token_current"),
      "rotated-token",
    );
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "webhook_token"),
      "rotated-header",
    );

    service.admit(database, {
      schema_version: 1,
      event_id: "33333333-3333-4333-8333-333333333399",
      event_type: "pour.completed",
      occurred_at: NOW,
      identifiers: { tap_id: TAP, fill_id: FILL },
      data: { volume_ml: 355 },
    });
    service.removeHeaderSecret(DESTINATION, "webhook_token");
    assert.equal(service.get(DESTINATION)?.enabled, false);
    service.replaceHeaders(DESTINATION, {
      staticHeaders: [],
      secretHeaders: [{ name: "X-Webhook-Token", slot: "webhook_token", value: "restored-header" }],
    });
    const repaired = service.setEnabled(DESTINATION, true);
    assert.equal(repaired.enabled, true);
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "webhook_token"),
      "restored-header",
    );
  } finally {
    database.close();
  }
});

void test("a new Home Assistant origin discards the token and queued deliveries", () => {
  const { database, service, secrets, lifecycleCalls } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Home",
      transport: "home_assistant",
      baseUrl: "http://ha.test:8123",
      token: "original-token",
    });
    service.admit(database, pourCompleted("33333333-3333-4333-8333-333333333401"));

    lifecycleCalls.length = 0;
    // Without a token for the new address, the destination pauses instead of sending.
    const moved = service.changeEndpoint(DESTINATION, { url: "http://other-ha.test:8123" });
    assert.equal(moved.enabled, false);
    assert.equal(moved.disabledReason, "token_missing");
    assert.throws(() => secrets.revealPrivileged("outbound", DESTINATION, "token_current"));
    assert.equal(deliveryState(database, "33333333-3333-4333-8333-333333333401"), "dismissed");
    assert.deepEqual(lifecycleCalls, [`disabled:${DESTINATION}`]);
    assert.throws(() => service.setEnabled(DESTINATION, true), /token is required/u);

    service.setToken(DESTINATION, "second-token");
    service.setEnabled(DESTINATION, true);
    service.admit(database, pourCompleted("33333333-3333-4333-8333-333333333404"));
    lifecycleCalls.length = 0;
    // A scheme change is an origin change too; a token that comes along keeps it enabled.
    const restored = service.changeEndpoint(DESTINATION, {
      url: "https://other-ha.test:8123",
      token: "replacement-token",
    });
    assert.equal(restored.enabled, true);
    assert.equal(deliveryState(database, "33333333-3333-4333-8333-333333333404"), "dismissed");
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "token_current"),
      "replacement-token",
    );
    assert.deepEqual(lifecycleCalls, [`credentials:${DESTINATION}`]);
  } finally {
    database.close();
  }
});

void test("a failed delivery for an old origin cannot be retried with the new origin's secrets", () => {
  const cases = [
    {
      transport: "home_assistant",
      create: (service: OutboundService) =>
        service.create({
          id: DESTINATION,
          label: "Home",
          transport: "home_assistant",
          baseUrl: "http://ha.test:8123",
          token: "original-token",
        }),
      move: (service: OutboundService) =>
        service.changeEndpoint(DESTINATION, {
          url: "http://other-ha.test:8123",
          token: "replacement-token",
        }),
    },
    {
      transport: "webhook",
      create: (service: OutboundService) =>
        service.create({
          id: DESTINATION,
          label: "Hook",
          transport: "webhook",
          webhookUrl: "https://hooks.example.test/a",
          secretHeaders: [{ name: "Authorization", value: "Bearer original" }],
        }),
      move: (service: OutboundService) => {
        service.changeEndpoint(DESTINATION, { url: "https://elsewhere.example.test/b" });
        service.replaceHeaders(DESTINATION, {
          staticHeaders: [],
          secretHeaders: [{ name: "Authorization", value: "Bearer replacement" }],
        });
        return service.setEnabled(DESTINATION, true);
      },
    },
  ] as const;
  for (const { transport, create, move } of cases) {
    const { database, service } = harness();
    try {
      create(service);
      const eventId = "33333333-3333-4333-8333-333333333403";
      service.admit(database, pourCompleted(eventId));
      // Deliver anything admitted earlier, then fail the pour delivery permanently.
      let failedDeliveryId: string | undefined;
      for (let attempt = 0; attempt < 5 && failedDeliveryId === undefined; attempt += 1) {
        const [claim] = claimDue(database, "worker", NOW, 5_000, 1);
        assert.ok(claim, transport);
        const target = claim.eventId === eventId;
        assert.equal(
          applyDeliveryResult(database, {
            deliveryId: claim.deliveryId,
            owner: "worker",
            revision: claim.revision,
            outcome: target ? "permanent" : "success",
            now: NOW,
          }),
          true,
          transport,
        );
        if (target) failedDeliveryId = claim.deliveryId;
      }
      assert.ok(failedDeliveryId, transport);
      assert.equal(deliveryState(database, eventId), "terminal", transport);

      move(service);
      assert.equal(deliveryState(database, eventId), "dismissed", transport);
      assert.equal(service.retryDelivery(DESTINATION, failedDeliveryId), false, transport);
      assert.equal(
        claimDue(database, "worker", NOW, 5_000, 10).some(
          (item) => item.deliveryId === failedDeliveryId,
        ),
        false,
        transport,
      );
    } finally {
      database.close();
    }
  }
});

void test("webhook secrets follow same-origin edits but must be re-entered for a new origin", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Hook",
      transport: "webhook",
      webhookUrl: "https://hooks.example.test/a",
      secretHeaders: [{ name: "Authorization", value: "Bearer kept" }],
    });
    const slot = created.currentVersion!.config.secretHeaders[0]!.slot;
    assert.equal(created.enabled, true);
    service.admit(database, pourCompleted("33333333-3333-4333-8333-333333333402"));

    const samePath = service.changeEndpoint(DESTINATION, { url: "https://hooks.example.test/b" });
    assert.equal(samePath.enabled, true);
    assert.equal(secrets.revealPrivileged("outbound", DESTINATION, slot), "Bearer kept");
    assert.equal(deliveryState(database, "33333333-3333-4333-8333-333333333402"), "pending");

    const elsewhere = service.changeEndpoint(DESTINATION, {
      url: "https://elsewhere.example.test/b",
    });
    assert.equal(elsewhere.enabled, false);
    assert.equal(elsewhere.disabledReason, "secret_missing");
    assert.throws(() => secrets.revealPrivileged("outbound", DESTINATION, slot));

    service.replaceHeaders(DESTINATION, {
      staticHeaders: [],
      secretHeaders: [{ name: "Authorization", value: "Bearer moved" }],
    });
    const moved = service.setEnabled(DESTINATION, true);
    assert.equal(moved.enabled, true);
    assert.equal(secrets.revealPrivileged("outbound", DESTINATION, slot), "Bearer moved");
    // Dismissed by the move, never left to resend, and kept as history for System retention.
    assert.equal(deliveryState(database, "33333333-3333-4333-8333-333333333402"), "dismissed");
  } finally {
    database.close();
  }
});

void test("HA token rotation does not fake recovery and removal disables the destination", () => {
  const { database, service, secrets } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "HA",
      transport: "home_assistant",
      baseUrl: "http://home-assistant.test",
      required: true,
      enabled: false,
    });
    service.setToken(DESTINATION, "first-token");
    service.setEnabled(DESTINATION, true);
    service.recordFailure(DESTINATION, "ha_auth_invalid", "authentication");
    service.setToken(DESTINATION, "rotated-token");
    assert.equal(service.get(DESTINATION)?.failure?.code, "ha_auth_invalid");
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "token_current"),
      "rotated-token",
    );
    service.removeToken(DESTINATION);
    const removed = service.get(DESTINATION)!;
    assert.equal(removed.enabled, false);
    assert.equal(removed.state, "disabled");
    assert.equal(
      secrets
        .list()
        .some((item) => item.recordId === DESTINATION && item.fieldName === "token_current"),
      false,
    );
  } finally {
    database.close();
  }
});

void test("optional failures remain visible while required degradation waits five minutes", () => {
  const { database, service, setNow } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Required",
      transport: "home_assistant",
      baseUrl: "http://ha.test",
      required: true,
      token: "required-token",
    });
    service.create({
      id: DESTINATION_TWO,
      label: "Optional",
      transport: "home_assistant",
      baseUrl: "http://ha2.test",
      token: "optional-token",
    });
    service.recordFailure(DESTINATION, "auth_invalid", "authentication");
    service.recordFailure(DESTINATION_TWO, "connect_timeout", "connectivity");
    assert.equal(service.get(DESTINATION)?.state, "needs_attention");
    assert.equal(service.get(DESTINATION_TWO)?.state, "failing");
    assert.equal(service.connectivity().state, "healthy");
    setNow("2026-08-17T12:05:00.000Z");
    assert.equal(service.get(DESTINATION)?.state, "degraded");
    assert.equal(service.connectivity().state, "degraded");
  } finally {
    database.close();
  }
});

void test("aggregate connectivity stays degraded until every required destination recovers", () => {
  const { database, service, setNow } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Required one",
      transport: "webhook",
      webhookUrl: "https://one.example.test/hook",
      required: true,
    });
    service.create({
      id: DESTINATION_TWO,
      label: "Required two",
      transport: "webhook",
      webhookUrl: "https://two.example.test/hook",
      required: true,
    });
    service.recordFailure(DESTINATION, "connect_timeout", "connectivity");
    service.recordFailure(DESTINATION_TWO, "webhook_http_500", "connectivity");
    setNow("2026-08-17T12:04:59.000Z");
    assert.equal(service.connectivity().state, "healthy");
    setNow("2026-08-17T12:05:00.000Z");
    assert.deepEqual(
      new Set(service.connectivity().degradedRequiredDestinationIds),
      new Set([DESTINATION, DESTINATION_TWO]),
    );
    service.recordSuccess(DESTINATION);
    assert.deepEqual(service.connectivity().degradedRequiredDestinationIds, [DESTINATION_TWO]);
    service.recordSuccess(DESTINATION_TWO);
    assert.equal(service.connectivity().state, "healthy");
  } finally {
    database.close();
  }
});

void test("retirement dismisses pending work and revokes endpoint material", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Retired hook",
      transport: "webhook",
      webhookUrl: "https://retire.example.test/hook",
    });
    service.pourCompleted(database, {
      fillId: FILL,
      tapId: TAP,
      canonicalVolumeMl: 355,
      completedAt: NOW,
    });
    const retired = service.retire(DESTINATION);
    assert.equal(retired.retiredAt, NOW);
    assert.equal(retired.enabled, false);
    assert.equal(service.listDeliveries(DESTINATION)[0]?.state, "dismissed");
    assert.equal(
      secrets
        .list()
        .some((item) => item.recordId === created.currentVersion!.id && item.configured),
      false,
    );
  } finally {
    database.close();
  }
});

void test("retired destinations are permanent read-only service history", () => {
  const { database, service } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Retired HA",
      transport: "home_assistant",
      baseUrl: "http://ha.test:8123",
      token: "ha-token",
      enabled: false,
      secretHeaders: [{ name: "X-Secret", slot: "x_secret", value: "header-token" }],
    });
    service.retire(DESTINATION);
    const versionCount = rowCount(database, "outbound_destination_versions");
    const mutationCalls: readonly (() => unknown)[] = [
      () => service.updateSettings(DESTINATION, { label: "Changed" }),
      () => service.changeEndpoint(DESTINATION, { url: "http://other-ha.test:8123" }),
      () => service.replaceHeaders(DESTINATION, { staticHeaders: [], secretHeaders: [] }),
      () => service.setRequired(DESTINATION, true),
      () => service.setEnabled(DESTINATION, true),
      () => service.setEnabled(DESTINATION, false),
      () => service.setToken(DESTINATION, "replacement"),
      () => service.removeToken(DESTINATION),
      () => service.setHeaderSecret(DESTINATION, "x_secret", "replacement"),
      () => service.removeHeaderSecret(DESTINATION, "x_secret"),
      () => service.retryDelivery(DESTINATION, "99999999-9999-4999-8999-999999999999"),
      () => service.dismissDelivery(DESTINATION, "99999999-9999-4999-8999-999999999999"),
      () => service.recordFailure(DESTINATION, "late_failure", "connectivity"),
      () => service.recordSuccess(DESTINATION),
      () => service.retire(DESTINATION),
    ];
    for (const mutate of mutationCalls) {
      assert.throws(mutate, /Retired outbound destinations are read-only/u);
    }
    assert.equal(rowCount(database, "outbound_destination_versions"), versionCount);
    assert.equal(service.get(DESTINATION)?.retiredAt, NOW);
  } finally {
    database.close();
  }
});

void test("secret header slots follow logical names and removal pauses historical delivery", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Header hook",
      transport: "webhook",
      webhookUrl: "https://example.test/hook",
      secretHeaders: [{ name: "X-First" }, { name: "X-Second" }],
    });
    const first = created.currentVersion!.config;
    assert.equal(first.transport, "webhook");
    const firstSlots = new Map(first.secretHeaders.map((header) => [header.name, header.slot]));
    const edited = service.replaceHeaders(DESTINATION, {
      staticHeaders: [],
      secretHeaders: [{ name: "X-Second" }, { name: "X-First" }],
    });
    const second = edited.currentVersion!.config;
    assert.equal(second.transport, "webhook");
    assert.equal(
      second.secretHeaders.find((header) => header.name === "X-First")?.slot,
      firstSlots.get("X-First"),
    );
    assert.equal(
      second.secretHeaders.find((header) => header.name === "X-Second")?.slot,
      firstSlots.get("X-Second"),
    );

    const firstSlot = firstSlots.get("X-First")!;
    service.setHeaderSecret(DESTINATION, firstSlot, "header-secret");
    assert.equal(JSON.stringify(service.get(DESTINATION)).includes("header-secret"), false);
    service.removeHeaderSecret(DESTINATION, firstSlot);
    assert.equal(service.get(DESTINATION)?.enabled, false);
    assert.throws(
      () => service.setEnabled(DESTINATION, true),
      /Every configured secret header requires a value/u,
    );
    assert.equal(
      secrets.list().some((item) => item.recordId === DESTINATION && item.fieldName === firstSlot),
      false,
    );
  } finally {
    database.close();
  }
});

void test("producer admission methods preserve fill-end semantics and low-keg evidence", () => {
  const { database, service } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Events",
      transport: "webhook",
      webhookUrl: "https://example.test/events",
    });
    const closed = {
      assignmentId: ASSIGNMENT,
      tapId: TAP,
      fillId: FILL,
      occurredAt: NOW,
      reason: "unassigned" as const,
    };
    assert.deepEqual(service.assignmentClosed(database, closed), { status: "no_targets" });
    assert.equal(rowCount(database, "outbound_events"), 0);
    assert.equal(service.assignmentClosed(database, closed, "manual").status, "queued");
    assert.equal(
      service.healthTransitioned(database, {
        tapId: TAP,
        checkId: "low_keg",
        previousState: "healthy",
        previousSeverity: "none",
        current: {
          state: "degraded",
          severity: "warning",
          evidence: { remaining_percent: 12, threshold_percent: 20 },
        },
        occurredAt: NOW,
      }).status,
      "queued",
    );
    assert.equal(rowCount(database, "outbound_events"), 3);
    const eventRows = database
      .prepare<[], { readonly event_type: string }>(
        "SELECT event_type FROM outbound_events ORDER BY created_at, id",
      )
      .all();
    assert.deepEqual(eventRows.map((row) => row.event_type).sort(), [
      "fill.ended",
      "health.transitioned",
      "keg.low",
    ]);
    assert.equal(
      service.integrationStatusChanged(database, {
        integrationType: "home_assistant",
        state: "degraded",
        occurredAt: NOW,
        coalescingKey: "ha",
      }).status,
      "queued",
    );
    assert.equal(rowCount(database, "outbound_events"), 4);
  } finally {
    database.close();
  }
});

void test("private-network opt-in is stored per webhook version, defaults off, and is refused for Home Assistant", () => {
  const { database, service } = harness();
  const allowPrivate = (value: OutboundDestination): boolean | undefined =>
    value.currentVersion?.config.transport === "webhook"
      ? value.currentVersion.config.allowPrivateNetwork
      : undefined;
  const storedConfig = (): Record<string, unknown> =>
    JSON.parse(
      database
        .prepare<[], { readonly config_json: string }>(
          "SELECT config_json FROM outbound_destination_configs ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get()!.config_json,
    ) as Record<string, unknown>;
  try {
    const created = service.create({
      id: DESTINATION,
      label: "LAN n8n",
      transport: "webhook",
      webhookUrl: "http://n8n.lan:5678/webhook/tapboard",
    });
    assert.equal(allowPrivate(created), false);
    assert.equal("allowPrivateNetwork" in storedConfig(), false);

    const opted = service.updateSettings(DESTINATION, { allowPrivateNetwork: true });
    assert.equal(opted.currentVersion?.versionNumber, 2);
    assert.equal(allowPrivate(opted), true);
    assert.equal(storedConfig().allowPrivateNetwork, true);
    assert.equal(opted.enabled, true, "the option does not move the origin");

    const relabelled = service.updateSettings(DESTINATION, { label: "LAN n8n (renamed)" });
    assert.equal(allowPrivate(relabelled), true);
    const kept = service.changeEndpoint(DESTINATION, {
      url: "http://n8n.lan:5678/webhook/other",
    });
    assert.equal(allowPrivate(kept), true, "an endpoint edit keeps the option");

    const off = service.updateSettings(DESTINATION, { allowPrivateNetwork: false });
    assert.equal(allowPrivate(off), false);

    assert.throws(
      () =>
        service.create({
          id: DESTINATION_TWO,
          label: "HA",
          transport: "home_assistant",
          baseUrl: "http://192.168.1.35:8123",
          allowPrivateNetwork: true,
        }),
      /allowPrivateNetwork/u,
    );
  } finally {
    database.close();
  }
});
