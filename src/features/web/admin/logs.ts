import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  validationFieldsFor,
  type AutosaveValidationFields,
} from "./http.ts";
import { requestUrl, actor, type AdminContext } from "./context.ts";
import { adminTabs, renderAdmin } from "./layout.ts";
import { humanizeAdminIdentifier } from "./detector-presentation.ts";
import { invalidForm } from "./forms.ts";
import { requireSystemService, systemFormFields, systemFormNumber } from "./system.ts";
import type { SystemActivityItem, SystemRetentionSettings } from "../../system/types.ts";
import type {
  RegisterSystemPagesDependencies,
  RegisterSystemMutationsDependencies,
} from "../contracts.ts";

/** The Retention form's fields, every one required by each save. */
const RETENTION_FIELDS = [
  "activityDays",
  "rawSeconds",
  "receiptSeconds",
  "reconnectSeconds",
  "hourlyRollupDays",
  "dailyRollupDays",
  "outboxDays",
] as const;

/**
 * The form field a service validation error belongs to. The receipt check across raw
 * retention and the reconnect horizon is reported as "telemetry", and Receipts is the field
 * the page's note tells the operator to raise.
 */
const RETENTION_SERVICE_FIELDS: Readonly<Record<string, string>> = {
  "activity.retentionDays": "activityDays",
  rawRetentionSeconds: "rawSeconds",
  receiptRetentionSeconds: "receiptSeconds",
  reconnectHorizonSeconds: "reconnectSeconds",
  hourlyRollupRetentionDays: "hourlyRollupDays",
  dailyRollupRetentionDays: "dailyRollupDays",
  telemetry: "receiptSeconds",
  "outbox.retentionDays": "outboxDays",
};

const retentionValidationFields: AutosaveValidationFields = (error) => {
  const serviceField = String(error.details?.field ?? "").replace(/^telemetry\.(?=.)/u, "");
  const field = RETENTION_SERVICE_FIELDS[serviceField];
  return field === undefined
    ? validationFieldsFor(RETENTION_FIELDS)(error)
    : { [field]: error.clientMessage };
};

/** Retention settings by the form's field names. */
function retentionFormValues(settings: SystemRetentionSettings): Record<string, number> {
  return {
    activityDays: settings.activity.retentionDays,
    rawSeconds: settings.telemetry.rawRetentionSeconds,
    receiptSeconds: settings.telemetry.receiptRetentionSeconds,
    reconnectSeconds: settings.telemetry.reconnectHorizonSeconds,
    hourlyRollupDays: settings.telemetry.hourlyRollupRetentionDays,
    dailyRollupDays: settings.telemetry.dailyRollupRetentionDays,
    outboxDays: settings.outbox.retentionDays,
  };
}

/** Logs: the Activity log, Admin sessions and retention, as three tabs. */
export function registerLogsPages(dependencies: RegisterSystemPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/logs", (request, response, context) => {
    const service = requireSystemService(dependencies);
    const url = requestUrl(request);
    const category = url.searchParams.get("category") ?? "";
    const activity = service.getActivityPage({
      ...(category === "" ? {} : { category }),
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
    });
    const nextQuery = new URLSearchParams();
    if (category !== "") nextQuery.set("category", category);
    if (activity.nextCursor !== null) nextQuery.set("cursor", activity.nextCursor);
    renderAdmin(dependencies, response, request, context, "/admin/logs", "Logs", "/admin/logs", {
      tabs: adminTabs("logs", "/admin/logs"),
      activity: {
        ...activity,
        category,
        hasCursor: url.searchParams.has("cursor"),
        items: presentActivityItems(activity.items),
        nextHref: activity.nextCursor === null ? null : `/admin/logs?${nextQuery}`,
      },
    });
  });

  registerAdminGet(dependencies, "/admin/logs/sessions", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/logs-sessions",
      "Admin sessions",
      "/admin/logs/sessions",
      {
        tabs: adminTabs("logs", "/admin/logs/sessions"),
        sessions: dependencies.authService.listActiveSessions({
          currentSessionId: context.session.id,
        }),
      },
    );
  });

  registerAdminGet(dependencies, "/admin/logs/retention", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/logs-retention",
      "Retention",
      "/admin/logs/retention",
      {
        tabs: adminTabs("logs", "/admin/logs/retention"),
        retention: requireSystemService(dependencies).getRetentionSettings(),
      },
    );
  });
}

