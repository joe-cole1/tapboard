/**
 * The registry of telemetry metrics Tapboard accepts. A reading whose metric is not listed
 * here is rejected (roadmap #164, decision 1).
 *
 * - `level` metrics measure how much beer is in the keg. They feed interpretation and the pour
 *   detector, so a new level metric also needs code in `interpretation.ts` and a migration
 *   (`primary_kind` keeps a CHECK list). A sample carries at most one level reading.
 * - `condition` metrics (temperature) feed health and the display.
 * - `recorded` metrics are stored only.
 *
 * A `condition` or `recorded` metric needs only an entry here: readings are stored in the
 * generic `telemetry_readings` and `telemetry_source_tap_readings` tables.
 */
export type TelemetryMetricRole = "level" | "condition" | "recorded";

export interface TelemetryMetricDefinition {
  readonly role: TelemetryMetricRole;
  readonly canonicalUnit: string;
  /** Accepted wire units, in the order error messages list them, each converting to canonical. */
  readonly units: Readonly<Record<string, (value: number) => number>>;
  /** Inclusive bounds on the wire value, before unit conversion. */
  readonly min?: number;
  readonly max?: number;
  /**
   * The legacy column that also stores this metric, and its key in the semantic digest. Only
   * the metrics that existed before the registry have one.
   */
  readonly column?: "total_mass_g" | "remaining_volume_ml" | "fill_percentage" | "temperature_c";
}

const identity = (value: number): number => value;
const factor =
  (multiplier: number) =>
  (value: number): number =>
    value * multiplier;

export const TELEMETRY_METRICS: Readonly<Record<string, TelemetryMetricDefinition>> = {
  total_weight: {
    role: "level",
    canonicalUnit: "g",
    units: { g: identity, kg: factor(1000), oz: factor(28.349523125), lb: factor(453.59237) },
    min: 0,
    column: "total_mass_g",
  },
  remaining_volume: {
    role: "level",
    canonicalUnit: "ml",
    units: {
      ml: identity,
      l: factor(1000),
      us_fl_oz: factor(29.5735295625),
      us_gal: factor(3785.411784),
    },
    min: 0,
    column: "remaining_volume_ml",
  },
  fill_percentage: {
    role: "level",
    canonicalUnit: "percent",
    units: { percent: identity },
    min: 0,
    max: 100,
    column: "fill_percentage",
  },
  temperature: {
    role: "condition",
    canonicalUnit: "c",
    units: { c: identity, f: (value) => ((value - 32) * 5) / 9 },
    min: -100,
    max: 150,
    column: "temperature_c",
  },
};

export function telemetryMetric(metric: string): TelemetryMetricDefinition | undefined {
  return Object.hasOwn(TELEMETRY_METRICS, metric) ? TELEMETRY_METRICS[metric] : undefined;
}

export function telemetryMetricNames(role?: TelemetryMetricRole): readonly string[] {
  return Object.keys(TELEMETRY_METRICS).filter(
    (metric) => role === undefined || TELEMETRY_METRICS[metric]!.role === role,
  );
}
