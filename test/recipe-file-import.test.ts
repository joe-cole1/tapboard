import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readBrewingInputs } from "../src/features/beverages/brewing-inputs.ts";
import type { BrewingInputs } from "../src/features/beverages/brewing-types.ts";
import {
  MAX_RECIPE_FILE_BYTES,
  parseRecipeFile,
} from "../src/features/beverages/recipe-files/import.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { listActivity } from "../src/features/activity/repository.ts";
import { adminBeverageDetailDto } from "../src/features/web/admin/beverage-presentation.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { corpus, evaluateFixture } from "./fixtures/flavor/corpus.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/recipe-files/${name}`, import.meta.url), "utf8");
const BEERXML = fixture("pale-ale.beerxml.xml");
const BEERJSON = fixture("dry-stout.beerjson.json");
const MARKER = "PRIVATE_FILE_MARKER";

function inputs(text: string): { inputs: BrewingInputs; snapshot: Record<string, unknown> } {
  const parsed = parseRecipeFile(text);
  const snapshot = JSON.parse(parsed.recipeJson) as Record<string, unknown>;
  const result = readBrewingInputs(snapshot);
  assert.ok(result, "the stored snapshot must pass the production snapshot reader");
  return { inputs: result, snapshot };
}

function rejected(text: string, message: RegExp, label = message.source) {
  assert.throws(
    () => parseRecipeFile(text),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "beverage.invalid_recipe_file" &&
      message.test(error.clientMessage) &&
      !error.clientMessage.includes(MARKER),
    label,
  );
}

const close = (actual: number | null | undefined, expected: number, label: string) =>
  assert.ok(
    actual !== null && actual !== undefined && Math.abs(actual - expected) < 0.01,
    `${label}: ${actual}`,
  );

void test("a Brewfather batch or recipe export imports exactly as the export-v3 adapter normalizes it", () => {
  const batch = corpus.batches[0]!.input;
  const expected = evaluateFixture(batch).snapshot.recipeJson;
  for (const text of [JSON.stringify(batch), JSON.stringify([batch], null, 2)]) {
    const parsed = parseRecipeFile(text);
    assert.equal(parsed.format, "brewfather-export-v3");
    assert.equal(parsed.recipeJson, expected);
    assert.match(parsed.sourceKey, /^brewfather-export-v3:[0-9a-f]{32}$/u);
  }
  const recipe = corpus.recipes[0]!.input;
  assert.equal(
    parseRecipeFile(JSON.stringify(recipe)).recipeJson,
    evaluateFixture(recipe, "recipe").snapshot.recipeJson,
  );
});

void test("BeerXML maps targets, grams, hop stages, dry-hop days and steps; notes and brewer are dropped", () => {
  assert.equal(parseRecipeFile(BEERXML).format, "beerxml-1");
  const { inputs: result, snapshot } = inputs(BEERXML);
  assert.equal(result.format, "beerxml-1");
  assert.equal(result.beverageType, "beer");
  assert.equal(result.style.name, "American Pale Ale");
  for (const [key, value] of [
    ["og", 1.054],
    ["fg", 1.011],
    ["abv", 5.6],
    ["ibu", 38.5],
    ["color", 8.2],
    ["volume", 20.82],
    ["carbonation", 2.4],
  ] as const) {
    close(result.scalars[key].value, value, key);
    assert.equal(result.scalars[key].provenance, "recipe_target", key);
  }
  assert.equal(snapshot.type, "All Grain");
  assert.equal(snapshot.boilTime, 60);
  const { fermentables, hops, yeasts, miscs } = result.ingredients;
  for (const collection of [fermentables, hops, yeasts, miscs]) assert.ok(collection.complete);
  close(fermentables.items[0]!.grams, 4535.92, "base malt grams");
  assert.deepEqual(
    fermentables.items.map((item) => item.lovibond),
    [2, 40],
  );
  assert.equal(fermentables.items[0]!.supplier, "Fixture Maltings");
  assert.deepEqual(
    hops.items.map((item) => [item.name, item.stage, item.boilMinutes, item.contactDays]),
    [
      ["Magnum", "boil", 60, null],
      ["Cascade", "whirlpool", null, null],
      ["Centennial", "dry_hop", null, 3],
    ],
  );
  close(hops.items[2]!.grams, 56.7, "dry hop grams");
  assert.equal(hops.items[0]!.alpha, 12);
  assert.equal(yeasts.items[0]!.productId, "US-05");
  close(yeasts.items[0]!.grams, 11.5, "yeast grams");
  close(miscs.items[0]!.grams, 1, "misc grams");
  assert.deepEqual(
    result.mash.map((step) => [step.name, step.temperatureC, step.time, step.timeUnit]),
    [
      ["Mash In", 66.7, 60, "min"],
      ["Mash Out", 75.6, 10, "min"],
    ],
  );
  // FERMENTATION_STAGES is 2, so the tertiary values are ignored.
  assert.deepEqual(
    result.fermentation.map((step) => [step.name, step.temperatureC, step.time, step.timeUnit]),
    [
      ["Primary", 19.4, 10, "day"],
      ["Secondary", 20, 4, "day"],
    ],
  );
  const json = parseRecipeFile(BEERXML).recipeJson;
  assert.ok(!json.includes("Private"), "notes, taste notes and brewer stay out of the snapshot");
});

void test("BeerXML accepts a bare RECIPE root, EBC colour and non-ASCII text; non-SG gravity is dropped", () => {
  const { inputs: result } = inputs(
    "<RECIPE><NAME>Bière</NAME><TYPE>Extract</TYPE><EST_OG>13.2 °P</EST_OG><OG>1.050</OG>" +
      "<EST_COLOR>20 EBC</EST_COLOR><FERMENTABLES/></RECIPE>",
  );
  close(result.scalars.og.value, 1.05, "falls back to OG");
  close(result.scalars.color.value, 10.16, "EBC to SRM");
  assert.equal(result.beverageType, "beer");
});

void test("BeerJSON converts unit objects to litres, minutes, days, °C, SG and SRM", () => {
  assert.equal(parseRecipeFile(BEERJSON).format, "beerjson");
  const { inputs: result, snapshot } = inputs(BEERJSON);
  assert.equal(result.format, "beerjson");
  assert.equal(result.style.name, "Irish Stout");
  close(result.scalars.og.value, 1.042, "og");
  close(result.scalars.fg.value, 1.0098, "fg from Plato");
  close(result.scalars.abv.value, 4.2, "abv");
  close(result.scalars.ibu.value, 40, "ibu");
  close(result.scalars.color.value, 40.64, "EBC colour");
  close(result.scalars.volume.value, 20.82, "gallons");
  close(result.scalars.carbonation.value, 2.1, "carbonation");
  assert.equal(snapshot.boilTime, 60);
  const { fermentables, hops, yeasts, miscs } = result.ingredients;
  close(fermentables.items[0]!.grams, 3175.15, "pounds");
  assert.equal(fermentables.items[0]!.lovibond, 3);
  assert.equal(fermentables.items[1]!.color, 1.7);
  close(fermentables.items[2]!.color, 660.4, "EBC fermentable colour");
  assert.deepEqual(
    hops.items.map((item) => [item.name, item.stage, item.boilMinutes, item.contactDays]),
    [
      ["East Kent Goldings", "boil", 60, null],
      ["Fuggle", "dry_hop", null, 3],
    ],
  );
  close(hops.items[0]!.grams, 56.7, "ounces");
  assert.equal(yeasts.items[0]!.laboratory, "Fixture Labs");
  assert.equal(yeasts.items[0]!.unit, "pkg");
  assert.equal(miscs.items[0]!.boilMinutes, 10);
  assert.equal(miscs.items[0]!.time, 10);
  assert.deepEqual(
    result.mash.map((step) => [step.temperatureC, step.time]),
    [[66, 60]],
  );
  assert.deepEqual(
    result.fermentation.map((step) => [step.temperatureC, step.time, step.timeUnit]),
    [[19, 14, "day"]],
  );
  assert.ok(!parseRecipeFile(BEERJSON).recipeJson.includes("Private"));
});

void test("files up to 1 MiB are accepted; empty, oversized, malformed and unrecognised files are rejected", () => {
  const padded = BEERXML + " ".repeat(MAX_RECIPE_FILE_BYTES - Buffer.byteLength(BEERXML));
  assert.equal(parseRecipeFile(padded).format, "beerxml-1");
  rejected(`${padded} `, /larger than 1 MiB/u, "one byte over");
  rejected(`<!--${"é".repeat(MAX_RECIPE_FILE_BYTES / 2)}-->${BEERXML}`, /larger than 1 MiB/u);
  rejected("", /Paste or choose/u);
  rejected(" \n\t", /Paste or choose/u);
  rejected(`{"${MARKER}": `, /not valid JSON/u);
  rejected(`<RECIPES><RECIPE><NAME>${MARKER}</NAME></RECIPE>`, /not well-formed XML/u);
  rejected(
    `<!DOCTYPE RECIPES [<!ENTITY x "${MARKER}">]><RECIPES><RECIPE><NAME>&x;</NAME></RECIPE></RECIPES>`,
    /not well-formed XML/u,
    "DTD",
  );
  rejected(`<${MARKER}/>`, /not a BeerXML recipe file/u);
  rejected(MARKER, /couldn't recognise/u);
  rejected("{}", /couldn't recognise/u);
  rejected(`{"_type":"batch","name":"${MARKER}"}`, /couldn't recognise/u, "batch without recipe");
  rejected("[]", /no recipe/u);
  rejected('{"beerjson":{"version":1,"recipes":[]}}', /no recipe/u);
  rejected('{"beerjson":{"version":9,"recipes":[{}]}}', /version is not supported/u);
  rejected('{"beerjson":{"recipes":[{}]}}', /version is not supported/u);
});

void test("files holding more than one recipe are rejected in every format", () => {
  const recipe = "<RECIPE><NAME>One</NAME></RECIPE>";
  rejected(`<RECIPES>${recipe}${recipe}</RECIPES>`, /has 2 recipes/u, "BeerXML");
  const document = JSON.parse(BEERJSON) as { beerjson: { recipes: unknown[] } };
  document.beerjson.recipes.push(document.beerjson.recipes[0], document.beerjson.recipes[0]);
  rejected(JSON.stringify(document), /has 3 recipes/u, "BeerJSON");
  const batch = corpus.batches[0]!.input;
  rejected(JSON.stringify([batch, batch]), /has 2 recipes/u, "Brewfather");
});

void test("a recipe whose cleaned snapshot exceeds the 256 KiB limit is rejected", () => {
  const long = (size: number) => "x".repeat(size);
  const row = (role: string) => ({
    name: long(160),
    producer: long(120),
    origin: long(120),
    product_id: long(80),
    type: role,
    form: long(80),
    amount: { unit: "g", value: 1 },
  });
  const document = {
    beerjson: {
      version: 1,
      recipes: [
        {
          name: "Overflow",
          type: "all grain",
          ingredients: {
            fermentable_additions: Array.from({ length: 100 }, () => row("grain")),
            hop_additions: Array.from({ length: 100 }, () => row("hop")),
            culture_additions: Array.from({ length: 100 }, () => row("ale")),
            miscellaneous_additions: Array.from({ length: 100 }, () => row("spice")),
          },
        },
      ],
    },
  };
  const text = JSON.stringify(document);
  assert.ok(Buffer.byteLength(text) < MAX_RECIPE_FILE_BYTES);
  rejected(text, /256 KiB/u);
});

void test("the service attaches one immutable detached snapshot to a Custom beverage", () => {
  const db = openDatabase(":memory:");
  try {
    const service = createBeverageService(db);
    const id = service.createCustomBeverage({ name: "Imported" }).beverage.id;
    assert.throws(
      () => service.importRecipeFile(id, "not a recipe"),
      (error: unknown) => error instanceof ApplicationError && error.category === "validation",
    );
    assert.equal(service.getRecipeSnapshots(id).length, 0);
    const { format, snapshot } = service.importRecipeFile(id, BEERXML, {
      actorType: "admin",
      sessionId: "session-1",
    });
    assert.equal(format, "beerxml-1");
    const imported = () =>
      listActivity(db).filter(
        (entry) => entry.entityId === id && entry.details?.change === "recipe_imported",
      );
    assert.deepEqual(
      imported().map((entry) => [entry.action, entry.actorType, entry.sessionId, entry.entityType]),
      [["entity_changed", "admin", "session-1", "beverage"]],
    );
    assert.equal(snapshot.state, "detached");
    assert.equal(snapshot.accountId, "offline-history");
    assert.equal(snapshot.recipeJson, parseRecipeFile(BEERXML).recipeJson);
    const detail = service.getBeverage(id);
    assert.equal(detail.customRecipe, undefined);
    assert.equal(detail.recipeSnapshot?.id, snapshot.id);
    assert.deepEqual(service.importRecipeFile(id, BEERXML).snapshot, snapshot, "idempotent");
    assert.equal(imported().length, 1, "an idempotent re-import logs nothing new");
    const conflict = (action: () => unknown) =>
      assert.throws(
        action,
        (error: unknown) => error instanceof ApplicationError && error.category === "conflict",
      );
    conflict(() => service.importRecipeFile(id, BEERJSON));
    assert.deepEqual(service.getRecipeSnapshots(id), [snapshot]);
    const editable = service.createCustomBeverage({ name: "Editable", recipe: { notes: "x" } });
    conflict(() => service.importRecipeFile(editable.beverage.id, BEERXML));
    for (const table of [
      "brewfather_accounts",
      "brewfather_beverage_links",
      "brewfather_source_profiles",
      "encrypted_secrets",
    ])
      assert.equal(
        db.prepare<[], { count: number }>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
        0,
        table,
      );
  } finally {
    db.close();
  }
});

void test("Admin labels a Custom beverage's recipe state: importable, imported, kept source or blocked", () => {
  const db = openDatabase(":memory:");
  try {
    const service = createBeverageService(db);
    const state = (beverageId: string) =>
      adminBeverageDetailDto(
        service.getBeverage(beverageId),
        { current: 0, total: 0 },
        [],
        undefined,
      ).recipeImport;
    const id = service.createCustomBeverage({ name: "Importable" }).beverage.id;
    assert.equal(state(id), "available");
    service.importRecipeFile(id, BEERXML);
    assert.equal(state(id), "imported");
    // A detached snapshot kept after a Brewfather unlink is not an import.
    db.prepare(
      "UPDATE beverage_source_recipe_snapshots SET account_id = 'brewfather-account' WHERE beverage_id = ?",
    ).run(id);
    assert.equal(state(id), "source");
    const editable = service.createCustomBeverage({ name: "Editable", recipe: { notes: "x" } });
    assert.equal(state(editable.beverage.id), "unavailable");
  } finally {
    db.close();
  }
});
