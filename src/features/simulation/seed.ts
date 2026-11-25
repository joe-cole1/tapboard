import { ApplicationError } from "../../shared/errors.ts";
import { BEVERAGE_SENSORY_AXES } from "../beverages/types.ts";
import type { EffectiveBeveragePresentation } from "../beverages/types.ts";
import { HISTORY_BEERS } from "./history-beers.ts";
import { LEGACY_BEERS, LEGACY_ON_DECK } from "./legacy-samples.ts";
import { insertSensor, listSensors, readSettings, setFillVolume, setSeeded } from "./repository.ts";
import type { SimulationDependencies, SimulationSensor } from "./types.ts";

/** Tap 3 has a scale and a flow meter (flow pours, scale truth); Tap 4 has only a flow meter. */
const SCALE_AND_FLOW_TAP = 3;
const FLOW_ONLY_TAP = 4;
// A flow-only Tap reads its Fill as full until pours are recorded, so Tap 4's keg starts full.
const FRACTIONS = [0.93, 0.78, 0.6, 1, 0.27, 1, 1] as const;
const LEGACY_PROFILES = [
  ...LEGACY_BEERS.map(({ fraction: _fraction, ...profile }) => ({
    ...profile,
    beverageType: "beer" as const,
    fg: 1.012,
    description: "Fictional sample beer for the built-in Simulation workspace.",
  })),
  LEGACY_ON_DECK,
].map((profile): EffectiveBeveragePresentation => ({
  og: null,
  displayColor: null,
  manualDensityOverride: null,
  ...profile,
}));

