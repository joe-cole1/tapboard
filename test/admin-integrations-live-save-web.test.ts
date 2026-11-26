import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { adminApp } from "./fixtures/admin-app.ts";

const SECRET_KEY = Buffer.alloc(32, 7).toString("base64url");
const ENDPOINT = "https://hooks.example.invalid/private-path-sentinel";

/** The `<form>` that posts to `action`, or "" when the page has none. */
function form(html: string, action: string): string {
  return new RegExp(`<form[^>]*action="${action}"[\\s\\S]*?</form>`, "u").exec(html)?.[0] ?? "";
}

function inputValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "u").exec(html);
  assert.ok(match, `input ${name}`);
  return match[1]!;
}

void test("Outbound destination: settings and switches save live, endpoint and headers stay explicit", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database, { secretKey: SECRET_KEY });
  await admin.post("/admin/integrations/outbound/create", {
    transport: "webhook",
    label: "Receiver",
    webhookUrl: ENDPOINT,
    enabled: "on",
    subscription_pour_completed: "on",
  });
  const { id } = database
    .prepare<[], { readonly id: string }>("SELECT id FROM outbound_destinations")
    .get()!;
  const base = `/admin/integrations/outbound/${id}`;
  const page = await admin.get(base);
  assert.equal(page.includes(ENDPOINT), false);

  const settingsForm = form(page, `${base}/settings`);
  assert.match(settingsForm, /data-autosave="blur"/u);
  assert.match(settingsForm, /data-autosave-fallback/u);
  assert.doesNotMatch(settingsForm, /name="(webhookUrl|url|token|static_header_0_value)"/u);
  for (const explicit of ["endpoint", "headers"]) {
    const html = form(page, `${base}/${explicit}`);
    assert.ok(html, explicit);
    assert.doesNotMatch(html, /data-autosave/u, explicit);
  }
  assert.match(form(page, `${base}/enabled`), /data-autosave="submit"/u);
  assert.match(form(page, `${base}/required`), /role="switch" aria-checked="false"/u);
  assert.doesNotMatch(page, /Make required|>Disable<|>Enable</u);

  const saved = await admin.autosave(`${base}/settings`, {
    updatedAt: inputValue(settingsForm, "updatedAt"),
    label: "Renamed receiver",
    subscription_fill_assigned: "on",
    subscription_pour_completed: "false",
    payloadFormat: "discord",
    allowPrivateNetwork: "false",
  });
  assert.equal(saved.status, 200);
  const resource = saved.body.resource as Record<string, unknown>;
  assert.equal(resource.label, "Renamed receiver");
  assert.equal(resource.subscription_fill_assigned, true);
  assert.equal(resource.subscription_pour_completed, false);
  assert.equal(resource.payloadFormat, "discord");
  assert.equal(resource.versionNumber, "2");
  assert.equal(JSON.stringify(saved.body).includes("private-path-sentinel"), false);
  assert.match(await admin.get(base), /<h1[^>]*>Renamed receiver</u);

  const invalid = await admin.autosave(`${base}/settings`, { label: "" });
  assert.equal(invalid.status, 422);
  assert.ok((invalid.body.fields as Record<string, string>).label);

  const off = await admin.autosave(`${base}/enabled`, { enabled: "false" });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.resource, {
    enabled: false,
    statusLabel: "Disabled",
    statusClass: "muted",
    disabledNote: "Disabled: Operator disabled",
  });
  const on = await admin.autosave(`${base}/enabled`, { enabled: "true" });
  assert.equal((on.body.resource as Record<string, unknown>).enabled, true);
  assert.equal((on.body.resource as Record<string, unknown>).disabledNote, "");
  assert.equal((await admin.autosave(`${base}/enabled`, { enabled: "maybe" })).status, 422);

  const required = await admin.autosave(`${base}/required`, { required: "true" });
  assert.deepEqual(required.body.resource, { required: true });

  // A secret header with no value yet pauses delivery, and the switch says why it can't resume.
  assert.match(
    await admin.post(`${base}/headers`, { secret_header_0_name: "Authorization" }),
    /notice=/u,
  );
  const blocked = await admin.autosave(`${base}/enabled`, { enabled: "true" });
  assert.equal(blocked.status, 422);
  assert.match(String(blocked.body.message), /secret header requires a value/u);

  // Without JavaScript every form posts and lands back on the page.
  assert.match(
    await admin.post(`${base}/settings`, { label: "Posted", subscription_keg_low: "on" }),
    /notice=/u,
  );
  assert.match(
    await admin.post(`${base}/endpoint`, { url: "https://hooks.example.invalid/second" }),
    /notice=/u,
  );
  assert.match(await admin.post(`${base}/required`, { required: "false" }), /notice=/u);
  const after = await admin.get(base);
  assert.match(after, /<h1[^>]*>Posted</u);
  assert.match(form(after, `${base}/required`), /aria-checked="false"/u);
});

void test("Brewfather: the sync switch saves live and the account form keeps it", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const status = () => createBeverageService(database).getBrewfatherStatus().account;

  const before = await admin.autosave("/admin/integrations/brewfather/enabled", {
    enabled: "true",
  });
  assert.equal(before.status, 422, "there is no account to switch yet");

  await admin.post("/admin/integrations/brewfather", { userId: "brewer-one" });
  assert.equal(status()?.enabled, true);
  const page = await admin.get("/admin/integrations/brewfather");
  const switchForm = form(page, "/admin/integrations/brewfather/enabled");
  assert.match(switchForm, /data-autosave="submit"/u);
  assert.match(switchForm, /aria-checked="true"/u);
  const account = form(page, "/admin/integrations/brewfather");
  assert.doesNotMatch(account, /name="enabled"/u);
  assert.equal(page.includes("brewer-one"), false, "the User ID is never shown");

  const off = await admin.autosave("/admin/integrations/brewfather/enabled", {
    updatedAt: inputValue(switchForm, "updatedAt"),
    enabled: "false",
  });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.resource, {
    enabled: false,
    statusLabel: "Disabled",
    statusClass: "muted",
  });
  assert.equal(status()?.enabled, false);
  assert.equal(
    (await admin.autosave("/admin/integrations/brewfather/enabled", { enabled: "maybe" })).status,
    422,
  );

  // Saving the account again keeps sync off.
  await admin.post("/admin/integrations/brewfather", { userId: "brewer-two" });
  assert.equal(status()?.userId, "brewer-two");
  assert.equal(status()?.enabled, false);
});

void test("Brewfather: the account form and sync switch keep the discovery statuses", async (context) => {
  const database = openDatabase(":memory:");
  const admin = await adminApp(context, database);
  const beverages = () => createBeverageService(database);
  beverages().configureBrewfatherAccount({
    userId: "brewer-one",
    enabled: true,
    discoveryStatuses: ["Fermenting"],
  });

  await admin.post("/admin/integrations/brewfather", { userId: "brewer-two" });
  assert.deepEqual(beverages().getBrewfatherStatus().account?.discoveryStatuses, ["Fermenting"]);
  await admin.post("/admin/integrations/brewfather/enabled", { enabled: "false" });
  assert.deepEqual(beverages().getBrewfatherStatus().account?.discoveryStatuses, ["Fermenting"]);
  assert.equal(beverages().getBrewfatherStatus().account?.enabled, false);
});
