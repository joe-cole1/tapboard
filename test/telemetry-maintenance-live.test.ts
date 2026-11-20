import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createApplication } from "../src/application.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import type { Router } from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";

class CapturedResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    Object.assign(this.headers, headers);
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk);
  }
  destroy(): void {}
}

void test("a flow pour closed by maintenance refreshes the display and health with no further telemetry", async (context) => {
  const database = openDatabase(":memory:");
  const detector = new DetectorService(database);
  const taps = createTapService(database, { extensionPort: detector });
  const beverage = createBeverageService(database).createCustomBeverage({ name: "Flow Ale" });
  const keg = createKegService(database).createKeg({ kegNumber: 1, capacityMl: 1_000 });
  const fill = createFillService(database, {
    assignmentPort: taps.asFillAssignmentPort(),
  }).createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const telemetry = new TelemetryService({
    database,
    machineKeyService: createMachineKeyService(database),
    authorityExtensionPort: detector,
    acceptedExtensionPort: detector,
  });
  const tap = taps.createTap({ tapNumber: 1 });
  const meter = telemetry.createSource({ name: "meter" });
  telemetry.setTapAuthority(tap.id, {
    levelSourceId: null,
    conditionSourceId: null,
    flowSourceId: meter.source.id,
  });
  // A flow pour closes 100 ms after its last increase.
  detector.setTapOverride(tap.id, { ...DEFAULT_DETECTOR_CONFIG, quietPeriodMs: 100 });
  taps.assignFill(tap.id, { fillId: fill.id });

  let router: Pick<Router, "handle"> | undefined;
  const application = createApplication({
    config: {
      host: "127.0.0.1",
      port: 0,
      databasePath: ":memory:",
      shutdownGraceMs: 100,
      canonicalExternalOrigin: "http://127.0.0.1:3000",
    },
    logger: createLogger({ sink: () => undefined }),
    openDatabase: () => database,
    createHttpServer: (options) => {
      router = options.router;
      return {
        start: () => Promise.resolve({ address: "127.0.0.1", family: "IPv4", port: 0 }),
        stop: () => Promise.resolve(),
      };
    },
  });
  context.after(() => application.stop());
  await application.start();
  assert.ok(router);
  const route = router;
  async function request(path: string, body?: object): Promise<CapturedResponse> {
    const input = Object.assign(
      Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
      {
        method: body === undefined ? "GET" : "POST",
        url: path,
        headers: {
          authorization: `Bearer ${meter.initialToken}`,
          "content-type": "application/json",
        },
      },
    );
    const response = new CapturedResponse();
    await route.handle(input as IncomingMessage, response as unknown as ServerResponse);
    return response;
  }
  async function dispensed(id: string, counterMl: number): Promise<void> {
    const response = await request("/api/v1/telemetry/taps/1", {
      client_sample_id: id,
      measured_at: new Date().toISOString(),
      readings: [{ metric: "dispensed_volume", value: counterMl, unit: "ml" }],
    });
    assert.equal(response.status, 200, response.chunks.join(""));
  }
  const lowKeg = database.prepare<[string], { state: string; reason_code: string | null }>(
    "SELECT state, reason_code FROM health_check_state WHERE tap_id = ? AND check_id = 'low_keg'",
  );

  const events = await request("/api/public/events");
  await dispensed("baseline", 0);
  await delay(20);
  await dispensed("pour", 850);
  assert.equal(lowKeg.get(tap.id)?.state, "healthy");
  events.chunks.length = 0;

  // No more telemetry: a maintenance tick (every 200 ms) closes the pour after the quiet period.
  // Wait for it with a generous deadline so a slow machine does not fail the test.
  for (let waited = 0; events.chunks.length < 2 && waited < 5_000; waited += 50) await delay(50);
  const tapEvent = `data: {"tapId":"${tap.id}"}\n\n`;
  assert.deepEqual(events.chunks, [
    `event: telemetry.updated\n${tapEvent}`,
    `event: health.updated\n${tapEvent}`,
  ]);
  assert.equal(database.prepare<[], { n: number }>("SELECT count(*) AS n FROM pours").get()!.n, 1);
  // 150 ml of 1000 ml is below the 20% low-keg threshold, now settling before it opens.
  assert.deepEqual(lowKeg.get(tap.id), { state: "degraded", reason_code: "threshold_settling" });
  const card = await request(`/api/public/dashboard/taps/${tap.id}`);
  assert.equal(card.status, 200);
  assert.equal(
    (JSON.parse(card.chunks.join("")) as { remainingVolumeMl: number | null }).remainingVolumeMl,
    150,
  );
});
