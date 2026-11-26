import { sendJson } from "../../../infrastructure/http/error-mapper.ts";
import { registerAdminGet } from "./http.ts";
import { isActionableHealth, type StatTile, type StatusBadge } from "./presentation.ts";
import { renderAdmin } from "./layout.ts";
import { humanizeAdminIdentifier, healthCheckPresentation } from "./detector-presentation.ts";
import { adminContext } from "./context.ts";
import { brewfatherConnectionBadge } from "./integrations.ts";
import type {
  RegisterOverviewPagesDependencies,
  RegisterAdminEventRoutesDependencies,
} from "../contracts.ts";

export function registerOverviewPages(dependencies: RegisterOverviewPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/overview", (request, response, context) => {
    const taps = dependencies.tapService.listTaps();
    const fills = dependencies.fillService.listFills();
    const health = dependencies.healthService.listAdminOverview();
    const actionableHealth = health.filter((item) =>
      isActionableHealth(item.aggregate.state, item.aggregate.severity),
    );
    const kegs = dependencies.kegService.listKegs();
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    const header = dependencies.dashboardService.getHeader();
    const telemetryConfigured = dependencies.telemetryService.listSources().length;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/overview",
      "Overview",
      "/admin/overview",
      {
        metrics: [
          {
            label: "Enabled taps",
            value: taps.filter((tap) => tap.enabled && !tap.isRetired).length,
            href: "/admin/taps",
          },
          {
            label: "Active fills",
            value: fills.filter((fill) => fill.state !== "ended").length,
            href: "/admin/keg-room?state=active",
          },
          {
            label: "On deck",
            value: fills.filter((fill) => fill.state === "on_deck").length,
            href: "/admin/keg-room?state=on_deck",
          },
          { label: "Health warnings", value: actionableHealth.length, href: "#attention-heading" },
        ] satisfies readonly StatTile[],
        taps: taps.map((tap) => {
          const isPublic = tap.enabled && !tap.isRetired;
          return {
            id: tap.id,
            title: `#${tap.tapNumber}${tap.name ? ` — ${tap.name}` : ""}`,
            assignmentLabel: tap.activeAssignment?.beverageName || "Unassigned",
            badge: {
              label: tap.isRetired ? "Retired" : tap.enabled ? "Enabled" : "Disabled",
              tone: isPublic ? "healthy" : "muted",
            } satisfies StatusBadge,
            publicLabel: isPublic ? "Enabled" : "Hidden",
            href: `/admin/taps/${encodeURIComponent(tap.id)}`,
          };
        }),
        health: actionableHealth.map((item) => ({
          tapId: item.tapId,
          tapNumber: taps.find((tap) => tap.id === item.tapId)?.tapNumber ?? null,
          tapLabel: `Tap ${taps.find((tap) => tap.id === item.tapId)?.tapNumber ?? "unknown"}`,
          tapName: item.name,
          href: `/admin/taps/${encodeURIComponent(item.tapId)}`,
          badge: healthBadge(item.aggregate.state, item.aggregate.severity),
          state: item.aggregate.state,
          stateLabel: humanizeAdminIdentifier(item.aggregate.state),
          severity: item.aggregate.severity,
          severityLabel: humanizeAdminIdentifier(item.aggregate.severity),
          checksLabel: (item.checks ?? [])
            .filter((check) => isActionableHealth(check.state, check.severity))
            .map((check) => healthCheckPresentation(check.checkId).title)
            .join(", "),
          checks: (item.checks ?? [])
            .filter((check) => isActionableHealth(check.state, check.severity))
            .map((check) => ({
              id: check.checkId,
              label: healthCheckPresentation(check.checkId).title,
              state: check.state,
              stateLabel: humanizeAdminIdentifier(check.state),
              severity: check.severity,
              severityLabel: humanizeAdminIdentifier(check.severity),
              reason: check.reason,
              reasonLabel: check.reason === null ? null : humanizeAdminIdentifier(check.reason),
            })),
        })),
        kegRoom: [
          {
            label: "Active kegs",
            value: kegs.filter((keg) => keg.isActive).length,
            href: "/admin/keg-room/kegs?status=active",
          },
          {
            label: "On tap",
            value: fills.filter((fill) => fill.state === "on_tap").length,
            href: "/admin/keg-room?state=on_tap",
          },
          {
            label: "On deck",
            value: fills.filter((fill) => fill.state === "on_deck").length,
            href: "/admin/keg-room?state=on_deck",
          },
          {
            label: "Available fills",
            value: fills.filter((fill) => fill.state === "available").length,
            href: "/admin/keg-room?state=available",
          },
        ] satisfies readonly StatTile[],
        connectivity: {
          label: header.connectivityLabel,
          tone:
            header.connectivity === "disconnected"
              ? "critical"
              : header.connectivity === "healthy"
                ? "healthy"
                : "degraded",
        } satisfies StatusBadge,
        integrations: [
          {
            label: "Telemetry sources",
            value: telemetryConfigured,
            href: "/admin/integrations/telemetry",
          },
          {
            label: "Brewfather",
            value: brewfatherConnectionBadge(brewfather).label,
            href: "/admin/integrations/brewfather",
          },
          {
            label: "Linked beverages",
            value: brewfather.totalLinkedBeverages,
            href: "/admin/integrations/brewfather",
          },
        ] satisfies readonly StatTile[],
        quickLinks: [
          { label: "Manage Taps", href: "/admin/taps" },
          { label: "Open Keg Room", href: "/admin/keg-room" },
          { label: "Manage Beverages", href: "/admin/beverages" },
          { label: "Configure Integrations", href: "/admin/integrations" },
          { label: "Adjust Display", href: "/admin/display" },
        ],
      },
    );
  });
}

/** A Tap's overall health as a badge: severity first, then state. */
function healthBadge(state: string, severity: string): StatusBadge {
  return {
    label: humanizeAdminIdentifier(severity === "none" ? state : severity),
    tone:
      severity === "critical"
        ? "critical"
        : severity === "warning"
          ? "warning"
          : state === "active"
            ? "active"
            : "degraded",
  };
}

export function registerAdminEventRoutes(dependencies: RegisterAdminEventRoutesDependencies): void {
  dependencies.router.get("/api/admin/events", (request, response) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Authentication is required." },
      });
      return;
    }
    dependencies.liveUpdates.connectAdmin(response, context.sessionToken);
  });
}
