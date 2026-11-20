import {
  HEALTH_CHECK_IDS,
  type EffectiveHealthConfig,
  type HealthCheckId,
  type HealthConfig,
  type HealthConfigInheritance,
  type HealthConfigInherited,
  type HealthConfigOverride,
  type HealthConfigSource,
  type LineCleaningDueHealthConfig,
  type LowKegHealthConfig,
  type ScaleAvailabilityHealthConfig,
  type ServingTemperatureHealthConfig,
  type SuspectedLeakHealthConfig,
  type ThresholdHealthCheckId,
  type ThresholdHealthConfig,
} from "./types.ts";

export const LOW_KEG_CONFIG_FIELDS = [
  "enabled",
  "thresholdPercent",
  "criticalPercent",
  "fixedThresholdMl",
  "settlingMs",
] as const satisfies readonly (keyof LowKegHealthConfig)[];

export const SCALE_AVAILABILITY_CONFIG_FIELDS = [
  "enabled",
  "degradedAfterMs",
  "activeAfterMs",
] as const satisfies readonly (keyof ScaleAvailabilityHealthConfig)[];

export const SUSPECTED_LEAK_CONFIG_FIELDS = [
  "enabled",
  "lossThresholdMl",
  "windowMs",
  "pourGraceMs",
  "settlingMs",
  "resetMovementMl",
  "maxSamples",
] as const satisfies readonly (keyof SuspectedLeakHealthConfig)[];

export const SERVING_TEMPERATURE_CONFIG_FIELDS = [
  "enabled",
  "normalMinC",
  "normalMaxC",
  "criticalMinC",
  "criticalMaxC",
  "durationMs",
] as const satisfies readonly (keyof ServingTemperatureHealthConfig)[];

export const LINE_CLEANING_DUE_CONFIG_FIELDS = [
  "enabled",
  "intervalDays",
  "criticalGraceDays",
] as const satisfies readonly (keyof LineCleaningDueHealthConfig)[];

export const THRESHOLD_CONFIG_FIELDS = [
  "enabled",
  "normalMin",
  "normalMax",
  "criticalMin",
  "criticalMax",
  "durationMs",
] as const satisfies readonly (keyof ThresholdHealthConfig)[];

/**
 * Each threshold check's condition metric (a `condition` metric in `TELEMETRY_METRICS`) and
 * default ranges in that metric's canonical unit. Every default check is disabled.
 */
export const THRESHOLD_HEALTH_CHECKS: Readonly<
  Record<
    ThresholdHealthCheckId,
    { readonly metric: string; readonly defaults: ThresholdHealthConfig }
  >
> = {
  // Gauge serving pressure in kPa: normal about 10–18 psi, critical below 5 or above 30 psi.
  serving_pressure: {
    metric: "pressure",
    defaults: {
      enabled: false,
      normalMin: 68.94757293168,
      normalMax: 124.105631277024,
      criticalMin: 34.47378646584,
      criticalMax: 206.84271879504,
      durationMs: 15 * 60_000,
    },
  },
};

export const HEALTH_CONFIG_FIELDS: {
  readonly [K in HealthCheckId]: readonly (keyof HealthConfig[K])[];
} = {
  low_keg: LOW_KEG_CONFIG_FIELDS,
  scale_availability: SCALE_AVAILABILITY_CONFIG_FIELDS,
  suspected_leak: SUSPECTED_LEAK_CONFIG_FIELDS,
  serving_temperature: SERVING_TEMPERATURE_CONFIG_FIELDS,
  line_cleaning_due: LINE_CLEANING_DUE_CONFIG_FIELDS,
  serving_pressure: THRESHOLD_CONFIG_FIELDS,
};

export function isThresholdHealthCheckId(id: string): id is ThresholdHealthCheckId {
  return Object.hasOwn(THRESHOLD_HEALTH_CHECKS, id);
}

