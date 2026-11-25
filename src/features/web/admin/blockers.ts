/**
 * Plain-language lines for what stops a permanent Admin action (delete, retire, disable).
 *
 * Every line says why the action is blocked and links to where it is fixed or, for a permanent
 * blocker, to the alternative. `views/partials/permanent-action.eta` renders them.
 */

export interface BlockerLine {
  readonly text: string;
  readonly linkLabel: string;
  readonly href: string;
}

export interface TapDeletionFacts {
  readonly canDelete: boolean;
  readonly firstUsedAt: string | null;
  readonly retiredAt: string | null;
  readonly activeAssignmentCount: number;
  readonly historicalAssignmentCount: number;
}

export interface TapBlockerLinks {
  readonly assignment: string;
  readonly lifecycle: string;
  readonly history: string;
}

/** Why a Tap can't be deleted: one line, the permanent reason first. Empty when it can be. */
export function tapDeletionBlockers(
  tapLabel: string,
  facts: TapDeletionFacts,
  links: TapBlockerLinks,
): readonly BlockerLine[] {
  if (facts.retiredAt !== null) {
    return [
      {
        text: `${tapLabel} is retired, so it can't be deleted. It keeps its number and history.`,
        linkLabel: "See its history",
        href: links.history,
      },
    ];
  }
  const hasActiveFill = facts.activeAssignmentCount > 0;
  if (facts.firstUsedAt !== null || facts.historicalAssignmentCount > 0) {
    const reason = facts.firstUsedAt !== null ? "has served beer" : "has assignment history";
    return [
      hasActiveFill
        ? {
            text: `${tapLabel} ${reason}, so it can't be deleted. Retire it instead, once its Filled Keg is off the tap.`,
            linkLabel: "Go to Assignment",
            href: links.assignment,
          }
        : {
            text: `${tapLabel} ${reason}, so it can't be deleted.`,
            linkLabel: "Retire it instead",
            href: links.lifecycle,
          },
    ];
  }
  if (hasActiveFill) {
    return [
      {
        text: `${tapLabel} has a Filled Keg on it, so it can't be deleted yet.`,
        linkLabel: "Take it off in Assignment",
        href: links.assignment,
      },
    ];
  }
  // A refusal these facts don't explain still gets a line, never a form that would fail.
  return facts.canDelete
    ? []
    : [
        {
          text: `${tapLabel} can't be deleted.`,
          linkLabel: "Retire it instead",
          href: links.lifecycle,
        },
      ];
}

/** Why a Tap can't be retired yet. */
export function tapRetireBlockers(
  tapLabel: string,
  hasActiveFill: boolean,
  assignmentHref: string,
): readonly BlockerLine[] {
  return hasActiveFill
    ? [
        {
          text: `${tapLabel} has a Filled Keg on it, so it can't be retired yet.`,
          linkLabel: "Take it off in Assignment",
          href: assignmentHref,
        },
      ]
    : [];
}

/** A Filled Keg is deleted only once it has ended; until then, kicking it is the fix. */
export function fillDeletionBlockers(ended: boolean, kickHref: string): readonly BlockerLine[] {
  return ended
    ? []
    : [
        {
          text: "This Filled Keg is still in use, so it can't be deleted.",
          linkLabel: "Kick it first",
          href: kickHref,
        },
      ];
}

/** One line per Tap that holds a role from the source; each links to that Tap's sensors. */
export function telemetryDisableBlockers(
  taps: readonly { readonly tapNumber: number; readonly sensorsHref: string }[],
): readonly BlockerLine[] {
  return taps.map((tap) => ({
    text: `Tap ${tap.tapNumber} uses this source, so it can't be disabled.`,
    linkLabel: `Change Tap ${tap.tapNumber}'s sensors`,
    href: tap.sensorsHref,
  }));
}

const IMPACT_NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  beverages: ["beverage", "beverages"],
  fills: ["Filled Keg and its pours", "Filled Kegs and their pours"],
  custom_recipes: ["custom recipe", "custom recipes"],
  beverage_sensory_overrides: ["sensory override", "sensory overrides"],
  beverage_source_recipe_snapshots: ["imported recipe", "imported recipes"],
  keg_tare_history: ["tare correction", "tare corrections"],
  keg_maintenance_records: ["maintenance record", "maintenance records"],
  kegs: ["Keg", "Kegs"],
  taps: ["Tap", "Taps"],
};

function impactPhrase(code: string, count: number): string {
  const nouns = IMPACT_NOUNS[code];
  const noun = nouns
    ? nouns[count === 1 ? 0 : 1]
    : `${code.replaceAll("_", " ")} record${count === 1 ? "" : "s"}`;
  return `${count} ${noun}`;
}

/**
 * One sentence naming what else a deletion removes, from a service's `{ code, count }` impacts.
 * `selfCode` is the record being deleted, which the section already names.
 */
export function deletionImpactSentence(
  impacts: readonly { readonly code: string; readonly count: number }[],
  selfCode: string,
): string {
  const phrases = impacts
    .filter((impact) => impact.code !== selfCode && impact.count > 0)
    .map((impact) => impactPhrase(impact.code, impact.count));
  if (phrases.length === 0) return "Nothing else is deleted with it.";
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return `This also deletes ${list}.`;
}
