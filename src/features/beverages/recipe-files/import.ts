import { createHash } from "node:crypto";
import { sanitizeRecipeSnapshot } from "../brewfather/sanitizer.ts";
import type { BrewingInputFormat } from "../brewing-types.ts";
import { beerJsonRecipe, isBeerJson } from "./beerjson.ts";
import { beerXmlRecipe } from "./beerxml.ts";
import { invalidRecipeFile, oneRecipe } from "./problem.ts";
import { parseXml, XmlSyntaxError } from "./xml.ts";

/** Account marker on every offline (imported) detached snapshot. */
export const OFFLINE_RECIPE_ACCOUNT_ID = "offline-history";

/** Raw file text accepted from Admin. Only the sanitized snapshot (at most 256 KiB) is kept. */
export const MAX_RECIPE_FILE_BYTES = 1_048_576;

export type RecipeFileFormat = Extract<
  BrewingInputFormat,
  "brewfather-export-v3" | "beerjson" | "beerxml-1"
>;

export const RECIPE_FILE_FORMAT_NAMES: Readonly<Record<RecipeFileFormat, string>> = {
  "brewfather-export-v3": "Brewfather",
  beerjson: "BeerJSON",
  "beerxml-1": "BeerXML",
};

export interface ParsedRecipeFile {
  readonly format: RecipeFileFormat;
  /** Content-derived, so re-importing the identical file is idempotent. */
  readonly sourceKey: string;
  readonly recipeJson: string;
}

const UNRECOGNISED =
  "Tapboard couldn't recognise this file. Use a Brewfather batch or recipe JSON export, a BeerJSON file or a BeerXML file.";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalidRecipeFile("The file is not valid JSON.");
  }
}

/** Brewfather exports one batch or recipe as an object; a multi-item export is an array. */
function brewfather(document: unknown): { recipe: unknown; batch?: unknown } {
  const item = object(Array.isArray(document) ? oneRecipe(document) : document);
  if (item?._type === "batch" && object(item.recipe)) return { recipe: item.recipe, batch: item };
  if (item?._type === "recipe") return { recipe: item };
  return invalidRecipeFile(UNRECOGNISED);
}

export function parseRecipeFile(text: string): ParsedRecipeFile {
  if (typeof text !== "string" || text.trim() === "")
    invalidRecipeFile("Paste or choose a recipe file first.");
  if (Buffer.byteLength(text, "utf8") > MAX_RECIPE_FILE_BYTES)
    invalidRecipeFile("The recipe file is larger than 1 MiB.");
  const body = text.replace(/^﻿/u, "").trimStart();
  let format: RecipeFileFormat;
  let source: { recipe: unknown; batch?: unknown };
  if (body.startsWith("<")) {
    let root;
    try {
      root = parseXml(body);
    } catch (error) {
      if (!(error instanceof XmlSyntaxError)) throw error;
      return invalidRecipeFile(
        "The file is not well-formed XML. Files with a DOCTYPE or custom entities are not accepted.",
      );
    }
    format = "beerxml-1";
    source = { recipe: beerXmlRecipe(root) };
  } else if (body.startsWith("{") || body.startsWith("[")) {
    const document = parseJson(body);
    if (isBeerJson(document)) {
      format = "beerjson";
      source = { recipe: beerJsonRecipe(document) };
    } else {
      format = "brewfather-export-v3";
      source = brewfather(document);
    }
  } else return invalidRecipeFile(UNRECOGNISED);
  const snapshot = sanitizeRecipeSnapshot(source.recipe, source.batch, { format });
  if (snapshot === null)
    invalidRecipeFile("This recipe has more data than Tapboard keeps (256 KiB after cleanup).");
  const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
  return { format, sourceKey: `${format}:${digest}`, recipeJson: snapshot.recipeJson };
}
