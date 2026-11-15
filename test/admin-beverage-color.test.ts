import assert from "node:assert/strict";
import test from "node:test";

import type { DashboardService } from "../src/features/dashboard/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/index.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { displayColorForSrm, SAFE_DISPLAY_COLOR } from "../src/features/story/vessels.ts";
import {
  adminBeverageDetailDto,
  adminBeverageListItem,
} from "../src/features/web/admin/beverage-presentation.ts";
import { safeFillCard } from "../src/features/web/admin/keg-room.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";

const ROOT_KEY = Buffer.alloc(32, 1).toString("base64url");
const unusedDashboard = {} as DashboardService;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function setup() {
  const database = openDatabase(":memory:");
  const secretsService = createSecretsService(database, { rootKey: ROOT_KEY });
  const beverageService = createBeverageService(database, { secretsService });
  const kegService = createKegService(database);
  const fillService = createFillService(database, { beverageService });
  const srmBeer = beverageService.createCustomBeverage({
    id: uuid(1),
    name: "SRM Stout",
    beverageType: "beer",
    srm: 40,
  });
  const explicitBeer = beverageService.createCustomBeverage({
    id: uuid(2),
    name: "Painted Pale",
    beverageType: "beer",
    srm: 40,
    displayColor: "#123456",
  });
  const cider = beverageService.createCustomBeverage({
    id: uuid(3),
    name: "Orchard Cider",
    beverageType: "cider",
    srm: 40,
  });
  for (const [index, beverage] of [srmBeer, explicitBeer, cider].entries()) {
    const keg = kegService.createKeg({
      id: uuid(10 + index),
      kegNumber: index + 1,
      capacityMl: 19_000,
    });
    fillService.createFill({
      id: uuid(20 + index),
      beverageId: beverage.beverage.id,
      kegId: keg.id,
      fillDate: "2026-11-01",
    });
  }
  return { beverageService, fillService };
}

const SRM_40 = displayColorForSrm(40);

void test("SRM 40 has a palette colour distinct from the safe default", () => {
  assert.ok(SRM_40);
  assert.notEqual(SRM_40, SAFE_DISPLAY_COLOR);
});

void test("Beverages list and detail use a beer's SRM colour unless an explicit colour is set", () => {
  const { beverageService } = setup();
  const colors = new Map(
    beverageService
      .listBeveragePage({})
      .items.map((item) => [
        item.effectivePresentation.name,
        adminBeverageListItem(item).displayColor,
      ]),
  );
  assert.equal(colors.get("SRM Stout"), SRM_40);
  assert.equal(colors.get("Painted Pale"), "#123456");
  assert.equal(colors.get("Orchard Cider"), SAFE_DISPLAY_COLOR);

  const detail = adminBeverageDetailDto(
    beverageService.getBeverage(uuid(1)),
    { current: 0, total: 0 },
    [],
    null,
  );
  assert.equal(detail["resolvedColor"], SRM_40);
  // The edit form still shows only the stored explicit colour.
  assert.equal(detail["displayColor"], null);
});

void test("Keg Room cards use a beer's SRM colour in every fill state", () => {
  const { fillService } = setup();
  fillService.markOnDeck(uuid(21));
  const byName = (items: readonly Parameters<typeof safeFillCard>[0][]) =>
    new Map(items.map((fill) => [fill.beverageName, safeFillCard(fill, unusedDashboard, [])]));

  // The paged Keg Room projection (SQL) and the single-fill view (service) both carry SRM.
  const page = byName(fillService.listAdminPage({ state: "active", sort: "keg" }).items);
  assert.equal(page.get("SRM Stout")?.["displayColor"], SRM_40);
  assert.equal(page.get("Painted Pale")?.["displayColor"], "#123456");
  assert.equal(page.get("Orchard Cider")?.["displayColor"], SAFE_DISPLAY_COLOR);

  const single = safeFillCard(fillService.getFill(uuid(20)), unusedDashboard, []);
  assert.equal(single["displayColor"], SRM_40);
});
