import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import type { PublicDashboardView, PublicTapCardView } from "../src/features/dashboard/types.ts";
import { tapWarPercentages } from "../src/features/tap-wars/service.ts";
import type { PublicTapWarView } from "../src/features/tap-wars/types.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";

const hostile = '<script>alert(1)</script>" onmouseover="alert(2)';

function tap(id: number, enabled = true): PublicTapCardView & { readonly enabled?: boolean } {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    tapNumber: id,
    tapName: id === 1 ? hostile : `Tap ${id}`,
    graphicId: "pint_glass",
    displayColor: "#D97706",
    beverageName: id === 2 ? null : `Beverage ${id}`,
    style: id % 2 === 0 ? null : "Pale Ale",
    abv: id % 2 === 0 ? null : 5.2,
    metrics: id % 2 === 0 ? [] : [{ key: "abv", label: "ABV", value: "5.2%" }],
    description: id === 3 ? hostile : null,
    storyPath: id === 1 ? `/taps/${id}/story` : null,
    ...(id === 1 ? { accessibleLabel: `Tap ${id}, Beverage ${id}` } : {}),
    ...(id === 2 ? { accessibleLabel: `Tap ${id}, Empty Tap` } : {}),
    fillId: null,
    fillPercent: id * 10,
    remainingVolumeMl: id === 2 ? null : 10_000,
    capacityMl: id === 2 ? null : 19_000,
    servingsRemaining: id === 2 ? null : 28,
    daysRemaining: null,
    temperatureC: id === 2 ? null : 4,
    waitingForMeasurement: id === 2,
    health: "healthy",
    badges: [],
    enabled,
  };
}

function dashboard(tapWars: PublicTapWarView | null = null): PublicDashboardView {
  return {
    sharedDisplay: {
      revision: 1,
      tapboardName: hostile,
      theme: "modern_dark",
      font: "system",
      accent: "amber",
      unitSystem: "us",
      showServingTemperature: true,
      layoutMode: "scroll",
      remainingMode: "percent",
    },
    header: {
      tapboardName: hostile,
      connectivity: "healthy",
      connectivityLabel: "Connected",
    },
    taps: [tap(6), tap(1), tap(4), tap(2), tap(5), tap(3)].sort(
      (left, right) => left.tapNumber - right.tapNumber,
    ),
    onDeck: { items: [{ fillId: tap(9).id, name: hostile, style: "Porter" }] },
    tapWars,
    ssePath: "/api/public/events",
  };
}

function tapWar(status: PublicTapWarView["status"] = "active"): PublicTapWarView {
  const completed = status === "completed";
  return {
    id: "00000000-0000-4000-8000-000000000078",
    status,
    startedAt: "2026-08-17T12:00:00.000Z",
    completedAt: completed ? "2026-08-17T12:05:00.000Z" : null,
    side1: {
      side: 1,
      tapId: tap(1).id,
      tapNumber: 1,
      title: "Mystery Tap",
      isCardParticipant: true,
      voteCount: 7,
      percentage: 70,
      meterLabel: "70% (7 votes)",
    },
    side2: {
      side: 2,
      tapId: tap(3).id,
      tapNumber: 3,
      title: "Public Porter",
      isCardParticipant: true,
      voteCount: 3,
      percentage: 30,
      meterLabel: "30% (3 votes)",
    },
    totalVotes: 10,
    result: completed ? "side1" : null,
    winnerSide: completed ? 1 : null,
    leaderSide: completed ? null : 1,
    isTie: false,
    canVote: status === "active",
    votePath: "/api/public/tap-wars/00000000-0000-4000-8000-000000000078/votes",
    statusLabel: completed ? "Final result" : status === "paused" ? "Voting paused" : "Voting open",
  };
}