/** Enrich only exact original profiles; operator edits and physical history are authoritative. */
function upgradeLegacy(dependencies: SimulationDependencies): void {
  const { beverageService, tapService, fillService } = dependencies;
  const details = beverageService
    .listBeverages()
    .map(({ beverage }) => beverageService.getBeverage(beverage.id));
  const matches = LEGACY_PROFILES.map((profile) => {
    const candidates = details.filter(
      (detail) =>
        detail.beverage.ownershipType === "custom" &&
        !detail.customRecipe &&
        beverageService.getRecipeSnapshots(detail.beverage.id).length === 0 &&
        !detail.brewfatherLink &&
        !BEVERAGE_SENSORY_AXES.some((axis) => detail.sensoryOverrides?.[axis] != null) &&
        Object.entries(profile).every(
          ([key, value]) =>
            detail.effectivePresentation[key as keyof EffectiveBeveragePresentation] === value,
        ),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  });
  const taps = tapService.listTaps();
  const fills = fillService.listFills();
  const originalTaps = Array.from({ length: 6 }, (_, index) =>
    taps.find((tap) => tap.tapNumber === index + 1),
  );
  const originalDeck = fills.filter(
    (fill) => fill.beverageId === matches[6]?.beverage.id && fill.state === "on_deck",
  );
  const convertLayout =
    matches.every(Boolean) &&
    taps.length === 6 &&
    fills.length === 7 &&
    originalDeck.length === 1 &&
    originalTaps.every(
      (tap, index) =>
        tap &&
        tap.name === `Sample Tap ${index + 1}` &&
        tap.enabled &&
        !tap.isRetired &&
        tap.activeAssignment?.beverageId === matches[index]?.beverage.id,
    );
  const actor = { actorType: "system" } as const;
  for (const [index, match] of matches.entries()) {
    if (!match) continue;
    const beer = HISTORY_BEERS[index]!;
    beverageService.updateCustomBeverage(match.beverage.id, beer.profile, actor);
    beverageService.attachOfflineRecipeSnapshot(
      match.beverage.id,
      { sourceKey: beer.caseId, recipeJson: beer.snapshotJson },
      actor,
    );
  }
  if (convertLayout) {
    const sixth = originalTaps[5]!;
    const fillId = sixth.activeAssignment!.fillId;
    tapService.unassign(sixth.id, actor);
    fillService.markOnDeck(fillId, actor);
    fillService.reorderOnDeck({ fillIds: [fillId, originalDeck[0]!.id] }, actor);
    tapService.updateTap(sixth.id, { enabled: false }, actor);
  }
}

/** Seed only a new, dedicated simulation database, through ordinary domain services. */
export function seedSimulation(dependencies: SimulationDependencies): readonly SimulationSensor[] {
  const { database, tapService, kegService, beverageService, fillService, telemetryService } =
    dependencies;
  return database.withTransaction(() => {
    if (readSettings(database).seeded) {
      upgradeLegacy(dependencies);
      return listSensors(database);
    }
    if (
      tapService.listTaps().length ||
      kegService.listKegs().length ||
      beverageService.listBeverages().length ||
      fillService.listFills().length ||
      telemetryService.listSources().length ||
      listSensors(database).length
    ) {
      throw new ApplicationError({
        category: "conflict",
        code: "simulation.database_not_empty",
        clientMessage: "Simulation can only be initialized in an empty, separate database.",
      });
    }
    const actor = { actorType: "system" } as const;
    for (const [index, beer] of HISTORY_BEERS.entries()) {
      const number = index + 1;
      const beverage = beverageService.createCustomBeverage(beer.profile, actor);
      beverageService.attachOfflineRecipeSnapshot(
        beverage.beverage.id,
        { sourceKey: beer.caseId, recipeJson: beer.snapshotJson },
        actor,
      );
      const keg = kegService.createKeg(
        {
          kegNumber: number,
          label: index < 5 ? `Sample Keg ${number}` : `Sample On Deck Keg ${number - 5}`,
          capacityMl: 19_000,
          currentTareG: 4_200,
        },
        actor,
      );
      const fill = fillService.createFill(
        { beverageId: beverage.beverage.id, kegId: keg.id },
        actor,
      );
      const remainingMl = keg.capacityMl * FRACTIONS[index]!;
      setFillVolume(database, fill.id, remainingMl);
      if (index >= 5) {
        fillService.markOnDeck(fill.id, actor);
        continue;
      }
      const tap = tapService.createTap({ tapNumber: number, name: `Sample Tap ${number}` }, actor);
      const { source } = telemetryService.createSource(
        { name: `Simulation sensor ${number}` },
        actor,
      );
      telemetryService.setTapAuthority(
        tap.id,
        {
          levelSourceId: number === FLOW_ONLY_TAP ? null : source.id,
          conditionSourceId: source.id,
          flowSourceId:
            number === SCALE_AND_FLOW_TAP || number === FLOW_ONLY_TAP ? source.id : null,
        },
        actor,
      );
      tapService.assignFill(tap.id, { fillId: fill.id }, actor);
      if (number === 1) {
        // Take the first keg off once and put it back (a line clean), so the Tap page's History
        // tab has an ended Fill to show beside the one on tap.
        tapService.unassign(tap.id, actor);
        tapService.assignFill(tap.id, { fillId: fill.id }, actor);
      }
      insertSensor(database, {
        tapId: tap.id,
        sourceId: source.id,
        remainingMl,
        temperatureC: 4 + index * 0.2,
        online: true,
        noiseEnabled: false,
        sequence: 0,
      });
    }
    // A cider nobody pours yet, with its own recipe and tasting overrides, and an empty keg to
    // fill it into: the Beverage page's Recipe, Sensory and Current usage tabs, a non-beer
    // display colour, and a Physical Keg without a Fill.
    const cider = beverageService.createCustomBeverage(
      {
        name: "Sample Orchard Cider",
        beverageType: "cider",
        abv: 6.2,
        og: 1.05,
        fg: 1.003,
        description: "Fictional sample cider for the built-in Simulation workspace.",
        recipe: {
          notes: "Pressed dessert apples, fermented cool and dry.",
          ingredients: [
            { name: "Apple juice", amount: 20, unit: "L" },
            { name: "Cider yeast", amount: 1, unit: "packet" },
          ],
          steps: [{ name: "Ferment", temperatureC: 16, timeMinutes: 20_160 }],
        },
        sensoryOverrides: { sweetness: 3, tartness: 6, body: 2 },
      },
      actor,
    );
    kegService.createKeg(
      {
        kegNumber: HISTORY_BEERS.length + 1,
        label: "Sample Spare Keg",
        capacityMl: 19_000,
        currentTareG: 4_200,
      },
      actor,
    );
    // The other side of every permanent action: a never-used Tap that can be deleted or retired,
    // a kicked Filled Keg that can be deleted, and a sensor no Tap uses, which can be disabled.
    tapService.createTap({ tapNumber: 6, name: "Sample Spare Tap", enabled: false }, actor);
    const kickedKeg = kegService.createKeg(
      {
        kegNumber: HISTORY_BEERS.length + 2,
        label: "Sample Kicked Keg",
        capacityMl: 19_000,
        currentTareG: 4_200,
      },
      actor,
    );
    const kicked = fillService.createFill(
      { beverageId: cider.beverage.id, kegId: kickedKeg.id },
      actor,
    );
    // A custom beverage has no Brewfather batch, so the kick completes synchronously inside this
    // transaction; the check below makes a failure roll the seed back.
    fillService.kickFill(kicked.id, { reason: "Sample kicked keg" }, actor).catch(() => undefined);
    if (fillService.getFill(kicked.id).state !== "ended") {
      throw new Error("The sample kicked keg could not be ended.");
    }
    telemetryService.createSource({ name: "Simulation spare sensor" }, actor);
    setSeeded(database);
    return listSensors(database);
  });
}
