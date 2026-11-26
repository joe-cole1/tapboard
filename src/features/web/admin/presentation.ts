import { ML_PER_US_FL_OZ } from "../../forecasting/forecast.ts";

export function volume(ml: number, unit: string): string {
  return unit === "metric" ? `${(ml / 1000).toFixed(1)} L` : `${(ml / 3785.411784).toFixed(1)} gal`;
}

/** A single pour is too small for litres or gallons. */
export function pourVolume(ml: number, unit: string): string {
  return unit === "metric" ? `${Math.round(ml)} mL` : `${(ml / ML_PER_US_FL_OZ).toFixed(1)} fl oz`;
}

export function capacityLabel(ml: number, unit: string): string {
  return volume(ml, unit);
}

export function tareLabel(grams: number, unit: string): string {
  if (unit === "metric") return `${(grams / 1000).toFixed(2)} kg`;
  const totalOunces = Math.max(0, Math.round(grams / 28.349523125));
  const pounds = Math.floor(totalOunces / 16);
  const ounces = totalOunces % 16;
  return `${pounds} lb ${ounces} oz`;
}

export function isActionableHealth(state: string, severity: string): boolean {
  return state === "active" || severity === "warning" || severity === "critical";
}

export function temperature(c: number, unit: string): string {
  return unit === "metric" ? `${c.toFixed(1)} °C` : `${((c * 9) / 5 + 32).toFixed(1)} °F`;
}

export const ADMIN_TIMESTAMP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function adminTimestampLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const hour24 = date.getUTCHours();
  const hour = hour24 % 12 || 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${ADMIN_TIMESTAMP_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour}:${minute} ${hour24 < 12 ? "AM" : "PM"} UTC`;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
const DAY_MS = 86_400_000;

/**
 * "12 seconds ago", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago".
 * Hours apply only within the same calendar day, so a pour before midnight
 * reads "yesterday". Days follow adminTimestampLabel and use UTC.
 */
export function relativeTimeLabel(value: string, now: string): string {
  const at = Date.parse(value);
  const current = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(current)) return "Unknown";
  const seconds = Math.floor(Math.max(0, current - at) / 1000);
  if (seconds < 60) return RELATIVE_TIME.format(-seconds, "second");
  if (seconds < 3600) return RELATIVE_TIME.format(-Math.floor(seconds / 60), "minute");
  const days = Math.floor(current / DAY_MS) - Math.floor(at / DAY_MS);
  if (days === 0) return RELATIVE_TIME.format(-Math.floor(seconds / 3600), "hour");
  return RELATIVE_TIME.format(-days, "day");
}

export interface PourHistoryEntry {
  readonly completedAt: string;
  readonly relativeLabel: string;
  readonly absoluteLabel: string;
  readonly volumeLabels: { readonly us: string; readonly metric: string };
}

export function pourHistoryEntry(
  pour: { readonly volumeMl: number; readonly completedAt: string },
  now: string,
): PourHistoryEntry {
  return {
    completedAt: pour.completedAt,
    relativeLabel: relativeTimeLabel(pour.completedAt, now),
    absoluteLabel: adminTimestampLabel(pour.completedAt),
    volumeLabels: {
      us: pourVolume(pour.volumeMl, "us"),
      metric: pourVolume(pour.volumeMl, "metric"),
    },
  };
}

/** A status label, rendered by `views/partials/status-badge.eta`. */
export interface StatusBadge {
  readonly label: string;
  /** A `badge--*` variant; none for a neutral badge. */
  readonly tone?: string;
  /** Live save replaces the label with this field of the saved resource. */
  readonly labelField?: string;
  /** Live save replaces the tone with this field of the saved resource. */
  readonly toneField?: string;
}

/** The top of an Admin page, rendered by `views/partials/page-header.eta`. */
export interface PageHeader {
  readonly title: string;
  /** Live save replaces the title with this field of the saved resource. */
  readonly titleField?: string;
  readonly colourCue?: string;
  readonly badge?: StatusBadge;
  readonly intro?: string;
  /** A link that ends the intro sentence. */
  readonly introLink?: { readonly label: string; readonly href: string };
  readonly updated?: { readonly datetime: string; readonly label: string };
}

/** A linked count, rendered by `views/partials/stat-tiles.eta`. */
export interface StatTile {
  readonly label: string;
  readonly value: string | number;
  readonly href: string;
}

export interface PageLink {
  readonly label: string;
  readonly href: string;
}

/** Links between the pages of a list, rendered by `views/partials/pagination.eta`. */
export interface PageNavigation {
  readonly label: string;
  readonly previous: PageLink | null;
  readonly status: string | null;
  readonly next: PageLink | null;
}

/** Previous, "Page n of m" and Next for a numbered list; null when there is nowhere to go. */
export function numberedPageNavigation(
  label: string,
  page: number,
  pageCount: number,
  previousHref: string | null,
  nextHref: string | null,
): PageNavigation | null {
  if (previousHref === null && nextHref === null) return null;
  return {
    label,
    previous: previousHref === null ? null : { label: "Previous", href: previousHref },
    status: `Page ${page} of ${pageCount}`,
    next: nextHref === null ? null : { label: "Next", href: nextHref },
  };
}