void test("public SSR is complete, ordered, null-safe, and escapes hostile text", () => {
  const html = createRenderer().render("/public/dashboard", { ...dashboard() });
  assert.match(html, /<!doctype html>/);
  assert.equal((html.match(/class="tap-card"/gu) ?? []).length, 6);
  assert.ok(html.indexOf('data-tap-number="1"') < html.indexOf('data-tap-number="6"'));
  assert.match(html, /Empty Tap/);
  assert.match(html, /href="\/taps\/1\/story"/u);
  assert.match(html, /data-tap-number="2"[^>]*aria-label="Tap 2, Empty Tap"/u);
  assert.match(html, /data-fill-percent="10"/u);
  assert.match(html, /data-remaining-volume-ml="10000"/u);
  assert.match(html, /data-capacity-ml="19000"/u);
  assert.match(html, /data-servings-remaining="28"/u);
  assert.match(html, /data-waiting-for-measurement="false"/u);
  assert.match(html, /data-waiting-for-measurement="true"/u);
  assert.doesNotMatch(html, /data-(?:remaining-volume-ml|capacity-ml|servings-remaining)="0"/u);
  assert.match(html, /class="public-brand" href="\/"/u);
  assert.equal((html.match(/class="tap-badges"/gu) ?? []).length, 6);
  assert.equal((html.match(/class="beer-bubble"/gu) ?? []).length, 144);
  assert.match(html, /data-field="forecast-servings"/u);
  assert.match(html, /data-field="forecast-days"/u);
  assert.match(html, /On Deck:/u);
  assert.match(html, /data-on-deck-toggle/gu);
  assert.match(html, /<\/strong> — <span>Porter<\/span>/u);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
  assert.doesNotMatch(html, /onmouseover="alert\(2\)"/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /IBU: N\/A/u);
  assert.doesNotMatch(html, /Story/u);
});

for (const [connectivity, connectivityLabel] of [
  ["healthy", "Connected"],
  ["degraded", "Partial"],
  ["disconnected", "Disconnected"],
] as const) {
  for (const populated of [false, true]) {
    void test(`public SSR keeps Settings available with ${connectivity} connectivity and ${populated ? "populated" : "empty"} taps`, () => {
      const view = dashboard();
      const html = createRenderer().render("/public/dashboard", {
        ...view,
        header: {
          ...view.header,
          connectivity,
          connectivityLabel,
        },
        taps: populated ? view.taps : [],
      });
      const header = html.match(
        /<header\b[^>]*class="public-header"[^>]*>[\s\S]*?<\/header>/u,
      )?.[0];
      assert.ok(header, "The public header is rendered without a tap or integration prerequisite.");
      const settings = header.match(/<a\b[^>]*href="\/admin\/system"[^>]*>[\s\S]*?<\/a>/gu);
      assert.equal(settings?.length, 1);
      assert.equal(settings[0].replace(/<[^>]*>/gu, "").trim(), "Settings");
      assert.match(header, /<a\b[^>]*class="connectivity"[^>]*href="\/admin"/u);
      assert.match(header, new RegExp(`data-connectivity="${connectivity}"`, "u"));
      assert.match(header, new RegExp(`data-connectivity-label>${connectivityLabel}<`, "u"));

      const emptyState = html.match(
        /<([a-z][a-z0-9-]*)\b([^>]*\bdata-dashboard-empty\b[^>]*)>([\s\S]*?)<\/\1>/u,
      );
      assert.ok(emptyState, "The empty state remains available for live dashboard updates.");
      assert.equal(/\shidden(?:\s|=|$)/u.test(emptyState[2]!), populated);
      assert.match(emptyState[3]!, /<h[1-6]\b[^>]*>\s*No taps to display\s*<\/h[1-6]>/u);
      assert.match(emptyState[3]!, /Admin/u);
      assert.equal((html.match(/class="tap-card"/gu) ?? []).length, populated ? 6 : 0);
    });
  }
}

