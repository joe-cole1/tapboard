import { invalidRecipeFile, oneRecipe } from "./problem.ts";

/** BeerJSON (versions 1 to 3 share these fields) → the recipe object the Brewfather normalizer
 * reads. Unit objects are converted to litres, minutes, days, °C, SG and SRM; ingredient masses
 * keep their unit, which the normalizer converts to grams. Notes, taste and author are dropped. */

type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Reads a BeerJSON `{ unit, value }` and converts it by a unit table; unknown units are dropped. */
function convert(
  measure: unknown,
  table: Readonly<Record<string, (value: number) => number>>,
): number | undefined {
  const { unit, value } = object(measure);
  const number = finite(value);
  if (number === undefined || typeof unit !== "string" || !Object.hasOwn(table, unit))
    return undefined;
  return round(table[unit]!(number));
}

const LITRES: Record<string, (v: number) => number> = {
  ml: (v) => v / 1000,
  l: (v) => v,
  tsp: (v) => v * 0.00492892159375,
  tbsp: (v) => v * 0.01478676478125,
  floz: (v) => v * 0.0295735295625,
  cup: (v) => v * 0.2365882365,
  pt: (v) => v * 0.473176473,
  qt: (v) => v * 0.946352946,
  gal: (v) => v * 3.785411784,
  bbl: (v) => v * 117.347765304,
  ifloz: (v) => v * 0.0284130625,
  ipt: (v) => v * 0.56826125,
  iqt: (v) => v * 1.1365225,
  igal: (v) => v * 4.54609,
  ibbl: (v) => v * 163.65924,
};
const MINUTES: Record<string, (v: number) => number> = {
  sec: (v) => v / 60,
  min: (v) => v,
  hr: (v) => v * 60,
  day: (v) => v * 1440,
  week: (v) => v * 10080,
};
const DAYS: Record<string, (v: number) => number> = Object.fromEntries(
  Object.entries(MINUTES).map(([unit, toMinutes]) => [unit, (v: number) => toMinutes(v) / 1440]),
);
const CELSIUS: Record<string, (v: number) => number> = {
  C: (v) => v,
  F: (v) => ((v - 32) * 5) / 9,
};
const platoToSg = (p: number): number => 1 + p / (258.6 - (p / 258.2) * 227.1);
const SG: Record<string, (v: number) => number> = {
  sg: (v) => v,
  plato: platoToSg,
  brix: platoToSg,
};
const SRM: Record<string, (v: number) => number> = {
  SRM: (v) => v,
  EBC: (v) => v * 0.508,
  Lovi: (v) => 1.3546 * v - 0.76,
};

/** Masses, volumes and counts pass through with their unit; the normalizer converts masses. */
function amount(addition: Row): Row {
  const { unit, value } = object(addition.amount);
  const number = finite(value);
  return number === undefined || typeof unit !== "string" ? {} : { amount: number, unit };
}

function colour(measure: unknown): Row {
  const { unit } = object(measure);
  return unit === "Lovi"
    ? { lovibond: convert(measure, { Lovi: (v) => v }) }
    : { color: convert(measure, SRM) };
}

const HOP_USE: Readonly<Record<string, string>> = {
  add_to_mash: "Mash",
  add_to_boil: "Boil",
  add_to_fermentation: "Dry Hop",
  add_to_package: "Dry Hop",
};
const MISC_USE: Readonly<Record<string, string>> = {
  add_to_mash: "Mash",
  add_to_boil: "Boil",
  add_to_fermentation: "Primary",
  add_to_package: "Bottling",
};

function hop(value: unknown): Row {
  const addition = object(value);
  const timing = object(addition.timing);
  const use =
    typeof timing.use === "string" && Object.hasOwn(HOP_USE, timing.use)
      ? HOP_USE[timing.use]
      : undefined;
  const dryHop = use === "Dry Hop";
  const time = dryHop ? convert(timing.duration, DAYS) : convert(timing.time, MINUTES);
  return {
    name: string(addition.name),
    supplier: string(addition.producer),
    origin: string(addition.origin),
    productId: string(addition.product_id),
    form: string(addition.form),
    alpha: finite(object(addition.alpha_acid).value),
    use,
    ...amount(addition),
    ...(time === undefined ? {} : { time: round(time, 2), timeUnit: dryHop ? "day" : "min" }),
  };
}

export function isBeerJson(document: unknown): boolean {
  return Object.hasOwn(object(document), "beerjson");
}

export function beerJsonRecipe(document: unknown): Row {
  const root = object(object(document).beerjson);
  const version = finite(root.version);
  if (version === undefined || version < 1 || version >= 4)
    invalidRecipeFile("This BeerJSON version is not supported.");
  const recipe = object(oneRecipe(array(root.recipes)));
  const ingredients = object(recipe.ingredients);
  const ibu = object(recipe.ibu_estimate).value;
  return {
    name: string(recipe.name),
    type: string(recipe.type),
    og: convert(recipe.original_gravity, SG),
    fg: convert(recipe.final_gravity, SG),
    abv: convert(recipe.alcohol_by_volume, { "%": (v) => v }),
    ibu: convert(ibu, { IBUs: (v) => v }),
    color: convert(recipe.color_estimate, SRM),
    batchSize: convert(recipe.batch_size, LITRES),
    boilTime: convert(object(recipe.boil).boil_time, MINUTES),
    carbonation: finite(recipe.carbonation),
    style: { name: string(object(recipe.style).name) },
    fermentables: array(ingredients.fermentable_additions).map((value) => {
      const addition = object(value);
      return {
        name: string(addition.name),
        type: string(addition.type),
        supplier: string(addition.producer),
        origin: string(addition.origin),
        productId: string(addition.product_id),
        ...colour(addition.color),
        ...amount(addition),
      };
    }),
    hops: array(ingredients.hop_additions).map(hop),
    yeasts: array(ingredients.culture_additions).map((value) => {
      const addition = object(value);
      return {
        name: string(addition.name),
        type: string(addition.type),
        form: string(addition.form),
        laboratory: string(addition.producer),
        productId: string(addition.product_id),
        ...amount(addition),
      };
    }),
    miscs: array(ingredients.miscellaneous_additions).map((value) => {
      const addition = object(value);
      const timing = object(addition.timing);
      const minutes = convert(timing.time, MINUTES);
      return {
        name: string(addition.name),
        type: string(addition.type),
        use:
          typeof timing.use === "string" && Object.hasOwn(MISC_USE, timing.use)
            ? MISC_USE[timing.use]
            : undefined,
        ...amount(addition),
        ...(minutes === undefined ? {} : { time: minutes, timeUnit: "min" }),
      };
    }),
    mash: {
      steps: array(object(recipe.mash).mash_steps).map((value) => {
        const step = object(value);
        return {
          name: string(step.name),
          type: string(step.type),
          stepTemp: convert(step.step_temperature, CELSIUS),
          stepTime: convert(step.step_time, MINUTES),
        };
      }),
    },
    fermentation: {
      steps: array(object(recipe.fermentation).fermentation_steps).map((value) => {
        const step = object(value);
        return {
          name: string(step.name),
          stepTemp: convert(step.start_temperature ?? step.end_temperature, CELSIUS),
          stepTime: convert(step.step_time, DAYS),
        };
      }),
    },
  };
}
