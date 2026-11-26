import { randomUUID } from "node:crypto";

import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { createEventEnvelope } from "../events/envelope.ts";
import type { EventEnvelope, EventType } from "../events/types.ts";
import type { EventIdentifiers } from "../events/types.ts";
import { findActiveAssignmentByTapId } from "../taps/repository.ts";
import { findFillById } from "../fills/repository.ts";
import type {
  AssignmentClosedEventContext,
  AssignmentOpenedEventContext,
  CompletedPourEventContext,
  CreateOutboundDestinationInput,
  HealthTransitionEventContext,
  IntegrationStatusEventContext,
  OutboundAdmissionPort,
  OutboundAdmissionResult,
  OutboundConfig,
  OutboundDestination,
  OutboundDestinationListItem,
  OutboundEndpointInput,
  OutboundHeader,
  OutboundHeadersInput,
  OutboundSecretHeaderInput,
  OutboundSecretStore,
  OutboundServiceOptions,
  OutboundSettingsInput,
} from "./types.ts";
import {
  HA_TOKEN_SLOT,
  MAX_OUTBOUND_DESTINATIONS,
  WEBHOOK_ENDPOINT_SLOT,
  MAX_HEADER_TOTAL_BYTES,
  configuredHeaderBytes,
  credentialOrigin,
  normalizeCreateInput,
  normalizeDestinationConfig,
  validateOutboundId,
  validateDestinationLabel,
  validateHeaderSecretValue,
  validateHomeAssistantToken,
  parseOutboundUrl,
  validateSubscriptions,
} from "./outbound-validation.ts";
import {
  admitOutboxIntent,
  deliveryBelongsToDestination,
  dismissDestinationDeliveries,
  dismissFailedDestinationDeliveries,
  insertDestinationBase,
  insertVersionConfig,
  listDeliveryHistory,
  listDestinationPage,
  listDestinationProfiles,
  listDestinationConfigJson,
  listDestinationVersionIds,
  listUnfinishedSecretSlots,
  listDestinations,
  markTokenMissing,
  nextVersionNumber,
  projectConnectivity,
  readCurrentDestinationVersion,
  readDestination,
  recordFailure as recordFailureRow,
  recordSuccess as recordSuccessRow,
  resetConnectivityState,
  resolveTargets,
  setEnabledState,
  setRetired,
  shiftDestinationDeliveries,
  updateDestinationLabelRequired,
  type OutboundSecretDescriptorLike,
} from "./repository.ts";
import {
  dismissDelivery as dismissOutboxDelivery,
  retryDelivery as retryOutboxDelivery,
} from "../outbox/repository.ts";

const DEFAULT_NOW = (): Date => new Date();

function clock(factory: (() => Date) | undefined): Date {
  const value = factory?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError("Invalid outbound clock");
  return new Date(value.getTime());
}

function iso(factory: (() => Date) | undefined): string {
  return clock(factory).toISOString();
}

function safeSecretDescriptors(
  secrets: OutboundSecretStore | undefined,
): readonly OutboundSecretDescriptorLike[] {
  const rows = secrets?.list?.() ?? [];
  return rows.map((row) => ({
    integrationType: row.integrationType,
    recordId: row.recordId,
    fieldName: row.fieldName,
    configured: row.configured,
    available: row.available,
  }));
}

function canonicalId(value: string | undefined, factory: () => string): string {
  const result = value ?? factory();
  return validateOutboundId(result, "destinationId");
}

function secretAvailable(
  secrets: OutboundSecretStore | undefined,
  recordId: string,
  fieldName: string,
): boolean {
  return safeSecretDescriptors(secrets).some(
    (row) =>
      row.integrationType === "outbound" &&
      row.recordId === recordId &&
      row.fieldName === fieldName &&
      row.configured &&
      row.available,
  );
}

/** Why a destination cannot deliver yet, as its disabled reason and the operator's message. */
type EnableBlocker = "token_missing" | "endpoint_missing" | "secret_missing" | "pending_secret";

const ENABLE_BLOCKERS: Readonly<
  Record<EnableBlocker, { readonly reason: string; readonly message: string }>
> = {
  token_missing: {
    reason: "token_missing",
    message: "Home Assistant token is required before enabling",
  },
  endpoint_missing: {
    reason: "endpoint_missing",
    message: "Webhook endpoint is required before enabling",
  },
  secret_missing: {
    reason: "secret_missing",
    message: "Every configured secret header requires a value before enabling",
  },
  pending_secret: {
    reason: "secret_missing",
    message: "Pending delivery requires a removed secret header value",
  },
};

/** A change to what a configuration version records; absent fields keep their values. */
interface ConfigChange {
  readonly label?: string;
  readonly subscriptions?: readonly EventType[];
  readonly baseUrl?: string;
  readonly webhookUrl?: string;
  readonly payloadFormat?: "standard" | "discord";
  readonly allowPrivateNetwork?: boolean;
  readonly staticHeaders?: readonly OutboundHeader[];
  readonly secretHeaders?: readonly OutboundSecretHeaderInput[];
}

function requireSecretStore(secrets: OutboundSecretStore | undefined): OutboundSecretStore {
  if (secrets === undefined) throw new Error("Outbound secret storage is unavailable");
  return secrets;
}

