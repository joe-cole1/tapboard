import type { XmlElement } from "./xml.ts";
import { invalidRecipeFile, oneRecipe } from "./problem.ts";

/** BeerXML 1.0 (BeerSmith, Brewer's Friend, Grainfather, BrewTarget and others) → the recipe
 * object the Brewfather normalizer reads. BeerXML units are fixed by the spec: kg, L, minutes,
 * °C, days for fermentation ages, Lovibond for fermentable colour and SRM for recipe colour.
 * Notes, taste notes and brewer names are not carried over. */

type Row = Record<string, unknown>;

const children = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter((child) => child.name.toUpperCase() === name);

function text(element: XmlElement, name: string): string | undefined {
  const value = children(element, name)[0]?.text.trim();
  return value ? value : undefined;
}

/** Leading number of a value such as "1.050 SG" or "8.5 SRM", with the trailing unit text. */
function measure(
  element: XmlElement,
  name: string,
): { readonly value: number; readonly unit: string } | undefined {
  const raw = text(element, name);
  const match = raw === undefined ? null : /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))(.*)$/su.exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, unit: match[2]!.trim().toLowerCase() } : undefined;
}

function number(element: XmlElement, name: string): number | undefined {
  return measure(element, name)?.value;
}

function gravity(element: XmlElement, name: string): number | undefined {
  const found = measure(element, name);
  return found && (found.unit === "" || found.unit === "sg") ? found.value : undefined;
}

function list(recipe: XmlElement, group: string, item: string): XmlElement[] {
  return children(recipe, group).flatMap((element) => children(element, item));
}

const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Weight amounts become grams; volume amounts (AMOUNT_IS_WEIGHT false) become millilitres. */
function amount(element: XmlElement, defaultWeight: boolean): Row {
  const value = number(element, "AMOUNT");
  if (value === undefined) return {};
  const flag = text(element, "AMOUNT_IS_WEIGHT")?.toUpperCase();
  const weight = flag === undefined ? defaultWeight : flag === "TRUE";
  return { amount: round(value * 1000), unit: weight ? "g" : "ml" };
}

function hop(element: XmlElement): Row {
  const use = text(element, "USE");
  const minutes = number(element, "TIME");
  const dryHop = use?.toLowerCase().replace(/[\s_-]+/gu, "") === "dryhop";
  return {
    name: text(element, "NAME"),
    origin: text(element, "ORIGIN"),
    alpha: number(element, "ALPHA"),
    form: text(element, "FORM"),
    use,
    ...amount(element, true),
    ...(minutes === undefined
      ? {}
      : dryHop
        ? { time: round(minutes / 1440, 2), timeUnit: "day" }
        : { time: minutes, timeUnit: "min" }),
  };
}

function fermentationSteps(recipe: XmlElement): Row[] {
  const count = number(recipe, "FERMENTATION_STAGES");
  return (["PRIMARY", "SECONDARY", "TERTIARY"] as const).flatMap((stage, index) => {
    const stepTime = number(recipe, `${stage}_AGE`);
    const stepTemp = number(recipe, `${stage}_TEMP`);
    if (
      (count !== undefined && index >= count) ||
      (stepTime === undefined && stepTemp === undefined)
    )
      return [];
    const name = stage[0] + stage.slice(1).toLowerCase();
    return [{ name, type: name, stepTemp, stepTime }];
  });
}

export function beerXmlRecipe(root: XmlElement): Row {
  const rootName = root.name.toUpperCase();
  if (rootName !== "RECIPES" && rootName !== "RECIPE")
    invalidRecipeFile("This XML file is not a BeerXML recipe file.");
  const recipe = oneRecipe(rootName === "RECIPE" ? [root] : children(root, "RECIPE"));
  const color = measure(recipe, "EST_COLOR");
  const style = children(recipe, "STYLE")[0];
  return {
    name: text(recipe, "NAME"),
    type: text(recipe, "TYPE"),
    og: gravity(recipe, "EST_OG") ?? gravity(recipe, "OG"),
    fg: gravity(recipe, "EST_FG") ?? gravity(recipe, "FG"),
    abv: number(recipe, "EST_ABV") ?? number(recipe, "ABV"),
    ibu: number(recipe, "IBU"),
    color:
      color === undefined
        ? undefined
        : color.unit.includes("ebc")
          ? round(color.value * 0.508, 2)
          : color.value,
    batchSize: number(recipe, "BATCH_SIZE"),
    boilTime: number(recipe, "BOIL_TIME"),
    carbonation: number(recipe, "CARBONATION"),
    style: style === undefined ? undefined : { name: text(style, "NAME") },
    fermentables: list(recipe, "FERMENTABLES", "FERMENTABLE").map((element) => {
      const kg = number(element, "AMOUNT");
      return {
        name: text(element, "NAME"),
        type: text(element, "TYPE"),
        supplier: text(element, "SUPPLIER"),
        origin: text(element, "ORIGIN"),
        lovibond: number(element, "COLOR"),
        ...(kg === undefined ? {} : { amount: kg, unit: "kg" }),
      };
    }),
    hops: list(recipe, "HOPS", "HOP").map(hop),
    yeasts: list(recipe, "YEASTS", "YEAST").map((element) => ({
      name: text(element, "NAME"),
      type: text(element, "TYPE"),
      form: text(element, "FORM"),
      laboratory: text(element, "LABORATORY"),
      productId: text(element, "PRODUCT_ID"),
      ...amount(element, false),
    })),
    miscs: list(recipe, "MISCS", "MISC").map((element) => {
      const minutes = number(element, "TIME");
      return {
        name: text(element, "NAME"),
        type: text(element, "TYPE"),
        use: text(element, "USE"),
        ...amount(element, false),
        ...(minutes === undefined ? {} : { time: minutes, timeUnit: "min" }),
      };
    }),
    mash: {
      steps: children(recipe, "MASH")
        .flatMap((mash) => list(mash, "MASH_STEPS", "MASH_STEP"))
        .map((element) => ({
          name: text(element, "NAME"),
          type: text(element, "TYPE"),
          stepTemp: number(element, "STEP_TEMP"),
          stepTime: number(element, "STEP_TIME"),
        })),
    },
    fermentation: { steps: fermentationSteps(recipe) },
  };
}
