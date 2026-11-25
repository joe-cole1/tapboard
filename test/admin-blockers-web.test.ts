import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import {
  deletionImpactSentence,
  tapDeletionBlockers,
  telemetryDisableBlockers,
} from "../src/features/web/admin/blockers.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { adminApp } from "./fixtures/admin-app.ts";

function seed(database: DatabaseConnection) {
  const beverages = createBeverageService(database);
  const kegs = createKegService(database);
  const fills = createFillService(database);
  const taps = createTapService(database);
  const telemetry = new TelemetryService({
    database,
    machineKeyService: createMachineKeyService(database),
  });
  let kegNumber = 0;
  const fill = (name: string) => {
    const beverage = beverages.createCustomBeverage({ name });
    const keg = kegs.createKeg({ kegNumber: ++kegNumber, capacityMl: 19000 });
    return fills.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  };
  return { beverages, kegs, taps, telemetry, fill };
}

/** The `<section>` whose heading has this id, or "" when the page has none. */
function section(html: string, headingId: string): string {
  return (
    new RegExp(`<section[^>]*aria-labelledby="${headingId}"[\\s\\S]*?</section>`, "u").exec(
      html,
    )?.[0] ?? ""
  );
}

/** Each blocker line as `{ text, href }`; every line must end in a link. */
function blockers(html: string): { text: string; href: string }[] {
  const list = /<ul class="blocker-list">([\s\S]*?)<\/ul>/u.exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map(([, item]) => {
    const link = /<a href="([^"]+)">/u.exec(item!);
    assert.ok(link, `blocker without a link: ${item}`);
    return {
      text: item!
        .replace(/<[^>]+>/gu, "")
        .replaceAll("&#39;", "'")
        .trim(),
      href: link[1]!,
    };
  });
}

void test("blocker lines put the permanent reason first and always name the way forward", () => {
  const links = { assignment: "#assignment", lifecycle: "#lifecycle", history: "/history" };
  const facts = {
    canDelete: true,
    firstUsedAt: null,
    retiredAt: null,
    activeAssignmentCount: 0,
    historicalAssignmentCount: 0,
  };
  assert.deepEqual(tapDeletionBlockers("Tap 1", facts, links), []);
  // A refusal the four facts don't explain still blocks the form, with the way forward.
  assert.deepEqual(tapDeletionBlockers("Tap 1", { ...facts, canDelete: false }, links), [
    { text: "Tap 1 can't be deleted.", linkLabel: "Retire it instead", href: "#lifecycle" },
  ]);
  assert.deepEqual(
    tapDeletionBlockers(
      "Tap 1",
      { ...facts, canDelete: false, firstUsedAt: "2026-01-01T00:00:00.000Z" },
      links,
    ),
    [
      {
        text: "Tap 1 has served beer, so it can't be deleted.",
        linkLabel: "Retire it instead",
        href: "#lifecycle",
      },
    ],
  );
  // An active fill also blocks retiring, so the alternative starts at Assignment.
  const served = {
    ...facts,
    canDelete: false,
    firstUsedAt: "2026-01-01T00:00:00.000Z",
    activeAssignmentCount: 1,
  };
  assert.equal(tapDeletionBlockers("Tap 1", served, links)[0]?.href, "#assignment");
  assert.equal(tapDeletionBlockers("Tap 1", served, links).length, 1);
  assert.equal(
    tapDeletionBlockers("Tap 1", { ...served, retiredAt: "2026-02-01T00:00:00.000Z" }, links)[0]
      ?.href,
    "/history",
  );
  assert.deepEqual(
    telemetryDisableBlockers([{ tapNumber: 2, sensorsHref: "/admin/taps/t/sensors" }]),
    [
      {
        text: "Tap 2 uses this source, so it can't be disabled.",
        linkLabel: "Change Tap 2's sensors",
        href: "/admin/taps/t/sensors",
      },
    ],
  );

  assert.equal(
    deletionImpactSentence(
      [
        { code: "beverages", count: 1 },
        { code: "fills", count: 2 },
        { code: "custom_recipes", count: 1 },
        { code: "beverage_sensory_overrides", count: 0 },
      ],
      "beverages",
    ),
    "This also deletes 2 Filled Kegs and their pours and 1 custom recipe.",
  );
  assert.equal(
    deletionImpactSentence(
      [
        { code: "kegs", count: 1 },
        { code: "keg_tare_history", count: 1 },
        { code: "keg_maintenance_records", count: 3 },
        { code: "fills", count: 1 },
      ],
      "kegs",
    ),
    "This also deletes 1 tare correction, 3 maintenance records and 1 Filled Keg and its pours.",
  );
  assert.equal(
    deletionImpactSentence([{ code: "kegs", count: 1 }], "kegs"),
    "Nothing else is deleted with it.",
  );
});

