import { randomUUID } from "node:crypto";
import {
  assertSynchronousCompletion,
  type DatabaseConnection,
  type DatabaseExecutor,
} from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { validationError } from "../../shared/validation.ts";
import { appendActivity } from "../activity/operations.ts";
import type { MachineKeyService } from "../machine-keys/service.ts";
import {
  findActiveAssignmentByTapId,
  findTapById,
  findTapByNumber,
  registerTapFirstUse,
} from "../taps/repository.ts";
import {
  computeSemanticPayloadDigest,
  levelReading,
  normalizeExternalTelemetrySample,
  readingValue,
  registeredMetric,
  type NormalizedTelemetrySample,
} from "./normalization.ts";
import { readCurrentTapReading, type CurrentTapReading } from "./current-reading.ts";
import { InMemoryTelemetryRateLimiter } from "./rate-limiter.ts";
import { TELEMETRY_AUTHORITY_ROLES, TELEMETRY_NORMALIZATION_VERSION } from "./types.ts";
import {
  countTapTelemetryAuthoritiesForSource,
  deleteTapTelemetryAuthority,
  disableTelemetrySource,
  insertTelemetryMeasurement,
  insertTelemetryReadings,
  insertTelemetryReceipt,
  insertTelemetrySource,
  listAllSourceTapStatuses,
  listSourceTapStatusesForTap,
  listTapTelemetryAuthorities,
  listTapTelemetryAuthoritiesForTap,
  listActiveTelemetrySources,
  listTelemetrySources,
  countTelemetrySourcesPage,
  listTelemetrySourcePage,
  listTelemetryRollups,
  mergeTelemetryRollup,
  pruneMeasurementsOlderThan,
  pruneReceiptsOlderThan,
  pruneTelemetryRollupsOlderThan,
  readTelemetryRollupSettings,
  readReceiptByClientSampleId,
  readReceiptByFallbackIdentity,
  readSourceTapWatermark,
  readTapTelemetryAuthority,
  readTelemetrySettings,
  readTelemetrySourceByCurrentMachineKeyId,
  readTelemetrySourceById,
  readTelemetrySourceByName,
  updateTelemetryRollupSettings,
  updateTelemetrySettings,
  updateTelemetrySourceCurrentMachineKey,
  updateTelemetrySourceName,
  upsertSourceTapReading,
  upsertSourceTapStatus,
  upsertTapTelemetryAuthority,
} from "./repository.ts";
import {
  validateAssignAuthorityInput,
  validateCreateTelemetrySourceInput,
  validateRenameTelemetrySourceInput,
  validateRotateTelemetrySourceInput,
  TELEMETRY_ROLLUP_MAX_BUCKETS,
  validateTapId,
  validateTelemetryRollupQuery,
  validateTelemetrySourceId,
  validateUpdateTelemetrySettingsInput,
} from "./telemetry-validation.ts";
import type {
  AcceptedTelemetryExtensionPort,
  AssignAuthorityInput,
  AuthorityChangedEvent,
  BatchIngestResult,
  BatchItemIngestResult,
  CreateTelemetrySourceInput,
  ExternalBatchTelemetryRequestInput,
  ExternalTelemetryRequestInput,
  RenameTelemetrySourceInput,
  RotateTelemetrySourceInput,
  SingleIngestResult,
  TapTelemetryAuthority,
  TapTelemetryAuthorityRow,
  TelemetryAuthorityExtensionPort,
  TelemetryAuthorityRole,
  TelemetryRateLimiter,
  TelemetryRollupSeries,
  TelemetrySettings,
  TelemetrySource,
  TelemetrySourceRow,
  TelemetrySourceTapStatus,
  TelemetrySourceWithKeyDetails,
  TelemetryAdminSourcePage,
  TelemetryAdminSourcePageQuery,
  TelemetryAdminSourceState,
  UpdateTelemetrySettingsInput,
} from "./types.ts";

function compareCanonicalStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function boundedAdminSourceQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  const characters = Array.from(value.trim());
  while (characters.length > 0 && Buffer.byteLength(characters.join(""), "utf8") > 80) {
    characters.pop();
  }
  return characters.join("");
}

function mapTapAuthority(
  tapId: string,
  rows: readonly TapTelemetryAuthorityRow[],
): TapTelemetryAuthority {
  const role = (name: TelemetryAuthorityRole) => {
    const row = rows.find((candidate) => candidate.tap_id === tapId && candidate.role === name);
    return row === undefined ? null : { sourceId: row.source_id, changedAt: row.changed_at };
  };
  return { tapId, level: role("level"), condition: role("condition"), flow: role("flow") };
}

function readTapAuthority(database: DatabaseExecutor, tapId: string): TapTelemetryAuthority {
  return mapTapAuthority(tapId, listTapTelemetryAuthoritiesForTap(database, tapId));
}

