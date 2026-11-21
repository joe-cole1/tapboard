import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createApplication } from "../src/application.ts";
import { createAuthService } from "../src/features/auth/index.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import type { TapAssignmentMysteryConfig } from "../src/features/taps/types.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
} from "../src/infrastructure/http/security/cookie.ts";
import { createLogger } from "../src/shared/logging.ts";

const ORIGIN = "http://tapboard.test";
const BEERXML = readFileSync(
  new URL("./fixtures/recipe-files/pale-ale.beerxml.xml", import.meta.url),
  "utf8",
);
const HIDDEN: TapAssignmentMysteryConfig = {
  enabled: true,
  revealBeverageType: false,
  revealStyle: false,
  revealAbv: false,
  revealIbu: false,
  revealOg: false,
  revealFg: false,
  revealSrm: false,
  revealDescription: false,
  revealRecipe: false,
  revealSensory: false,
  revealHistory: false,
};

interface Fixture {
  readonly base: string;
  readonly database: DatabaseConnection;
  readonly beverageId: string;
  readonly tapId: string;
  readonly startedAt: number;
}

/** A Custom beverage on Tap 1, seeded before start; no Brewfather account exists. */
async function fixture(
  context: TestContext,
  options: { readonly imported?: boolean; readonly mystery?: TapAssignmentMysteryConfig } = {},
): Promise<Fixture> {
  const directory = mkdtempSync("/tmp/tapboard-recipe-import-");
  const databasePath = join(directory, "tapboard.sqlite3");
  const database = openDatabase(databasePath);
  await createAuthService(database, { canonicalOrigin: ORIGIN }).resetOperatorPin("1234");
  const beverages = createBeverageService(database);
  const beverageId = beverages.createCustomBeverage({ name: "Imported Pale Ale" }).beverage.id;
  if (options.imported) beverages.importRecipeFile(beverageId, BEERXML);
  const keg = createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19_000 });
  const fill = createFillService(database).createFill({ beverageId, kegId: keg.id });
  const taps = createTapService(database);
  const tapId = taps.createTap({ tapNumber: 1, name: "Tap 1" }).id;
  taps.assignFill(tapId, { fillId: fill.id });
  if (options.mystery) taps.updateAssignmentMystery(tapId, options.mystery);
  const application = createApplication({
    config: {
      host: "127.0.0.1",
      port: 0,
      databasePath,
      shutdownGraceMs: 100,
      canonicalExternalOrigin: ORIGIN,
      trustedProxies: [],
      sessionInactivityMs: 86_400_000,
      sessionAbsoluteMs: 86_400_000,
    },
    logger: createLogger({ sink: () => undefined }),
  });
  context.after(async () => {
    try {
      await application.stop();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const address = await application.start();
  const startedAt = Date.now();
  return { base: `http://127.0.0.1:${address.port}`, database, beverageId, tapId, startedAt };
}

async function login(f: Fixture): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${f.base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: "1234" }),
  });
  assert.equal(response.status, 303);
  const cookies = new Map(
    response.headers.getSetCookie().map((value) => {
      const pair = value.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
    }),
  );
  const token = cookies.get(ADMIN_SESSION_COOKIE);
  const csrf = cookies.get(ADMIN_CSRF_COOKIE);
  assert.ok(token && csrf);
  return { cookie: `${ADMIN_SESSION_COOKIE}=${token}; ${ADMIN_CSRF_COOKIE}=${csrf}`, csrf };
}

function postImport(
  f: Fixture,
  browser: { cookie: string; csrf: string },
  recipeFile: string,
  options: { readonly origin?: string; readonly csrf?: string | null } = {},
): Promise<Response> {
  const csrf = options.csrf === undefined ? browser.csrf : options.csrf;
  return fetch(`${f.base}/admin/beverages/${f.beverageId}/recipe-import`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: browser.cookie,
      origin: options.origin ?? ORIGIN,
    },
    body: new URLSearchParams({ ...(csrf === null ? {} : { _csrf: csrf }), recipeFile }),
  });
}

function redirectMessage(response: Response, kind: "notice" | "error"): string {
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location") ?? "", ORIGIN);
  return location.searchParams.get(kind) ?? "";
}

async function page(f: Fixture, path: string, cookie?: string): Promise<string> {
  const response = await fetch(`${f.base}${path}`, {
    redirect: "manual",
    ...(cookie ? { headers: { cookie } } : {}),
  });
  assert.equal(response.status, 200, path);
  return response.text();
}

