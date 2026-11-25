import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { adminApp } from "./fixtures/admin-app.ts";

function services(database: DatabaseConnection) {
  return {
    beverages: createBeverageService(database),
    kegs: createKegService(database),
    fills: createFillService(database),
  };
}

/** A Brewfather-linked Beverage from a cached candidate; no API key, so nothing syncs. */
function linkedBeverage(database: DatabaseConnection) {
  const beverages = createBeverageService(database);
  beverages.configureBrewfatherAccount({ userId: "linked-user" });
  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, status, raw_summary_json,
        summary_fingerprint, synced_at)
       VALUES (?, 'default', ?, ?, 'Completed', ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      "linked-batch",
      "Linked Lager",
      '{"beverageType":"beer"}',
      "l".repeat(64),
      "2026-11-01T00:00:00.000Z",
    );
  return beverages.linkBrewfatherCandidate({ sourceBatchId: "linked-batch" });
}

/** The `<section>` whose heading has this id, or "" when the page has none. */
function section(html: string, headingId: string): string {
  return (
    new RegExp(`<section[^>]*aria-labelledby="${headingId}"[\\s\\S]*?</section>`, "u").exec(
      html,
    )?.[0] ?? ""
  );
}

void test("the Beverage page is six link tabs, and each form returns to its own tab", async (context) => {
  const database = openDatabase(":memory:");
  const { beverages, kegs } = services(database);
  const beer = beverages.createCustomBeverage({ name: "Tabbed Pale", srm: 4 });
  kegs.createKeg({ kegNumber: 1, capacityMl: 19_000 });
  const admin = await adminApp(context, database);
  const id = beer.beverage.id;
  const base = `/admin/beverages/${id}`;

  const tabs = [
    ["", "Info"],
    ["/presentation", "Presentation"],
    ["/usage", "Current usage"],
    ["/recipe", "Recipe"],
    ["/sensory", "Sensory"],
    ["/delete", "Delete"],
  ] as const;
  for (const [path, label] of tabs) {
    const html = await admin.get(`${base}${path}`);
    assert.match(html, new RegExp(`href="${base}${path}" aria-current="page">${label}<`, "u"));
    // Sub-tabs put the Beverage in the breadcrumb, linked to its first tab.
    if (path !== "")
      assert.match(html, new RegExp(`<a href="${base}">Tabbed Pale</a>`, "u"), label);
  }

  // Presentation is open, never collapsed, and holds the colour picker.
  const presentation = await admin.get(`${base}/presentation`);
  assert.doesNotMatch(presentation, /class="disclosure"/u);
  assert.match(presentation, /name="description"/u);
  assert.match(presentation, /type="radio" name="srm" value="4" checked/u);
  assert.match(presentation, /data-colour-source[^>]*>Matches SRM</u);
  assert.match(presentation, /data-colour-reset hidden/u);
  // Info holds identity; SRM, glass and description moved to Presentation.
  const info = await admin.get(base);
  assert.match(info, /name="abv"/u);
  assert.doesNotMatch(info, /name="srm"|name="description"/u);

  const back = (location: string, tab: string) =>
    assert.match(location, new RegExp(`^${base}${tab}\\?(notice|error)=`, "u"), tab);
  back(await admin.post(`${base}/update`, { name: "Tabbed Pale", abv: "5.1" }), "");
  back(await admin.post(`${base}/update`, { description: "Hazy." }), "/presentation");
  back(await admin.post(`${base}/update`, { srm: "exact", srmExact: "7.5" }), "/presentation");
  back(await admin.post(`${base}/update`, { displayColor: "" }), "/presentation");
  back(await admin.post(`${base}/sensory`, { malt: "4" }), "/sensory");
  back(await admin.post(`${base}/recipe`, { recipeJson: "" }), "/recipe");
  back(await admin.post(`${base}/create-fill`, { kegId: "" }), "/usage");
  // A refused deletion stays on Delete; a deletion goes back to the list.
  back(await admin.post(`${base}/delete`, { confirmationName: "Wrong" }), "/delete");
  assert.match(
    await admin.post(`${base}/delete`, { confirmationName: "Tabbed Pale" }),
    /^\/admin\/beverages\?notice=/u,
  );

  // Unlinking a Brewfather beverage returns to its Info tab.
  const linked = linkedBeverage(database);
  assert.match(
    await admin.post(`/admin/beverages/${linked.beverage.id}/unlink`, {}),
    new RegExp(`^/admin/beverages/${linked.beverage.id}\\?notice=`, "u"),
  );
});