/** Canonical v2 health defaults.  Volumes are millilitres and temperatures Celsius. */
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  low_keg: {
    enabled: true,
    thresholdPercent: 20,
    criticalPercent: 5,
    fixedThresholdMl: 0,
    settlingMs: 30_000,
  },
  scale_availability: {
    enabled: true,
    degradedAfterMs: 5 * 60_000,
    activeAfterMs: 30 * 60_000,
  },
  suspected_leak: {
    enabled: false,
    lossThresholdMl: 236.5882365,
    windowMs: 15 * 60_000,
    pourGraceMs: 2 * 60_000,
    settlingMs: 10 * 60_000,
    resetMovementMl: 946.352946,
    maxSamples: 64,
  },
  serving_temperature: {
    enabled: false,
    normalMinC: 1.1111111111111112,
    normalMaxC: 5.555555555555555,
    criticalMinC: -1.1111111111111112,
    criticalMaxC: 10,
    durationMs: 15 * 60_000,
  },
  line_cleaning_due: {
    enabled: false,
    intervalDays: 14,
    criticalGraceDays: 7,
  },
  serving_pressure: THRESHOLD_HEALTH_CHECKS.serving_pressure.defaults,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCompleteConfigShape(value: unknown): value is HealthConfig {
  if (!isRecord(value)) return false;
  return HEALTH_CHECK_IDS.every((id) => {
    const section = value[id];
    return (
      isRecord(section) && HEALTH_CONFIG_FIELDS[id].every((field) => Object.hasOwn(section, field))
    );
  });
}

type ConfigSection = HealthConfig[HealthCheckId];
type OverrideSection = HealthConfigOverride[HealthCheckId];

function mergeSection<T extends ConfigSection>(base: T, override: OverrideSection): T {
  if (override === null || override === undefined) return { ...base };
  const result = { ...base } as Record<string, unknown>;
  for (const [field, value] of Object.entries(override)) {
    if (value !== null && value !== undefined) result[field] = value;
  }
  return result as T;
}

/**
 * Merge nullable per-field overrides without mutating either input.  `null`
 * and `undefined` both inherit the base value; explicit nulls are therefore
 * safe to persist as a clear operation before resolving the effective config.
 */
export function mergeHealthConfig(
  base: HealthConfig,
  override: HealthConfigOverride | null | undefined,
): HealthConfig;
export function mergeHealthConfig(override: HealthConfigOverride | null | undefined): HealthConfig;
export function mergeHealthConfig(
  baseOrOverride: HealthConfig | HealthConfigOverride | null | undefined = DEFAULT_HEALTH_CONFIG,
  maybeOverride?: HealthConfigOverride | null,
): HealthConfig {
  const base =
    maybeOverride === undefined && !hasCompleteConfigShape(baseOrOverride)
      ? DEFAULT_HEALTH_CONFIG
      : (baseOrOverride as HealthConfig);
  const override =
    maybeOverride === undefined && !hasCompleteConfigShape(baseOrOverride)
      ? (baseOrOverride as HealthConfigOverride | null | undefined)
      : maybeOverride;
  const source = override ?? null;
  const result = {} as Record<HealthCheckId, ConfigSection>;
  for (const id of HEALTH_CHECK_IDS) result[id] = mergeSection(base[id], source?.[id]);
  return result as HealthConfig;
}

function sectionInheritance(
  fields: readonly PropertyKey[],
  override: OverrideSection,
): Record<string, HealthConfigSource> {
  const result: Record<string, HealthConfigSource> = {};
  const values = override as unknown as Record<string, unknown> | null | undefined;
  for (const field of fields as readonly string[]) {
    result[field] =
      values !== null &&
      values !== undefined &&
      Object.hasOwn(values, field) &&
      values[field] !== null &&
      values[field] !== undefined
        ? "override"
        : "default";
  }
  return result;
}

function inheritanceFor(
  override: HealthConfigOverride | null | undefined,
): HealthConfigInheritance {
  const source = override ?? null;
  const result: Record<string, Record<string, HealthConfigSource>> = {};
  for (const id of HEALTH_CHECK_IDS) {
    result[id] = sectionInheritance(HEALTH_CONFIG_FIELDS[id], source?.[id]);
  }
  return result as unknown as HealthConfigInheritance;
}