async function story(f: Fixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${f.base}/api/public/taps/${f.tapId}/story`);
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

const count = (f: Fixture, table: string) =>
  f.database.prepare<[], { count: number }>(`SELECT count(*) AS count FROM ${table}`).get()?.count;

void test("Admin imports a BeerXML file with no Brewfather account; Story shows the recipe sheet and flavor guidance", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  const before = await page(f, `/admin/beverages/${f.beverageId}`, browser.cookie);
  assert.ok(before.includes(`/admin/beverages/${f.beverageId}/recipe-import`));
  assert.deepEqual((await story(f)).recipes, { custom: null, sources: [] });

  // Open displays learn about the import through the public SSE stream. The startup
  // Brewfather sync (1 s after start, then hourly) also refreshes every tap, so let it
  // pass first; afterwards only the import can publish fill.updated.
  const events = new AbortController();
  context.after(() => events.abort());
  const stream = await fetch(`${f.base}/api/public/events`, { signal: events.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborted at the end of the test.
    }
  })();
  const waitFor = async (text: string, until: number): Promise<boolean> => {
    while (!received.includes(text) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return received.includes(text);
  };
  await waitFor("event: integration_status.updated", f.startedAt + 3_000);
  received = "";

  const response = await postImport(f, browser, BEERXML);
  const location = new URL(response.headers.get("location") ?? "", ORIGIN);
  assert.equal(location.pathname, `/admin/beverages/${f.beverageId}`);
  assert.equal(redirectMessage(response, "notice"), "Recipe imported (BeerXML).");
  assert.ok(
    await waitFor(`event: fill.updated\ndata: {"tapId":"${f.tapId}"}`, Date.now() + 5_000),
    "the import publishes fill.updated for the beverage's tap",
  );
  events.abort();

  const after = await page(f, `/admin/beverages/${f.beverageId}`, browser.cookie);
  assert.ok(after.includes("Imported BeerXML recipe"));
  assert.ok(after.includes("Centennial"));
  assert.ok(
    !after.includes(`/admin/beverages/${f.beverageId}/recipe-import`),
    "import is one-time",
  );

  const json = await story(f);
  const recipes = json.recipes as {
    sources: { provenance: { label: string }; sheet: Record<string, Record<string, unknown>> }[];
  };
  const source = recipes.sources[0]!;
  assert.equal(source.provenance.label, "Imported BeerXML recipe");
  assert.equal(source.sheet.summary!.og, 1.054);
  assert.equal(source.sheet.summary!.method, "All Grain");
  const hops = source.sheet.ingredients!.hops as { name: string }[];
  assert.deepEqual(
    hops.map((hop) => hop.name),
    ["Magnum", "Cascade", "Centennial"],
  );
  const sensory = json.sensory as Record<string, { value: number | null }>;
  assert.ok((sensory.hops?.value ?? 0) > 0, "flavor guidance comes from the imported recipe");
  assert.ok(json.flavor, "flavor guidance is present");
  const html = await page(f, `/taps/${f.tapId}/story`);
  assert.ok(html.includes("Centennial"));
  assert.ok(!JSON.stringify(json).includes("Private"), "no brewer notes or name");
  assert.equal(count(f, "brewfather_accounts"), 0);
  assert.equal(count(f, "beverage_source_recipe_snapshots"), 1);
});

void test("recipe import refuses a missing CSRF token, a foreign Origin, oversized bodies and bad files without writing", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  for (const [response, message] of [
    [await postImport(f, browser, BEERXML, { csrf: null }), /could not be authorized/u],
    [await postImport(f, browser, BEERXML, { csrf: "wrong" }), /could not be authorized/u],
    [
      await postImport(f, browser, BEERXML, { origin: "https://evil.example" }),
      /could not be authorized/u,
    ],
    [await postImport(f, browser, "{".repeat(1_100_000)), /too large/u],
    [await postImport(f, browser, `${BEERXML}${" ".repeat(1_048_576)}`), /larger than 1 MiB/u],
    [await postImport(f, browser, "<RECIPES><RECIPE>"), /not well-formed XML/u],
  ] as const)
    assert.match(redirectMessage(response, "error"), message);
  assert.equal(count(f, "beverage_source_recipe_snapshots"), 0);
});

void test("Mystery hides an imported recipe, and a revealed recipe still hides unrevealed metrics", async (context) => {
  const hidden = await fixture(context, { imported: true, mystery: HIDDEN });
  const hiddenJson = await story(hidden);
  assert.equal(hiddenJson.title, "Mystery Tap");
  assert.equal(hiddenJson.recipes, null);
  for (const text of [
    JSON.stringify(hiddenJson),
    await page(hidden, `/taps/${hidden.tapId}/story`),
  ])
    for (const forbidden of [
      "Centennial",
      "Imported Pale Ale",
      "American Pale Ale",
      "Imported BeerXML",
    ])
      assert.ok(!text.includes(forbidden), forbidden);

  const revealed = await fixture(context, {
    imported: true,
    mystery: { ...HIDDEN, revealRecipe: true },
  });
  const json = await story(revealed);
  const recipes = json.recipes as {
    sources: {
      sheet: { summary: Record<string, unknown>; measurements: Record<string, unknown> };
    }[];
  };
  const sheet = recipes.sources[0]!.sheet;
  for (const key of ["og", "fg", "abv", "ibu", "colorSrm", "method"])
    assert.equal(sheet.summary[key], null, key);
  assert.equal(sheet.measurements.og, null);
  assert.ok(JSON.stringify(sheet).includes("Centennial"), "revealed ingredients stay visible");
  assert.ok(!JSON.stringify(json).includes("American Pale Ale"), "style stays hidden");
});