void test("Tap deletion and retiring show a linked blocker or the inline copy-then-type form", async (context) => {
  const database = openDatabase(":memory:");
  const { taps, fill } = seed(database);
  const spare = taps.createTap({ tapNumber: 1, name: "Spare" });
  const used = taps.createTap({ tapNumber: 2 });
  const onTap = fill("Blocker Pale");
  taps.assignFill(used.id, { fillId: onTap.id });
  const admin = await adminApp(context, database);

  const spareHtml = await admin.get(`/admin/taps/${spare.id}/identity`);
  assert.deepEqual(blockers(spareHtml), []);
  const spareDelete = section(spareHtml, "tap-delete-heading");
  assert.match(
    spareDelete,
    /<label for="tap-delete-[^"]+-confirmation">Type "<span [^>]*>Tap 1 — Spare<\/span>"<span class="sr-only"> to confirm<\/span><\/label>/u,
  );
  assert.match(
    spareDelete,
    /<button [^>]*data-copy-target="[^"]+"[^>]*aria-label="Copy Tap 1 — Spare"[^>]*hidden>/u,
  );
  assert.match(spareDelete, /action="\/admin\/taps\/[^"]+\/delete"/u);
  assert.doesNotMatch(spareDelete, /readonly/u);
  assert.match(section(spareHtml, "lifecycle-heading"), /<summary>Retire Tap<\/summary>/u);

  // A Filled Keg on tap blocks retiring (fixable: Assignment) and deleting (permanent: it has
  // served, so the alternative is retiring once the keg is off).
  const usedHtml = await admin.get(`/admin/taps/${used.id}/identity`);
  assert.match(
    section(usedHtml, "assignment-heading"),
    new RegExp(
      `<a class="button[^"]*" href="/admin/keg-room/fills/${onTap.id}">Open Filled Keg</a>`,
      "u",
    ),
  );
  assert.deepEqual(blockers(section(usedHtml, "lifecycle-heading")), [
    {
      text: "Tap 2 has a Filled Keg on it, so it can't be retired yet. Take it off in Assignment →",
      href: "#assignment",
    },
  ]);
  const usedDelete = section(usedHtml, "tap-delete-heading");
  assert.equal(blockers(usedDelete)[0]?.href, "#assignment");
  assert.match(blockers(usedDelete)[0]!.text, /^Tap 2 has served beer, so it can't be deleted\./u);
  assert.doesNotMatch(usedDelete, /<form/u);
  assert.match(usedHtml, /<section id="assignment" /u);

  taps.unassign(used.id);
  const offHtml = await admin.get(`/admin/taps/${used.id}/identity`);
  assert.deepEqual(blockers(section(offHtml, "tap-delete-heading")), [
    {
      text: "Tap 2 has served beer, so it can't be deleted. Retire it instead →",
      href: "#lifecycle",
    },
  ]);
  assert.match(offHtml, /<section id="lifecycle" /u);

  taps.retireTap(used.id, {});
  const retiredHtml = await admin.get(`/admin/taps/${used.id}/identity`);
  assert.equal(
    blockers(section(retiredHtml, "tap-delete-heading"))[0]?.href,
    `/admin/taps/${used.id}/history`,
  );
});

