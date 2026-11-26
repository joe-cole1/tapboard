/**
 * The household's display time zone. Intl's list has no "UTC" entry (and uses ICU's
 * canonical names, such as Asia/Calcutta), so UTC is allowed by name and listed first.
 */
export const TIME_ZONES: readonly string[] = ["UTC", ...Intl.supportedValuesOf("timeZone")];

const SUPPORTED = new Set(TIME_ZONES);

export function isTimeZone(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED.has(value);
}

export interface ZonedParts {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
  /** 1 to 12. */
  readonly hour12: number;
  readonly minute: number;
  readonly dayPeriod: "AM" | "PM";
  /** Intl's short name, such as "UTC", "EST" or "GMT+1". */
  readonly zoneName: string;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = FORMATTERS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    FORMATTERS.set(timeZone, format);
  }
  return format;
}

/** The wall-clock parts of an instant in a zone; the zone must pass `isTimeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const hour23 = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour12: hour23 % 12 || 12,
    minute: Number(parts.minute),
    dayPeriod: hour23 < 12 ? "AM" : "PM",
    zoneName: parts.timeZoneName ?? timeZone,
  };
}

const DAY_MS = 86_400_000;

/** A whole-day number for the instant's calendar date in the zone, for day differences. */
export function calendarDay(instant: Date, timeZone: string): number {
  const { year, month, day } = zonedParts(instant, timeZone);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** The instant's calendar date in the zone, as YYYY-MM-DD. */
export function calendarDate(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
