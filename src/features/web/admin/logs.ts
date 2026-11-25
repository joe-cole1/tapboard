import { registerAdminGet, registerAdminAction } from "./http.ts";
import { requestUrl, actor } from "./context.ts";
import { adminTabs, renderAdmin } from "./layout.ts";
import { humanizeAdminIdentifier } from "./detector-presentation.ts";
import { invalidForm } from "./forms.ts";
import { requireSystemService, systemFormFields, systemFormNumber } from "./system.ts";
import type { SystemActivityItem } from "../../system/types.ts";
import type {
  RegisterSystemPagesDependencies,
  RegisterSystemMutationsDependencies,
} from "../contracts.ts";

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
  registerAdminAction(
    dependencies,
    "/admin/logs/retention",
    "/admin/logs/retention",
    (form, context) => {
      systemFormFields(form, [
        "activityDays",
        "rawSeconds",
        "receiptSeconds",
        "reconnectSeconds",
        "hourlyRollupDays",
        "dailyRollupDays",
        "outboxDays",
      ]);
      requireSystemService(dependencies).updateRetentionSettings(
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
    },
    "Retention settings saved. Pruning runs automatically in bounded batches.",
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
