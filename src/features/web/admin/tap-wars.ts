import { sendJson } from "../../../infrastructure/http/error-mapper.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import type { TapActorOptions } from "../../taps/types.ts";
import { tapWarPercentages } from "../../tap-wars/service.ts";
import type { EligibilityReason, TapWar } from "../../tap-wars/types.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  validationFieldsFor,
} from "./http.ts";
import { renderAdmin } from "./layout.ts";
import { invalidForm } from "./forms.ts";
import { adminContext, actor, requestUrl, type AdminContext } from "./context.ts";
import type {
  RegisterTapWarsPagesDependencies,
  RegisterAdminTapWarsApiDependencies,
  RegisterTapWarsMutationsDependencies,
  AdminTapWarsPageDataDependencies,
  TapWarMysteryDependencies,
} from "../contracts.ts";

export function registerTapWarsPages(dependencies: RegisterTapWarsPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/tap-wars", (request, response, context) => {
    const data = adminTapWarsPageData(dependencies);
    // Without JavaScript, the preview button reloads the page with the chosen pair (a GET form,
    // so the CSRF token never enters the URL). Only eligible assignments are kept.
    const query = requestUrl(request).searchParams;
    const eligibleIds = new Set(
      (data.eligible as readonly { readonly assignmentId: string }[]).map(
        (item) => item.assignmentId,
      ),
    );
    const chosen = (name: string) => {
      const value = query.get(name) ?? "";
      return eligibleIds.has(value) ? value : "";
    };
    const side1 = data.current === null ? chosen("side1") : "";
    const side2 = data.current === null ? chosen("side2") : "";
    const banner =
      side1 === "" || side2 === ""
        ? null
        : dependencies.publicTapWarsService.previewMatchup(side1, side2);
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-wars",
      "Tap Wars",
      "/admin/tap-wars",
      {
        tapWars: {
          ...data,
          matchup: { side1, side2, duplicate: side1 !== "" && side1 === side2, banner },
        },
        // The "What guests see" preview renders the public banner partial.
        includeDashboardStyles: true,
      },
    );
  });
}

export function registerAdminTapWarsApi(dependencies: RegisterAdminTapWarsApiDependencies): void {
  dependencies.router.get("/api/admin/tap-wars", (request, response) => {
    if (adminContext(request, dependencies.authService) === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Authentication is required." },
      });
      return;
    }
    sendJson(response, 200, { ...adminTapWarsPageData(dependencies) });
  });
}

export function registerTapWarsMutations(dependencies: RegisterTapWarsMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/start",
    "/admin/tap-wars",
    (form, context) => {
      dependencies.tapWarsService.start(
        {
          competitor1AssignmentId: form.competitor1AssignmentId,
          competitor2AssignmentId: form.competitor2AssignmentId,
        },
        actor(context),
      );
    },
    "Tap War started.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/resume",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.resume(params.id!, actor(context));
    },
    "Tap War resumed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/stop",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.stop(params.id!, actor(context));
    },
    "Tap War completed.",
  );
  /** Saves the switch and returns what the page announces. */
  const saveMystery = (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ): { readonly enabled: boolean; readonly notice: string } => {
    if (form.enabled !== "true" && form.enabled !== "false") {
      invalidForm("Choose whether Mystery Tap is on or off.", "enabled");
    }
    const enabled = form.enabled === "true";
    setTapWarMystery(dependencies, params.id!, enabled, actor(context));
    return {
      enabled,
      notice: enabled
        ? "Mystery Tap is on for both Tap War Taps."
        : "Mystery Tap is off for both Tap War Taps.",
    };
  };
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/mystery",
    "/admin/tap-wars",
    (form, context, params) => ({ notice: saveMystery(form, context, params).notice }),
    "Saved.",
    {},
    {
      // A Tap War keeps no revision; the service checks the war is still current instead.
      handle: (body, context, params) => {
        const saved = saveMystery(autosaveFieldStrings(body, ["enabled"]), context, params);
        return { resource: { enabled: saved.enabled }, message: saved.notice };
      },
      current: () => {
        const sides = tapWarMysteryState(dependencies);
        return { current: sides === null ? null : mysterySwitchView(sides) };
      },
      validationFields: validationFieldsFor(["enabled"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/dismiss",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.dismissPublicResult(params.id!, actor(context));
    },
    "Tap War result dismissed.",
  );
}

export interface TapWarMysterySide {
  readonly side: 1 | 2;
  readonly tapNumber: number;
  readonly enabled: boolean;
  /** False once the war's original Fill has left the Tap: Mystery then belongs to another Fill. */
  readonly changeable: boolean;
}

function mysterySides(
  dependencies: TapWarMysteryDependencies,
  war: TapWar,
): readonly TapWarMysterySide[] {
  return war.competitors.map((competitor) => {
    const changeable =
      dependencies.tapService.getTap(competitor.tapId).activeAssignment?.id ===
      competitor.assignmentId;
    return {
      side: competitor.side,
      tapNumber: competitor.tapNumber,
      enabled: changeable && dependencies.tapService.getAssignmentMystery(competitor.tapId).enabled,
      changeable,
    };
  });
}

/** What the Admin switch shows: on only when both sides are Mystery Taps. */
function mysterySwitchView(sides: readonly TapWarMysterySide[]): Readonly<Record<string, unknown>> {
  const blocked = sides.find((side) => !side.changeable);
  const enabledSides = sides.filter((side) => side.enabled);
  return {
    enabled: enabledSides.length === sides.length,
    blockedTapNumber: blocked?.tapNumber ?? null,
    onlyTapNumber: enabledSides.length === 1 ? enabledSides[0]!.tapNumber : null,
  };
}

