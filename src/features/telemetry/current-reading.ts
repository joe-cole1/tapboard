import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { telemetryMetric } from "./metrics.ts";
import { readSourceTapReading, readTapTelemetryAuthority } from "./repository.ts";
import { readOpenTelemetryEpochForTap } from "./repositories/detector.ts";
import type {
  TapTelemetryAuthorityRow,
  TelemetryAuthorityRole,
  TelemetrySourceTapReadingRow,
} from "./types.ts";

export interface CurrentTapReading {
  readonly value: number;
  /** Null only for a reading backfilled after its raw measurement was pruned. */
  readonly measurementId: string | null;
  readonly measuredAtMs: number;
  readonly receivedAtMs: number;
}

/**
 * Gates a source/Tap reading with the same provenance isolation the detector applies to
 * keg-level samples: a reading measured before its role's current authority was assigned
 * describes another source, and while a serving epoch is open only a reading attributed to
 * that epoch's assignment describes the current keg. A level reading must also come from the
 * epoch's source; a condition reading comes from the condition source, which may be another
 * device.
 */
export function currentTapReading(
  reading: TelemetrySourceTapReadingRow | undefined,
  authority: Pick<TapTelemetryAuthorityRow, "role" | "source_id" | "changed_at"> | undefined,
  epoch:
    | {
        readonly sourceId: string | null;
        readonly assignmentId: string;
        readonly startedAtEpochMs: number;
      }
    | undefined,
): CurrentTapReading | null {
  if (reading === undefined || authority === undefined) return null;
  const measuredAtMs = reading.measured_at_epoch_ms;
  if (reading.source_id !== authority.source_id) return null;
  if (measuredAtMs < Date.parse(authority.changed_at)) return null;
  if (
    epoch !== undefined &&
    ((authority.role === "level" && epoch.sourceId !== reading.source_id) ||
      epoch.assignmentId !== reading.captured_assignment_id ||
      measuredAtMs < epoch.startedAtEpochMs)
  ) {
    return null;
  }
  return {
    value: reading.value,
    measurementId: reading.measurement_id,
    measuredAtMs,
    receivedAtMs: Date.parse(reading.received_at),
  };
}

/** The authority role whose source supplies `metric` for a Tap. */
function metricAuthorityRole(metric: string): TelemetryAuthorityRole {
  const role = telemetryMetric(metric)?.role;
  if (role !== "level" && role !== "condition") {
    throw new Error(`Telemetry metric '${metric}' has no current-reading authority`);
  }
  return role;
}

/** The Tap's latest reading of `metric` from the source holding its role, gated as above. */
export function readCurrentTapReading(
  database: DatabaseExecutor,
  tapId: string,
  metric: string,
): CurrentTapReading | null {
  const authority = readTapTelemetryAuthority(database, tapId, metricAuthorityRole(metric));
  if (authority === undefined) return null;
  return currentTapReading(
    readSourceTapReading(database, authority.source_id, tapId, metric),
    authority,
    readOpenTelemetryEpochForTap(database, tapId),
  );
}