/** The submitted secret header values, by the slot of the header each names. */
function headerValuesBySlot(
  headers: readonly { readonly name: string; readonly slot: string }[],
  rows: readonly OutboundSecretHeaderInput[] | undefined,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.value === undefined) continue;
    const header = headers.find(
      (candidate) => candidate.name.toLowerCase() === row.name.trim().toLowerCase(),
    );
    if (header === undefined) throw new Error("The submitted secret header is not configured");
    result.set(header.slot, validateHeaderSecretValue(row.value));
  }
  return result;
}

function appendOutboundActivity(
  database: DatabaseExecutor,
  action: string,
  destinationId: string,
  occurredAt: string,
  details: Record<string, string | number | boolean | null> = {},
): void {
  appendActivity(database, {
    category: action === "configuration_changed" ? "admin" : "integration",
    action,
    actorType: "system",
    entityType: "outbound_destination",
    entityId: destinationId,
    details,
    occurredAt,
  });
}

function fillIdentifiers(
  database: DatabaseExecutor,
  fillId: string,
  tapId?: string,
): EventIdentifiers {
  const fill = findFillById(database, fillId);
  return {
    ...(tapId === undefined ? {} : { tap_id: tapId }),
    fill_id: fillId,
    ...(fill === undefined ? {} : { keg_id: fill.kegId, beverage_id: fill.beverageId }),
  };
}

function activeFillForTap(
  database: DatabaseExecutor,
  tapId: string,
): { readonly fillId: string; readonly kegId: string; readonly beverageId: string } | undefined {
  const assignment = findActiveAssignmentByTapId(database, tapId);
  if (assignment === undefined) return undefined;
  const fill = findFillById(database, assignment.fillId);
  return fill === undefined
    ? undefined
    : { fillId: fill.id, kegId: fill.kegId, beverageId: fill.beverageId };
}

function changedSemantic(
  previousState: string | null | undefined,
  previousSeverity: string | null | undefined,
  state: string,
  severity: string,
): boolean {
  return (
    previousState === undefined ||
    previousState === null ||
    previousSeverity === undefined ||
    previousSeverity === null ||
    previousState !== state ||
    previousSeverity !== severity
  );
}

function healthState(value: string): "healthy" | "degraded" | "active" | undefined {
  return value === "healthy" || value === "degraded" || value === "active" ? value : undefined;
}

function healthSeverity(value: string): "none" | "info" | "warning" | "critical" | undefined {
  return value === "none" || value === "info" || value === "warning" || value === "critical"
    ? value
    : undefined;
}

function numberEvidence(evidence: unknown, names: readonly string[]): number | undefined {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence))
    return undefined;
  const record = evidence as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
      return value;
  }
  return undefined;
}

function eventEnvelope(
  eventType: EventType,
  identifiers: EventIdentifiers,
  data: unknown,
  occurredAt: string,
  idFactory: () => string,
  coalescingKey?: string,
): EventEnvelope {
  return createEventEnvelope(
    {
      event_type: eventType,
      identifiers,
      data,
      occurred_at: occurredAt,
      ...(coalescingKey === undefined ? {} : { coalescing_key: coalescingKey }),
    },
    { idFactory, now: () => new Date(occurredAt) },
  );
}

function integrationEventState(
  destination: OutboundDestination,
): "healthy" | "degraded" | "disabled" {
  if (!destination.enabled || destination.retiredAt !== null || destination.state === "disabled") {
    return "disabled";
  }
  return destination.state === "healthy" || destination.state === "unknown"
    ? "healthy"
    : "degraded";
}

export class OutboundService implements OutboundAdmissionPort {
  readonly #database: DatabaseExecutor;
  readonly #options: OutboundServiceOptions;
  readonly #now: () => Date;
  readonly #ids: () => string;
  #lifecycleSuppression = 0;

  constructor(database: DatabaseExecutor, options: OutboundServiceOptions = {}) {
    this.#database = database;
    this.#options = options;
    this.#now = options.now ?? DEFAULT_NOW;
    this.#ids = options.idFactory ?? randomUUID;
  }