/** Mystery Tap state for each side of the unfinished Tap War, or null when there is none. */
export function tapWarMysteryState(
  dependencies: TapWarMysteryDependencies,
): readonly TapWarMysterySide[] | null {
  const war = dependencies.tapWarsService.getCurrentUnfinished();
  return war === undefined ? null : mysterySides(dependencies, war);
}

/**
 * Turns Mystery Tap on or off for both Taps of the unfinished Tap War and returns how many
 * changed. Turning it on leaves a side that is already a Mystery Tap, and its reveal choices,
 * as they are. Both sides are checked before anything is written, and the whole call is
 * synchronous, so no other request can reassign a Tap in between.
 */
export function setTapWarMystery(
  dependencies: TapWarMysteryDependencies,
  warId: string,
  enabled: boolean,
  options: TapActorOptions = {},
): number {
  const war = dependencies.tapWarsService.getCurrentUnfinished();
  if (war === undefined || war.id !== warId)
    throw new ApplicationError({
      category: "conflict",
      code: "tap_war.not_current",
      clientMessage: "This Tap War is no longer current. Reload and try again.",
    });
  const blocked = mysterySides(dependencies, war).find((side) => !side.changeable);
  if (blocked !== undefined)
    throw new ApplicationError({
      category: "conflict",
      code: "tap_war.assignment_changed",
      clientMessage: `Tap ${blocked.tapNumber} has a different Fill now. Change its Mystery setting on the Tap page.`,
      details: { tapWarId: war.id, side: blocked.side },
    });
  let changed = 0;
  for (const competitor of war.competitors) {
    const current = dependencies.tapService.getAssignmentMystery(competitor.tapId);
    if (current.enabled === enabled) continue;
    const result = dependencies.tapService.updateAssignmentMystery(
      competitor.tapId,
      { ...current, enabled },
      options,
    );
    if (result.changed) changed += 1;
  }
  return changed;
}

export function tapWarUnavailabilityLabel(reason: EligibilityReason | null): string | null {
  switch (reason) {
    case "disabled":
      return "This Tap is disabled.";
    case "retired":
      return "This Tap has been retired.";
    case "original_assignment_ended_or_replaced":
      return "The original Tap assignment ended or changed.";
    case "fill_ended_or_missing":
      return "The original filled keg ended or is unavailable.";
    case null:
      return null;
  }
}

export function adminTapWarView(war: TapWar | undefined): Readonly<Record<string, unknown>> | null {
  if (war === undefined) return null;
  const [first, second] = war.competitors;
  const firstVotes = war.status === "completed" ? (first.finalVoteCount ?? 0) : first.voteCount;
  const secondVotes = war.status === "completed" ? (second.finalVoteCount ?? 0) : second.voteCount;
  const percentages = tapWarPercentages(firstVotes, secondVotes);
  const totalVotes = firstVotes + secondVotes;
  const leaderSide =
    firstVotes === secondVotes ? null : firstVotes > secondVotes ? (1 as const) : (2 as const);
  return {
    id: war.id,
    status: war.status,
    result: war.result,
    startedAt: war.startedAt,
    pausedAt: war.pausedAt,
    completedAt: war.completedAt,
    publishedAt: war.publishedAt,
    dismissedAt: war.dismissedAt,
    totalVotes,
    leaderSide: war.status === "completed" ? null : leaderSide,
    isTie:
      war.status === "completed" ? war.result === "tie" : totalVotes > 0 && leaderSide === null,
    completionPublicTitleSide1: war.completionPublicTitleSide1,
    completionPublicTitleSide2: war.completionPublicTitleSide2,
    competitors: war.competitors.map((competitor) => ({
      side: competitor.side,
      assignmentId: competitor.assignmentId,
      tapId: competitor.tapId,
      tapNumber: competitor.tapNumber,
      adminBeverageTitle: competitor.adminBeverageTitle,
      voteCount:
        war.status === "completed" ? (competitor.finalVoteCount ?? 0) : competitor.voteCount,
      percentage:
        competitor.side === 1 ? (percentages?.side1 ?? null) : (percentages?.side2 ?? null),
      eligible: competitor.eligibility.eligible,
      unavailableReason: tapWarUnavailabilityLabel(competitor.eligibility.reason),
    })),
  };
}

export function adminTapWarsPageData(
  dependencies: AdminTapWarsPageDataDependencies,
): Readonly<Record<string, unknown>> {
  const rawCurrent = dependencies.tapWarsService.getCurrentUnfinished();
  return {
    current: adminTapWarView(rawCurrent),
    published: adminTapWarView(dependencies.tapWarsService.getPublishedResult()),
    publicVisible: dependencies.publicTapWarsService.getVisible(),
    history: dependencies.tapWarsService
      .listCompletedHistory()
      .map((completed) => adminTapWarView(completed)!),
    eligible: dependencies.tapWarsService.listEligibleParticipants().map((participant) => ({
      assignmentId: participant.assignmentId,
      tapId: participant.tapId,
      tapNumber: participant.tapNumber,
      preview: dependencies.publicTapWarsService.previewEligible(participant.assignmentId),
    })),
    mystery:
      rawCurrent === undefined ? null : mysterySwitchView(mysterySides(dependencies, rawCurrent)),
    canResume:
      rawCurrent?.status === "paused" &&
      rawCurrent.competitors.every((side) => side.eligibility.eligible),
  };
}