function mapTelemetrySource(row: {
  readonly id: string;
  readonly name: string;
  readonly current_machine_key_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
}): TelemetrySource {
  return {
    id: row.id,
    name: row.name,
    currentMachineKeyId: row.current_machine_key_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

function mapTelemetrySourceWithKey(
  row: {
    readonly id: string;
    readonly name: string;
    readonly current_machine_key_id: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly disabled_at: string | null;
  },
  key: {
    readonly id: string;
    readonly publicId: string;
    readonly label: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
  },
): TelemetrySourceWithKeyDetails {
  return {
    ...mapTelemetrySource(row),
    currentMachineKey: {
      id: key.id,
      publicId: key.publicId,
      label: key.label,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt,
    },
  };
}

const TELEMETRY_MAINTENANCE_SAMPLE_INTERVAL = 100;

export interface TelemetryActorOptions {
  readonly actorType?: string | undefined;
  readonly actorId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface TelemetryServiceDependencies {
  readonly database: DatabaseConnection;
  readonly machineKeyService: MachineKeyService;
  readonly rateLimiter?: TelemetryRateLimiter | undefined;
  readonly authorityExtensionPort?: TelemetryAuthorityExtensionPort | undefined;
  readonly acceptedExtensionPort?: AcceptedTelemetryExtensionPort | undefined;
  readonly idGenerator?: (() => string) | undefined;
  readonly clock?: (() => Date) | undefined;
}

export class TelemetryService {
  private readonly database: DatabaseConnection;
  private readonly machineKeyService: MachineKeyService;
  private readonly rateLimiter: TelemetryRateLimiter;
  private readonly authorityExtensionPort: TelemetryAuthorityExtensionPort;
  private readonly acceptedExtensionPort: AcceptedTelemetryExtensionPort;
  private readonly idGenerator: () => string;
  private readonly clock: () => Date;
  private samplesUntilMaintenance = TELEMETRY_MAINTENANCE_SAMPLE_INTERVAL;

  constructor(dependencies: TelemetryServiceDependencies) {
    this.database = dependencies.database;
    this.machineKeyService = dependencies.machineKeyService;
    this.rateLimiter = dependencies.rateLimiter ?? new InMemoryTelemetryRateLimiter();
    this.authorityExtensionPort = dependencies.authorityExtensionPort ?? {
      onAuthorityChanged: (_database, _event) => {},
    };
    this.acceptedExtensionPort = dependencies.acceptedExtensionPort ?? {
      onAcceptedSample: (_database, _event) => {},
    };
    this.idGenerator = dependencies.idGenerator ?? randomUUID;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  // --- Source Management ---

  createSource(
    inputRaw: unknown,
    options: TelemetryActorOptions = {},
  ): { readonly source: TelemetrySource; readonly initialToken: string } {
    const input: CreateTelemetrySourceInput = validateCreateTelemetrySourceInput(inputRaw);
    return this.database.withTransaction(() => {
      const existing = readTelemetrySourceByName(this.database, input.name);
      if (existing) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_name_conflict",
          clientMessage: `A telemetry source named '${input.name}' already exists.`,
          details: { name: input.name },
        });
      }

      const keyLabel = input.label ?? input.name;
      const issued = this.machineKeyService.create(keyLabel, {
        now: this.clock,
        suppressActivity: true,
      });

      const nowIso = this.clock().toISOString();
      const sourceId = this.idGenerator();

      insertTelemetrySource(this.database, {
        id: sourceId,
        name: input.name,
        current_machine_key_id: issued.descriptor.id,
        created_at: nowIso,
        updated_at: nowIso,
        disabled_at: null,
      });

      appendActivity(
        this.database,
        {
          category: "integration",
          action: "api_key_created",
          actorType: options.actorType ?? "operator",
          ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          entityType: "telemetry_source",
          entityId: sourceId,
          details: { name: input.name, machineKeyId: issued.descriptor.id },
        },
        { now: () => new Date(nowIso) },
      );

      return {
        source: {
          id: sourceId,
          name: input.name,
          currentMachineKeyId: issued.descriptor.id,
          createdAt: nowIso,
          updatedAt: nowIso,
          disabledAt: null,
        },
        initialToken: issued.token,
      };
    });
  }

  renameSource(
    sourceIdRaw: string,
    inputRaw: unknown,
    options: TelemetryActorOptions = {},
  ): TelemetrySource {
    const sourceId = validateTelemetrySourceId(sourceIdRaw);
    const input: RenameTelemetrySourceInput = validateRenameTelemetrySourceInput(inputRaw);
    return this.database.withTransaction(() => {
      const source = readTelemetrySourceById(this.database, sourceId);
      if (!source) {
        throw new ApplicationError({
          category: "not_found",
          code: "telemetry.source_not_found",
          clientMessage: "Telemetry source not found.",
          details: { sourceId },
        });
      }

      if (source.disabled_at !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_disabled",
          clientMessage: "Disabled telemetry sources cannot be renamed.",
          details: { sourceId },
        });
      }

      if (source.name === input.name) {
        return mapTelemetrySource(source);
      }

      const existingName = readTelemetrySourceByName(this.database, input.name);
      if (existingName && existingName.id !== sourceId) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_name_conflict",
          clientMessage: `A telemetry source named '${input.name}' already exists.`,
          details: { name: input.name },
        });
      }

      const nowIso = this.clock().toISOString();
      if (!updateTelemetrySourceName(this.database, sourceId, input.name, nowIso)) {
        throw new Error("Telemetry source rename failed");
      }

      appendActivity(
        this.database,
        {
          category: "domain",
          action: "entity_changed",
          actorType: options.actorType ?? "operator",
          ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          entityType: "telemetry_source",
          entityId: sourceId,
          details: { previousName: source.name, newName: input.name },
        },
        { now: this.clock },
      );

      return mapTelemetrySource({ ...source, name: input.name, updated_at: nowIso });
    });
  }

  rotateSourceKey(
    sourceIdRaw: string,
    inputRaw: unknown,
    options: TelemetryActorOptions = {},
  ): { readonly source: TelemetrySource; readonly replacementToken: string } {
    const sourceId = validateTelemetrySourceId(sourceIdRaw);
    const input: RotateTelemetrySourceInput = validateRotateTelemetrySourceInput(inputRaw);
    return this.database.withTransaction(() => {
      const source = readTelemetrySourceById(this.database, sourceId);
      if (!source) {
        throw new ApplicationError({
          category: "not_found",
          code: "telemetry.source_not_found",
          clientMessage: "Telemetry source not found.",
          details: { sourceId },
        });
      }

      if (source.disabled_at !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_disabled",
          clientMessage: "Disabled telemetry sources cannot rotate keys.",
          details: { sourceId },
        });
      }

      const keyLabel = input.label ?? source.name;
      const issued = this.machineKeyService.rotate(source.current_machine_key_id, keyLabel, {
        now: this.clock,
        suppressActivity: true,
      });

      const nowIso = this.clock().toISOString();
      if (
        !updateTelemetrySourceCurrentMachineKey(
          this.database,
          sourceId,
          issued.descriptor.id,
          nowIso,
        )
      ) {
        throw new Error("Telemetry source key rotation failed");
      }

      appendActivity(
        this.database,
        {
          category: "integration",
          action: "api_key_rotated",
          actorType: options.actorType ?? "operator",
          ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          entityType: "telemetry_source",
          entityId: sourceId,
          details: {
            previousMachineKeyId: source.current_machine_key_id,
            newMachineKeyId: issued.descriptor.id,
          },
        },
        { now: this.clock },
      );

      return {
        source: mapTelemetrySource({
          ...source,
          current_machine_key_id: issued.descriptor.id,
          updated_at: nowIso,
        }),
        replacementToken: issued.token,
      };
    });
  }

  disableSource(sourceIdRaw: string, options: TelemetryActorOptions = {}): TelemetrySource {
    const sourceId = validateTelemetrySourceId(sourceIdRaw);
    return this.database.withTransaction(() => {
      const source = readTelemetrySourceById(this.database, sourceId);
      if (!source) {
        throw new ApplicationError({
          category: "not_found",
          code: "telemetry.source_not_found",
          clientMessage: "Telemetry source not found.",
          details: { sourceId },
        });
      }
      if (source.disabled_at !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_disabled",
          clientMessage: "Telemetry source is already disabled.",
          details: { sourceId },
        });
      }

      // Check authority before revoking the key or changing source state. The
      // database trigger repeats this invariant for direct SQL writers.
      if (countTapTelemetryAuthoritiesForSource(this.database, sourceId) > 0) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_has_authority",
          clientMessage: "Telemetry source cannot be disabled while assigned to a Tap.",
          details: { sourceId },
        });
      }

      const currentKey = this.machineKeyService.get(source.current_machine_key_id);
      if (currentKey === undefined) {
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.source_key_unavailable",
          clientMessage: "Telemetry source key is unavailable.",
          details: { sourceId },
        });
      }

      const nowIso = this.clock().toISOString();
      if (currentKey.revokedAt === null) {
        if (
          !this.machineKeyService.revoke(source.current_machine_key_id, {
            now: () => new Date(nowIso),
            suppressActivity: true,
          })
        ) {
          throw new Error("Telemetry source key revocation failed");
        }
      }
      if (!disableTelemetrySource(this.database, sourceId, nowIso, nowIso)) {
        throw new Error("Telemetry source disable failed");
      }

      appendActivity(
        this.database,
        {
          category: "integration",
          action: "api_key_revoked",
          actorType: options.actorType ?? "operator",
          ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          entityType: "telemetry_source",
          entityId: sourceId,
          details: { machineKeyId: source.current_machine_key_id, disabled: true },
        },
        { now: () => new Date(nowIso) },
      );

      return mapTelemetrySource({ ...source, disabled_at: nowIso, updated_at: nowIso });
    });
  }

  getSourceById(sourceIdRaw: string): TelemetrySource | undefined {
    const sourceId = validateTelemetrySourceId(sourceIdRaw);
    const row = readTelemetrySourceById(this.database, sourceId);
    if (!row) {
      return undefined;
    }
    return mapTelemetrySource(row);
  }

  listSources(): readonly TelemetrySourceWithKeyDetails[] {
    return this.listSourceRows(listTelemetrySources(this.database));
  }

  listActiveSources(): readonly TelemetrySourceWithKeyDetails[] {
    return this.listSourceRows(listActiveTelemetrySources(this.database));
  }

  listAdminSourcePage(query: TelemetryAdminSourcePageQuery = {}): TelemetryAdminSourcePage {
    const requested = query !== null && typeof query === "object" ? query : {};
    const normalizedQuery = boundedAdminSourceQuery(requested.q);
    const state: TelemetryAdminSourceState = requested.state === "disabled" ? "disabled" : "active";
    const rawPage =
      typeof requested.page === "number" ? requested.page : Number(requested.page ?? 1);
    const requestedPage =
      Number.isInteger(rawPage) && Number.isFinite(rawPage)
        ? Math.max(1, Math.min(10_000, rawPage))
        : 1;
    const total = countTelemetrySourcesPage(this.database, normalizedQuery, state);
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pageCount);
    return {
      items: this.listSourceRows(
        listTelemetrySourcePage(this.database, normalizedQuery, state, page, pageSize),
      ),
      total,
      page,
      pageSize,
      pageCount,
      query: normalizedQuery,
      state,
    };
  }

  private listSourceRows(
    rows: readonly TelemetrySourceRow[],
  ): readonly TelemetrySourceWithKeyDetails[] {
    return rows.map((r) => {
      const key = this.machineKeyService.get(r.current_machine_key_id);
      if (!key) {
        throw new Error(`Telemetry source ${r.id} references a missing machine key`);
      }
      return mapTelemetrySourceWithKey(r, key);
    });
  }

  authenticateSourceToken(token: string): TelemetrySource | undefined {
    const verified = this.machineKeyService.verify(token, { now: this.clock });
    if (!verified) {
      return undefined;
    }
    const source = readTelemetrySourceByCurrentMachineKeyId(this.database, verified.id);
    if (!source) {
      return undefined;
    }
    if (source.disabled_at !== null) return undefined;
    return mapTelemetrySource(source);
  }

  // --- Authority Management ---

  getTapAuthority(tapIdRaw: string): TapTelemetryAuthority {
    return readTapAuthority(this.database, validateTapId(tapIdRaw));
  }

  /** The Tap's latest `metric` reading from the source holding that metric's role, if current. */
  getCurrentTapReading(tapIdRaw: string, metric: string): CurrentTapReading | null {
    return readCurrentTapReading(this.database, validateTapId(tapIdRaw), metric);
  }

  listAuthorities(): readonly TapTelemetryAuthority[] {
    const rows = listTapTelemetryAuthorities(this.database);
    return [...new Set(rows.map((row) => row.tap_id))].map((tapId) => mapTapAuthority(tapId, rows));
  }

  /**
   * Sets every role source of a Tap in one transaction. Each changed role is written, logged and
   * announced to the extensions; a `level` or `flow` change needs a fresh baseline.
   */
  setTapAuthority(
    tapIdRaw: string,
    inputRaw: unknown,
    options: TelemetryActorOptions = {},
  ): {
    readonly authority: TapTelemetryAuthority;
    readonly requiresFreshBaseline: boolean;
  } {
    const tapId = validateTapId(tapIdRaw);
    const input: AssignAuthorityInput = validateAssignAuthorityInput(inputRaw);
    return this.database.withTransaction(() => {
      const tap = findTapById(this.database, tapId);
      if (!tap) {
        throw new ApplicationError({
          category: "not_found",
          code: "taps.tap_not_found",
          clientMessage: "Tap not found.",
          details: { tapId },
        });
      }

      const requested: Readonly<Record<TelemetryAuthorityRole, string | null>> = {
        level: input.levelSourceId,
        condition: input.conditionSourceId,
        flow: input.flowSourceId,
      };
      for (const sourceId of new Set(Object.values(requested))) {
        if (sourceId !== null) this.assertAssignableSource(sourceId);
      }

      const nowIso = this.clock().toISOString();
      const events: AuthorityChangedEvent[] = [];
      for (const role of TELEMETRY_AUTHORITY_ROLES) {
        const previousSourceId = readTapTelemetryAuthority(this.database, tapId, role)?.source_id;
        const newSourceId = requested[role];
        if ((previousSourceId ?? null) === newSourceId) continue;
        if (newSourceId === null) deleteTapTelemetryAuthority(this.database, tapId, role);
        else upsertTapTelemetryAuthority(this.database, tapId, role, newSourceId, nowIso);
        events.push({
          tapId,
          role,
          previousSourceId: previousSourceId ?? null,
          newSourceId,
          changedAt: nowIso,
          requiresFreshBaseline: role !== "condition",
        });
      }

      // Every role is written before any extension runs, so each sees the final authority.
      for (const event of events) {
        assertSynchronousCompletion(
          this.authorityExtensionPort.onAuthorityChanged(this.database, event),
          "Telemetry authority extensions",
        );
        appendActivity(
          this.database,
          {
            category: "domain",
            action: "entity_changed",
            actorType: options.actorType ?? "operator",
            ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            entityType: "tap",
            entityId: tapId,
            details: {
              role: event.role,
              previousSourceId: event.previousSourceId,
              newSourceId: event.newSourceId,
            },
          },
          { now: this.clock },
        );
      }

      return {
        authority: readTapAuthority(this.database, tapId),
        requiresFreshBaseline: events.some((event) => event.requiresFreshBaseline),
      };
    });
  }

  private assertAssignableSource(sourceId: string): void {
    const source = readTelemetrySourceById(this.database, sourceId);
    if (!source) {
      throw new ApplicationError({
        category: "not_found",
        code: "telemetry.source_not_found",
        clientMessage: "Telemetry source not found.",
        details: { sourceId },
      });
    }
    if (source.disabled_at !== null) {
      throw new ApplicationError({
        category: "conflict",
        code: "telemetry.source_disabled",
        clientMessage: "Disabled telemetry sources cannot be assigned to a Tap.",
        details: { sourceId },
      });
    }
  }

  // --- Telemetry Settings ---

  getSettings(): TelemetrySettings {
    const row = readTelemetrySettings(this.database);
    const rollups = readTelemetryRollupSettings(this.database);
    return {
      maxBatchSize: row.max_batch_size,
      maxFutureSkewSeconds: row.max_future_skew_seconds,
      reconnectHorizonSeconds: row.reconnect_horizon_seconds,
      rawRetentionSeconds: row.raw_retention_seconds,
      receiptRetentionSeconds: row.receipt_retention_seconds,
      rateLimitSamplesPerMinute: row.rate_limit_samples_per_minute,
      rateLimitBurstSamples: row.rate_limit_burst_samples,
      hourlyRollupRetentionDays: rollups.hourly_retention_days,
      dailyRollupRetentionDays: rollups.daily_retention_days,
      updatedAt: row.updated_at > rollups.updated_at ? row.updated_at : rollups.updated_at,
    };
  }

  updateSettings(inputRaw: unknown, options: TelemetryActorOptions = {}): TelemetrySettings {
    const input: UpdateTelemetrySettingsInput = validateUpdateTelemetrySettingsInput(inputRaw);
    return this.database.withTransaction(() => {
      const current = readTelemetrySettings(this.database);
      const currentRollups = readTelemetryRollupSettings(this.database);

      const merged = {
        hourlyRollupRetentionDays:
          input.hourlyRollupRetentionDays ?? currentRollups.hourly_retention_days,
        dailyRollupRetentionDays:
          input.dailyRollupRetentionDays ?? currentRollups.daily_retention_days,
        maxBatchSize: input.maxBatchSize ?? current.max_batch_size,
        maxFutureSkewSeconds: input.maxFutureSkewSeconds ?? current.max_future_skew_seconds,
        reconnectHorizonSeconds: input.reconnectHorizonSeconds ?? current.reconnect_horizon_seconds,
        rawRetentionSeconds: input.rawRetentionSeconds ?? current.raw_retention_seconds,
        receiptRetentionSeconds: input.receiptRetentionSeconds ?? current.receipt_retention_seconds,
        rateLimitSamplesPerMinute:
          input.rateLimitSamplesPerMinute ?? current.rate_limit_samples_per_minute,
        rateLimitBurstSamples: input.rateLimitBurstSamples ?? current.rate_limit_burst_samples,
      };

      if (merged.receiptRetentionSeconds < merged.reconnectHorizonSeconds) {
        throw new ApplicationError({
          category: "validation",
          code: "telemetry.invalid_settings_invariant",
          clientMessage:
            "receiptRetentionSeconds must be greater than or equal to reconnectHorizonSeconds.",
        });
      }
      if (merged.receiptRetentionSeconds < merged.rawRetentionSeconds) {
        throw new ApplicationError({
          category: "validation",
          code: "telemetry.invalid_settings_invariant",
          clientMessage:
            "receiptRetentionSeconds must be greater than or equal to rawRetentionSeconds.",
        });
      }
      if (merged.maxBatchSize > merged.rateLimitBurstSamples) {
        throw new ApplicationError({
          category: "validation",
          code: "telemetry.invalid_settings_invariant",
          clientMessage: "maxBatchSize must be less than or equal to rateLimitBurstSamples.",
        });
      }

      const nowIso = this.clock().toISOString();
      updateTelemetrySettings(this.database, {
        max_batch_size: merged.maxBatchSize,
        max_future_skew_seconds: merged.maxFutureSkewSeconds,
        reconnect_horizon_seconds: merged.reconnectHorizonSeconds,
        raw_retention_seconds: merged.rawRetentionSeconds,
        receipt_retention_seconds: merged.receiptRetentionSeconds,
        rate_limit_samples_per_minute: merged.rateLimitSamplesPerMinute,
        rate_limit_burst_samples: merged.rateLimitBurstSamples,
        updated_at: nowIso,
      });
      updateTelemetryRollupSettings(this.database, {
        hourly_retention_days: merged.hourlyRollupRetentionDays,
        daily_retention_days: merged.dailyRollupRetentionDays,
        updated_at: nowIso,
      });

      // Activity details hold at most eight keys, so rollup retention gets its own entry, and
      // only when it changed.
      const { hourlyRollupRetentionDays, dailyRollupRetentionDays, ...ingestSettings } = merged;
      const activity = (details: Readonly<Record<string, number>>) =>
        appendActivity(
          this.database,
          {
            category: "admin",
            action: "configuration_changed",
            actorType: options.actorType ?? "operator",
            ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            entityType: "telemetry_settings",
            entityId: "1",
            details,
          },
          { now: this.clock },
        );
      activity(ingestSettings);
      if (
        hourlyRollupRetentionDays !== currentRollups.hourly_retention_days ||
        dailyRollupRetentionDays !== currentRollups.daily_retention_days
      ) {
        activity({ hourlyRollupRetentionDays, dailyRollupRetentionDays });
      }

      return {
        ...merged,
        updatedAt: nowIso,
      };
    });
  }

  // --- Ingestion ---

  ingestSingle(
    source: TelemetrySource,
    tapNumber: number,
    payload: ExternalTelemetryRequestInput,
  ): SingleIngestResult {
    const normalized = normalizeExternalTelemetrySample(payload);
    const tap = findTapByNumber(this.database, tapNumber);
    if (!tap) {
      throw new ApplicationError({
        category: "not_found",
        code: "taps.tap_not_found",
        clientMessage: `Tap #${tapNumber} not found.`,
        details: { tapNumber },
      });
    }

    const receivedAt = this.clock();
    this.runOpportunisticMaintenance(receivedAt, 1);
    return this.database.withTransaction(() =>
      this.processSingleSample(
        this.database,
        source,
        tap.id,
        tap.tapNumber,
        normalized,
        receivedAt,
        this.getSettings(),
      ),
    );
  }

  ingestBatch(
    source: TelemetrySource,
    batch: ExternalBatchTelemetryRequestInput,
  ): BatchIngestResult {
    const { maxBatchSize } = this.getSettings();
    if (batch.samples.length > maxBatchSize) {
      throw validationError(
        "body.samples",
        `must not contain more than ${maxBatchSize} samples (received ${batch.samples.length})`,
      );
    }

    // Preflight: resolve taps for all items
    interface PreflightItem {
      readonly index: number;
      readonly tapId: string;
      readonly tapNumber: number;
      readonly sample: NormalizedTelemetrySample;
      readonly identityKey: string;
      readonly payloadDigest: string;
    }

    const preflightItems: PreflightItem[] = [];

    for (let i = 0; i < batch.samples.length; i++) {
      const item = batch.samples[i]!;
      const tap = findTapByNumber(this.database, item.tap_number);
      if (!tap) {
        throw new ApplicationError({
          category: "not_found",
          code: "taps.tap_not_found",
          clientMessage: `Tap #${item.tap_number} not found.`,
          details: { tapNumber: item.tap_number, itemIndex: i },
        });
      }
      const tapId = tap.id;
      const tapNumber = tap.tapNumber;

      const sample = normalizeExternalTelemetrySample(item);
      const identityKey = sample.clientSampleId
        ? `client:${sample.clientSampleId}`
        : `fallback:${tapId}:${sample.measuredAtEpochMs}`;
      const payloadDigest = computeSemanticPayloadDigest(sample, tapId);

      preflightItems.push({
        index: i,
        tapId,
        tapNumber,
        sample,
        identityKey,
        payloadDigest,
      });
    }

    const receivedAt = this.clock();
    this.runOpportunisticMaintenance(receivedAt, batch.samples.length);
    const results: BatchItemIngestResult[] = new Array<BatchItemIngestResult>(
      preflightItems.length,
    );

    // Intra-batch grouping by identityKey
    const identityGroups = new Map<string, PreflightItem[]>();
    for (const item of preflightItems) {
      const group = identityGroups.get(item.identityKey);
      if (!group) {
        identityGroups.set(item.identityKey, [item]);
      } else {
        group.push(item);
      }
    }

    const itemsToProcess: PreflightItem[] = [];

    for (const group of identityGroups.values()) {
      if (group.length === 1) {
        itemsToProcess.push(group[0]!);
      } else {
        // Multiple items in batch with same identity key
        const firstDigest = group[0]!.payloadDigest;
        const allMatch = group.every((g) => g.payloadDigest === firstDigest);

        if (allMatch) {
          // All have same digest: process the first one, mark subsequent ones as intra-batch duplicates
          itemsToProcess.push(group[0]!);
        } else {
          // Intra-batch conflict: all items in group receive idempotency conflict
          const processedAt = receivedAt.toISOString();
          for (const member of group) {
            results[member.index] = {
              index: member.index,
              tapNumber: member.tapNumber,
              ...(member.sample.clientSampleId !== undefined
                ? { clientSampleId: member.sample.clientSampleId }
                : {}),
              outcome: "rejected",
              code: "telemetry.idempotency_conflict",
              duplicate: false,
              processedAt,
            };
          }
        }
      }
    }

    // Sort items to process deterministically: (measuredAtEpochMs ASC, tapId ASC, identityKey ASC, payloadDigest ASC)
    itemsToProcess.sort((a, b) => {
      if (a.sample.measuredAtEpochMs !== b.sample.measuredAtEpochMs) {
        return a.sample.measuredAtEpochMs - b.sample.measuredAtEpochMs;
      }
      if (a.tapId !== b.tapId) {
        return compareCanonicalStrings(a.tapId, b.tapId);
      }
      if (a.identityKey !== b.identityKey) {
        return compareCanonicalStrings(a.identityKey, b.identityKey);
      }
      return compareCanonicalStrings(a.payloadDigest, b.payloadDigest);
    });

    // Execute in transaction
    this.database.withTransaction(() => {
      const transactionSettings = this.getSettings();
      for (const item of itemsToProcess) {
        const res = this.processSingleSample(
          this.database,
          source,
          item.tapId,
          item.tapNumber,
          item.sample,
          receivedAt,
          transactionSettings,
        );

        results[item.index] = {
          index: item.index,
          tapNumber: item.tapNumber,
          ...(item.sample.clientSampleId !== undefined
            ? { clientSampleId: item.sample.clientSampleId }
            : {}),
          outcome: res.outcome,
          code: res.code,
          duplicate: res.duplicate,
          ...(res.acceptedMeasurementId !== undefined
            ? { acceptedMeasurementId: res.acceptedMeasurementId }
            : {}),
          processedAt: res.processedAt,
        };

        // If this item was part of an intra-batch duplicate group, populate followers with duplicate result
        const group = identityGroups.get(item.identityKey);
        if (group && group.length > 1) {
          for (let k = 1; k < group.length; k++) {
            const follower = group[k]!;
            results[follower.index] = {
              index: follower.index,
              tapNumber: follower.tapNumber,
              ...(follower.sample.clientSampleId !== undefined
                ? { clientSampleId: follower.sample.clientSampleId }
                : {}),
              outcome: res.outcome,
              code: res.code,
              duplicate: true,
              ...(res.acceptedMeasurementId !== undefined
                ? { acceptedMeasurementId: res.acceptedMeasurementId }
                : {}),
              processedAt: res.processedAt,
            };
          }
        }
      }
    });

    let acceptedCount = 0;
    let rejectedCount = 0;
    let duplicateCount = 0;

    for (const r of results) {
      if (r.outcome === "accepted") {
        acceptedCount++;
      } else {
        rejectedCount++;
      }
      if (r.duplicate) {
        duplicateCount++;
      }
    }

    return {
      processedCount: results.length,
      acceptedCount,
      rejectedCount,
      duplicateCount,
      results,
    };
  }

  private processSingleSample(
    db: DatabaseExecutor,
    source: TelemetrySource,
    tapId: string,
    tapNumber: number,
    sample: NormalizedTelemetrySample,
    receivedAt: Date,
    settings: TelemetrySettings,
  ): SingleIngestResult {
    const receivedAtMs = receivedAt.getTime();
    const receivedAtIso = receivedAt.toISOString();
    const payloadDigest = computeSemanticPayloadDigest(sample, tapId);

    // 1. Idempotency Check BEFORE Rate Limiting
    const existingReceipt = sample.clientSampleId
      ? readReceiptByClientSampleId(db, source.id, sample.clientSampleId)
      : readReceiptByFallbackIdentity(db, source.id, tapId, sample.measuredAtEpochMs);

    if (existingReceipt) {
      if (existingReceipt.payload_digest === payloadDigest) {
        // Exact duplicate
        return {
          outcome: existingReceipt.outcome,
          code: existingReceipt.outcome_code,
          duplicate: true,
          ...(existingReceipt.accepted_measurement_id !== null
            ? { acceptedMeasurementId: existingReceipt.accepted_measurement_id }
            : {}),
          processedAt: existingReceipt.processed_at,
        };
      }
      // Idempotency Conflict (same key, different measurement payload)
      return {
        outcome: "rejected",
        code: "telemetry.idempotency_conflict",
        duplicate: false,
        processedAt: receivedAtIso,
      };
    }

    // 2. Check Rate Limit (consumes 1 token)
    const allowed = this.rateLimiter.consume(source.id, 1, receivedAtMs, {
      rateLimitSamplesPerMinute: settings.rateLimitSamplesPerMinute,
      rateLimitBurstSamples: settings.rateLimitBurstSamples,
    });
    if (!allowed) {
      return {
        outcome: "rejected",
        code: "telemetry.rate_limited",
        duplicate: false,
        processedAt: receivedAtIso,
      };
    }

    // 3. Re-check Tap existence and lifecycle state under the write transaction.
    // A vanished Tap is an API not-found error and must not receive a receipt.
    const tap = findTapById(db, tapId);
    if (!tap) {
      throw new ApplicationError({
        category: "not_found",
        code: "taps.tap_not_found",
        clientMessage: `Tap #${tapNumber} not found.`,
        details: { tapId, tapNumber },
      });
    }
    // 4. Check Authority. Keep the readings whose role this source holds on the Tap and drop
    // the rest, so a multi-sensor device keeps working after its roles are split. A sample
    // left with nothing is a durable rejection. The digest above covers the whole sample, so
    // a retry stays an exact duplicate.
    const heldRoles = new Set(
      listTapTelemetryAuthoritiesForTap(db, tapId)
        .filter((row) => row.source_id === source.id)
        .map((row) => row.role),
    );
    const readings = sample.readings.filter((reading) => {
      const role = registeredMetric(reading.metric).role;
      return role === "recorded" ? heldRoles.size > 0 : heldRoles.has(role);
    });
    if (readings.length === 0) {
      return this.rejectWithReceipt(
        db,
        source.id,
        tapId,
        sample,
        payloadDigest,
        receivedAtIso,
        "telemetry.not_authoritative",
      );
    }

    // An authoritative source still receives a durable lifecycle outcome,
    // but non-authoritative sources do not learn more than the authority check.
    if (tap.retiredAt !== null) {
      return this.rejectWithReceipt(
        db,
        source.id,
        tap.id,
        sample,
        payloadDigest,
        receivedAtIso,
        "telemetry.tap_retired",
      );
    }

    // 5. Check Timestamp Horizon: Future Skew
    const maxFutureMs = receivedAtMs + settings.maxFutureSkewSeconds * 1000;
    if (sample.measuredAtEpochMs > maxFutureMs) {
      return this.rejectWithReceipt(
        db,
        source.id,
        tapId,
        sample,
        payloadDigest,
        receivedAtIso,
        "telemetry.future_timestamp",
      );
    }

    // 6. Check Timestamp Horizon: Stale Horizon
    const minPastMs = receivedAtMs - settings.reconnectHorizonSeconds * 1000;
    if (sample.measuredAtEpochMs < minPastMs) {
      return this.rejectWithReceipt(
        db,
        source.id,
        tapId,
        sample,
        payloadDigest,
        receivedAtIso,
        "telemetry.stale_timestamp",
      );
    }

    // 7. Check Watermark & Out of Order. The watermark covers every metric, so a level sample
    // cannot be older than a temperature-only sample the same source already sent.
    const watermark = readSourceTapWatermark(db, source.id, tapId);
    if (watermark !== null && sample.measuredAtEpochMs <= watermark) {
      return this.rejectWithReceipt(
        db,
        source.id,
        tapId,
        sample,
        payloadDigest,
        receivedAtIso,
        "telemetry.out_of_order",
      );
    }

    // 8. Accept the authorized readings
    const accepted = readings.length === sample.readings.length ? sample : { ...sample, readings };
    return this.acceptSample(db, source.id, tap.id, accepted, payloadDigest, receivedAtIso);
  }

  private rejectWithReceipt(
    db: DatabaseExecutor,
    sourceId: string,
    tapId: string,
    sample: NormalizedTelemetrySample,
    payloadDigest: string,
    receivedAtIso: string,
    outcomeCode: string,
  ): SingleIngestResult {
    const receiptId = this.idGenerator();
    const processedAt = receivedAtIso;

    insertTelemetryReceipt(db, {
      id: receiptId,
      source_id: sourceId,
      tap_id: tapId,
      identity_kind: sample.clientSampleId ? "client_sample_id" : "fallback",
      client_sample_id: sample.clientSampleId ?? null,
      measured_at_epoch_ms: sample.measuredAtEpochMs,
      payload_digest: payloadDigest,
      normalization_version: TELEMETRY_NORMALIZATION_VERSION,
      outcome: "rejected",
      outcome_code: outcomeCode,
      accepted_measurement_id: null,
      measured_at: sample.measuredAt,
      received_at: receivedAtIso,
      processed_at: processedAt,
    });

    return {
      outcome: "rejected",
      code: outcomeCode,
      duplicate: false,
      processedAt,
    };
  }

  private acceptSample(
    db: DatabaseExecutor,
    sourceId: string,
    tapId: string,
    sample: NormalizedTelemetrySample,
    payloadDigest: string,
    receivedAtIso: string,
  ): SingleIngestResult {
    const measurementId = this.idGenerator();
    const processedAt = receivedAtIso;

    // Determine active assignment attribution
    const activeAssignment = findActiveAssignmentByTapId(db, tapId);

    let capturedAssignmentId: string | null = null;
    let capturedFillId: string | null = null;

    if (activeAssignment) {
      const assignedAtEpochMs = Date.parse(activeAssignment.assignedAt);
      if (sample.measuredAtEpochMs >= assignedAtEpochMs) {
        capturedAssignmentId = activeAssignment.id;
        capturedFillId = activeAssignment.fillId;
      }
    }

    const level = levelReading(sample);
    // The legacy value columns still hold the metrics that existed before the registry.
    const legacyValues = {
      primary_kind: level?.metric ?? null,
      total_mass_g: readingValue(sample, "total_weight"),
      remaining_volume_ml: readingValue(sample, "remaining_volume"),
      fill_percentage: readingValue(sample, "fill_percentage"),
      temperature_c: readingValue(sample, "temperature"),
    };

    // Persist the immutable raw measurement and its readings first.
    insertTelemetryMeasurement(db, {
      id: measurementId,
      source_id: sourceId,
      tap_id: tapId,
      measured_at: sample.measuredAt,
      measured_at_epoch_ms: sample.measuredAtEpochMs,
      received_at: receivedAtIso,
      normalization_version: TELEMETRY_NORMALIZATION_VERSION,
      ...legacyValues,
      captured_assignment_id: capturedAssignmentId,
      captured_fill_id: capturedFillId,
      created_at: receivedAtIso,
    });
    insertTelemetryReadings(db, measurementId, sample.readings);
    // Rollups keep bounded history after raw pruning. The daily bucket takes the same merge as
    // the hourly one, so it always equals the aggregate of its hours, even once they are pruned.
    for (const reading of sample.readings) {
      const rollup = {
        tapId,
        metric: reading.metric,
        value: reading.value,
        measuredAtEpochMs: sample.measuredAtEpochMs,
      };
      mergeTelemetryRollup(db, "hourly", rollup);
      mergeTelemetryRollup(db, "daily", rollup);
    }

    // Advance the latest readings, and for a level sample the latest status, with
    // database-level monotonic guards. If a concurrent writer won after the pre-check, abort
    // the whole transaction instead of leaving a partially accepted sample behind.
    for (const reading of sample.readings) {
      const readingChanged = upsertSourceTapReading(db, {
        source_id: sourceId,
        tap_id: tapId,
        metric: reading.metric,
        value: reading.value,
        measurement_id: measurementId,
        captured_assignment_id: capturedAssignmentId,
        measured_at: sample.measuredAt,
        measured_at_epoch_ms: sample.measuredAtEpochMs,
        received_at: receivedAtIso,
      });
      if (!readingChanged) {
        throw new Error("Telemetry reading monotonic guard rejected an accepted sample");
      }
    }
    if (level !== undefined) {
      const statusChanged = upsertSourceTapStatus(db, {
        source_id: sourceId,
        tap_id: tapId,
        latest_measurement_id: measurementId,
        latest_measured_at: sample.measuredAt,
        latest_measured_at_epoch_ms: sample.measuredAtEpochMs,
        latest_received_at: receivedAtIso,
        normalization_version: TELEMETRY_NORMALIZATION_VERSION,
        ...legacyValues,
        primary_kind: level.metric,
        captured_assignment_id: capturedAssignmentId,
        captured_fill_id: capturedFillId,
        updated_at: receivedAtIso,
      });
      if (!statusChanged) {
        throw new Error("Telemetry status monotonic guard rejected an accepted sample");
      }
    }

    // first_used_at records the first committed/received operation time, not
    // a delayed measurement timestamp.
    registerTapFirstUse(db, tapId, receivedAtIso);

    const primaryMeasurement =
      level === undefined ? null : { kind: level.metric, value: level.value };

    // Invoke the accepted extension synchronously after all projections but
    // before the receipt is finalized. Hook failure rolls back every write.
    const acceptedEvent = {
      measurementId,
      sourceId,
      tapId,
      measuredAt: sample.measuredAt,
      receivedAt: receivedAtIso,
      normalizationVersion: TELEMETRY_NORMALIZATION_VERSION,
      primaryMeasurement,
      temperatureC: legacyValues.temperature_c,
      dispensedVolumeMl: readingValue(sample, "dispensed_volume"),
      capturedAssignmentId,
      capturedFillId,
    } as const;
    assertSynchronousCompletion(
      this.acceptedExtensionPort.onAcceptedSample(db, acceptedEvent),
      "Accepted telemetry extensions",
    );

    // Finalize the durable accepted receipt last.
    const receiptId = this.idGenerator();
    insertTelemetryReceipt(db, {
      id: receiptId,
      source_id: sourceId,
      tap_id: tapId,
      identity_kind: sample.clientSampleId ? "client_sample_id" : "fallback",
      client_sample_id: sample.clientSampleId ?? null,
      measured_at_epoch_ms: sample.measuredAtEpochMs,
      payload_digest: payloadDigest,
      normalization_version: TELEMETRY_NORMALIZATION_VERSION,
      outcome: "accepted",
      outcome_code: "telemetry.accepted",
      accepted_measurement_id: measurementId,
      measured_at: sample.measuredAt,
      received_at: receivedAtIso,
      processed_at: processedAt,
    });

    return {
      outcome: "accepted",
      code: "telemetry.accepted",
      duplicate: false,
      acceptedMeasurementId: measurementId,
      processedAt,
    };
  }

  // --- Retention & Pruning ---

  private runOpportunisticMaintenance(now: Date, sampleCount: number): void {
    this.samplesUntilMaintenance -= sampleCount;
    if (this.samplesUntilMaintenance <= 0) {
      this.pruneTelemetry(now);
      this.samplesUntilMaintenance += TELEMETRY_MAINTENANCE_SAMPLE_INTERVAL;
    }
  }

  pruneTelemetry(now?: Date): {
    readonly prunedMeasurementsCount: number;
    readonly prunedReceiptsCount: number;
    readonly prunedRollupsCount: number;
  } {
    const referenceDate = now ?? this.clock();

    return this.database.withTransaction(() => {
      const settings = this.getSettings();
      const rawCutoffIso = new Date(
        referenceDate.getTime() - settings.rawRetentionSeconds * 1000,
      ).toISOString();
      const receiptCutoffIso = new Date(
        referenceDate.getTime() - settings.receiptRetentionSeconds * 1000,
      ).toISOString();

      // Each repository delete is deterministic and capped at 500 rows. Raw
      // measurements are removed before receipts so durable identities remain
      // available for the full receipt horizon.
      const prunedMeasurementsCount = pruneMeasurementsOlderThan(this.database, rawCutoffIso);
      const prunedReceiptsCount = pruneReceiptsOlderThan(this.database, receiptCutoffIso);
      const prunedRollupsCount =
        pruneTelemetryRollupsOlderThan(
          this.database,
          "hourly",
          referenceDate.getTime() - settings.hourlyRollupRetentionDays * 86_400_000,
        ) +
        pruneTelemetryRollupsOlderThan(
          this.database,
          "daily",
          referenceDate.getTime() - settings.dailyRollupRetentionDays * 86_400_000,
        );

      return {
        prunedMeasurementsCount,
        prunedReceiptsCount,
        prunedRollupsCount,
      };
    });
  }

  // --- Rollups ---

  /** Admin-only rollup series of one Tap metric, oldest bucket first, in canonical units. */
  getTapRollups(tapIdRaw: string, queryRaw: unknown): TelemetryRollupSeries {
    const tapId = validateTapId(tapIdRaw);
    const query = validateTelemetryRollupQuery(queryRaw, this.clock().getTime());
    if (!findTapById(this.database, tapId)) {
      throw new ApplicationError({
        category: "not_found",
        code: "taps.tap_not_found",
        clientMessage: "Tap not found.",
        details: { tapId },
      });
    }
    const rows = listTelemetryRollups(this.database, query.resolution, {
      tapId,
      metric: query.metric,
      fromEpochMs: query.fromEpochMs,
      toEpochMs: query.toEpochMs,
      limit: TELEMETRY_ROLLUP_MAX_BUCKETS,
    });
    return {
      tapId,
      metric: query.metric,
      unit: query.unit,
      resolution: query.resolution,
      from: new Date(query.fromEpochMs).toISOString(),
      to: new Date(query.toEpochMs).toISOString(),
      buckets: rows.map((row) => ({
        start: new Date(row.bucket_start_epoch_ms).toISOString(),
        min: row.min_value,
        max: row.max_value,
        mean: row.sum_value / row.sample_count,
        last: row.last_value,
        lastMeasuredAt: new Date(row.last_measured_at_epoch_ms).toISOString(),
        count: row.sample_count,
      })),
    };
  }

  // --- Status Queries ---

  getTapLatestHardwareStatus(tapIdRaw: string): readonly TelemetrySourceTapStatus[] {
    const tapId = validateTapId(tapIdRaw);
    const rows = listSourceTapStatusesForTap(this.database, tapId);
    return rows.map((r) => ({
      sourceId: r.source_id,
      tapId: r.tap_id,
      latestMeasurementId: r.latest_measurement_id,
      latestMeasuredAt: r.latest_measured_at,
      latestMeasuredAtEpochMs: r.latest_measured_at_epoch_ms,
      latestReceivedAt: r.latest_received_at,
      normalizationVersion: r.normalization_version,
      primaryKind: r.primary_kind as "total_weight" | "remaining_volume" | "fill_percentage",
      totalMassG: r.total_mass_g,
      remainingVolumeMl: r.remaining_volume_ml,
      fillPercentage: r.fill_percentage,
      temperatureC: r.temperature_c,
      capturedAssignmentId: r.captured_assignment_id,
      capturedFillId: r.captured_fill_id,
      updatedAt: r.updated_at,
    }));
  }

  getAllHardwareStatus(): readonly TelemetrySourceTapStatus[] {
    const rows = listAllSourceTapStatuses(this.database);
    return rows.map((r) => ({
      sourceId: r.source_id,
      tapId: r.tap_id,
      latestMeasurementId: r.latest_measurement_id,
      latestMeasuredAt: r.latest_measured_at,
      latestMeasuredAtEpochMs: r.latest_measured_at_epoch_ms,
      latestReceivedAt: r.latest_received_at,
      normalizationVersion: r.normalization_version,
      primaryKind: r.primary_kind as "total_weight" | "remaining_volume" | "fill_percentage",
      totalMassG: r.total_mass_g,
      remainingVolumeMl: r.remaining_volume_ml,
      fillPercentage: r.fill_percentage,
      temperatureC: r.temperature_c,
      capturedAssignmentId: r.captured_assignment_id,
      capturedFillId: r.captured_fill_id,
      updatedAt: r.updated_at,
    }));
  }
}