void test("public dashboard DTO contains no privileged integration or telemetry shape", () => {
  const serialized = JSON.stringify(dashboard());
  for (const forbidden of [
    "apiKey",
    "secret",
    "sessionId",
    "actorId",
    "sourceId",
    "measurementId",
    "rawPayload",
    "maintenanceNotes",
    "brewfatherSnapshot",
    "mystery",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

void test("Tap Wars SSR augments cards in place with safe forms, a compact banner, and results dialog", () => {
  const html = createRenderer().render("/public/dashboard", { ...dashboard(tapWar()) });
  assert.ok(html.indexOf("data-tap-wars") < html.indexOf("data-tap-grid"));
  assert.equal((html.match(/data-tap-wars-participant=/gu) ?? []).length, 2);
  assert.equal((html.match(/data-tap-wars-vote(?:\s|>)/gu) ?? []).length, 2);
  assert.match(html, /TAP WARS! Vote below/u);
  assert.match(html, /Mystery Tap/u);
  assert.match(html, /Public Porter/u);
  assert.match(
    html,
    /aria-label="Vote split: Mystery Tap 70 percent; Public Porter 30 percent\."/u,
  );

  const banner = html.slice(
    html.indexOf('<section class="tap-wars-banner"'),
    html.indexOf("</section>", html.indexOf('<section class="tap-wars-banner"')),
  );
  assert.doesNotMatch(banner, /7 votes|3 votes|10 total/u);
  assert.match(html, /<strong>7 votes<\/strong><span>70%<\/span>/u);

  const firstCardStart = html.indexOf('data-tap-number="1"');
  const firstCard = html.slice(firstCardStart, html.indexOf("</article>", firstCardStart));
  assert.ok(
    firstCard.indexOf('data-field="description"') <
      firstCard.indexOf("data-tap-wars-card-controls"),
  );
  assert.ok(
    firstCard.indexOf("data-tap-wars-card-controls") <
      firstCard.indexOf('data-field="temperature"'),
  );
  assert.match(firstCard, /method="post"/u);
  assert.match(firstCard, /name="side" value="1"/u);
  assert.match(firstCard, />Vote for this tap<\/button>/u);
  assert.doesNotMatch(firstCard, /assignment|beverage|fillId|admin/u);

  const completed = createRenderer().render("/public/dashboard", {
    ...dashboard(tapWar("completed")),
  });
  assert.match(completed, /TAP WARS WINNER — Mystery Tap!/u);
  assert.doesNotMatch(completed, /data-tap-wars-participant=/u);
  assert.doesNotMatch(completed, /data-tap-wars-vote(?:\s|>)/u);
});

void test("live Mystery patches refresh the SVG accessible name from the incoming public DTO", async () => {
  const source = await readFile(new URL("../public/js/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function patchTap(tap)");
  const end = source.indexOf("const pourTimers", start);
  assert.ok(start >= 0 && end > start);
  const patch = source.slice(start, end);
  const labelStart = source.indexOf("function publicTapLabel");
  const labelEnd = source.indexOf("function isStoryCard", labelStart);
  assert.ok(labelStart >= 0 && labelEnd > labelStart);
  const labelHelper = source.slice(labelStart, labelEnd);

  assert.match(
    labelHelper,
    /return tap\.accessibleLabel \|\| tap\.title \|\| tap\.beverageName \|\| `Tap \$\{tap\.tapNumber\}`;/u,
  );
  assert.doesNotMatch(labelHelper, /tap\.(?:id|tapName)/u);
  assert.match(patch, /const graphicLabel = `\$\{publicTapLabel\(tap\)\} fill level`;/u);
  assert.match(
    patch,
    /applyGraphic\(svg, tap\);\s*svg\.setAttribute\("aria-label", graphicLabel\);\s*text\(svg\.querySelector\("title"\), graphicLabel\);/u,
  );
  assert.doesNotMatch(patch, /svg\.getAttribute\("aria-label"\)/u);
});

void test("a card retagged during a pour preview keeps everything but the preview class (#226)", async () => {
  const source = await readFile(new URL("../public/js/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function retagCard(card, tagName)");
  const end = source.indexOf("function promoteStoryCard", start);
  assert.ok(start >= 0 && end > start);

  // Just enough of an element for retagCard: attributes, a class list and moved children.
  class FakeElement {
    readonly attributes: { name: string; value: string }[] = [];
    readonly children: FakeElement[] = [];
    parent: FakeElement | undefined;
    replacedWith: FakeElement | undefined;
    readonly tagName: string;
    constructor(tagName: string) {
      this.tagName = tagName;
    }
    setAttribute(name: string, value: string) {
      const existing = this.attributes.find((attribute) => attribute.name === name);
      if (existing) existing.value = value;
      else this.attributes.push({ name, value });
    }
    getAttribute(name: string) {
      return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
    }
    get classList() {
      return {
        remove: (name: string) =>
          this.setAttribute(
            "class",
            (this.getAttribute("class") ?? "")
              .split(/\s+/u)
              .filter((value) => value !== "" && value !== name)
              .join(" "),
          ),
      };
    }
    get firstChild(): FakeElement | null {
      return this.children[0] ?? null;
    }
    // Appending moves the child, as in the DOM.
    append(child: FakeElement) {
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
    replaceWith(replacement: FakeElement) {
      this.replacedWith = replacement;
    }
  }
  const card = new FakeElement("a");
  card.setAttribute("class", "tap-card is-pour-preview");
  card.setAttribute("data-tap-id", "tap-1");
  const graphic = new FakeElement("svg");
  card.append(graphic);
  const retagCard = runInNewContext(`${source.slice(start, end)}; retagCard`, {
    document: { createElement: (tagName: string) => new FakeElement(tagName) },
  }) as (card: FakeElement, tagName: string) => FakeElement;

  const article = retagCard(card, "article");
  assert.equal(article.tagName, "article");
  assert.equal(card.replacedWith, article);
  assert.equal(article.getAttribute("class"), "tap-card");
  assert.equal(article.getAttribute("data-tap-id"), "tap-1");
  assert.deepEqual(article.children, [graphic]);
});

void test("live header patches preserve the public brand while updating nested connectivity text", async () => {
  const source = await readFile(new URL("../public/js/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function patchHeader(header)");
  const end = source.indexOf("function patchSharedDisplay", start);
  assert.ok(start >= 0 && end > start);
  const patch = source.slice(start, end);

  assert.match(
    patch,
    /text\(document\.querySelector\("\.public-brand"\), header\.tapboardName\);/u,
  );
  assert.match(
    patch,
    /text\(\s*document\.querySelector\("\.public-header \[data-connectivity-label\]"\),\s*header\.connectivityLabel,?\s*\);/u,
  );
  assert.doesNotMatch(patch, /querySelector\("\[data-connectivity-label\]"\)/u);
  assert.doesNotMatch(patch, /replaceChildren|innerHTML/u);
});

void test("Admin shell exposes all independently reachable navigation seams", () => {
  const html = createRenderer().render("/admin/overview", {
    page: { title: "Overview", path: "/admin/overview", csrfToken: "safe" },
    navItems: [
      "overview",
      "integrations",
      "beverages",
      "kegs",
      "fills",
      "taps",
      "tap-wars",
      "display",
      "system",
    ].map((name) => ({ label: name, href: `/admin/${name}` })),
    metrics: [],
    taps: [],
    health: [],
    connectivity: { state: "healthy", label: "Connected" },
    integrations: {
      telemetryConfigured: 0,
      brewfatherConfigured: false,
      brewfatherEnabled: false,
      brewfatherApiKeyConfigured: false,
      brewfatherLinkedBeverages: 0,
    },
  });
  for (const route of [
    "overview",
    "integrations",
    "beverages",
    "kegs",
    "fills",
    "taps",
    "tap-wars",
    "display",
    "system",
  ]) {
    assert.match(html, new RegExp(`href="/admin/${route}"`, "u"));
  }
  assert.match(html, /aria-current="page"/u);
  assert.match(html, /Skip to content/u);
  assert.match(html, /Connectivity and integrations/u);
  assert.match(html, /Health summary/u);
});

const SPLITS = [
  { votes: [1, 0], widths: [100, 0] },
  { votes: [1, 1], widths: [50, 50] },
  { votes: [0, 0], widths: [0, 0] },
] as const;

function splitWar(side1Votes: number, side2Votes: number): PublicTapWarView {
  const war = tapWar();
  const split = tapWarPercentages(side1Votes, side2Votes);
  const isTie = split !== null && split.side1 === split.side2;
  return {
    ...war,
    side1: { ...war.side1, voteCount: side1Votes, percentage: split?.side1 ?? null },
    side2: { ...war.side2, voteCount: side2Votes, percentage: split?.side2 ?? null },
    totalVotes: side1Votes + side2Votes,
    isTie,
    leaderSide: split === null || isTie ? null : split.side1 > split.side2 ? 1 : 2,
  };
}

function meterSegment(
  html: string,
  attribute: string,
  side: number,
): { readonly x: number; readonly width: number } {
  const tag = new RegExp(`<rect\\b[^>]*\\s${attribute}="${side}"[^>]*>`, "u").exec(html)?.[0];
  assert.ok(tag, `${attribute}="${side}" renders as an SVG rect`);
  const value = (name: string): number =>
    Number(new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1] ?? Number.NaN);
  return { x: value("x"), width: value("width") };
}

function assertNoInlineStyles(html: string): void {
  assert.doesNotMatch(html, /\sstyle\s*=/iu);
  assert.doesNotMatch(html, /<style\b/iu);
}

void test("public Tap Wars meters carry the split in SVG geometry, not inline styles", () => {
  for (const { votes, widths } of SPLITS) {
    const html = createRenderer().render("/public/dashboard", {
      ...dashboard(splitWar(votes[0], votes[1])),
    });
    assertNoInlineStyles(html);
    for (const attribute of ["data-tap-wars-meter-side", "data-tap-wars-dialog-meter-side"]) {
      assert.deepEqual(meterSegment(html, attribute, 1), { x: 0, width: widths[0] }, attribute);
      assert.deepEqual(
        meterSegment(html, attribute, 2),
        { x: widths[0], width: widths[1] },
        attribute,
      );
    }
    // The divider marks the split in themes whose two segment colours are close.
    const dividers = html.match(/<line\b[^>]*\sdata-tap-wars-meter-divider\b[^>]*>/gu) ?? [];
    assert.equal(dividers.length, 2);
    for (const divider of dividers) {
      assert.match(divider, new RegExp(`\\sx1="${widths[0]}"`, "u"));
      assert.match(divider, new RegExp(`\\sx2="${widths[0]}"`, "u"));
      const visible = widths[0] > 0 && widths[1] > 0 ? "visible" : "hidden";
      assert.match(divider, new RegExp(`\\svisibility="${visible}"`, "u"));
    }
  }
});

// One banner label's text, tags stripped: "Mystery Tap Tap 1 · 90%".
function bannerLabel(html: string, side: number): string {
  const start = html.indexOf(`data-tap-wars-label="${side}"`);
  assert.ok(start > 0, `banner label ${side} renders`);
  const end = html.indexOf("</em>", start);
  return html
    .slice(html.indexOf(">", start) + 1, end)
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

void test("the Tap Wars banner bar carries each side's title, tap and percentage inside it", () => {
  for (const { votes, labels } of [
    { votes: [9, 1], labels: ["Mystery Tap Tap 1 · 90%", "Public Porter Tap 3 · 10%"] },
    { votes: [1, 0], labels: ["Mystery Tap Tap 1 · 100%", "Public Porter Tap 3 · 0%"] },
    { votes: [1, 1], labels: ["Mystery Tap Tap 1 · 50%", "Public Porter Tap 3 · 50%"] },
    { votes: [0, 0], labels: ["Mystery Tap Tap 1 · —", "Public Porter Tap 3 · —"] },
  ] as const) {
    const html = createRenderer().render("/public/dashboard", {
      ...dashboard(splitWar(votes[0], votes[1])),
    });
    assertNoInlineStyles(html);
    assert.deepEqual([bannerLabel(html, 1), bannerLabel(html, 2)], labels, votes.join("/"));
    // The labels sit inside the role="img" bar, hidden from screen readers, which hear the
    // split once through the bar's aria-label.
    const meter = html.indexOf("data-tap-wars-meter ");
    assert.ok(meter > 0 && meter < html.indexOf('data-tap-wars-label="1"'));
    assert.ok(html.indexOf('data-tap-wars-label="2"') < html.indexOf("data-tap-wars-results"));
    assert.match(html, /class="tap-wars-banner__labels" aria-hidden="true"/u);
    assert.doesNotMatch(html, />vs</u);
  }
  // With no war, the labels still render empty so a live update can fill them in.
  const none = createRenderer().render("/public/dashboard", { ...dashboard() });
  assert.equal(bannerLabel(none, 1), "·");
  assert.equal(bannerLabel(none, 2), "·");
});

void test("Admin Tap Wars meters carry each side's share in SVG geometry, not inline styles", () => {
  for (const { votes, widths } of SPLITS) {
    const split = tapWarPercentages(votes[0], votes[1]);
    const html = createRenderer().render("/admin/tap-wars", {
      page: { title: "Tap Wars", path: "/admin/tap-wars", csrfToken: "safe" },
      navItems: [],
      tapWars: {
        current: {
          id: "00000000-0000-4000-8000-000000000175",
          status: "active",
          startedAt: "2026-11-14T12:00:00.000Z",
          totalVotes: votes[0] + votes[1],
          isTie: split !== null && split.side1 === split.side2,
          leaderSide: null,
          competitors: [1, 2].map((side) => ({
            side,
            tapNumber: side + 3,
            adminBeverageTitle: `Admin beverage ${side}`,
            voteCount: votes[side - 1],
            percentage: split === null ? null : side === 1 ? split.side1 : split.side2,
            eligible: true,
          })),
        },
        published: null,
        publicVisible: null,
        eligible: [],
        history: [],
      },
    });
    assertNoInlineStyles(html);
    assert.deepEqual(meterSegment(html, "data-war-meter", 1), { x: 0, width: widths[0] });
    assert.deepEqual(meterSegment(html, "data-war-meter", 2), { x: 0, width: widths[1] });
  }
});

void test("no view template writes an inline style the CSP would block", async () => {
  const root = new URL("../views/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".eta"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /\sstyle\s*=/iu, file);
    assert.doesNotMatch(source, /<style\b/iu, file);
  }
});
