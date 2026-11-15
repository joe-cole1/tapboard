import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../shared/canonical-json.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type {
  ExternalTelemetryRequestInput,
  MassUnit,
  NormalizedTelemetrySample,
  TemperatureUnit,
  VolumeUnit,
} from "./types.ts";
import { TELEMETRY_NORMALIZATION_VERSION as NORMALIZATION_VERSION } from "./types.ts";

export { canonicalizeJson };
export type { MassUnit, VolumeUnit, TemperatureUnit, NormalizedTelemetrySample };

const CANONICAL_DECIMAL_PLACES = 6;

// RFC3339 timestamp with the machine API's strict grammar: uppercase T,
// explicit uppercase Z or a complete +/-HH:MM offset.
const RFC3339_EXPLICIT_OFFSET_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const CLIENT_SAMPLE_ID_REGEX = /^[A-Za-z0-9_.:\/-]{1,128}$/;

const MASS_FACTORS_TO_GRAMS: Record<MassUnit, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

const VOLUME_FACTORS_TO_MILLILITERS: Record<VolumeUnit, number> = {
  ml: 1,
  l: 1000,
  us_fl_oz: 29.5735295625,
  us_gal: 3785.411784,
};

export function roundCanonicalNumber(
  value: number,
  decimals: number = CANONICAL_DECIMAL_PLACES,
): number {
  if (!Number.isFinite(value)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_number",
      clientMessage: "Measurement value must be a finite number.",
    });
  }
  const factor = 10 ** decimals;
  const shifted = (value + Number.EPSILON) * factor;
  if (!Number.isFinite(shifted)) {
    return value;
  }
  return Math.round(shifted) / factor;
}

export function parseRfc3339Timestamp(measuredAtRaw: unknown): {
  readonly isoString: string;
  readonly measuredAtEpochMs: number;
} {
  if (typeof measuredAtRaw !== "string" || measuredAtRaw.trim().length === 0) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.missing_measured_at",
      clientMessage: "Measurement timestamp 'measuredAt' is required.",
    });
  }

  if (!RFC3339_EXPLICIT_OFFSET_REGEX.test(measuredAtRaw)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_timestamp_format",
      clientMessage:
        "Measurement timestamp must be an RFC3339/ISO-8601 string with an explicit timezone offset.",
    });
  }

  const parts = RFC3339_EXPLICIT_OFFSET_REGEX.exec(measuredAtRaw);
  // The lexical check above is intentionally followed by calendar/range
  // checks because Date.parse normalizes some impossible calendar dates.
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  const hour = Number(parts?.[4]);
  const minute = Number(parts?.[5]);
  const second = Number(parts?.[6]);
  const offset = parts?.[8];
  const offsetHour = offset === "Z" ? 0 : Number(offset?.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset?.slice(4, 6));
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_timestamp",
      clientMessage: "Measurement timestamp is not a valid RFC3339 calendar instant.",
    });
  }

  const epochMs = Date.parse(measuredAtRaw);
  if (!Number.isSafeInteger(epochMs)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_timestamp",
      clientMessage: "Measurement timestamp is not a valid RFC3339 calendar instant.",
    });
  }

  const isoString = new Date(epochMs).toISOString();
  return { isoString, measuredAtEpochMs: epochMs };
}

export function isValidClientSampleId(clientSampleId: unknown): boolean {
  if (typeof clientSampleId !== "string") {
    return false;
  }
  if (Buffer.byteLength(clientSampleId, "utf8") > 128) {
    return false;
  }
  return CLIENT_SAMPLE_ID_REGEX.test(clientSampleId);
}

/**
 * Converts a wire sample that `validateExternalTelemetryPayload` has already
 * accepted into canonical units (grams, millilitres, percent, Celsius).
 */
export function normalizeExternalTelemetrySample(
  input: ExternalTelemetryRequestInput,
): NormalizedTelemetrySample {
  const { isoString: measuredAt, measuredAtEpochMs } = parseRfc3339Timestamp(input.measured_at);
  const { measurement } = input;
  const primary =
    measurement.kind === "total_weight"
      ? {
          totalMassG: roundCanonicalNumber(
            measurement.value * MASS_FACTORS_TO_GRAMS[measurement.unit],
          ),
        }
      : measurement.kind === "remaining_volume"
        ? {
            remainingVolumeMl: roundCanonicalNumber(
              measurement.value * VOLUME_FACTORS_TO_MILLILITERS[measurement.unit],
            ),
          }
        : { fillPercentage: roundCanonicalNumber(measurement.value) };
  const temperature = input.temperature;
  const temperatureC =
    temperature === undefined
      ? undefined
      : roundCanonicalNumber(
          temperature.unit === "c" ? temperature.value : ((temperature.value - 32) * 5) / 9,
        );

  return {
    ...(input.client_sample_id !== undefined ? { clientSampleId: input.client_sample_id } : {}),
    measuredAt,
    measuredAtEpochMs,
    normalizationVersion: NORMALIZATION_VERSION,
    primaryKind: measurement.kind,
    ...primary,
    ...(temperatureC !== undefined ? { temperatureC } : {}),
  };
}

export function computeSemanticPayloadDigest(
  sample: NormalizedTelemetrySample,
  tapId: string,
): string {
  const canonicalObject = {
    fill_percentage: sample.fillPercentage ?? null,
    measured_at_epoch_ms: sample.measuredAtEpochMs,
    normalization_version: NORMALIZATION_VERSION,
    primary_kind: sample.primaryKind,
    remaining_volume_ml: sample.remainingVolumeMl ?? null,
    tap_id: tapId,
    temperature_c: sample.temperatureC ?? null,
    total_mass_g: sample.totalMassG ?? null,
  };

  const jsonString = canonicalizeJson(canonicalObject);
  return createHash("sha256").update(jsonString, "utf8").digest("hex");
}
