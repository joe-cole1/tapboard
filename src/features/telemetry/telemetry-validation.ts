import {
  requireUuid,
  validationError,
  rejectUnknownKeys,
  requireBoundedNonemptyString,
  requireIntegerInRange,
  requirePlainObject,
} from "../../shared/validation.ts";
import {
  telemetryMetric,
  telemetryMetricNames,
  type TelemetryMetricDefinition,
} from "./metrics.ts";
import { isValidClientSampleId, parseRfc3339Timestamp } from "./normalization.ts";
import type {
  AssignAuthorityInput,
  CreateTelemetrySourceInput,
  ExternalBatchTelemetryRequestInput,
  ExternalBatchTelemetryRequestSampleInput,
  ExternalTelemetryReadingInput,
  ExternalTelemetryRequestInput,
  RenameTelemetrySourceInput,
  RotateTelemetrySourceInput,
  UpdateTelemetrySettingsInput,
} from "./types.ts";

const MAX_SOURCE_NAME_LENGTH = 120;
const MAX_MACHINE_KEY_LABEL_LENGTH = 120;
const MAX_EXTERNAL_BATCH_SIZE = 100;
/** Metric names this format may be echoed back in an error message. */
const ECHOABLE_METRIC_REGEX = /^[a-z0-9_]{1,64}$/;

export function validateTelemetrySourceId(value: unknown, field = "id"): string {
  return requireUuid(value, field);
}

export function validateTapId(value: unknown, field = "tapId"): string {
  return requireUuid(value, field);
}

export function validateTapNumber(value: unknown, field = "tapNumber"): number {
  return requireIntegerInRange(value, field, 1, 1_000_000);
}

export function validateCreateTelemetrySourceInput(input: unknown): CreateTelemetrySourceInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["name", "label"], "body");

  const name = requireBoundedNonemptyString(obj.name, "name", {
    maxLength: MAX_SOURCE_NAME_LENGTH,
  });
  if (Buffer.byteLength(name, "utf8") > MAX_SOURCE_NAME_LENGTH) {
    throw validationError("name", `must not exceed ${MAX_SOURCE_NAME_LENGTH} UTF-8 bytes`);
  }

  let label: string | undefined;
  if (obj.label !== undefined) {
    label = requireBoundedNonemptyString(obj.label, "label", {
      maxLength: MAX_MACHINE_KEY_LABEL_LENGTH,
    });
    if (Buffer.byteLength(label, "utf8") > MAX_MACHINE_KEY_LABEL_LENGTH) {
      throw validationError("label", `must not exceed ${MAX_MACHINE_KEY_LABEL_LENGTH} UTF-8 bytes`);
    }
  }

  return {
    name,
    ...(label !== undefined ? { label } : {}),
  };
}

export function validateRenameTelemetrySourceInput(input: unknown): RenameTelemetrySourceInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["name"], "body");

  const name = requireBoundedNonemptyString(obj.name, "name", {
    maxLength: MAX_SOURCE_NAME_LENGTH,
  });
  if (Buffer.byteLength(name, "utf8") > MAX_SOURCE_NAME_LENGTH) {
    throw validationError("name", `must not exceed ${MAX_SOURCE_NAME_LENGTH} UTF-8 bytes`);
  }

  return { name };
}

export function validateRotateTelemetrySourceInput(input: unknown): RotateTelemetrySourceInput {
  if (input === undefined || input === null || input === "") {
    return {};
  }
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["label"], "body");

  let label: string | undefined;
  if (obj.label !== undefined) {
    label = requireBoundedNonemptyString(obj.label, "label", {
      maxLength: MAX_MACHINE_KEY_LABEL_LENGTH,
    });
    if (Buffer.byteLength(label, "utf8") > MAX_MACHINE_KEY_LABEL_LENGTH) {
      throw validationError("label", `must not exceed ${MAX_MACHINE_KEY_LABEL_LENGTH} UTF-8 bytes`);
    }
  }

  return {
    ...(label !== undefined ? { label } : {}),
  };
}

