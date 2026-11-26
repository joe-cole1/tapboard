import type { IncomingMessage, ServerResponse } from "node:http";
import { reportFailure } from "../../../shared/diagnostics.ts";
import { tapDeletionConfirmationLabel, type TapService } from "../../taps/service.ts";
import type { AdminTapView } from "../../taps/types.ts";
import { DETECTOR_CONFIG_FIELDS, mergeDetectorConfig } from "../../telemetry/detector-config.ts";
import { TELEMETRY_METRICS } from "../../telemetry/metrics.ts";
import { HEALTH_CHECK_IDS } from "../../health/types.ts";
import { type AdminContext, requestUrl } from "./context.ts";
import { safeDashboardTap, safeMysteryPreview, safeHealthOverview } from "./tap-presentation.ts";
import { TAP_CARD_DISPLAY_FIELDS } from "./presentation-overrides.ts";
import {
  DETECTOR_FIELD_PRESENTATION,
  formatAdminConfigValue,
  DETECTOR_GROUPS,
  humanizeAdminIdentifier,
} from "./detector-presentation.ts";
import { HEALTH_SECTION_PRESENTATION } from "./health-presentation.ts";
import { tapDeletionBlockers, tapRetireBlockers } from "./blockers.ts";
import { renderAdmin } from "./layout.ts";
import { presentActivityItems } from "./logs.ts";
import { timestampLabel, type PageHeader } from "./presentation.ts";
import type { RenderTapDetailDependencies } from "../contracts.ts";

const KPA_PER_PSI = TELEMETRY_METRICS.pressure!.units.psi!(1);

/** The Tap page's tabs, in order; the first is the Tap's own URL. */
export const TAP_TABS = [
  { id: "card", label: "Public card", path: "" },
  { id: "identity", label: "Identity", path: "/identity" },
  { id: "sensors", label: "Sensors", path: "/sensors" },
  { id: "maintenance", label: "Maintenance", path: "/maintenance" },
  { id: "history", label: "History", path: "/history" },
] as const;

export type TapTab = (typeof TAP_TABS)[number]["id"];

/** The URL of one tab of a Tap's page. */
export function tapPagePath(tapId: string, tab: TapTab): string {
  const path = TAP_TABS.find((item) => item.id === tab)!.path;
  return `/admin/taps/${encodeURIComponent(tapId)}${path}`;
}

const END_REASON_LABELS: Readonly<Record<string, string>> = {
  unassigned: "Taken off tap",
  moved: "Moved to another Tap",
  fill_ended: "Kicked",
};

type Report = (operation: string, error: unknown) => void;

