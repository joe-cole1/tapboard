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
  assert.equal(relativeTimeLabel(NOW, NOW, "UTC"), "now");
  assert.equal(relativeTimeLabel(before(1_000), NOW, "UTC"), "1 second ago");
  assert.equal(relativeTimeLabel(before(12_000), NOW, "UTC"), "12 seconds ago");
  assert.equal(relativeTimeLabel(before(59_999), NOW, "UTC"), "59 seconds ago");
  assert.equal(relativeTimeLabel(before(60_000), NOW, "UTC"), "1 minute ago");
  assert.equal(relativeTimeLabel(before(5 * 60_000), NOW, "UTC"), "5 minutes ago");
  assert.equal(relativeTimeLabel(before(3_599_999), NOW, "UTC"), "59 minutes ago");
  assert.equal(relativeTimeLabel(before(3_600_000), NOW, "UTC"), "1 hour ago");
  assert.equal(relativeTimeLabel(before(3 * 3_600_000), NOW, "UTC"), "3 hours ago");
  assert.equal(relativeTimeLabel("2026-11-20T00:00:00.000Z", NOW, "UTC"), "15 hours ago");
});

void test("relative pour times switch to calendar days at UTC midnight", () => {
  // Under an hour across midnight is still counted in minutes.
  assert.equal(
    relativeTimeLabel("2026-11-19T23:50:00.000Z", "2026-11-20T00:10:00.000Z", "UTC"),
    "20 minutes ago",
  );
  // Three hours across midnight is the previous day, not "3 hours ago".
  assert.equal(
    relativeTimeLabel("2026-11-19T22:00:00.000Z", "2026-11-20T01:00:00.000Z", "UTC"),
    "yesterday",
  );
  assert.equal(relativeTimeLabel("2026-11-19T00:00:00.000Z", NOW, "UTC"), "yesterday");
  assert.equal(relativeTimeLabel("2026-11-18T23:59:59.999Z", NOW, "UTC"), "2 days ago");
  assert.equal(relativeTimeLabel("2026-11-16T15:42:00.000Z", NOW, "UTC"), "4 days ago");
  // Crossing a month and a year still counts calendar days.
  assert.equal(
    relativeTimeLabel("2025-12-31T23:00:00.000Z", "2026-01-01T02:00:00.000Z", "UTC"),
    "yesterday",
  );
});

void test("relative pour times tolerate clock skew and invalid input", () => {
  assert.equal(relativeTimeLabel("2026-11-20T15:43:00.000Z", NOW, "UTC"), "now");
  assert.equal(relativeTimeLabel("not a time", NOW, "UTC"), "Unknown");
  assert.equal(relativeTimeLabel(NOW, "not a time", "UTC"), "Unknown");
});

void test("pour volumes use fl oz for US and whole millilitres for metric", () => {
  assert.equal(pourVolume(12 * ML_PER_US_FL_OZ, "us"), "12.0 fl oz");
  assert.equal(pourVolume(500, "us"), "16.9 fl oz");
  assert.equal(pourVolume(354.88235475, "metric"), "355 mL");
  assert.equal(pourVolume(29.5735295625, "metric"), "30 mL");
  assert.equal(pourVolume(0.4, "metric"), "0 mL");
});

void test("a pour history entry pairs the relative time with the Admin timestamp", () => {
  assert.deepEqual(
    pourHistoryEntry({ volumeMl: 500, completedAt: before(5 * 60_000) }, NOW, "UTC"),
    {
      completedAt: "2026-11-20T15:37:00.000Z",
      relativeLabel: "5 minutes ago",
      absoluteLabel: "Nov 20, 2026, 3:37 PM UTC",
      volumeLabels: { us: "16.9 fl oz", metric: "500 mL" },
    },
  );
});

const NEW_YORK = "America/New_York";

void test("relative pour days follow the display time zone's midnight, not UTC's", () => {
  // 6 PM to 9 PM Eastern on Nov 20 crosses UTC midnight but not New York's.
  assert.equal(
    relativeTimeLabel("2026-11-20T23:00:00.000Z", "2026-11-21T02:00:00.000Z", NEW_YORK),
    "3 hours ago",
  );
  assert.equal(
    relativeTimeLabel("2026-11-20T23:00:00.000Z", "2026-11-21T02:00:00.000Z", "UTC"),
    "yesterday",
  );
  // 11 PM to 2 AM Eastern crosses New York's midnight but not UTC's.
  assert.equal(
    relativeTimeLabel("2026-11-21T04:00:00.000Z", "2026-11-21T07:00:00.000Z", NEW_YORK),
    "yesterday",
  );
  assert.equal(
    relativeTimeLabel("2026-11-21T04:00:00.000Z", "2026-11-21T07:00:00.000Z", "UTC"),
    "3 hours ago",
  );
});

void test("relative pour days count calendar days across daylight-saving changes", () => {
  // Nov 1, 2026 has 25 hours in New York: 12:30 AM EDT to 11:30 PM EST is the same day.
  assert.equal(
    relativeTimeLabel("2026-11-01T04:30:00.000Z", "2026-11-02T04:30:00.000Z", NEW_YORK),
    "24 hours ago",
  );
  // 11:30 PM EDT on Oct 31 is yesterday at 11:30 PM EST on Nov 1, and two days before 12:30 AM on Nov 2.
  assert.equal(
    relativeTimeLabel("2026-11-01T03:30:00.000Z", "2026-11-02T04:30:00.000Z", NEW_YORK),
    "yesterday",
  );
  assert.equal(
    relativeTimeLabel("2026-11-01T03:30:00.000Z", "2026-11-02T05:30:00.000Z", NEW_YORK),
    "2 days ago",
  );
  // Mar 8, 2026 has 23 hours: 12:30 AM EST to 11:30 PM EDT is still the same day.
  assert.equal(
    relativeTimeLabel("2026-03-08T05:30:00.000Z", "2026-03-09T03:30:00.000Z", NEW_YORK),
    "22 hours ago",
  );
});

void test("a pour history entry in a non-UTC zone uses that zone for both labels", () => {
  assert.deepEqual(
    pourHistoryEntry(
      { volumeMl: 500, completedAt: "2026-11-21T04:00:00.000Z" },
      "2026-11-21T07:00:00.000Z",
      NEW_YORK,
    ),
    {
      completedAt: "2026-11-21T04:00:00.000Z",
      relativeLabel: "yesterday",
      absoluteLabel: "Nov 20, 2026, 11:00 PM EST",
      volumeLabels: { us: "16.9 fl oz", metric: "500 mL" },
    },
  );
});
