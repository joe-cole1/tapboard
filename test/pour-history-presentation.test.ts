import assert from "node:assert/strict";
import test from "node:test";
import { ML_PER_US_FL_OZ } from "../src/features/forecasting/forecast.ts";
import {
  pourHistoryEntry,
  pourVolume,
  relativeTimeLabel,
} from "../src/features/web/admin/presentation.ts";

const NOW = "2026-11-20T15:42:00.000Z";
const before = (milliseconds: number) => new Date(Date.parse(NOW) - milliseconds).toISOString();

void test("relative pour times use seconds, minutes, then hours within the same day", () => {
  assert.equal(relativeTimeLabel(NOW, NOW), "now");
  assert.equal(relativeTimeLabel(before(1_000), NOW), "1 second ago");
  assert.equal(relativeTimeLabel(before(12_000), NOW), "12 seconds ago");
  assert.equal(relativeTimeLabel(before(59_999), NOW), "59 seconds ago");
  assert.equal(relativeTimeLabel(before(60_000), NOW), "1 minute ago");
  assert.equal(relativeTimeLabel(before(5 * 60_000), NOW), "5 minutes ago");
  assert.equal(relativeTimeLabel(before(3_599_999), NOW), "59 minutes ago");
  assert.equal(relativeTimeLabel(before(3_600_000), NOW), "1 hour ago");
  assert.equal(relativeTimeLabel(before(3 * 3_600_000), NOW), "3 hours ago");
  assert.equal(relativeTimeLabel("2026-11-20T00:00:00.000Z", NOW), "15 hours ago");
});

void test("relative pour times switch to calendar days at UTC midnight", () => {
  // Under an hour across midnight is still counted in minutes.
  assert.equal(
    relativeTimeLabel("2026-11-19T23:50:00.000Z", "2026-11-20T00:10:00.000Z"),
    "20 minutes ago",
  );
  // Three hours across midnight is the previous day, not "3 hours ago".
  assert.equal(
    relativeTimeLabel("2026-11-19T22:00:00.000Z", "2026-11-20T01:00:00.000Z"),
    "yesterday",
  );
  assert.equal(relativeTimeLabel("2026-11-19T00:00:00.000Z", NOW), "yesterday");
  assert.equal(relativeTimeLabel("2026-11-18T23:59:59.999Z", NOW), "2 days ago");
  assert.equal(relativeTimeLabel("2026-11-16T15:42:00.000Z", NOW), "4 days ago");
  // Crossing a month and a year still counts calendar days.
  assert.equal(
    relativeTimeLabel("2025-12-31T23:00:00.000Z", "2026-01-01T02:00:00.000Z"),
    "yesterday",
  );
});

void test("relative pour times tolerate clock skew and invalid input", () => {
  assert.equal(relativeTimeLabel("2026-11-20T15:43:00.000Z", NOW), "now");
  assert.equal(relativeTimeLabel("not a time", NOW), "Unknown");
  assert.equal(relativeTimeLabel(NOW, "not a time"), "Unknown");
});

void test("pour volumes use fl oz for US and whole millilitres for metric", () => {
  assert.equal(pourVolume(12 * ML_PER_US_FL_OZ, "us"), "12.0 fl oz");
  assert.equal(pourVolume(500, "us"), "16.9 fl oz");
  assert.equal(pourVolume(354.88235475, "metric"), "355 mL");
  assert.equal(pourVolume(29.5735295625, "metric"), "30 mL");
  assert.equal(pourVolume(0.4, "metric"), "0 mL");
});

void test("a pour history entry pairs the relative time with the Admin timestamp", () => {
  assert.deepEqual(pourHistoryEntry({ volumeMl: 500, completedAt: before(5 * 60_000) }, NOW), {
    completedAt: "2026-11-20T15:37:00.000Z",
    relativeLabel: "5 minutes ago",
    absoluteLabel: "Nov 20, 2026, 3:37 PM UTC",
    volumeLabels: { us: "16.9 fl oz", metric: "500 mL" },
  });
});