export function renderTapDetail(
  dependencies: RenderTapDetailDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  context: AdminContext,
  params: Readonly<Record<string, string>>,
  tab: TapTab,
) {
  const id = params.id ?? "";
  const tap = dependencies.tapService.getTap(id);
  const report: Report = (operation, error) =>
    reportFailure(error, {
      operation,
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
  const tapTitle = `Tap ${tap.tapNumber}${tap.name ? ` — ${tap.name}` : ""}`;
  const current = TAP_TABS.find((item) => item.id === tab)!;
  const { timeZone } = dependencies.displayService.getSettings();
  const tabData =
    tab === "card"
      ? cardTab(dependencies, tap, report)
      : tab === "identity"
        ? identityTab(dependencies, tap, report)
        : tab === "sensors"
          ? sensorsTab(dependencies, tap, report)
          : tab === "maintenance"
            ? maintenanceTab(dependencies, tap, report)
            : historyTab(dependencies, tap, request, report);

  renderAdmin(
    dependencies,
    response,
    request,
    context,
    "/admin/tap-detail",
    tab === "card" ? tapTitle : current.label,
    "/admin/taps",
    {
      tab,
      header: tapPageHeader(tap),
      tabs: {
        label: tapTitle,
        items: TAP_TABS.map((item) => ({
          label: item.label,
          href: tapPagePath(tap.id, item.id),
          current: item.id === tab,
        })),
      },
      ...(tab === "card"
        ? {}
        : { breadcrumbParents: [{ label: tapTitle, href: tapPagePath(tap.id, "card") }] }),
      tap: {
        identity: {
          id: tap.id,
          tapNumber: tap.tapNumber,
          name: tap.name,
          createdAt: tap.createdAt,
          updatedAt: tap.updatedAt,
          updatedAtLabel: timestampLabel(tap.updatedAt, timeZone),
          confirmationLabel: tapDeletionConfirmationLabel(tap),
        },
        lifecycle: {
          enabled: tap.enabled,
          isRetired: tap.isRetired,
          firstUsedAt: tap.firstUsedAt,
          firstUsedAtLabel: timestampLabel(tap.firstUsedAt, timeZone),
          retiredAt: tap.retiredAt,
        },
        ...tabData,
      },
      includeDashboardStyles: tab === "card",
    },
  );
}

/** What a Mystery Tap can reveal to guests, in the order the switches show. */
const MYSTERY_REVEALS = [
  ["revealBeverageType", "Beverage type"],
  ["revealStyle", "Style"],
  ["revealAbv", "ABV"],
  ["revealIbu", "IBU"],
  ["revealOg", "OG"],
  ["revealFg", "FG"],
  ["revealSrm", "SRM"],
  ["revealDescription", "Description"],
  ["revealRecipe", "Recipe"],
  ["revealSensory", "Sensory profile"],
  ["revealHistory", "Fill history"],
] as const;

/** The Assignment heading links to the Filled Keg on the Tap. */
function assignmentActions(assignment: { readonly fillId: string } | null | undefined) {
  return assignment
    ? [{ label: "Open Filled Keg", href: `/admin/keg-room/fills/${assignment.fillId}` }]
    : [];
}

function tapPageHeader(tap: AdminTapView): PageHeader {
  return {
    title: `Tap ${tap.tapNumber} — ${tap.name || "(unnamed)"}`,
    badge: tap.isRetired
      ? { label: "Retired" }
      : tap.enabled
        ? { label: "Enabled", tone: "active" }
        : { label: "Disabled" },
  };
}

/** Public card: the preview, the metric switches and Mystery Tap. */
function cardTab(dependencies: RenderTapDetailDependencies, tap: AdminTapView, report: Report) {
  const assignment = tap.activeAssignment ?? null;
  const publicCard = safeDashboardTap(dependencies.dashboardService, tap.id, dependencies.logger);
  let mystery: ReturnType<TapService["getAssignmentMystery"]> | null = null;
  let mysteryLookupFailed = false;
  try {
    if (assignment !== null) mystery = dependencies.tapService.getAssignmentMystery(tap.id);
  } catch (error) {
    report("admin.tap.mystery", error);
    mystery = null;
    mysteryLookupFailed = assignment !== null;
  }
  // One switch per public-card metric: its effective state, and whether this Tap overrides
  // the Display default (then a reset button clears the override).
  let cardMetrics: readonly {
    readonly field: string;
    readonly label: string;
    readonly shown: boolean;
    readonly overridden: boolean;
    /** What Display shows by default, so a reset can redraw the switch without a reload. */
    readonly displayDefault: boolean;
  }[] = [];
  try {
    const effective = dependencies.displayService.getEffectiveTapCardSettings(tap.id);
    const defaults = dependencies.displayService.getTapCardSettings();
    cardMetrics = TAP_CARD_DISPLAY_FIELDS.map(([field, label]) => ({
      field,
      label,
      shown: effective.settings[field],
      overridden: typeof effective.override?.[field] === "boolean",
      displayDefault: defaults[field],
    }));
  } catch (error) {
    report("admin.tap.tap_card", error);
  }
  let displayDefaults: Record<string, unknown> = { unitSystem: "us", remainingMode: "percent" };
  try {
    displayDefaults = dependencies.dashboardService.getDisplayDefaults() as unknown as Record<
      string,
      unknown
    >;
  } catch (error) {
    report("admin.tap.display_defaults", error);
    // Keep the deterministic preview fallback for small service doubles.
  }
  return {
    assignment: {
      active: assignment,
      mystery,
      actions: assignmentActions(assignment),
      revealSwitches: MYSTERY_REVEALS.map(([name, label]) => ({
        name,
        label,
        checked: mystery?.[name] === true,
      })),
    },
    cardMetrics,
    publicPreview: mysteryLookupFailed
      ? null
      : safeMysteryPreview(publicCard, mystery?.enabled === true),
    displayDefaults,
  };
}

/** Identity: details, the Filled Keg on tap, retiring and deleting. */
function identityTab(dependencies: RenderTapDetailDependencies, tap: AdminTapView, report: Report) {
  const { timeZone } = dependencies.displayService.getSettings();
  const assignment = tap.activeAssignment ?? null;
  let assignableFills: readonly Record<string, unknown>[] = [];
  try {
    const fillsById = new Map<
      string,
      ReturnType<typeof dependencies.fillService.listFills>[number]
    >();
    for (const fill of [
      ...dependencies.fillService.listFills({ state: "available" }),
      ...dependencies.fillService.listFills({ state: "on_deck" }),
    ]) {
      if (!fillsById.has(fill.id)) fillsById.set(fill.id, fill);
    }
    assignableFills = [...fillsById.values()]
      .sort((left, right) => {
        const stateOrder = (state: string): number => (state === "available" ? 0 : 1);
        const stateDifference = stateOrder(left.state) - stateOrder(right.state);
        if (stateDifference !== 0) return stateDifference;
        const leftQueueOrder = left.onDeckOrder ?? Number.MAX_SAFE_INTEGER;
        const rightQueueOrder = right.onDeckOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftQueueOrder !== rightQueueOrder) return leftQueueOrder - rightQueueOrder;
        const dateDifference = left.fillDate.localeCompare(right.fillDate);
        return dateDifference !== 0 ? dateDifference : left.id.localeCompare(right.id);
      })
      .slice(0, 200)
      .map((fill) => ({
        id: fill.id,
        beverageName: fill.beverageName,
        kegNumber: fill.kegNumber,
        kegLabel: fill.kegLabel,
        label: `${fill.beverageName} — Keg ${fill.kegNumber}${fill.kegLabel ? ` — ${fill.kegLabel}` : ""}`,
      }));
  } catch (error) {
    report("admin.tap.assignable_fills", error);
    assignableFills = [];
  }
  const moveTargets = dependencies.tapService
    .listTaps()
    .filter((candidate) => candidate.id !== tap.id && !candidate.isRetired)
    .slice(0, 200)
    .map((candidate) => ({
      id: candidate.id,
      tapNumber: candidate.tapNumber,
      name: candidate.name,
    }));
  const tapLabel = `Tap ${tap.tapNumber}`;
  let deletionImpact: ReturnType<TapService["getTapDeletionImpact"]> | null = null;
  try {
    deletionImpact = dependencies.tapService.getTapDeletionImpact(tap.id);
  } catch (error) {
    report("admin.tap.deletion_impact", error);
    deletionImpact = null;
  }
  return {
    configuration: {
      gasType: tap.gasType,
      servingPressureKpa: tap.servingPressureKpa,
      lineLengthMm: tap.lineLengthMm,
      lineDiameterMm: tap.lineDiameterMm,
      notes: tap.notes,
    },
    assignment: {
      active:
        assignment === null
          ? null
          : { ...assignment, assignedAtLabel: timestampLabel(assignment.assignedAt, timeZone) },
      actions: assignmentActions(assignment),
    },
    assignableFills,
    moveTargets,
    deletionImpact,
    blockers: {
      retire: tapRetireBlockers(tapLabel, assignment !== null, "#assignment"),
      delete:
        deletionImpact === null
          ? []
          : tapDeletionBlockers(tapLabel, deletionImpact, {
              assignment: "#assignment",
              lifecycle: "#lifecycle",
              history: tapPagePath(tap.id, "history"),
            }),
    },
  };
}

/** Sensors: telemetry authority, then the pour detector and health rules. */
function sensorsTab(dependencies: RenderTapDetailDependencies, tap: AdminTapView, report: Report) {
  const id = tap.id;
  const allTelemetrySources = dependencies.telemetryService.listSources();
  // A disabled source cannot be assigned, so only enabled ones are offered; every name stays
  // available for the summary of what is assigned.
  const telemetrySources = allTelemetrySources
    .filter((source) => source.disabledAt === null)
    .slice(0, 200)
    .map((source) => ({ id: source.id, name: source.name }));
  const sourceNames = new Map(allTelemetrySources.map((source) => [source.id, source.name]));

  let levelSourceId = "";
  let conditionSourceId = "";
  let flowSourceId = "";
  let authoritySummary = "No sources assigned";
  try {
    const authority = dependencies.telemetryService.getTapAuthority(id);
    levelSourceId = authority.level?.sourceId ?? "";
    conditionSourceId = authority.condition?.sourceId ?? "";
    flowSourceId = authority.flow?.sourceId ?? "";
    const name = (sourceId: string) =>
      sourceId === "" ? "none" : (sourceNames.get(sourceId) ?? "configured source");
    // Roles that share a source read as one entry, e.g. "Level and condition: Scale · Flow: none".
    const roles: Map<string, string[]> = new Map();
    for (const [role, sourceId] of [
      ["level", levelSourceId],
      ["condition", conditionSourceId],
      ["flow", flowSourceId],
    ] as const) {
      roles.set(sourceId, [...(roles.get(sourceId) ?? []), role]);
    }
    if (levelSourceId !== "" || conditionSourceId !== "" || flowSourceId !== "") {
      authoritySummary = [...roles]
        .map(([sourceId, names]) => {
          const label =
            names.length === 1
              ? names[0]!
              : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
          return `${label[0]!.toUpperCase()}${label.slice(1)}: ${name(sourceId)}`;
        })
        .join(" · ");
    }
  } catch (error) {
    report("admin.tap.authority", error);
    authoritySummary = "Unavailable";
  }

  let pressureLabel = "No reading";
  let metric = false;
  let timeZone = "UTC";
  try {
    const display = dependencies.displayService.getSettings();
    metric = display.unitSystem === "metric";
    timeZone = display.timeZone;
  } catch (error) {
    // The reading is still worth showing; US units and UTC are the defaults.
    report("admin.tap.unit_system", error);
  }
  try {
    const pressure = dependencies.telemetryService.getCurrentTapReading(id, "pressure");
    if (pressure !== null) {
      // Readings are stored in kPa; US units show psi, like the gauges.
      const value = metric
        ? `${pressure.value.toFixed(1)} kPa`
        : `${(pressure.value / KPA_PER_PSI).toFixed(1)} psi`;
      pressureLabel = `${value}, measured ${timestampLabel(
        new Date(pressure.measuredAtMs).toISOString(),
        timeZone,
      )}`;
    }
  } catch (error) {
    report("admin.tap.pressure", error);
    pressureLabel = "Unavailable";
  }

  let detectorFields: readonly Record<string, unknown>[] = [];
  try {
    const detectorGlobal = dependencies.detectorService.getGlobalConfig();
    const detectorOverride = dependencies.detectorService.getTapOverride(id)?.override ?? {};
    const detectorEffective = mergeDetectorConfig(detectorGlobal.config, detectorOverride);
    detectorFields = DETECTOR_CONFIG_FIELDS.map((field) => ({
      name: field,
      ...DETECTOR_FIELD_PRESENTATION[field],
      effective: detectorEffective[field],
      override: detectorOverride[field] ?? null,
      effectiveLabel: formatAdminConfigValue(
        detectorEffective[field],
        DETECTOR_FIELD_PRESENTATION[field].unit,
      ),
    }));
  } catch (error) {
    report("admin.tap.detector_config", error);
    detectorFields = [];
  }

  let healthConfig: {
    readonly effective: Record<string, unknown>;
    readonly override: Record<string, unknown> | null;
  } | null = null;
  try {
    const value = dependencies.healthService.getEffectiveConfig(id) as unknown as {
      readonly effective: Record<string, unknown>;
      readonly override?: Record<string, unknown> | null;
    };
    healthConfig = { effective: value.effective, override: value.override ?? null };
  } catch (error) {
    report("admin.tap.health_config", error);
    healthConfig = null;
  }
  const healthOverview = safeHealthOverview(dependencies.healthService, id, dependencies.logger);
  const healthSections =
    healthConfig === null
      ? []
      : HEALTH_CHECK_IDS.map((checkId) => {
          const presentation = HEALTH_SECTION_PRESENTATION[checkId];
          const effective = healthConfig?.effective[checkId];
          const effectiveFields =
            effective !== null && typeof effective === "object"
              ? Object.entries(effective as Record<string, unknown>)
              : [];
          const rawOverride = healthConfig?.override?.[checkId];
          const overrideFields =
            rawOverride !== null && typeof rawOverride === "object"
              ? new Map(Object.entries(rawOverride as Record<string, unknown>))
              : new Map<string, unknown>();
          return {
            id: checkId,
            title: presentation.title,
            description: presentation.description,
            fields: effectiveFields.map(([field, value]) => ({
              name: field,
              ...(presentation.fields[field] ?? {
                label: "Setting",
                help: "Tap-specific health setting.",
              }),
              effective: value,
              override: overrideFields.get(field) ?? null,
              effectiveLabel: formatAdminConfigValue(value, presentation.fields[field]?.unit),
            })),
          };
        });

  const detectorGroups = DETECTOR_GROUPS.map((group) => ({
    ...group,
    fields: detectorFields.filter((field) => field.group === group.id),
  })).filter((group) => group.fields.length > 0);

  return {
    telemetry: {
      authoritySummary,
      levelSourceId,
      conditionSourceId,
      flowSourceId,
      pressureLabel,
      sources: telemetrySources,
    },
    detector: {
      fields: detectorFields,
      groups: detectorGroups,
      autosaveFields: detectorFields.map((field) => `detector.${String(field.name)}`).join(","),
    },
    health: {
      overview: healthOverview,
      sections: healthSections,
      autosaveFields: healthSections
        .flatMap((section) => section.fields.map((field) => `health.${section.id}.${field.name}`))
        .join(","),
    },
  };
}

/** Maintenance: the line records and the form to add one. */
function maintenanceTab(
  dependencies: RenderTapDetailDependencies,
  tap: AdminTapView,
  report: Report,
) {
  const { timeZone } = dependencies.displayService.getSettings();
  let records: readonly Record<string, unknown>[] = [];
  try {
    records = dependencies.healthService
      .getAdminMaintenancePage(tap.id, { limit: 25 })
      .records.map((record) => {
        const performedAt = new Date(record.performedAtMs).toISOString();
        return {
          typeLabel: humanizeAdminIdentifier(record.maintenanceType),
          performedAt,
          performedAtLabel: timestampLabel(performedAt, timeZone),
        };
      });
  } catch (error) {
    report("admin.tap.maintenance", error);
    records = [];
  }
  return { maintenance: { records } };
}

/** History: the Fills this Tap served, then its Activity log entries. */
function historyTab(
  dependencies: RenderTapDetailDependencies,
  tap: AdminTapView,
  request: IncomingMessage,
  report: Report,
) {
  const { timeZone } = dependencies.displayService.getSettings();
  let fills: readonly Record<string, unknown>[] = [];
  try {
    fills = dependencies.tapService.listFillHistory(tap.id).map((entry) => ({
      ...entry,
      assignedAtLabel: timestampLabel(entry.assignedAt, timeZone),
      endedAtLabel: entry.endedAt === null ? null : timestampLabel(entry.endedAt, timeZone),
      endLabel:
        entry.endedAt === null
          ? "On tap now"
          : (END_REASON_LABELS[entry.endReason ?? ""] ?? "Ended"),
    }));
  } catch (error) {
    report("admin.tap.fill_history", error);
  }
  let activity: Record<string, unknown> | null = null;
  const cursor = requestUrl(request).searchParams.get("cursor");
  try {
    if (dependencies.systemService !== undefined) {
      const page = dependencies.systemService.getActivityPage({
        tapId: tap.id,
        ...(cursor === null ? {} : { cursor }),
      });
      activity = {
        items: presentActivityItems(page.items, timeZone),
        hasCursor: cursor !== null,
        nextHref:
          page.nextCursor === null
            ? null
            : `${tapPagePath(tap.id, "history")}?${new URLSearchParams({ cursor: page.nextCursor })}`,
      };
    }
  } catch (error) {
    report("admin.tap.activity", error);
  }
  return { history: { fills, activity } };
}
