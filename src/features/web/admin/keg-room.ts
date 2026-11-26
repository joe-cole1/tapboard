import { redirect } from "../../../infrastructure/http/html.ts";
import type { DashboardService } from "../../dashboard/service.ts";
import type { PublicTapCardView } from "../../dashboard/types.ts";
import { fillDeletionConfirmationLabel, type FillService } from "../../fills/service.ts";
import type { AdminFillPage, AdminFillView } from "../../fills/types.ts";
import { kegDeletionConfirmationLabel, type KegService } from "../../kegs/service.ts";
import type { AdminKegPage } from "../../kegs/types.ts";
import { beverageDisplayColor, getVesselDescriptor } from "../../story/vessels.ts";
import {
  adminFillPageQueryFromRequest,
  adminKegPageQueryFromRequest,
  adminFillPageHref,
  adminKegPageHref,
} from "./list-query.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
} from "./http.ts";
import { safePublicTapCards } from "./tap-presentation.ts";
import { adminTabs, renderAdmin } from "./layout.ts";
import {
  adminTimestampLabel,
  capacityLabel,
  pourHistoryEntry,
  numberedPageNavigation,
  tareLabel,
  type AutosaveForm,
  type PageHeader,
  type PageNavigation,
} from "./presentation.ts";
import { reportFailure } from "../../../shared/diagnostics.ts";
import {
  decodeForecastHistoryCursor,
  type ForecastHistoryCursor,
} from "../../forecasting/forecast-validation.ts";
import { deletionImpactSentence, fillDeletionBlockers } from "./blockers.ts";
import { nullable, optionalNumber, invalidForm } from "./forms.ts";
import { actor, type AdminContext } from "./context.ts";
import { safeVesselForDisplay, boundedAdminString } from "./beverage-presentation.ts";
import type {
  RegisterKegRoomPagesDependencies,
  RegisterKegRoomMutationsDependencies,
} from "../contracts.ts";

const POUR_HISTORY_PAGE_SIZE = 25;
const PHYSICAL_KEGS_CRUMB = { label: "Physical Kegs", href: "/admin/keg-room/kegs" } as const;
const FILL_STATE_LABELS: Readonly<Record<string, string>> = {
  available: "Available",
  on_deck: "On Deck",
  on_tap: "On Tap",
  ended: "Ended",
};
/** The Keg settings saved by `updateKeg`; the label saves on its own. */
const KEG_SETTINGS_FIELDS = ["kegNumber", "capacityMl", "isActive", "currentTareG", "reason"];

/** A Physical Keg's page, where each of its forms returns. */
function kegPagePath(params: Readonly<Record<string, string>>): string {
  return `${PHYSICAL_KEGS_CRUMB.href}/${encodeURIComponent(params.id ?? "")}`;
}

