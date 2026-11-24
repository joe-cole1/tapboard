import assert from "node:assert/strict";
import test from "node:test";

import { adminBreadcrumbs, adminNavItems, adminTabs } from "../src/features/web/admin/layout.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";

void test("a section's own page ends its breadcrumb at the section", () => {
  assert.deepEqual(adminBreadcrumbs("/admin/taps", "/admin/taps", "Taps"), [
    { label: "Admin", href: "/admin/overview" },
    { label: "Taps" },
  ]);
  assert.deepEqual(adminBreadcrumbs("/admin/overview", "/admin/overview", "Overview"), [
    { label: "Admin", href: "/admin/overview" },
    { label: "Overview" },
  ]);
});

void test("a sub-page's breadcrumb links Admin, its section and every parent", () => {
  assert.deepEqual(adminBreadcrumbs("/admin/taps", "/admin/taps/tap-1", "Tap 1 — Porch"), [
    { label: "Admin", href: "/admin/overview" },
    { label: "Taps", href: "/admin/taps" },
    { label: "Tap 1 — Porch" },
  ]);
  assert.deepEqual(
    adminBreadcrumbs("/admin/keg-room/kegs", "/admin/keg-room/kegs/keg-7", "Keg 7", [
      { label: "Physical Kegs", href: "/admin/keg-room/kegs" },
    ]),
    [
      { label: "Admin", href: "/admin/overview" },
      { label: "Keg Room", href: "/admin/keg-room" },
      { label: "Physical Kegs", href: "/admin/keg-room/kegs" },
      { label: "Keg 7" },
    ],
  );
  // Legacy paths that the Keg Room menu item covers still find their section.
  assert.equal(
    adminBreadcrumbs("/admin/fills/abc", "/admin/fills/abc", "Filled Keg")[1]?.href,
    "/admin/keg-room",
  );
  assert.equal(
    adminBreadcrumbs("/admin/logs/sessions", "/admin/logs/sessions", "Admin sessions")[1]?.href,
    "/admin/logs",
  );
});

void test("a record named like its section still links the section", () => {
  // Regression: the section page used to be detected by title, so a Beverage named
  // "Beverages" lost its way back to the list.
  assert.deepEqual(adminBreadcrumbs("/admin/beverages", "/admin/beverages/b-1", "Beverages"), [
    { label: "Admin", href: "/admin/overview" },
    { label: "Beverages", href: "/admin/beverages" },
    { label: "Beverages" },
  ]);
});

void test("tabs mark exactly the current page", () => {
  const tabs = adminTabs("keg-room", "/admin/keg-room?state=ended");
  assert.equal(tabs.label, "Keg Room");
  assert.deepEqual(
    tabs.items.map((item) => [item.label, item.current]),
    [
      ["Filled Kegs", false],
      ["Physical Kegs", false],
      ["History", true],
    ],
  );
  for (const section of ["keg-room", "integrations", "display", "logs"] as const) {
    const first = adminTabs(section, adminTabs(section, "").items[0]!.href);
    assert.equal(first.items.filter((item) => item.current).length, 1, section);
  }
});

void test("the menu always lists Logs and Simulation under Configure", () => {
  const configure = adminNavItems()
    .filter((item) => item.group === "Configure")
    .map((item) => [item.label, item.href]);
  assert.deepEqual(configure, [
    ["Integrations", "/admin/integrations"],
    ["Display", "/admin/display"],
    ["System", "/admin/system"],
    ["Logs", "/admin/logs"],
    ["Simulation", "/admin/simulator"],
  ]);
});

void test("the Admin shell renders one menu button and a linked breadcrumb trail", () => {
  const title = "Keg 7";
  const html = createRenderer().render("/admin/not-found", {
    page: {
      title,
      path: "/admin/keg-room/kegs",
      breadcrumbs: adminBreadcrumbs("/admin/keg-room/kegs", "/admin/keg-room/kegs/keg-7", title, [
        { label: "Physical Kegs", href: "/admin/keg-room/kegs" },
      ]),
      csrfToken: "safe",
    },
    navItems: adminNavItems(),
  });
  assert.equal(html.match(/data-admin-menu-toggle/gu)?.length, 1);
  assert.doesNotMatch(html, />(?:Menu|Hide menu|Close menu)</u);
  const trail = /<ol class="admin-breadcrumbs__trail">([\s\S]*?)<\/ol>/u.exec(html)?.[1] ?? "";
  assert.deepEqual(
    [...trail.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/gu)].map((match) => [match[1], match[2]]),
    [
      ["/admin/overview", "Admin"],
      ["/admin/keg-room", "Keg Room"],
      ["/admin/keg-room/kegs", "Physical Kegs"],
    ],
  );
  assert.match(trail, /<span aria-current="page">Keg 7<\/span>/u);
  // Phones get one link to the parent instead of the trail.
  assert.match(
    html,
    /class="admin-breadcrumbs__back" href="\/admin\/keg-room\/kegs">[\s\S]*?Back to [\s\S]*?Physical Kegs<\/a>/u,
  );
});