export function validateAssignAuthorityInput(input: unknown): AssignAuthorityInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["levelSourceId", "conditionSourceId"], "body");
  return {
    levelSourceId: authoritySourceId(obj, "levelSourceId"),
    conditionSourceId: authoritySourceId(obj, "conditionSourceId"),
  };
}

/** A required role field: a source id, or null or "" for no source. */
function authoritySourceId(obj: Record<string, unknown>, field: string): string | null {
  if (!Object.hasOwn(obj, field)) throw validationError(field, "is required");
  const value = obj[field];
  return value === null || value === "" ? null : validateTelemetrySourceId(value, field);
}

export function validateUpdateTelemetrySettingsInput(input: unknown): UpdateTelemetrySettingsInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(
    obj,
    [
      "maxBatchSize",
      "maxFutureSkewSeconds",
      "reconnectHorizonSeconds",
      "rawRetentionSeconds",
      "receiptRetentionSeconds",
      "rateLimitSamplesPerMinute",
      "rateLimitBurstSamples",
    ],
    "body",
  );

  let maxBatchSize: number | undefined;
  let maxFutureSkewSeconds: number | undefined;
  let reconnectHorizonSeconds: number | undefined;
  let rawRetentionSeconds: number | undefined;
  let receiptRetentionSeconds: number | undefined;
  let rateLimitSamplesPerMinute: number | undefined;
  let rateLimitBurstSamples: number | undefined;

  if (obj.maxBatchSize !== undefined) {
    maxBatchSize = requireIntegerInRange(obj.maxBatchSize, "maxBatchSize", 1, 100);
  }
  if (obj.maxFutureSkewSeconds !== undefined) {
    maxFutureSkewSeconds = requireIntegerInRange(
      obj.maxFutureSkewSeconds,
      "maxFutureSkewSeconds",
      0,
      3600,
    );
  }
  if (obj.reconnectHorizonSeconds !== undefined) {
    reconnectHorizonSeconds = requireIntegerInRange(
      obj.reconnectHorizonSeconds,
      "reconnectHorizonSeconds",
      60,
      86400,
    );
  }
  if (obj.rawRetentionSeconds !== undefined) {
    rawRetentionSeconds = requireIntegerInRange(
      obj.rawRetentionSeconds,
      "rawRetentionSeconds",
      300,
      86400,
    );
  }
  if (obj.receiptRetentionSeconds !== undefined) {
    receiptRetentionSeconds = requireIntegerInRange(
      obj.receiptRetentionSeconds,
      "receiptRetentionSeconds",
      3600,
      604800,
    );
  }
  if (obj.rateLimitSamplesPerMinute !== undefined) {
    rateLimitSamplesPerMinute = requireIntegerInRange(
      obj.rateLimitSamplesPerMinute,
      "rateLimitSamplesPerMinute",
      1,
      6000,
    );
  }
  if (obj.rateLimitBurstSamples !== undefined) {
    rateLimitBurstSamples = requireIntegerInRange(
      obj.rateLimitBurstSamples,
      "rateLimitBurstSamples",
      1,
      1000,
    );
  }

  return {
    ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
    ...(maxFutureSkewSeconds !== undefined ? { maxFutureSkewSeconds } : {}),
    ...(reconnectHorizonSeconds !== undefined ? { reconnectHorizonSeconds } : {}),
    ...(rawRetentionSeconds !== undefined ? { rawRetentionSeconds } : {}),
    ...(receiptRetentionSeconds !== undefined ? { receiptRetentionSeconds } : {}),
    ...(rateLimitSamplesPerMinute !== undefined ? { rateLimitSamplesPerMinute } : {}),
    ...(rateLimitBurstSamples !== undefined ? { rateLimitBurstSamples } : {}),
  };
}

// --- Machine-facing v1 boundary ---

function parseExternalClientSampleId(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || !isValidClientSampleId(value)) {
    throw validationError(
      field,
      "must be a non-empty string between 1 and 128 characters consisting of alphanumeric characters, dashes, underscores, dots, colons, or slashes",
    );
  }
  return value;
}

function parseExternalMeasuredAt(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(field, "must be a valid RFC3339 timestamp string");
  }
  try {
    parseRfc3339Timestamp(value);
  } catch (err) {
    throw validationError(
      field,
      err instanceof Error ? err.message : "must be a valid RFC3339 timestamp string",
    );
  }
  return value;
}