function inheritedFor(inheritance: HealthConfigInheritance): HealthConfigInherited {
  const result = {} as Record<HealthCheckId, Record<string, boolean>>;
  for (const id of HEALTH_CHECK_IDS) {
    const section = {} as Record<string, boolean>;
    const sources = inheritance[id] as unknown as Record<string, HealthConfigSource>;
    for (const field of HEALTH_CONFIG_FIELDS[id] as readonly string[]) {
      section[field] = sources[field] === "default";
    }
    result[id] = section;
  }
  return result as HealthConfigInherited;
}

/** Resolve an override and include field-level inheritance metadata. */
export function resolveHealthConfig(
  override?: HealthConfigOverride | null,
  base?: HealthConfig,
): EffectiveHealthConfig;
export function resolveHealthConfig(
  base: HealthConfig,
  override?: HealthConfigOverride | null,
): EffectiveHealthConfig;
export function resolveHealthConfig(
  first?: HealthConfig | HealthConfigOverride | null,
  second?: HealthConfig | HealthConfigOverride | null,
): EffectiveHealthConfig {
  const firstIsBase = hasCompleteConfigShape(first);
  const base = firstIsBase
    ? first
    : hasCompleteConfigShape(second)
      ? second
      : DEFAULT_HEALTH_CONFIG;
  const override = firstIsBase ? second : first;
  const effective = mergeHealthConfig(base, override);
  const inheritance = inheritanceFor(override);
  return {
    effective,
    effectiveConfig: effective,
    inheritance,
    sources: inheritance,
    inherited: inheritedFor(inheritance),
    override: override ?? null,
  };
}

export function healthConfigsEqual(left: HealthConfig, right: HealthConfig): boolean {
  return HEALTH_CHECK_IDS.every((id) => {
    const a = left[id] as unknown as Record<string, unknown>;
    const b = right[id] as unknown as Record<string, unknown>;
    return (HEALTH_CONFIG_FIELDS[id] as readonly string[]).every((field) => a[field] === b[field]);
  });
}

/** True when a patch has no effective change (all null/undefined is a no-op). */
export function isNoopHealthConfigOverride(
  override: HealthConfigOverride | null | undefined,
  base: HealthConfig = DEFAULT_HEALTH_CONFIG,
): boolean {
  return healthConfigsEqual(mergeHealthConfig(base, override), base);
}

/** Canonical clear operation for a per-Tap override row. */
export function clearHealthConfigOverride(): null {
  return null;
}

/** Resolve a maintenance interval without consulting a clock or persistence. */
export function lineCleaningDueAtMs(
  cleanedAtMs: number,
  config: Pick<
    LineCleaningDueHealthConfig,
    "intervalDays"
  > = DEFAULT_HEALTH_CONFIG.line_cleaning_due,
): number {
  return cleanedAtMs + config.intervalDays * 86_400_000;
}

export function lineCleaningCriticalAtMs(
  dueAtMs: number,
  config: Pick<
    LineCleaningDueHealthConfig,
    "criticalGraceDays"
  > = DEFAULT_HEALTH_CONFIG.line_cleaning_due,
): number {
  return dueAtMs + config.criticalGraceDays * 86_400_000;
}

export function calculateLineCleaningDue(
  cleanedAtMs: number,
  config: Pick<
    LineCleaningDueHealthConfig,
    "intervalDays" | "criticalGraceDays"
  > = DEFAULT_HEALTH_CONFIG.line_cleaning_due,
): { readonly cleanedAtMs: number; readonly dueAtMs: number; readonly criticalAtMs: number } {
  const dueAtMs = lineCleaningDueAtMs(cleanedAtMs, config);
  return { cleanedAtMs, dueAtMs, criticalAtMs: lineCleaningCriticalAtMs(dueAtMs, config) };
}

// Keep the default object structurally immutable for service callers.
for (const id of HEALTH_CHECK_IDS) Object.freeze(DEFAULT_HEALTH_CONFIG[id]);
Object.freeze(DEFAULT_HEALTH_CONFIG);