/** One page of a Fill's pours, newest first, paged by the forecast history cursor. */
function fillPourHistory(
  dependencies: RegisterKegRoomPagesDependencies,
  fillId: string,
  requestUrl: string | undefined,
) {
  const path = `/admin/keg-room/fills/${encodeURIComponent(fillId)}`;
  let cursor: ForecastHistoryCursor | undefined;
  let cursorRejected = false;
  try {
    const requested = new URL(requestUrl ?? "/", "http://tapboard.local").searchParams.get("pours");
    cursor = requested === null ? undefined : decodeForecastHistoryCursor(requested);
  } catch {
    // A stale or edited link falls back to the newest pours instead of failing the page.
    cursorRejected = true;
  }
  try {
    const unitSystem =
      dependencies.displayService.getSettings().unitSystem === "metric" ? "metric" : "us";
    const page = dependencies.forecastService.getPourHistory(fillId, {
      limit: POUR_HISTORY_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const now = new Date().toISOString();
    return {
      available: true,
      cursorRejected,
      entries: page.pours.map((pour) => {
        const entry = pourHistoryEntry(
          { volumeMl: pour.canonicalVolumeMl, completedAt: pour.completedAt },
          now,
        );
        return { ...entry, volumeLabel: entry.volumeLabels[unitSystem] };
      }),
      navigation:
        cursor === undefined && page.nextCursor === null
          ? null
          : ({
              label: "Pour history pages",
              previous:
                cursor === undefined
                  ? null
                  : { label: "Newest pours", href: `${path}#pour-history` },
              status: null,
              next:
                page.nextCursor === null
                  ? null
                  : {
                      label: "Older pours",
                      href: `${path}?pours=${encodeURIComponent(page.nextCursor)}#pour-history`,
                    },
            } satisfies PageNavigation),
      isFirstPage: cursor === undefined,
    };
  } catch (error) {
    reportFailure(error, {
      operation: "admin.fill.pour_history",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    // One message only: with no history to show, whether the link was valid does not matter.
    return {
      available: false,
      cursorRejected: false,
      entries: [],
      navigation: null,
      isFirstPage: true,
    };
  }
}

/** A live-saving part of a Physical Keg's page. */
function kegForm(id: string, fields: string): AutosaveForm {
  return { action: `/admin/kegs/${id}/update`, mode: "blur", resource: `keg:${id}`, fields };
}

export function registerKegRoomPages(dependencies: RegisterKegRoomPagesDependencies): void {
  // Canonical Keg Room index. Ended fills are deliberately omitted unless the
  // operator asks for history through the validated state filter.
  registerAdminGet(dependencies, "/admin/keg-room", (request, response, context) => {
    const requested = adminFillPageQueryFromRequest(request);
    const page = fallbackAdminFillPage(dependencies.fillService, requested);
    const publicCards = safePublicTapCards(dependencies.dashboardService, dependencies.logger);
    const fills = page.items.map((fill) =>
      safeFillCard(fill, dependencies.dashboardService, publicCards),
    );
    const section = (state: "available" | "on_deck" | "on_tap" | "ended") =>
      fills.filter((fill) => fill.state === state);
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room",
      "Keg Room",
      "/admin/keg-room",
      {
        fills,
        sections: [
          {
            id: "available",
            title: "Available",
            eyebrow: "Ready to serve",
            items: section("available"),
          },
          { id: "on-deck", title: "On Deck", eyebrow: "Queued next", items: section("on_deck") },
          { id: "on-tap", title: "On Tap", eyebrow: "Serving now", items: section("on_tap") },
          ...(page.state === "ended" || page.state === "all"
            ? [
                {
                  id: "history",
                  title: "History",
                  eyebrow: "Audit trail",
                  items: section("ended"),
                },
              ]
            : []),
        ].map((item) => ({
          ...item,
          itemIds: item.items.map((fill) => String(fill.id)).join(","),
        })),
        query: requested,
        pagination: { total: page.total },
        pageNavigation: numberedPageNavigation(
          "Keg Room pages",
          page.page,
          page.pageCount,
          page.page > 1 ? adminFillPageHref(requested, page.page - 1) : null,
          page.page < page.pageCount ? adminFillPageHref(requested, page.page + 1) : null,
        ),
        newFillHref: "/admin/keg-room/fills/new",
        tabs: adminTabs(
          "keg-room",
          requested.state === "ended" ? "/admin/keg-room?state=ended" : "/admin/keg-room",
        ),
      },
    );
  });

  // Secondary physical inventory tab. The repository owns search/filter/page
  // SQL; the bounded per-keg history is an explicitly requested detail rail.
  registerAdminGet(dependencies, "/admin/keg-room/kegs", (request, response, context) => {
    const requested = adminKegPageQueryFromRequest(request);
    const page = fallbackAdminKegPage(dependencies.kegService, requested);
    const displaySettings = dependencies.displayService.getSettings();
    const unitSystem = displaySettings.unitSystem === "metric" ? "metric" : "us";
    const fillsFor = (kegId: string) => dependencies.fillService.listFills({ kegId });
    const publicCards = safePublicTapCards(dependencies.dashboardService, dependencies.logger);
    const cornyKeg = getVesselDescriptor("corny_keg");
    const kegs = page.items.map((keg) => {
      const detail = dependencies.kegService.getKeg(keg.id);
      const detailRecord = detail as unknown as {
        readonly keg?: typeof keg;
        readonly tareHistory?: readonly {
          readonly previousTareG: number | null;
          readonly newTareG: number;
          readonly recordedAt: string;
          readonly reason: string | null;
        }[];
        readonly maintenanceHistory?: readonly {
          readonly maintenanceType: string;
          readonly recordedAt: string;
        }[];
      };
      const fills = fillsFor(keg.id);
      const currentFillView = fills.find((fill) => fill.state !== "ended");
      // The row icon: the keg filled to its current Fill, or empty.
      const currentCard =
        currentFillView === undefined
          ? null
          : safeFillCard(currentFillView, dependencies.dashboardService, publicCards);
      const fillHistory = fills.map((fill) => ({
        id: fill.id,
        beverageName: fill.beverageName,
        fillDate: fill.fillDate,
        state: fill.state,
        endedAt: fill.endedAt,
      }));
      const currentFill = fillHistory.find((fill) => fill.state !== "ended") ?? null;
      const recentFill = fillHistory[0] ?? null;
      return {
        id: keg.id,
        kegNumber: keg.kegNumber,
        label: keg.label,
        capacityMl: keg.capacityMl,
        currentTareG: keg.currentTareG,
        capacityLabel: capacityLabel(keg.capacityMl, unitSystem),
        tareLabel: tareLabel(keg.currentTareG, unitSystem),
        isActive: keg.isActive,
        badge: keg.isActive
          ? { label: "Ready", tone: "healthy" }
          : { label: "Inactive", tone: "muted" },
        updatedAt: keg.updatedAt,
        currentFill: currentFill?.beverageName ?? null,
        currentFillId: currentFill?.id ?? null,
        currentFillRecord: currentFill,
        recentFillRecord: recentFill,
        vessel: {
          id: `keg-${keg.id}`,
          title: `Keg ${keg.kegNumber}`,
          graphic: cornyKeg,
          fillPercent: currentCard?.fillPercent ?? 0,
          displayColor: currentCard?.displayColor ?? null,
          tapNumber: 0,
        },
        fillCountLabel: `${fillHistory.length} fill record${fillHistory.length === 1 ? "" : "s"}`,
        fillHistorySummary:
          fillHistory.length === 0
            ? "No fills recorded"
            : `${fillHistory.length} fill record${fillHistory.length === 1 ? "" : "s"} · ${recentFill?.beverageName ?? "History available"}`,
        fillHistory,
        tareHistory: (detailRecord.tareHistory ?? []).map((item) => ({
          previousTareG: item.previousTareG,
          newTareG: item.newTareG,
          recordedAt: item.recordedAt,
          reason: item.reason,
        })),
        maintenanceHistory: (detailRecord.maintenanceHistory ?? []).map((item) => ({
          maintenanceType: item.maintenanceType,
          recordedAt: item.recordedAt,
        })),
      };
    });
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-kegs",
      "Physical Kegs",
      "/admin/keg-room/kegs",
      {
        kegs,
        query: requested,
        pagination: { total: page.total },
        pageNavigation: numberedPageNavigation(
          "Physical Keg pages",
          page.page,
          page.pageCount,
          page.page > 1 ? adminKegPageHref(requested, page.page - 1) : null,
          page.page < page.pageCount ? adminKegPageHref(requested, page.page + 1) : null,
        ),
        newKegHref: "/admin/keg-room/kegs/new",
        tabs: adminTabs("keg-room", "/admin/keg-room/kegs"),
      },
    );
  });

  // Static create path must be registered before /:id for the small path router.
  registerAdminGet(dependencies, "/admin/keg-room/kegs/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-keg-new",
      "New Keg",
      "/admin/keg-room/kegs/new",
      { breadcrumbParents: [PHYSICAL_KEGS_CRUMB] },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/keg-room/kegs/:id",
    (request, response, context, params) => {
      const detail = dependencies.kegService.getKeg(params.id ?? "");
      const detailRecord = detail as unknown as {
        readonly keg?: typeof detail.keg;
        readonly tareHistory?: typeof detail.tareHistory;
        readonly maintenanceHistory?: typeof detail.maintenanceHistory;
      };
      const physical = detailRecord.keg ?? (detail as unknown as typeof detail.keg);
      const tareHistory = detailRecord.tareHistory ?? [];
      const maintenanceHistory = detailRecord.maintenanceHistory ?? [];
      const impact = dependencies.kegService.getDeletionImpact(params.id ?? "");
      const fillHistory = dependencies.fillService
        .listFills({ kegId: physical.id })
        .map((fill) => ({
          id: fill.id,
          beverageName: fill.beverageName,
          fillDate: fill.fillDate,
          state: fill.state,
          stateLabel: FILL_STATE_LABELS[fill.state] ?? fill.state,
          endedAt: fill.endedAt,
          endedAtLabel: fill.endedAt === null ? null : adminTimestampLabel(fill.endedAt),
        }));
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/keg-room-keg-detail",
        `Keg ${physical.kegNumber}`,
        "/admin/keg-room/kegs",
        {
          header: {
            title: `Keg ${physical.kegNumber}${physical.label ? ` — ${physical.label}` : ""}`,
            badge: physical.isActive ? { label: "Active", tone: "active" } : { label: "Inactive" },
          } satisfies PageHeader,
          keg: {
            ...physical,
            updatedAtLabel: adminTimestampLabel(physical.updatedAt),
            confirmationLabel: kegDeletionConfirmationLabel(physical),
            tareHistory: tareHistory.map((item) => ({
              ...item,
              changeLabel: `${item.previousTareG === null ? "Initial" : `${item.previousTareG} g`} → ${item.newTareG} g`,
              recordedAtLabel: adminTimestampLabel(item.recordedAt),
            })),
            maintenanceHistory: maintenanceHistory.map((item) => ({
              ...item,
              recordedAtLabel: adminTimestampLabel(item.recordedAt),
            })),
            deletionImpact: deletionImpactSentence(impact.impacts, "kegs"),
            fillHistory,
            currentFill: fillHistory.find((fill) => fill.state !== "ended") ?? null,
          },
          breadcrumbParents: [PHYSICAL_KEGS_CRUMB],
          forms: {
            label: kegForm(physical.id, "label"),
            details: kegForm(physical.id, "kegNumber,capacityMl,isActive"),
            tare: kegForm(physical.id, "currentTareG,reason"),
          },
        },
      );
    },
  );

  registerAdminGet(dependencies, "/admin/keg-room/fills/new", (request, response, context) => {
    const activeKegs = dependencies.kegService.listKegs({ isActive: true });
    const occupiedKegIds = new Set(
      dependencies.fillService
        .listFills()
        .filter((fill) => fill.state !== "ended")
        .map((fill) => fill.kegId),
    );
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-fill",
      "Fill a Keg",
      "/admin/keg-room/fills/new",
      {
        beverages: dependencies.beverageService
          .listBeverages()
          .map((item) => ({ id: item.beverage.id, name: item.effectivePresentation.name })),
        kegs: activeKegs
          .filter((keg) => !occupiedKegIds.has(keg.id))
          .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label })),
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/keg-room/fills/:id",
    (request, response, context, params) => {
      const fill = dependencies.fillService.getFill(params.id ?? "");
      const taps = dependencies.tapService.listTaps();
      const activeTap = taps.find((tap) => tap.activeAssignment?.fillId === fill.id) ?? null;
      const availableTaps = taps
        .filter((tap) => !tap.isRetired && !tap.isOccupied)
        .map((tap) => ({ id: tap.id, tapNumber: tap.tapNumber, name: tap.name }));
      const publicCards = safePublicTapCards(dependencies.dashboardService, dependencies.logger);
      const card = safeFillCard(fill, dependencies.dashboardService, publicCards);
      const pourHistory = fillPourHistory(dependencies, fill.id, request.url);
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/keg-room-fill",
        "Filled Keg",
        "/admin/keg-room",
        {
          header: {
            title: "Filled Keg",
            intro: `${String(card.beverageName)} · Keg ${String(card.kegNumber)}${typeof card.kegLabel === "string" && card.kegLabel ? ` — ${card.kegLabel}` : ""}`,
          } satisfies PageHeader,
          fill: card,
          fillRecord: fill,
          deletion: {
            blockers: fillDeletionBlockers(fill.state === "ended", "#filled-keg-lifecycle"),
            impact: fill.state === "ended" ? fillDeletionImpact(dependencies, fill.id) : null,
          },
          activeTap,
          availableTaps,
          pourHistory,
        },
      );
    },
  );
  registerAdminGet(dependencies, "/admin/keg-room/fill", (_request, response) => {
    redirect(response, "/admin/keg-room/fills/new");
  });
  registerAdminGet(
    dependencies,
    "/admin/keg-room/fill/:id",
    (_request, response, _context, params) => {
      redirect(response, `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`);
    },
  );

  // Legacy authenticated GET entry points remain redirects only.
  registerAdminGet(dependencies, "/admin/fills", (_request, response) => {
    redirect(response, "/admin/keg-room");
  });
  registerAdminGet(dependencies, "/admin/kegs", (_request, response) => {
    redirect(response, "/admin/keg-room/kegs");
  });
  registerAdminGet(dependencies, "/admin/kegs/:id", (_request, response, _context, params) => {
    redirect(response, `/admin/keg-room/kegs/${encodeURIComponent(params.id ?? "")}`);
  });
  registerAdminGet(dependencies, "/admin/fills/:id", (_request, response, _context, params) => {
    redirect(response, `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`);
  });
}