function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function unitReason(definition: TelemetryMetricDefinition): string {
  const units = Object.keys(definition.units);
  return units.length === 1
    ? `must be exactly '${units[0]}'`
    : `must be one of ${quotedList(units)}`;
}

function outOfBoundsReason(definition: TelemetryMetricDefinition, value: number): string | null {
  const { min, max } = definition;
  if ((min === undefined || value >= min) && (max === undefined || value <= max)) return null;
  if (min !== undefined && max !== undefined) return `must be between ${min} and ${max}`;
  if (min === 0) return "must be non-negative";
  return min !== undefined ? `must be at least ${min}` : `must be at most ${max}`;
}

/** Legacy `measurement`: the v1 check order and messages are part of the wire contract. */
function parseExternalMeasurement(value: unknown, field: string): ExternalTelemetryReadingInput {
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["kind", "value", "unit"], field);

  const kindReason = `must be one of ${quotedList(telemetryMetricNames("level"))}`;
  if (typeof obj.kind !== "string") {
    throw validationError(`${field}.kind`, kindReason);
  }
  if (typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
    throw validationError(`${field}.value`, "must be a finite number");
  }
  if (obj.unit === undefined || typeof obj.unit !== "string") {
    throw validationError(`${field}.unit`, "is required");
  }
  const definition = telemetryMetric(obj.kind);
  if (definition?.role !== "level") {
    throw validationError(`${field}.kind`, kindReason);
  }
  const boundsReason = outOfBoundsReason(definition, obj.value);
  if (boundsReason !== null) {
    throw validationError(`${field}.value`, boundsReason);
  }
  if (!Object.hasOwn(definition.units, obj.unit)) {
    throw validationError(`${field}.unit`, unitReason(definition));
  }
  return { metric: obj.kind, value: obj.value, unit: obj.unit };
}

/** Legacy `temperature`: the v1 check order and messages are part of the wire contract. */
function parseExternalTemperature(
  value: unknown,
  field: string,
): ExternalTelemetryReadingInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  const definition = telemetryMetric("temperature")!;
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["value", "unit"], field);
  if (obj.value === undefined || typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
    throw validationError(`${field}.value`, "must be a finite number");
  }
  const boundsReason = outOfBoundsReason(definition, obj.value);
  if (boundsReason !== null) {
    throw validationError(`${field}.value`, boundsReason);
  }
  if (obj.unit === undefined || typeof obj.unit !== "string") {
    throw validationError(`${field}.unit`, "is required");
  }
  if (!Object.hasOwn(definition.units, obj.unit)) {
    throw validationError(`${field}.unit`, unitReason(definition));
  }
  return { metric: "temperature", value: obj.value, unit: obj.unit };
}

function parseExternalReading(value: unknown, field: string): ExternalTelemetryReadingInput {
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["metric", "value", "unit"], field);
  const registered = `use one of ${quotedList(telemetryMetricNames())}`;
  if (typeof obj.metric !== "string") {
    throw validationError(`${field}.metric`, `must be a registered metric name; ${registered}`);
  }
  const metric = obj.metric;
  const definition = telemetryMetric(metric);
  if (definition === undefined) {
    throw validationError(
      `${field}.metric`,
      ECHOABLE_METRIC_REGEX.test(metric)
        ? `'${metric}' is not a registered metric; ${registered}`
        : `must be a registered metric name; ${registered}`,
    );
  }
  if (typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
    throw validationError(`${field}.value`, "must be a finite number");
  }
  if (obj.unit === undefined || typeof obj.unit !== "string") {
    throw validationError(`${field}.unit`, "is required");
  }
  if (!Object.hasOwn(definition.units, obj.unit)) {
    throw validationError(`${field}.unit`, `${unitReason(definition)} for '${metric}'`);
  }
  const boundsReason = outOfBoundsReason(definition, obj.value);
  if (boundsReason !== null) {
    throw validationError(`${field}.value`, `${boundsReason} for '${metric}'`);
  }
  return { metric, value: obj.value, unit: obj.unit };
}