void test("Filled Keg, Keg and Beverage deletion say what else goes, in plain sentences", async (context) => {
  const database = openDatabase(":memory:");
  const { fill } = seed(database);
  const active = fill("Sentence Stout");
  const admin = await adminApp(context, database);

  const activeHtml = await admin.get(`/admin/keg-room/fills/${active.id}`);
  const activeDelete = section(activeHtml, "delete-filled-keg");
  assert.deepEqual(blockers(activeDelete), [
    {
      text: "This Filled Keg is still in use, so it can't be deleted. Kick it first →",
      href: "#filled-keg-lifecycle",
    },
  ]);
  assert.doesNotMatch(activeDelete, /<form/u);

  const beverageHtml = await admin.get(`/admin/beverages/${active.beverageId}/delete`);
  const beverageDelete = section(beverageHtml, "delete-heading");
  assert.match(beverageDelete, /This also deletes 1 Filled Keg and its pours\./u);
  assert.doesNotMatch(beverageDelete, /fills: 1|beverages: 1/u);
  assert.match(beverageDelete, /class="confirm-prompt__value">Sentence Stout</u);
  assert.match(beverageDelete, /name="confirmationName"/u);

  const kegHtml = await admin.get(`/admin/keg-room/kegs/${active.kegId}`);
  assert.match(section(kegHtml, "delete-keg"), /This also deletes .*1 Filled Keg and its pours\./u);
  assert.doesNotMatch(kegHtml, /keg_tare_history/u);
  assert.match(
    section(kegHtml, "keg-fill-history"),
    /<a class="button[^"]*" href="\/admin\/keg-room">Keg Room<\/a>/u,
  );
  assert.match(
    section(await admin.get(`/admin/beverages/${active.beverageId}/usage`), "fill-heading"),
    /<a class="button[^"]*" href="\/admin\/keg-room">Keg Room<\/a>/u,
  );

  await admin.post(`/admin/fills/${active.id}/kick`, { confirmKick: "true" });
  const endedDelete = section(
    await admin.get(`/admin/keg-room/fills/${active.id}`),
    "delete-filled-keg",
  );
  assert.deepEqual(blockers(endedDelete), []);
  assert.match(endedDelete, /<summary>Delete Filled Keg permanently<\/summary>/u);
  assert.match(endedDelete, /class="confirm-prompt__value">Sentence Stout — Keg 1</u);
});

void test("Telemetry adds sources on their own page and blocks disabling a source a Tap uses", async (context) => {
  const database = openDatabase(":memory:");
  const { taps, telemetry } = seed(database);
  const tap = taps.createTap({ tapNumber: 3 });
  const assigned = telemetry.createSource({ name: "Assigned scale" }).source;
  const spare = telemetry.createSource({ name: "Spare scale" }).source;
  telemetry.setTapAuthority(tap.id, {
    levelSourceId: assigned.id,
    conditionSourceId: assigned.id,
    flowSourceId: null,
  });
  const admin = await adminApp(context, database);

  const listHtml = await admin.get("/admin/integrations/telemetry");
  assert.match(listHtml, /href="\/admin\/integrations\/telemetry\/new">Add source<\/a>/u);
  assert.doesNotMatch(listHtml, /telemetry-sources\/create|Key label|name="label"/u);

  const newHtml = await admin.get("/admin/integrations/telemetry/new");
  const form =
    /<form[^>]*action="\/admin\/integrations\/telemetry-sources\/create"[\s\S]*?<\/form>/u.exec(
      newHtml,
    )?.[0];
  assert.ok(form);
  assert.deepEqual(
    [...form.matchAll(/name="([^"]+)"/gu)].map(([, name]) => name),
    ["_csrf", "name"],
  );
  assert.match(newHtml, /href="\/admin\/integrations\/telemetry">Telemetry<\/a>/u);

  const assignedHtml = await admin.get(`/admin/integrations/telemetry-sources/${assigned.id}`);
  assert.deepEqual(blockers(section(assignedHtml, "source-disable-heading")), [
    {
      text: "Tap 3 uses this source, so it can't be disabled. Change Tap 3's sensors →",
      href: `/admin/taps/${tap.id}/sensors`,
    },
  ]);
  assert.doesNotMatch(assignedHtml, /\/disable"|Key label|name="label"/u);
  assert.match(assignedHtml, /\/rotate"/u);

  const spareHtml = await admin.get(`/admin/integrations/telemetry-sources/${spare.id}`);
  assert.deepEqual(blockers(spareHtml), []);
  assert.match(section(spareHtml, "source-disable-heading"), /<summary>Disable source<\/summary>/u);
  assert.match(
    spareHtml,
    new RegExp(`action="/admin/integrations/telemetry-sources/${spare.id}/disable"`, "u"),
  );
});