export function registerLogsMutations(dependencies: RegisterSystemMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/logs/sessions/:id/revoke",
    "/admin/logs/sessions",
    (form, context, params) => {
      systemFormFields(form, ["confirm"]);
      if (form.confirm !== "revoke") invalidForm("Confirm the session revocation.");
      dependencies.authService.revokeSessionById(params.id, actor(context));
      return params.id === context.session.id ? "/admin/login" : "/admin/logs/sessions";
    },
    "Session revoked.",
  );
  const saveRetention = (form: Readonly<Record<string, string>>, context: AdminContext) => {
    systemFormFields(form, RETENTION_FIELDS);
    // The service checks this too, with a generic message; here it names the field and the rule.
    const receiptSeconds = systemFormNumber(form, "receiptSeconds");
    if (
      receiptSeconds < systemFormNumber(form, "rawSeconds") ||
      receiptSeconds < systemFormNumber(form, "reconnectSeconds")
    ) {
      invalidForm(
        "Keep receipts at least as long as raw telemetry and the reconnect horizon.",
        "receiptSeconds",
      );
    }
    return requireSystemService(dependencies).updateRetentionSettings(
      {
        activity: { retentionDays: systemFormNumber(form, "activityDays") },
        telemetry: {
          rawRetentionSeconds: systemFormNumber(form, "rawSeconds"),
          receiptRetentionSeconds: systemFormNumber(form, "receiptSeconds"),
          reconnectHorizonSeconds: systemFormNumber(form, "reconnectSeconds"),
          hourlyRollupRetentionDays: systemFormNumber(form, "hourlyRollupDays"),
          dailyRollupRetentionDays: systemFormNumber(form, "dailyRollupDays"),
        },
        outbox: { retentionDays: systemFormNumber(form, "outboxDays") },
      },
      { sessionId: context.session.id },
    );
  };
  registerAdminAction(
    dependencies,
    "/admin/logs/retention",
    "/admin/logs/retention",
    (form, context) => {
      saveRetention(form, context);
    },
    "Retention settings saved. Pruning runs automatically in bounded batches.",
    {},
    {
      // Retention keeps no single revision, so the whole form saves as the form post does.
      handle: (body, context) => ({
        resource: retentionFormValues(
          saveRetention(autosaveFieldStrings(body, RETENTION_FIELDS), context),
        ),
      }),
      current: () => ({
        current: retentionFormValues(requireSystemService(dependencies).getRetentionSettings()),
      }),
      validationFields: retentionValidationFields,
    },
  );
}

/** Activity log rows with readable labels and a link to each entry's resource. */
export function presentActivityItems(items: readonly SystemActivityItem[]) {
  return items.map((item) => ({
    ...item,
    actionLabel: humanizeAdminIdentifier(item.action.replaceAll(".", " ")),
    categoryLabel: humanizeAdminIdentifier(item.category),
    actorLabel: humanizeAdminIdentifier(item.actorType),
    entityLabel: `${humanizeAdminIdentifier(item.entityType, "—")}${item.entityId === null ? "" : ` ${item.entityId.slice(0, 8)}`}`,
    entityHref: activityEntityHref(item.entityType, item.entityId),
  }));
}

export function activityEntityHref(
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (entityType === null || entityId === null) return null;
  const paths: Readonly<Record<string, string>> = {
    beverage: "/admin/beverages",
    keg: "/admin/kegs",
    fill: "/admin/fills",
    tap: "/admin/taps",
  };
  const path = paths[entityType];
  return path === undefined ? null : `${path}/${encodeURIComponent(entityId)}`;
}