export function registerKegRoomMutations(dependencies: RegisterKegRoomMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/kegs/create",
    "/admin/keg-room/kegs",
    (form, context) => {
      dependencies.kegService.createKeg(
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: optionalNumber(form.currentTareG),
          isActive: form.isActive !== "false",
        },
        actor(context),
      );
    },
    "Keg created.",
  );
  /**
   * Saves one Keg form: each posts only its own fields, and the rest of the Keg stays as it is.
   * A correction reason is recorded with a tare change, so a reason alone changes nothing.
   * Returns whether the tare changed.
   */
  const saveKeg = (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ): boolean => {
    const input = {
      ...(form.kegNumber === undefined ? {} : { kegNumber: Number(form.kegNumber) }),
      ...(form.label === undefined ? {} : { label: nullable(form.label) ?? null }),
      ...(form.capacityMl === undefined ? {} : { capacityMl: Number(form.capacityMl) }),
      ...(form.currentTareG === undefined ? {} : { currentTareG: Number(form.currentTareG) }),
      ...(form.isActive === undefined ? {} : { isActive: form.isActive === "true" }),
    };
    const existing = dependencies.kegService.getKeg(params.id!).keg;
    if (
      Object.entries(input).every(
        ([field, value]) => existing[field as keyof typeof existing] === value,
      )
    )
      return false;
    dependencies.kegService.updateKeg(
      params.id!,
      { ...input, reason: nullable(form.reason) },
      actor(context),
    );
    return input.currentTareG !== undefined && input.currentTareG !== existing.currentTareG;
  };
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/update",
    kegPagePath,
    (form, context, params) => {
      saveKeg(form, context, params);
    },
    "Keg updated.",
    {},
    {
      handle: (body, context, params) => {
        if (KEG_SETTINGS_FIELDS.some((field) => Object.hasOwn(body, field))) {
          // Number, capacity, status and tare save their whole form. The reason clears once
          // it is recorded with a tare change, so the next correction needs its own.
          const tareChanged = saveKeg(
            autosaveFieldStrings(body, KEG_SETTINGS_FIELDS),
            context,
            params,
          );
          return {
            resource: tareChanged ? { reason: "" } : {},
            revision: dependencies.kegService.getKeg(params.id!).keg.updatedAt,
          };
        }
        // The label saves on its own, with its revision check.
        const fields = autosaveFieldStrings(body, ["updatedAt", "label"]);
        const updated = dependencies.kegService.autosaveLabel(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          { label: nullable(fields.label) },
          actor(context),
        );
        return {
          resource: { label: updated.label },
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.kegService.getKeg(params.id!).keg;
        return {
          current: { label: current.label, updatedAt: current.updatedAt },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor(["updatedAt", "label", ...KEG_SETTINGS_FIELDS]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/maintenance",
    kegPagePath,
    (form, context, params) => {
      dependencies.kegService.recordMaintenance(
        params.id!,
        { maintenanceType: form.maintenanceType, notes: nullable(form.notes) },
        actor(context),
      );
    },
    "Maintenance recorded.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/delete",
    // A refused deletion stays on the Keg's page; a deleted Keg returns to the list.
    kegPagePath,
    (form, context, params) => {
      if (form.confirmation === undefined || form.confirmation.trim() === "") {
        invalidForm("Type the exact visible Keg number and label to confirm permanent deletion.");
      }
      dependencies.kegService.deleteKeg(
        params.id!,
        { reason: nullable(form.reason), confirmation: form.confirmation },
        actor(context),
      );
      return PHYSICAL_KEGS_CRUMB.href;
    },
    "Keg deleted.",
  );

  registerAdminAction(
    dependencies,
    "/admin/fills/create",
    "/admin/keg-room",
    (form, context) => {
      dependencies.fillService.createFill(
        {
          beverageId: form.beverageId,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  // Static queue reorder path is registered before /:id action paths. The
  // browser enhancement submits the complete ordered list; the service
  // validates membership and remains the sole owner of queue state.
  registerAdminAction(
    dependencies,
    "/admin/fills/reorder-on-deck",
    "/admin/keg-room",
    (form, context) => {
      const fillIds = (form.fillIds ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (
        fillIds.length === 0 ||
        fillIds.length > 200 ||
        new Set(fillIds).size !== fillIds.length
      ) {
        invalidForm("On Deck order must contain each Filled Keg exactly once.");
      }
      dependencies.fillService.reorderOnDeck({ fillIds }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/on-deck",
    "/admin/keg-room",
    (_form, context, params) => {
      dependencies.fillService.markOnDeck(params.id!, actor(context));
    },
    "Fill placed On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/remove-on-deck",
    "/admin/keg-room",
    (_form, context, params) => {
      dependencies.fillService.removeFromOnDeck(params.id!, actor(context));
    },
    "Fill removed from On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/move",
    "/admin/keg-room",
    (form, context, params) => {
      const ids = dependencies.fillService.getPublicOnDeck().map((item) => item.fillId);
      const index = ids.indexOf(params.id!);
      const destination = form.direction === "up" ? index - 1 : index + 1;
      if (index < 0 || destination < 0 || destination >= ids.length) return;
      [ids[index], ids[destination]] = [ids[destination]!, ids[index]!];
      dependencies.fillService.reorderOnDeck({ fillIds: ids }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/kick",
    "/admin/keg-room",
    async (form, context, params) => {
      if (form.confirmKick !== "true") {
        invalidForm("Confirm ending this fill before kicking the keg.");
      }
      await dependencies.fillService.kickFill(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Fill ended.",
  );
  const saveFeatured = (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ): AdminFillView => {
    if (form.featured !== "true" && form.featured !== "false") {
      invalidForm("Choose On or Off for the Featured setting.");
    }
    return dependencies.fillService.setFeatured(
      params.id!,
      { featured: form.featured === "true" },
      actor(context),
    );
  };
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/featured",
    (params) => `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      saveFeatured(form, context, params);
    },
    "Featured setting updated.",
    {},
    {
      // The service checks no revision, so this answers with the Fill's current one.
      handle: (body, context, params) => {
        const fill = saveFeatured(autosaveFieldStrings(body, ["featured"]), context, params);
        return { resource: { featured: fill.featured === true }, revision: fill.updatedAt };
      },
      current: (params) => {
        const fill = dependencies.fillService.getFill(params.id!);
        return { current: { featured: fill.featured === true }, revision: fill.updatedAt };
      },
      validationFields: validationFieldsFor(["featured"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/delete",
    "/admin/keg-room",
    (form, context, params) => {
      if (form.confirmation === undefined || form.confirmation.trim() === "") {
        invalidForm("Type the exact visible Filled Keg label to confirm permanent deletion.");
      }
      dependencies.fillService.deleteFill(
        params.id!,
        { reason: nullable(form.reason), confirmation: form.confirmation },
        actor(context),
      );
    },
    "Fill deleted.",
  );
}

/** What else deleting an ended Fill removes; a failed lookup leaves the sentence out. */
function fillDeletionImpact(
  dependencies: RegisterKegRoomPagesDependencies,
  fillId: string,
): string | null {
  try {
    return deletionImpactSentence(
      dependencies.fillService.getDeletionImpact(fillId).impacts,
      "fills",
    );
  } catch (error) {
    reportFailure(error, {
      operation: "admin.fill.deletion_impact",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    return null;
  }
}

export function fallbackAdminFillPage(
  fillService: FillService,
  query: Readonly<Record<string, unknown>>,
): AdminFillPage {
  const candidate = fillService as FillService & {
    readonly listAdminPage?: (input?: unknown) => AdminFillPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);
  const requestedState = typeof query.state === "string" ? query.state : "active";
  const all = fillService.listFills();
  const filtered = all.filter((fill) => {
    if (requestedState === "active") return fill.state !== "ended";
    if (requestedState === "all") return true;
    return fill.state === requestedState;
  });
  const q = typeof query.q === "string" ? query.q.toLocaleLowerCase() : "";
  const searched =
    q.length === 0
      ? filtered
      : filtered.filter((fill) =>
          `${fill.beverageName} ${fill.kegNumber} ${fill.kegLabel ?? ""}`
            .toLocaleLowerCase()
            .includes(q),
        );
  const pageSize = 25;
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(typeof query.page === "number" ? query.page : 1, pageCount);
  return {
    items: searched.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    query: typeof query.q === "string" ? query.q : "",
    state: requestedState as AdminFillPage["state"],
    sort: (typeof query.sort === "string" ? query.sort : "state") as AdminFillPage["sort"],
  };
}

export function fallbackAdminKegPage(
  kegService: KegService,
  query: Readonly<Record<string, unknown>>,
): AdminKegPage {
  const candidate = kegService as KegService & {
    readonly listAdminPage?: (input?: unknown) => AdminKegPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);
  const requestedStatus = typeof query.status === "string" ? query.status : "active";
  const all = kegService.listKegs();
  const filtered = all.filter(
    (keg) =>
      requestedStatus === "all" || (requestedStatus === "active" ? keg.isActive : !keg.isActive),
  );
  const q = typeof query.q === "string" ? query.q.toLocaleLowerCase() : "";
  const searched =
    q.length === 0
      ? filtered
      : filtered.filter((keg) =>
          `keg ${keg.kegNumber} ${keg.label ?? ""}`.toLocaleLowerCase().includes(q),
        );
  const pageSize = 25;
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(typeof query.page === "number" ? query.page : 1, pageCount);
  return {
    items: searched.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    query: typeof query.q === "string" ? query.q : "",
    status: requestedStatus as AdminKegPage["status"],
    sort: (typeof query.sort === "string" ? query.sort : "number") as AdminKegPage["sort"],
  };
}

export function boundedFillPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

export function boundedRemainingMetric(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, 1_000_000);
}

export function safeRemainingEstimate(
  state: AdminFillView["state"],
  publicCard: PublicTapCardView | null,
  fillPercent: number,
  servingsRemaining: number | null,
  daysRemaining: number | null,
): string {
  if (publicCard?.waitingForMeasurement === true) return "Waiting for measurement";
  if (servingsRemaining !== null) return `${Math.floor(servingsRemaining)} servings estimated`;
  if (daysRemaining !== null) return `${Math.round(daysRemaining * 10) / 10} days estimated`;
  if (publicCard?.fillPercent !== null && publicCard?.fillPercent !== undefined) {
    return `${fillPercent}% remaining`;
  }
  if (state === "on_tap") return "Estimate unavailable";
  if (state === "ended") return "Ended";
  return "Not on tap";
}

export function safeFillCard(
  fill: AdminFillView,
  dashboardService: DashboardService,
  publicCards: readonly PublicTapCardView[] = safePublicTapCards(dashboardService),
): Record<string, unknown> {
  // Match only by the non-Mystery public fillId. Public projections may hide
  // identity for Mystery Taps; their runtime metrics must not cross that
  // visibility boundary into this privileged Admin card.
  const publicCard = publicCards.find((candidate) => candidate.fillId === fill.id) ?? null;
  const publicPercent = boundedFillPercent(publicCard?.fillPercent);
  const fallbackPercent =
    fill.state === "ended" ? 0 : fill.state === "available" || fill.state === "on_deck" ? 100 : 0;
  const fillPercent = publicPercent ?? fallbackPercent;
  const servingsRemaining = boundedRemainingMetric(publicCard?.servingsRemaining);
  const daysRemaining = boundedRemainingMetric(publicCard?.daysRemaining);
  const authoritativeTapId = fill.tapId ?? publicCard?.id ?? null;
  const authoritativeTapNumber = fill.tapNumber ?? publicCard?.tapNumber ?? null;
  const fillGlass = safeVesselForDisplay(fill.fillGlass);
  const graphicId = fillGlass ?? "pint_glass";
  const beverageName = boundedAdminString(fill.beverageName, 160) ?? "Unknown Beverage";
  const displayColor = beverageDisplayColor({
    displayColor: fill.displayColor,
    srm: fill.srm,
    beverageType: fill.beverageType,
  });
  return {
    id: fill.id,
    beverageName,
    beverageType: boundedAdminString(fill.beverageType, 32) ?? "other",
    beverageStyle: boundedAdminString(fill.beverageStyle, 120),
    beverageAbv: Number.isFinite(fill.beverageAbv) ? fill.beverageAbv : null,
    kegId: fill.kegId,
    kegNumber: fill.kegNumber,
    kegLabel: boundedAdminString(fill.kegLabel, 120),
    confirmationLabel: fillDeletionConfirmationLabel(fill),
    fillDate: fill.fillDate,
    state: fill.state,
    stateLabel: FILL_STATE_LABELS[fill.state] ?? "Available",
    onDeckOrder: fill.onDeckOrder,
    tapNumber: authoritativeTapNumber,
    tapId: authoritativeTapId,
    queuePosition: fill.onDeckOrder,
    fillPercent,
    servingsRemaining,
    daysRemaining,
    waitingForMeasurement: publicCard?.waitingForMeasurement ?? false,
    remainingEstimate: safeRemainingEstimate(
      fill.state,
      publicCard,
      fillPercent,
      servingsRemaining,
      daysRemaining,
    ),
    fillGlass: fillGlass ?? "pint_glass",
    displayColor,
    featured: fill.featured === true,
    graphic: getVesselDescriptor(graphicId),
    vessel: {
      id: fill.id,
      graphic: getVesselDescriptor(graphicId),
      title: beverageName,
      accessibleLabel: `${beverageName} Filled Keg`,
      fillPercent,
      displayColor,
      tapNumber: authoritativeTapNumber || 0,
    },
    updatedAt: fill.updatedAt,
  };
}