function parseExternalReadings(
  value: unknown,
  field: string,
): readonly ExternalTelemetryReadingInput[] {
  const maxReadings = telemetryMetricNames().length;
  if (!Array.isArray(value)) {
    throw validationError(field, "must be an array");
  }
  if (value.length < 1 || value.length > maxReadings) {
    throw validationError(field, `must contain between 1 and ${maxReadings} readings`);
  }
  const readings: ExternalTelemetryReadingInput[] = [];
  let level: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const readingField = `${field}[${index}]`;
    const reading = parseExternalReading(value[index], readingField);
    if (readings.some(({ metric }) => metric === reading.metric)) {
      throw validationError(
        `${readingField}.metric`,
        `repeats '${reading.metric}'; a sample carries each metric at most once`,
      );
    }
    if (telemetryMetric(reading.metric)!.role === "level") {
      if (level !== undefined) {
        throw validationError(
          `${readingField}.metric`,
          `'${reading.metric}' is a second keg-level reading after '${level}'; a sample carries at most one`,
        );
      }
      level = reading.metric;
    }
    readings.push(reading);
  }
  return readings;
}

export function validateExternalTelemetryPayload(
  input: unknown,
  prefix = "body",
): ExternalTelemetryRequestInput {
  const obj = requirePlainObject(input, prefix);
  rejectUnknownKeys(
    obj,
    ["client_sample_id", "measured_at", "measurement", "temperature", "readings"],
    prefix,
  );
  const readingsForm = obj.readings !== undefined;
  if (readingsForm && (obj.measurement !== undefined || obj.temperature !== undefined)) {
    throw validationError(
      prefix,
      "must use either 'measurement' (with optional 'temperature') or 'readings', not both",
    );
  }

  const measuredAt = parseExternalMeasuredAt(obj.measured_at, `${prefix}.measured_at`);
  let readings: readonly ExternalTelemetryReadingInput[];
  if (readingsForm) {
    readings = parseExternalReadings(obj.readings, `${prefix}.readings`);
  } else {
    const measurement = parseExternalMeasurement(obj.measurement, `${prefix}.measurement`);
    readings = [measurement];
  }
  const clientSampleId = parseExternalClientSampleId(
    obj.client_sample_id,
    `${prefix}.client_sample_id`,
  );
  if (!readingsForm) {
    const temperature = parseExternalTemperature(obj.temperature, `${prefix}.temperature`);
    if (temperature !== undefined) readings = [...readings, temperature];
  }

  return {
    ...(clientSampleId !== undefined ? { client_sample_id: clientSampleId } : {}),
    measured_at: measuredAt,
    readings,
  };
}

export function validateExternalBatchTelemetryPayload(
  input: unknown,
): ExternalBatchTelemetryRequestInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["samples"], "body");
  if (!Array.isArray(obj.samples)) {
    throw validationError("body.samples", "must be an array");
  }
  if (obj.samples.length < 1 || obj.samples.length > MAX_EXTERNAL_BATCH_SIZE) {
    throw validationError(
      "body.samples",
      `must contain between 1 and ${MAX_EXTERNAL_BATCH_SIZE} samples`,
    );
  }

  const samples: ExternalBatchTelemetryRequestSampleInput[] = [];
  for (let index = 0; index < obj.samples.length; index += 1) {
    const prefix = `body.samples[${index}]`;
    const item = requirePlainObject(obj.samples[index], prefix);
    rejectUnknownKeys(
      item,
      ["tap_number", "client_sample_id", "measured_at", "measurement", "temperature", "readings"],
      prefix,
    );
    if (
      typeof item.tap_number !== "number" ||
      !Number.isSafeInteger(item.tap_number) ||
      item.tap_number < 1 ||
      item.tap_number > 1_000_000
    ) {
      throw validationError(`${prefix}.tap_number`, "must be an integer between 1 and 1000000");
    }

    const tapNumber = item.tap_number;
    const sampleBody = { ...item };
    delete sampleBody.tap_number;
    const sample = validateExternalTelemetryPayload(sampleBody, prefix);
    samples.push({ ...sample, tap_number: tapNumber });
  }

  return { samples };
}
