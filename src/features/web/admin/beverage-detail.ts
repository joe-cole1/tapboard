import type { IncomingMessage, ServerResponse } from "node:http";
import type { BeverageService, BeverageDetailResult } from "../../beverages/service.ts";
import { BEVERAGE_TYPES } from "../../beverages/types.ts";
import { beverageDisplayColor } from "../../story/vessels.ts";
import { type AdminContext } from "./context.ts";
import { renderAdmin } from "./layout.ts";
import {
  adminBeverageDetailDto,
  displayColourPicker,
  fillGlassOptions,
  safeColorForDisplay,
} from "./beverage-presentation.ts";
import { adminTimestampLabel, type PageHeader } from "./presentation.ts";
import type { RegisterBeveragePagesDependencies } from "../contracts.ts";

/** The Beverage page's tabs, in order; the first is the Beverage's own URL. */
export const BEVERAGE_TABS = [
  { id: "info", label: "Info", path: "" },
  { id: "presentation", label: "Presentation", path: "/presentation" },
  { id: "usage", label: "Current usage", path: "/usage" },
  { id: "recipe", label: "Recipe", path: "/recipe" },
  { id: "sensory", label: "Sensory", path: "/sensory" },
  { id: "delete", label: "Delete", path: "/delete" },
] as const;

export type BeverageTab = (typeof BEVERAGE_TABS)[number]["id"];

/** The URL of one tab of a Beverage's page. */
export function beveragePagePath(beverageId: string, tab: BeverageTab): string {
  const path = BEVERAGE_TABS.find((item) => item.id === tab)!.path;
  return `/admin/beverages/${encodeURIComponent(beverageId)}${path}`;
}

/** The fields a Custom Beverage's Presentation tab posts to `/update`; the rest are on Info. */
export const PRESENTATION_TAB_FIELDS = [
  "srm",
  "srmExact",
  "displayColor",
  "description",
  "fillGlass",
] as const;

/** Usage and the current Fills come from the production service; small doubles may lack them. */
type ServiceWithUsage = BeverageService & {
  readonly getBeverageUsage?: (beverageId: string) => {
    readonly current: number;
    readonly total: number;
  };
  readonly listCurrentFills?: (
    beverageId: string,
    limit?: number,
  ) => readonly Record<string, unknown>[];
};

export function renderBeverageDetail(
  dependencies: RegisterBeveragePagesDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  context: AdminContext,
  params: Readonly<Record<string, string>>,
  tab: BeverageTab,
) {
  const id = params.id ?? "";
  const detail = dependencies.beverageService.getBeverage(id);
  const service = dependencies.beverageService as ServiceWithUsage;
  const usage =
    typeof service.getBeverageUsage === "function"
      ? service.getBeverageUsage(id)
      : { current: 0, total: 0 };
  // Guidance runs the flavor model, so only the tabs that show it ask for it.
  const guidance =
    (tab === "sensory" || tab === "recipe") &&
    typeof dependencies.storyService?.getAdminBeverageGuidance === "function"
      ? dependencies.storyService.getAdminBeverageGuidance(id)
      : undefined;
  const impacts =
    tab === "delete" ? dependencies.beverageService.getDeletionImpact(id).impacts : [];
  const beverage = adminBeverageDetailDto(detail, usage, impacts, guidance);
  const name = detail.effectivePresentation.name;
  const current = BEVERAGE_TABS.find((item) => item.id === tab)!;

  renderAdmin(
    dependencies,
    response,
    request,
    context,
    "/admin/beverage-detail",
    tab === "info" ? name : current.label,
    "/admin/beverages",
    {
      tab,
      header: {
        title: name,
        colourCue: beverageDisplayColor(detail.effectivePresentation),
        badge: {
          label:
            detail.beverage.ownershipType === "brewfather"
              ? "Brewfather linked"
              : "Custom beverage",
        },
        updated: {
          datetime: detail.beverage.updatedAt,
          label: adminTimestampLabel(detail.beverage.updatedAt),
        },
      } satisfies PageHeader,
      tabs: {
        label: name,
        items: BEVERAGE_TABS.map((item) => ({
          label: item.label,
          href: beveragePagePath(id, item.id),
          current: item.id === tab,
        })),
      },
      ...(tab === "info"
        ? {}
        : { breadcrumbParents: [{ label: name, href: beveragePagePath(id, "info") }] }),
      beverage: {
        ...beverage,
        updatedAtLabel: adminTimestampLabel(detail.beverage.updatedAt),
        lastSyncedAtLabel:
          detail.brewfatherLink?.lastSyncedAt == null
            ? null
            : adminTimestampLabel(detail.brewfatherLink.lastSyncedAt),
      },
      beverageTypes: BEVERAGE_TYPES,
      ...(tab === "presentation" ? presentationTab(detail) : {}),
      ...(tab === "usage" ? usageTab(dependencies, service, id) : {}),
    },
  );
}

/** Presentation: glass and description (or the Brewfather overrides), then the colour picker. */
function presentationTab(detail: BeverageDetailResult) {
  const effective = detail.effectivePresentation;
  const overrides = detail.presentationOverrides;
  const linked = detail.beverage.ownershipType === "brewfather";
  return {
    fillGlassOptions: fillGlassOptions(),
    colourPicker: displayColourPicker({
      beverageType: effective.beverageType,
      srm: effective.srm,
      resolvedColor: beverageDisplayColor(effective),
      colourOverridden: linked
        ? overrides?.overrideDisplayColorPresent === true
        : safeColorForDisplay(effective.displayColor) !== null,
      linked,
      srmOverridden: overrides?.overrideSrmPresent === true,
    }),
  };
}

/** Current usage: the Filled Kegs pouring this beverage, and the empty kegs a new Fill can use. */
function usageTab(
  dependencies: RegisterBeveragePagesDependencies,
  service: ServiceWithUsage,
  id: string,
) {
  const currentFills =
    typeof service.listCurrentFills === "function" ? service.listCurrentFills(id, 25) : [];
  const availableKegs = dependencies.kegService
    .listKegs({ isActive: true })
    .filter(
      (keg) =>
        !dependencies.fillService
          .listFills({ kegId: keg.id })
          .some((fill) => fill.state !== "ended"),
    )
    .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label }));
  return {
    currentFills: currentFills.map((fill) => ({
      ...fill,
      badge: { label: fill.state.replaceAll("_", " "), tone: fill.state },
    })),
    availableKegs,
  };
}
