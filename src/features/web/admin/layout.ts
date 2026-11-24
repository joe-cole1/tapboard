import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHtml } from "../../../infrastructure/http/html.ts";
import { displayStylesheetHref } from "../../display/palette.ts";
import { type AdminContext, pageMessage, requestUrl } from "./context.ts";
import type { RenderAdminDependencies } from "../contracts.ts";

export const ADMIN_NAV = [
  {
    key: "overview",
    label: "Overview",
    href: "/admin/overview",
    group: "Overview",
    activePaths: ["/admin/overview"],
  },
  {
    key: "keg-room",
    label: "Keg Room",
    href: "/admin/keg-room",
    group: "Manage",
    activePaths: ["/admin/fills", "/admin/kegs", "/admin/keg-room"],
  },
  {
    key: "taps",
    label: "Taps",
    href: "/admin/taps",
    group: "Manage",
    activePaths: ["/admin/taps"],
  },
  {
    key: "beverages",
    label: "Beverages",
    href: "/admin/beverages",
    group: "Manage",
    activePaths: ["/admin/beverages"],
  },
  {
    key: "tap-wars",
    label: "Tap Wars",
    href: "/admin/tap-wars",
    group: "Manage",
    activePaths: ["/admin/tap-wars"],
  },
  {
    key: "integrations",
    label: "Integrations",
    href: "/admin/integrations",
    group: "Configure",
    activePaths: ["/admin/integrations"],
  },
  {
    key: "display",
    label: "Display",
    href: "/admin/display",
    group: "Configure",
    activePaths: ["/admin/display"],
  },
  {
    key: "system",
    label: "System",
    href: "/admin/system",
    group: "Configure",
    activePaths: ["/admin/system"],
  },
  {
    key: "logs",
    label: "Logs",
    href: "/admin/logs",
    group: "Configure",
    activePaths: ["/admin/logs"],
  },
  {
    key: "simulation",
    label: "Simulation",
    href: "/admin/simulator",
    group: "Configure",
    activePaths: ["/admin/simulator"],
  },
] as const;

export function adminNavItems(): readonly (typeof ADMIN_NAV)[number][] {
  return ADMIN_NAV;
}

/** One breadcrumb level; the current page is the last one and has no link. */
export interface AdminBreadcrumb {
  readonly label: string;
  readonly href?: string;
}

/**
 * The full trail for an Admin page: Admin / Section / parents / this page. `path` is the
 * page's navigation path (the same one that marks the current menu item) and `pathname` the
 * URL path it was served at. A section's own page (served at the section's URL) ends at itself.
 */
export function adminBreadcrumbs(
  path: string,
  pathname: string,
  title: string,
  parents: readonly Required<AdminBreadcrumb>[] = [],
): readonly AdminBreadcrumb[] {
  const trail: AdminBreadcrumb[] = [{ label: "Admin", href: "/admin/overview" }];
  const section = ADMIN_NAV.find((item) =>
    item.activePaths.some((active) => path === active || path.startsWith(`${active}/`)),
  );
  if (section !== undefined && section.href !== pathname) {
    trail.push({ label: section.label, href: section.href });
  }
  trail.push(...parents, { label: title });
  return trail;
}

const ADMIN_TABS = {
  "keg-room": {
    label: "Keg Room",
    items: [
      { label: "Filled Kegs", href: "/admin/keg-room" },
      { label: "Physical Kegs", href: "/admin/keg-room/kegs" },
      { label: "History", href: "/admin/keg-room?state=ended" },
    ],
  },
  integrations: {
    label: "Integrations",
    items: [
      { label: "Overview", href: "/admin/integrations" },
      { label: "Brewfather", href: "/admin/integrations/brewfather" },
      { label: "Telemetry", href: "/admin/integrations/telemetry" },
      { label: "Outbound", href: "/admin/integrations/outbound" },
    ],
  },
  display: {
    label: "Display",
    items: [
      { label: "Overview", href: "/admin/display" },
      { label: "Default theme", href: "/admin/display/shared" },
      { label: "This display", href: "/admin/display/this-display" },
    ],
  },
  logs: {
    label: "Logs",
    items: [
      { label: "Activity log", href: "/admin/logs" },
      { label: "Admin sessions", href: "/admin/logs/sessions" },
      { label: "Retention", href: "/admin/logs/retention" },
    ],
  },
} as const;

export interface AdminTabs {
  readonly label: string;
  readonly items: readonly {
    readonly label: string;
    readonly href: string;
    readonly current: boolean;
  }[];
}

/** Link tabs for a section with sibling pages; `currentHref` is one of that section's tab hrefs. */
export function adminTabs(section: keyof typeof ADMIN_TABS, currentHref: string): AdminTabs {
  const tabs = ADMIN_TABS[section];
  return {
    label: tabs.label,
    items: tabs.items.map((item) => ({ ...item, current: item.href === currentHref })),
  };
}

export function renderAdmin(
  dependencies: RenderAdminDependencies,
  response: ServerResponse,
  request: IncomingMessage,
  context: AdminContext,
  view: string,
  title: string,
  path: string,
  data: Readonly<Record<string, unknown>> & {
    /** Breadcrumb levels between the section and this page. */
    readonly breadcrumbParents?: readonly Required<AdminBreadcrumb>[];
  } = {},
): void {
  const message = pageMessage(request);
  const display = dependencies.displayService.getSettings();
  const {
    includeDashboardStyles: requestedDashboardStyles,
    displayStylesheetHref: requestedDisplayStylesheetHref,
    breadcrumbParents,
    ...viewData
  } = data;
  const page = {
    title,
    path,
    breadcrumbs: adminBreadcrumbs(path, requestUrl(request).pathname, title, breadcrumbParents),
    csrfToken: context.csrfToken,
    siteName: display.tapboardName,
    ...(requestedDashboardStyles === true ? { includeDashboardStyles: true } : {}),
    // Every authenticated Admin page receives the configured external display
    // stylesheet. Dedicated preview pages may explicitly request a different
    // font set (the shared preview uses `all`); ordinary pages never do.
    displayStylesheetHref:
      requestedDisplayStylesheetHref ??
      displayStylesheetHref(display.theme, display.accent, display.font),
    ...message,
  };
  sendHtml(
    response,
    200,
    dependencies.renderer.render(view, {
      page,
      navItems: adminNavItems(),
      ...viewData,
    }),
  );
}