void test("Beverage settings save live: identity, the colour picker, sensory and the recipe", async (context) => {
  const database = openDatabase(":memory:");
  const { beverages } = services(database);
  const beer = beverages.createCustomBeverage({
    name: "Live Amber",
    srm: 12,
    fillGlass: "tulip_glass",
    description: "Kept",
  });
  const admin = await adminApp(context, database);
  const id = beer.beverage.id;
  const path = (action: string) => `/admin/beverages/${id}/${action}`;
  const revision = () => beverages.getBeverage(id).beverage.updatedAt;
  const effective = () => beverages.getBeverage(id).effectivePresentation;

  // Info saves its own fields; the rest of the Beverage stays as it is.
  const identity = await admin.autosave(path("update"), {
    updatedAt: revision(),
    name: "Live Amber Ale",
    abv: "5.6",
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.body.revision, revision());
  assert.equal(effective().name, "Live Amber Ale");
  assert.equal(effective().srm, 12);
  assert.equal(effective().description, "Kept");
  // A value the service rejects comes back against its field.
  const invalid = await admin.autosave(path("update"), { updatedAt: revision(), abv: "500" });
  assert.equal(invalid.status, 422);
  assert.ok(Object.hasOwn(invalid.body.fields as object, "abv"));

  // A swatch posts its number; "Exact value" posts the number field, read only then.
  const swatch = await admin.autosave(path("update"), {
    updatedAt: revision(),
    srm: "20",
    srmExact: "99",
  });
  assert.equal(swatch.status, 200);
  assert.equal(effective().srm, 20);
  const answer = swatch.body.resource as Record<string, unknown>;
  assert.equal(answer.srm, "20");
  assert.equal(answer.resolvedColor, "#530C00");
  assert.equal(answer.colourOverridden, false);
  const exact = await admin.autosave(path("update"), {
    updatedAt: revision(),
    srm: "exact",
    srmExact: "7.5",
  });
  assert.equal(exact.status, 200);
  assert.equal(effective().srm, 7.5);
  assert.equal((exact.body.resource as Record<string, unknown>).srm, "exact");

  // A picked colour overrides SRM until the reset clears it. Neither touches the glass.
  const picked = await admin.autosave(path("update"), {
    updatedAt: revision(),
    displayColor: "#123abc",
  });
  assert.equal(picked.status, 200);
  assert.equal(effective().displayColor, "#123abc");
  assert.equal((picked.body.resource as Record<string, unknown>).colourOverridden, true);
  const reset = await admin.autosave(path("update"), { updatedAt: revision(), displayColor: "" });
  assert.equal(reset.status, 200);
  assert.equal(effective().displayColor, null);
  assert.equal((reset.body.resource as Record<string, unknown>).colourOverridden, false);
  assert.equal(effective().fillGlass, "tulip_glass");

  // A stale revision is a conflict, never a silent overwrite.
  const stale = await admin.autosave(path("update"), {
    updatedAt: "2000-01-01T00:00:00.000Z",
    displayColor: "#000000",
  });
  assert.equal(stale.status, 409);
  assert.equal(effective().displayColor, null);

  // Sensory overrides save the whole form and answer with the new revision.
  const sensory = await admin.autosave(path("sensory"), {
    updatedAt: revision(),
    malt: "6",
    hops: "",
    bitterness: "2.5",
  });
  assert.equal(sensory.status, 200);
  assert.equal(sensory.body.revision, revision());
  const overrides = beverages.getBeverage(id).sensoryOverrides;
  assert.equal(overrides?.malt, 6);
  assert.equal(overrides?.hops, null);
  assert.equal(overrides?.bitterness, 2.5);
  const outOfRange = await admin.autosave(path("sensory"), { updatedAt: revision(), malt: "11" });
  assert.equal(outOfRange.status, 422);
  assert.ok(Object.hasOwn(outOfRange.body.fields as object, "malt"));

  // The custom recipe saves live, beyond the usual 16 KiB JSON limit, and rejects bad JSON.
  const recipe = {
    notes: "n".repeat(4_000),
    ingredients: Array.from({ length: 100 }, (_, index) => ({
      name: `Ingredient ${index} ${"x".repeat(140)}`,
      amount: index,
      unit: "g",
    })),
    steps: [],
  };
  const recipeJson = JSON.stringify(recipe);
  assert.ok(recipeJson.length > 16_384);
  const savedRecipe = await admin.autosave(path("recipe"), { updatedAt: revision(), recipeJson });
  assert.equal(savedRecipe.status, 200);
  assert.equal(beverages.getBeverage(id).customRecipe?.ingredients.length, 100);
  assert.equal(savedRecipe.body.revision, revision());
  const badRecipe = await admin.autosave(path("recipe"), {
    updatedAt: revision(),
    recipeJson: "{",
  });
  assert.equal(badRecipe.status, 422);
  assert.equal(beverages.getBeverage(id).customRecipe?.ingredients.length, 100);
});

void test("a linked Beverage's colour picker overrides and resets Brewfather's SRM and colour", async (context) => {
  const database = openDatabase(":memory:");
  const linked = linkedBeverage(database);
  const beverages = createBeverageService(database);
  const admin = await adminApp(context, database);
  const id = linked.beverage.id;
  const path = `/admin/beverages/${id}/presentation`;
  const revision = () => beverages.getBeverage(id).beverage.updatedAt;
  const overrides = () => beverages.getBeverage(id).presentationOverrides;

  const html = await admin.get(path);
  assert.match(html, /data-colour-source[^>]*>From Brewfather</u);
  assert.match(html, /data-srm-reset hidden/u);
  // SRM and colour moved from the overrides form to the picker.
  assert.doesNotMatch(html, /name="srmMode"><option/u);

  // A swatch overrides SRM without a mode; the picker's reset posts the mode alone.
  const srm = await admin.autosave(path, { updatedAt: revision(), srm: "9" });
  assert.equal(srm.status, 200);
  assert.equal(overrides()?.overrideSrmPresent, true);
  assert.equal(overrides()?.srm, 9);
  assert.equal((srm.body.resource as Record<string, unknown>).srmOverridden, true);
  const colour = await admin.autosave(path, { updatedAt: revision(), displayColor: "#abcdef" });
  assert.equal(colour.status, 200);
  assert.equal(overrides()?.overrideDisplayColorPresent, true);
  // An empty exact SRM clears it for this beverage rather than reading as 0.
  const cleared = await admin.autosave(path, { updatedAt: revision(), srm: "exact", srmExact: "" });
  assert.equal(cleared.status, 200);
  assert.equal(overrides()?.overrideSrmPresent, true);
  assert.equal(overrides()?.srm, null);
  for (const field of ["srmMode", "displayColorMode"]) {
    const reset = await admin.autosave(path, { updatedAt: revision(), [field]: "inherit" });
    assert.equal(reset.status, 200, field);
  }
  assert.equal(overrides()?.overrideSrmPresent, false);
  assert.equal(overrides()?.overrideDisplayColorPresent, false);
  // None of these posts touched the Fill Glass override.
  assert.equal(overrides()?.overrideFillGlassPresent, false);
});

void test("New Beverage reads SRM from the swatches and a colour only when its switch is on", async (context) => {
  const database = openDatabase(":memory:");
  const { beverages } = services(database);
  const admin = await adminApp(context, database);
  const created = (name: string) =>
    beverages.listBeverages().find((item) => item.effectivePresentation.name === name)!
      .effectivePresentation;

  const form = await admin.get("/admin/beverages/new");
  assert.match(form, /name="displayColorCustom"/u);
  assert.doesNotMatch(form, /type="radio" name="srm" value="[0-9]+" checked/u);

  await admin.post("/admin/beverages/create", {
    name: "Swatch Stout",
    beverageType: "beer",
    srm: "40",
    displayColor: "#d97706",
  });
  assert.equal(created("Swatch Stout").srm, 40);
  assert.equal(created("Swatch Stout").displayColor, null);
  await admin.post("/admin/beverages/create", {
    name: "Painted Cider",
    beverageType: "cider",
    srm: "exact",
    srmExact: "",
    displayColorCustom: "true",
    displayColor: "#336699",
  });
  assert.equal(created("Painted Cider").srm, null);
  assert.equal(created("Painted Cider").displayColor, "#336699");
});

void test("Keg detail forms save live, return to the Keg, and keep a reason for the tare change", async (context) => {
  const database = openDatabase(":memory:");
  const { beverages, kegs, fills } = services(database);
  const keg = kegs.createKeg({ kegNumber: 4, label: "Old label", capacityMl: 19_000 });
  const empty = kegs.createKeg({ kegNumber: 5, capacityMl: 19_000 });
  fills.createFill({
    beverageId: beverages.createCustomBeverage({ name: "Kegged Kölsch" }).beverage.id,
    kegId: keg.id,
  });
  const admin = await adminApp(context, database);
  const page = `/admin/keg-room/kegs/${keg.id}`;
  const action = `/admin/kegs/${keg.id}/update`;
  const current = () => kegs.getKeg(keg.id);

  // Everyday forms are open; tare sits behind the one Advanced settings disclosure.
  const html = await admin.get(page);
  assert.match(html, /<h1>Keg 4 — Old label<\/h1>/u);
  assert.equal(html.match(/<details class="disclosure">/gu)?.length, 2);
  assert.match(html, /<summary id="keg-advanced-heading">Advanced settings/u);
  assert.ok(html.indexOf('name="capacityMl"') < html.indexOf("Advanced settings"));
  assert.ok(html.indexOf('name="currentTareG"') > html.indexOf("Advanced settings"));
  assert.match(section(html, "keg-details-heading"), /Kegged Kölsch<\/a> · Available/u);

  // Without JavaScript the label form saves on its own (it used to fail on a missing number).
  const labelled = await admin.post(action, { updatedAt: current().keg.updatedAt, label: "New" });
  assert.match(labelled, new RegExp(`^${page}\\?notice=`, "u"));
  assert.equal(current().keg.label, "New");
  assert.equal(current().keg.kegNumber, 4);
  assert.match(
    await admin.post(`/admin/kegs/${keg.id}/maintenance`, { maintenanceType: "Cleaned" }),
    new RegExp(`^${page}\\?notice=`, "u"),
  );
  assert.match(
    await admin.post(`/admin/kegs/${keg.id}/delete`, { confirmation: "wrong" }),
    new RegExp(`^${page}\\?error=`, "u"),
  );

  // Live: the details form saves its whole form and answers with the new revision.
  const details = await admin.autosave(action, {
    updatedAt: current().keg.updatedAt,
    kegNumber: "6",
    capacityMl: "20000",
    isActive: "true",
  });
  assert.equal(details.status, 200);
  assert.equal(details.body.revision, current().keg.updatedAt);
  assert.equal(current().keg.kegNumber, 6);
  assert.equal(current().keg.capacityMl, 20_000);
  const taken = await admin.autosave(action, {
    updatedAt: current().keg.updatedAt,
    kegNumber: "5",
  });
  assert.equal(taken.status, 409);

  // A reason alone changes nothing; it is recorded with the tare change, then clears.
  const before = current().keg.updatedAt;
  const reasonOnly = await admin.autosave(action, {
    updatedAt: before,
    currentTareG: String(current().keg.currentTareG),
    reason: "Weighed empty",
  });
  assert.equal(reasonOnly.status, 200);
  assert.deepEqual(reasonOnly.body.resource, {});
  assert.equal(current().keg.updatedAt, before);
  const tare = await admin.autosave(action, {
    updatedAt: before,
    currentTareG: "4300",
    reason: "Weighed empty",
  });
  assert.equal(tare.status, 200);
  assert.deepEqual(tare.body.resource, { reason: "" });
  assert.equal(current().keg.currentTareG, 4300);
  assert.equal(
    current().tareHistory.find((item) => item.newTareG === 4300)?.reason,
    "Weighed empty",
  );

  // The label keeps its revision check.
  const staleLabel = await admin.autosave(action, {
    updatedAt: "2000-01-01T00:00:00.000Z",
    label: "Stale",
  });
  assert.equal(staleLabel.status, 409);

  // Kegs list: the corny keg icon, filled for the keg with a Fill and empty for the other.
  const list = await admin.get("/admin/keg-room/kegs");
  const row = (id: string) =>
    new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?/admin/keg-room/kegs/${id}"`, "u").exec(list)?.[0] ?? "";
  assert.match(row(keg.id), /data-graphic-id="corny_keg"[^>]*data-rendered-fill-percent="100"/u);
  assert.match(row(empty.id), /data-graphic-id="corny_keg"[^>]*data-rendered-fill-percent="0"/u);
});