  /** Create a destination, with its token and secret header values, in one step. */
  create(input: CreateOutboundDestinationInput): OutboundDestination {
    const normalized = normalizeCreateInput(input);
    const headerValues = headerValuesBySlot(normalized.config.secretHeaders, input.secretHeaders);
    this.#assertHeaderTotal(
      normalized.config.staticHeaders,
      normalized.config.secretHeaders,
      headerValues,
    );
    const now = iso(this.#now);
    const destinationId = canonicalId(input.id, this.#ids);
    const blocker: EnableBlocker | undefined =
      normalized.transport === "home_assistant" && normalized.secret === undefined
        ? "token_missing"
        : normalized.config.secretHeaders.some((header) => !headerValues.has(header.slot))
          ? "secret_missing"
          : undefined;
    const enabled = normalized.enabled && blocker === undefined;
    const result = this.#database.withTransaction(() => {
      const activeCount = listDestinationProfiles(this.#database).filter(
        (row) => row.retired_at === null,
      ).length;
      if (activeCount >= MAX_OUTBOUND_DESTINATIONS)
        throw new Error("Outbound destination limit reached");
      insertDestinationBase(this.#database, {
        id: destinationId,
        label: normalized.label,
        enabled,
        required: normalized.required,
        transport: normalized.transport,
        now,
      });
      insertVersionConfig(this.#database, {
        id: this.#ids(),
        destinationId,
        versionNumber: 1,
        createdAt: now,
        config: normalized.config,
        subscriptions: normalized.subscriptions,
        required: normalized.required,
      });
      this.#storeInitialSecret(destinationId, normalized.config, normalized.secret, now);
      for (const [slot, value] of headerValues) {
        requireSecretStore(this.#options.secrets).upsert("outbound", destinationId, slot, value, {
          now: this.#now,
        });
      }
      if (!enabled) {
        const reason = blocker === undefined ? "created_disabled" : ENABLE_BLOCKERS[blocker].reason;
        setEnabledState(this.#database, destinationId, false, now, reason);
        if (blocker === "token_missing") markTokenMissing(this.#database, destinationId, now);
      }
      appendOutboundActivity(this.#database, "configuration_changed", destinationId, now, {
        change: "created",
        transport: normalized.config.transportKind,
        required: normalized.required,
        enabled,
      });
      return this.#requireDestination(destinationId);
    });
    if (result.enabled && result.transport === "home_assistant") {
      this.#emitLifecycle("enabled", destinationId);
    }
    return result;
  }

  /** Change what a destination sends: its name, subscriptions and webhook payload options. */
  updateSettings(destinationId: string, input: OutboundSettingsInput): OutboundDestination {
    return this.#reconfigure(destinationId, {
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.subscriptions === undefined ? {} : { subscriptions: input.subscriptions }),
      ...(input.payloadFormat === undefined ? {} : { payloadFormat: input.payloadFormat }),
      ...(input.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: input.allowPrivateNetwork }),
    });
  }

  /**
   * Change where a destination sends. A new origin discards its stored token and secret
   * header values and its queued deliveries, so a Home Assistant token can come along.
   */
  changeEndpoint(destinationId: string, input: OutboundEndpointInput): OutboundDestination {
    const destination = this.#requireMutableDestination(
      validateOutboundId(destinationId, "destinationId"),
    );
    if (input.token !== undefined && destination.transport !== "home_assistant") {
      throw new Error("Only Home Assistant destinations have tokens");
    }
    return this.#reconfigure(
      destination.id,
      destination.transport === "home_assistant"
        ? { baseUrl: input.url }
        : { webhookUrl: input.url },
      input.token === undefined ? {} : { token: validateHomeAssistantToken(input.token) },
    );
  }

  /** Replace the static and secret header lists, storing any submitted secret values. */
  replaceHeaders(destinationId: string, input: OutboundHeadersInput): OutboundDestination {
    return this.#reconfigure(
      destinationId,
      { staticHeaders: input.staticHeaders, secretHeaders: input.secretHeaders },
      { headerValues: input.secretHeaders },
    );
  }

  setRequired(destinationId: string, required: boolean): OutboundDestination {
    if (typeof required !== "boolean") throw new TypeError("required must be boolean");
    const id = validateOutboundId(destinationId, "destinationId");
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      updateDestinationLabelRequired(
        this.#database,
        id,
        this.#requireDestination(id).label,
        required,
        now,
      );
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "required",
        required,
      });
      return this.#requireDestination(id);
    });
  }

  setEnabled(destinationId: string, enabled: boolean): OutboundDestination {
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
    const id = validateOutboundId(destinationId, "destinationId");
    const result = this.#database.withTransaction(() =>
      this.#writeEnabled(id, enabled, "operator_disabled"),
    );
    this.#emitLifecycle(enabled ? "enabled" : "disabled", id);
    return result;
  }

  retire(destinationId: string): OutboundDestination {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const before = this.#requireMutableDestination(id);
      setRetired(this.#database, id, now);
      this.#revokeSecrets(id);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "retired",
      });
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: before.transport,
        previousState: integrationEventState(before),
        state: integrationEventState(after),
        reasonCode: "retired",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle("retired", id);
    return result;
  }

  setToken(destinationId: string, plaintext: string): OutboundDestination {
    const id = validateOutboundId(destinationId, "destinationId");
    const token = validateHomeAssistantToken(plaintext);
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      if (destination.transport !== "home_assistant")
        throw new Error("Only Home Assistant destinations have tokens");
      requireSecretStore(this.#options.secrets).upsert("outbound", id, HA_TOKEN_SLOT, token, {
        now: this.#now,
      });
      resetConnectivityState(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "token_configured",
      });
      return this.#requireDestination(id);
    });
    this.#emitLifecycle("credentials_changed", id);
    return result;
  }

  removeToken(destinationId: string): OutboundDestination {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      if (destination.transport !== "home_assistant")
        throw new Error("Only Home Assistant destinations have tokens");
      requireSecretStore(this.#options.secrets).remove("outbound", id, HA_TOKEN_SLOT, {
        now: this.#now,
      });
      setEnabledState(this.#database, id, false, now, "token_missing");
      markTokenMissing(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "token_removed",
      });
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: destination.transport,
        previousState: integrationEventState(destination),
        state: integrationEventState(after),
        reasonCode: "token_missing",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle("disabled", id);
    return result;
  }

  setHeaderSecret(destinationId: string, slot: string, plaintext: string): OutboundDestination {
    const id = validateOutboundId(destinationId, "destinationId");
    const secretValue = validateHeaderSecretValue(plaintext);
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      const versionId = destination.currentVersion?.id;
      if (versionId === undefined) throw new Error("Outbound destination configuration is missing");
      const currentVersion = destination.currentVersion;
      if (
        currentVersion === null ||
        !currentVersion.config.secretHeaders.some((header) => header.slot === slot)
      )
        throw new Error("Header secret slot is not configured");
      const configuredHeaders = [...currentVersion.config.staticHeaders];
      for (const header of currentVersion.config.secretHeaders) {
        if (header.slot === slot) {
          configuredHeaders.push({ name: header.name, value: secretValue });
        } else if (header.configured && header.available === true) {
          configuredHeaders.push({
            name: header.name,
            value: requireSecretStore(this.#options.secrets).revealPrivileged(
              "outbound",
              id,
              header.slot,
            ),
          });
        }
      }
      if (configuredHeaderBytes(configuredHeaders) > MAX_HEADER_TOTAL_BYTES) {
        throw new TypeError("Configured outbound headers exceed 4096 total bytes");
      }
      requireSecretStore(this.#options.secrets).upsert("outbound", id, slot, secretValue, {
        now: this.#now,
      });
      resetConnectivityState(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "header_secret_configured",
      });
      return this.#requireDestination(id);
    });
    if (result.transport === "home_assistant") this.#emitLifecycle("credentials_changed", id);
    return result;
  }

  removeHeaderSecret(destinationId: string, slot: string): OutboundDestination {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      const versionId = destination.currentVersion?.id;
      if (versionId === undefined) throw new Error("Outbound destination configuration is missing");
      const currentVersion = destination.currentVersion;
      if (
        currentVersion === null ||
        !currentVersion.config.secretHeaders.some((header) => header.slot === slot)
      )
        throw new Error("Header secret slot is not configured");
      requireSecretStore(this.#options.secrets).remove("outbound", id, slot, { now: this.#now });
      setEnabledState(this.#database, id, false, now, "secret_missing");
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "header_secret_removed",
      });
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: destination.transport,
        previousState: integrationEventState(destination),
        state: integrationEventState(after),
        reasonCode: "secret_missing",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle("disabled", id);
    return result;
  }

  list(): readonly OutboundDestination[] {
    return listDestinations(this.#database, {
      secrets: safeSecretDescriptors(this.#options.secrets),
      now: clock(this.#now),
    });
  }

  listPage(): readonly OutboundDestinationListItem[] {
    return listDestinationPage(this.#database, {
      secrets: safeSecretDescriptors(this.#options.secrets),
      now: clock(this.#now),
    });
  }

  get(destinationId: string): OutboundDestination | undefined {
    return readDestination(this.#database, validateOutboundId(destinationId, "destinationId"), {
      secrets: safeSecretDescriptors(this.#options.secrets),
      now: clock(this.#now),
    });
  }

  listDeliveries(destinationId: string, limit = 100) {
    return listDeliveryHistory(this.#database, destinationId, limit);
  }

  retryDelivery(destinationId: string, deliveryId: string): boolean {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = clock(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      this.#requireOwnedDelivery(id, deliveryId);
      return retryOutboxDelivery(this.#database, deliveryId, now);
    });
  }

  dismissDelivery(destinationId: string, deliveryId: string): boolean {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = clock(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      this.#requireOwnedDelivery(id, deliveryId);
      return dismissOutboxDelivery(this.#database, deliveryId, now);
    });
  }

  connectivity(): ReturnType<typeof projectConnectivity> {
    const missing = this.list()
      .filter(
        (destination) =>
          destination.enabled &&
          destination.currentVersion !== null &&
          destination.currentVersion.config.transport === "home_assistant" &&
          !destination.currentVersion.config.authConfigured,
      )
      .map((destination) => destination.id);
    return projectConnectivity(this.#database, clock(this.#now), missing);
  }

  recordFailure(
    destinationId: string,
    errorCode: string,
    failureClass: "authentication" | "connectivity" | "unknown" = "unknown",
  ): OutboundDestination | undefined {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      recordFailureRow(this.#database, id, errorCode, failureClass, now);
      const safeCode = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u.test(errorCode)
        ? errorCode
        : "delivery_failed";
      appendOutboundActivity(this.#database, "status_degraded", id, now, {
        code: safeCode,
        failure_class: failureClass,
      });
      return this.get(id);
    });
  }

  recordSuccess(destinationId: string): OutboundDestination | undefined {
    const id = validateOutboundId(destinationId, "destinationId");
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      recordSuccessRow(this.#database, id, now);
      appendOutboundActivity(this.#database, "status_recovered", id, now);
      return this.get(id);
    });
  }

  admit(database: DatabaseExecutor, event: EventEnvelope): OutboundAdmissionResult {
    const targets = resolveTargets(database, event.event_type);
    if (targets.length === 0) return { status: "no_targets" };
    return this.#admitEnvelope(database, event, targets);
  }

  assignmentOpened(
    database: DatabaseExecutor,
    context: AssignmentOpenedEventContext,
  ): OutboundAdmissionResult {
    const event = eventEnvelope(
      "fill.assigned",
      fillIdentifiers(database, context.fillId, context.tapId),
      { assignment_id: context.assignmentId },
      context.occurredAt,
      this.#ids,
    );
    return this.admit(database, event);
  }

  assignmentClosed(
    database: DatabaseExecutor,
    context: AssignmentClosedEventContext,
    mappedReason?: "kicked" | "manual" | "deleted" | "other",
  ): OutboundAdmissionResult {
    // Assignment lifecycle closure (including a move) is not itself a fill
    // ending. The FillService supplies an explicit mapped reason only when a
    // persisted fill end/delete/kick has committed.
    if (mappedReason === undefined) return { status: "no_targets" };
    const event = eventEnvelope(
      "fill.ended",
      fillIdentifiers(database, context.fillId, context.tapId),
      { reason: mappedReason },
      context.occurredAt,
      this.#ids,
    );
    return this.admit(database, event);
  }

  pourCompleted(
    database: DatabaseExecutor,
    pour: CompletedPourEventContext,
  ): OutboundAdmissionResult {
    const event = eventEnvelope(
      "pour.completed",
      fillIdentifiers(database, pour.fillId, pour.tapId),
      { volume_ml: pour.canonicalVolumeMl },
      pour.completedAt,
      this.#ids,
    );
    return this.admit(database, event);
  }

  healthTransitioned(
    database: DatabaseExecutor,
    context: HealthTransitionEventContext,
  ): OutboundAdmissionResult {
    const state = healthState(context.current.state);
    const severity = healthSeverity(context.current.severity);
    if (
      state === undefined ||
      severity === undefined ||
      !changedSemantic(context.previousState, context.previousSeverity, state, severity)
    )
      return { status: "no_targets" };
    const active = activeFillForTap(database, context.tapId);
    const identifiers: EventIdentifiers = {
      tap_id: context.tapId,
      ...(active === undefined
        ? {}
        : { fill_id: active.fillId, keg_id: active.kegId, beverage_id: active.beverageId }),
    };
    const event = eventEnvelope(
      "health.transitioned",
      identifiers,
      { check_id: context.checkId, state, severity },
      context.occurredAt,
      this.#ids,
    );
    const result = this.admit(database, event);
    if (context.checkId === "low_keg" && state !== "healthy") {
      const remaining = numberEvidence(context.current.evidence, [
        "currentPercent",
        "remainingPercent",
        "remaining_percent",
      ]);
      const threshold = numberEvidence(context.current.evidence, [
        "thresholdPercent",
        "threshold_percent",
      ]);
      if (remaining !== undefined && threshold !== undefined) {
        const lowEvent = eventEnvelope(
          "keg.low",
          identifiers,
          { remaining_percent: remaining, threshold_percent: threshold },
          context.occurredAt,
          this.#ids,
        );
        this.admit(database, lowEvent);
      }
    }
    return result;
  }

  integrationStatusChanged(
    database: DatabaseExecutor,
    context: IntegrationStatusEventContext,
  ): OutboundAdmissionResult {
    if (
      context.previousState !== undefined &&
      context.previousState !== null &&
      context.previousState === context.state
    )
      return { status: "no_targets" };
    const key =
      context.coalescingKey ??
      `integration_${(context.destinationId ?? context.integrationType)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/gu, "_")}`;
    const event = eventEnvelope(
      "integration.status_changed",
      {},
      {
        integration_type: context.integrationType,
        state: context.state,
        reason_code: context.reasonCode ?? null,
      },
      context.occurredAt,
      this.#ids,
      key,
    );
    const targets = resolveTargets(database, event.event_type);
    if (targets.length === 0) return { status: "no_targets" };
    return this.#admitEnvelope(database, event, targets, key);
  }

  #admitEnvelope(
    database: DatabaseExecutor,
    event: EventEnvelope,
    targets: readonly { readonly destinationId: string; readonly destinationVersionId: string }[],
    coalescingKey?: string,
  ): OutboundAdmissionResult {
    const result = admitOutboxIntent(
      database,
      {
        event,
        ...(coalescingKey === undefined ? {} : { coalescingKey }),
        targets,
      },
      { now: this.#now, idFactory: this.#ids },
    );
    return result.status === "queued"
      ? result
      : result.status === "not_queued_capacity"
        ? result
        : { status: "no_targets" };
  }

  /**
   * Apply one configuration change and any secrets that come with it, atomically. A destination
   * that can no longer deliver is disabled with the reason; one that was enabled before and can
   * deliver again (a new origin with its token) is enabled again.
   */
  #reconfigure(
    destinationId: string,
    change: ConfigChange,
    secrets: {
      readonly token?: string;
      readonly headerValues?: readonly OutboundSecretHeaderInput[];
    } = {},
  ): OutboundDestination {
    const id = validateOutboundId(destinationId, "destinationId");
    let changed = false;
    return this.#withDeferredLifecycle(
      () =>
        this.#database.withTransaction(() => {
          const before = this.#requireMutableDestination(id);
          // A label is metadata: it never touches the connection.
          changed = this.#writeVersion(id, change) === "version";
          if (secrets.token !== undefined) {
            this.setToken(id, secrets.token);
            changed = true;
          }
          const config = this.#requireDestination(id).currentVersion?.config;
          if (config === undefined)
            throw new Error("Outbound destination configuration is missing");
          for (const [slot, value] of headerValuesBySlot(
            config.secretHeaders,
            secrets.headerValues,
          )) {
            this.setHeaderSecret(id, slot, value);
            changed = true;
          }
          // Only a change to where it sends or what it sends with can stop or restore delivery;
          // a name or subscription change leaves the enabled state alone.
          const credentialsTouched =
            secrets.token !== undefined ||
            secrets.headerValues !== undefined ||
            change.baseUrl !== undefined ||
            change.webhookUrl !== undefined ||
            change.staticHeaders !== undefined ||
            change.secretHeaders !== undefined;
          if (!credentialsTouched) return this.#requireDestination(id);
          const current = this.#requireDestination(id);
          const blocker = this.#enableBlocker(current);
          if (current.enabled && blocker !== undefined) {
            this.#writeEnabled(id, false, ENABLE_BLOCKERS[blocker].reason);
            changed = true;
          } else if (before.enabled && !current.enabled && blocker === undefined) {
            this.#writeEnabled(id, true);
            changed = true;
          }
          return this.#requireDestination(id);
        }),
      (updated) => {
        if (!changed) return;
        if (updated.enabled && updated.transport === "home_assistant") {
          this.#emitLifecycle("credentials_changed", id);
        } else if (!updated.enabled) {
          this.#emitLifecycle("disabled", id);
        }
      },
    );
  }

  /**
   * Record a change as a new configuration version, or as metadata when only the label changed.
   * Secrets never follow a destination to a new origin. Returns what it wrote.
   */
  #writeVersion(id: string, change: ConfigChange): "nothing" | "label" | "version" {
    const now = iso(this.#now);
    const current = this.#requireMutableDestination(id);
    const currentVersion = current.currentVersion;
    if (currentVersion === null) throw new Error("Outbound destination configuration is missing");
    const currentConfig = currentVersion.config;
    const label =
      change.label === undefined ? current.label : validateDestinationLabel(change.label);
    const writeLabel = (): "nothing" | "label" => {
      if (label === current.label) return "nothing";
      updateDestinationLabelRequired(this.#database, id, label, current.required, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "metadata",
        required: current.required,
      });
      return "label";
    };
    const subscriptions =
      change.subscriptions === undefined
        ? current.subscriptions
        : validateSubscriptions(change.subscriptions);
    const subscriptionsChanged =
      subscriptions.length !== current.subscriptions.length ||
      subscriptions.some((eventType) => !current.subscriptions.includes(eventType));
    const configChanged =
      change.baseUrl !== undefined ||
      change.webhookUrl !== undefined ||
      change.payloadFormat !== undefined ||
      change.allowPrivateNetwork !== undefined ||
      change.staticHeaders !== undefined ||
      change.secretHeaders !== undefined;
    // A label-only change never reads the stored endpoint.
    if (!configChanged && !subscriptionsChanged) return writeLabel();
    const transport = current.transport;
    let endpoint: string | undefined;
    if (transport === "webhook") {
      if (change.webhookUrl !== undefined) {
        endpoint = parseOutboundUrl(change.webhookUrl, "webhookUrl").url;
      } else if (currentConfig.transport === "webhook" && currentConfig.endpointConfigured) {
        endpoint = this.#revealSecret(currentVersion.id, WEBHOOK_ENDPOINT_SLOT);
      }
    }
    const config = normalizeDestinationConfig({
      transport,
      ...(change.baseUrl !== undefined
        ? { baseUrl: change.baseUrl }
        : currentConfig.transport === "home_assistant"
          ? { baseUrl: currentConfig.baseUrl }
          : {}),
      ...(change.webhookUrl !== undefined
        ? { webhookUrl: change.webhookUrl }
        : endpoint !== undefined
          ? { webhookUrl: endpoint }
          : {}),
      ...(change.payloadFormat !== undefined
        ? { payloadFormat: change.payloadFormat }
        : currentConfig.transport === "webhook"
          ? { payloadFormat: currentConfig.payloadFormat }
          : {}),
      ...(change.allowPrivateNetwork !== undefined
        ? { allowPrivateNetwork: change.allowPrivateNetwork }
        : currentConfig.transport === "webhook"
          ? { allowPrivateNetwork: currentConfig.allowPrivateNetwork }
          : {}),
      staticHeaders: change.staticHeaders ?? currentConfig.staticHeaders,
      secretHeaders:
        change.secretHeaders ??
        currentConfig.secretHeaders.map((header) => ({ name: header.name, slot: header.slot })),
    });
    const connectionChanged =
      config.configJson !== readCurrentDestinationVersion(this.#database, id)?.configJson ||
      (config.transport === "webhook" &&
        change.webhookUrl !== undefined &&
        (currentConfig.transport !== "webhook" ||
          !currentConfig.endpointAvailable ||
          endpoint !== this.#revealSecret(currentVersion.id, WEBHOOK_ENDPOINT_SLOT)));
    // Saving the same values again records nothing.
    if (!connectionChanged && !subscriptionsChanged) return writeLabel();
    for (const header of config.secretHeaders) {
      const previous = currentConfig.secretHeaders.find(
        (candidate) => candidate.slot === header.slot,
      );
      if (previous !== undefined && previous.name.toLowerCase() !== header.name.toLowerCase()) {
        throw new Error("A secret header slot cannot be reused for another header");
      }
    }
    this.#assertHistoricalSecretSlots(id, config.secretHeaders);
    const credentialsMoved = this.#credentialOriginChanged(
      currentVersion,
      config.transport,
      config.transport === "home_assistant" ? config.baseUrl : endpoint,
    );
    updateDestinationLabelRequired(this.#database, id, label, current.required, now);
    const versionId = this.#ids();
    insertVersionConfig(this.#database, {
      id: versionId,
      destinationId: id,
      versionNumber: nextVersionNumber(this.#database, id),
      createdAt: now,
      config,
      subscriptions,
    });
    this.#copyVersionSecrets(currentVersion.id, versionId, currentConfig, config, endpoint);
    if (connectionChanged) resetConnectivityState(this.#database, id, now);
    const store = this.#options.secrets;
    for (const previous of currentConfig.secretHeaders) {
      if (config.secretHeaders.some((header) => header.slot === previous.slot)) continue;
      store?.remove("outbound", id, previous.slot, { now: this.#now });
    }
    // Queued deliveries for the old address are dropped and failed ones made final (no
    // Retry), so they cannot resolve replacement secrets.
    let dismissedDeliveries = 0;
    if (credentialsMoved) {
      this.#removeDestinationSecrets(id);
      dismissedDeliveries = dismissDestinationDeliveries(this.#database, id, now);
      dismissFailedDestinationDeliveries(this.#database, id, now);
      if (config.transport === "home_assistant") markTokenMissing(this.#database, id, now);
    }
    appendOutboundActivity(this.#database, "configuration_changed", id, now, {
      change: "versioned",
      version: nextVersionNumber(this.#database, id) - 1,
      subscriptions_changed: subscriptionsChanged,
      ...(credentialsMoved
        ? { origin_changed: true, deliveries_dismissed: dismissedDeliveries }
        : {}),
    });
    return "version";
  }

  /** The first thing that stops a destination delivering, if any. */
  #enableBlocker(destination: OutboundDestination): EnableBlocker | undefined {
    const config = destination.currentVersion?.config;
    if (
      destination.transport === "home_assistant" &&
      !secretAvailable(this.#options.secrets, destination.id, HA_TOKEN_SLOT)
    ) {
      return "token_missing";
    }
    if (
      destination.transport === "webhook" &&
      (config?.transport !== "webhook" || config.endpointAvailable !== true)
    ) {
      return "endpoint_missing";
    }
    if (config?.secretHeaders.some((header) => !header.configured || header.available !== true)) {
      return "secret_missing";
    }
    const pendingSlotMissing = listUnfinishedSecretSlots(this.#database, destination.id).some(
      (slot) => !secretAvailable(this.#options.secrets, destination.id, slot),
    );
    return pendingSlotMissing ? "pending_secret" : undefined;
  }

  /** Enable or disable inside the caller's transaction; enabling refuses a blocked destination. */
  #writeEnabled(
    id: string,
    enabled: boolean,
    disabledReason = "operator_disabled",
  ): OutboundDestination {
    const now = iso(this.#now);
    const current = this.#requireMutableDestination(id);
    if (enabled) {
      const blocker = this.#enableBlocker(current);
      if (blocker !== undefined) {
        throw new ApplicationError({
          category: "validation",
          code: `outbound.${blocker}`,
          clientMessage: ENABLE_BLOCKERS[blocker].message,
        });
      }
      const disabledAt = current.disabledAt;
      setEnabledState(this.#database, id, true, now);
      if (disabledAt !== null) shiftDestinationDeliveries(this.#database, id, disabledAt, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "enabled",
      });
    } else {
      setEnabledState(this.#database, id, false, now, disabledReason);
      if (disabledReason === "token_missing") markTokenMissing(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "disabled",
        ...(disabledReason === "operator_disabled" ? {} : { reason: disabledReason }),
      });
    }
    const after = this.#requireDestination(id);
    this.integrationStatusChanged(this.#database, {
      destinationId: id,
      integrationType: after.transport,
      previousState: integrationEventState(current),
      state: integrationEventState(after),
      reasonCode: enabled ? "enabled" : disabledReason,
      occurredAt: now,
    });
    return after;
  }

  #requireDestination(destinationId: string): OutboundDestination {
    const result = this.get(destinationId);
    if (result === undefined) throw new Error("Outbound destination was not found");
    return result;
  }

  #requireMutableDestination(destinationId: string): OutboundDestination {
    const result = this.#requireDestination(destinationId);
    if (result.retiredAt !== null) {
      throw new Error("Retired outbound destinations are read-only");
    }
    return result;
  }

  #requireOwnedDelivery(destinationId: string, deliveryId: string): void {
    if (
      !deliveryBelongsToDestination(
        this.#database,
        destinationId,
        validateOutboundId(deliveryId, "deliveryId"),
      )
    ) {
      throw new Error("Outbound delivery was not found");
    }
  }

  #assertHeaderTotal(
    staticHeaders: readonly { readonly name: string; readonly value: string }[],
    secretHeaders: readonly { readonly name: string; readonly slot: string }[],
    secretValues: ReadonlyMap<string, string>,
  ): void {
    const configured = [
      ...staticHeaders,
      ...secretHeaders.flatMap((header) => {
        const value = secretValues.get(header.slot);
        return value === undefined ? [] : [{ name: header.name, value }];
      }),
    ];
    if (configuredHeaderBytes(configured) > MAX_HEADER_TOTAL_BYTES) {
      throw new TypeError("Configured outbound headers exceed 4096 total bytes");
    }
  }

  #withDeferredLifecycle<Result>(
    work: () => Result,
    afterCommit: (result: Result) => void,
  ): Result {
    this.#lifecycleSuppression += 1;
    let result: Result;
    try {
      result = work();
    } finally {
      this.#lifecycleSuppression -= 1;
    }
    afterCommit(result);
    return result;
  }

  #emitLifecycle(
    action: "enabled" | "disabled" | "credentials_changed" | "retired",
    destinationId: string,
  ): void {
    if (this.#lifecycleSuppression > 0) return;
    if (action === "enabled") this.#options.lifecycle?.onEnabled?.(destinationId);
    else if (action === "disabled") this.#options.lifecycle?.onDisabled?.(destinationId);
    else if (action === "credentials_changed")
      this.#options.lifecycle?.onCredentialsChanged?.(destinationId);
    else this.#options.lifecycle?.onRetired?.(destinationId);
  }

  #storeInitialSecret(
    destinationId: string,
    config: ReturnType<typeof normalizeDestinationConfig>,
    secret: string | undefined,
    _now: string,
  ): void {
    if (secret === undefined) return;
    const store = requireSecretStore(this.#options.secrets);
    if (config.transport === "home_assistant")
      store.upsert("outbound", destinationId, HA_TOKEN_SLOT, secret, { now: this.#now });
    else if (config.endpointSlot !== undefined)
      store.upsert("outbound", this.#currentVersionId(destinationId), config.endpointSlot, secret, {
        now: this.#now,
      });
  }

  #currentVersionId(destinationId: string): string {
    const result = readCurrentDestinationVersion(this.#database, destinationId);
    if (result === undefined) throw new Error("Outbound destination configuration is missing");
    return result.id;
  }

  #revealSecret(recordId: string, fieldName: string): string {
    return requireSecretStore(this.#options.secrets).revealPrivileged(
      "outbound",
      recordId,
      fieldName,
    );
  }

  /**
   * Whether an edit points the destination's stored secrets at a different
   * transport or origin. A first webhook endpoint binds secrets entered before
   * it; an endpoint that exists but cannot be read fails closed.
   */
  #credentialOriginChanged(
    currentVersion: NonNullable<OutboundDestination["currentVersion"]>,
    transport: OutboundConfig["transport"],
    url: string | undefined,
  ): boolean {
    const current = currentVersion.config;
    if (current.transport !== transport) return true;
    let previousUrl: string | undefined;
    if (current.transport === "home_assistant") previousUrl = current.baseUrl;
    else if (current.endpointConfigured) {
      if (!current.endpointAvailable) return true;
      previousUrl = this.#revealSecret(currentVersion.id, WEBHOOK_ENDPOINT_SLOT);
    } else return false;
    return credentialOrigin(current.transport, previousUrl) !== credentialOrigin(transport, url);
  }

  /** Remove every destination-scoped secret (Home Assistant token and header values). */
  #removeDestinationSecrets(destinationId: string): void {
    const store = this.#options.secrets;
    if (store === undefined) return;
    for (const descriptor of safeSecretDescriptors(store)) {
      if (
        descriptor.integrationType === "outbound" &&
        descriptor.recordId === destinationId &&
        descriptor.configured
      )
        store.remove("outbound", destinationId, descriptor.fieldName, { now: this.#now });
    }
  }

  #assertHistoricalSecretSlots(
    destinationId: string,
    headers: readonly { readonly name: string; readonly slot: string }[],
  ): void {
    const historical = listDestinationConfigJson(this.#database, destinationId);
    const namesBySlot = new Map<string, string>();
    for (const configJson of historical) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(configJson) as unknown;
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const raw = (parsed as Record<string, unknown>).secretHeaders;
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.slot !== "string" || typeof record.name !== "string") continue;
        namesBySlot.set(record.slot, record.name.toLowerCase());
      }
    }
    for (const header of headers) {
      const previousName = namesBySlot.get(header.slot);
      if (previousName !== undefined && previousName !== header.name.toLowerCase()) {
        throw new Error("A secret header slot cannot be reused for another header");
      }
    }
  }

  #copyVersionSecrets(
    oldVersionId: string,
    newVersionId: string,
    oldConfig: OutboundConfig,
    newConfig: ReturnType<typeof normalizeDestinationConfig>,
    endpoint: string | undefined,
  ): void {
    const store = this.#options.secrets;
    if (store === undefined) return;
    if (newConfig.transport === "webhook") {
      const endpointValue =
        endpoint ??
        (oldConfig.transport === "webhook" && oldConfig.endpointConfigured
          ? this.#revealSecret(oldVersionId, WEBHOOK_ENDPOINT_SLOT)
          : undefined);
      if (endpointValue !== undefined)
        store.upsert("outbound", newVersionId, WEBHOOK_ENDPOINT_SLOT, endpointValue, {
          now: this.#now,
        });
    }
  }

  #revokeSecrets(destinationId: string): void {
    const store = this.#options.secrets;
    if (store === undefined) return;
    const versionIds = new Set(listDestinationVersionIds(this.#database, destinationId));
    for (const descriptor of safeSecretDescriptors(store)) {
      if (descriptor.integrationType !== "outbound") continue;
      if (descriptor.recordId !== destinationId && !versionIds.has(descriptor.recordId)) continue;
      if (descriptor.configured)
        store.remove("outbound", descriptor.recordId, descriptor.fieldName, { now: this.#now });
    }
  }
}

export function createOutboundService(
  database: DatabaseExecutor,
  options: OutboundServiceOptions = {},
): OutboundService {
  return new OutboundService(database, options);
}
