import { ApplicationError } from "../../../shared/errors.ts";

/** Every rejected recipe file gets a fixed, operator-facing message that never echoes file content. */
export function invalidRecipeFile(clientMessage: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "beverage.invalid_recipe_file",
    clientMessage,
  });
}

export function oneRecipe<T>(recipes: readonly T[]): T {
  if (recipes.length === 0) invalidRecipeFile("This file has no recipe.");
  if (recipes.length > 1)
    invalidRecipeFile(
      `This file has ${recipes.length} recipes. Export just the recipe for this beverage.`,
    );
  return recipes[0]!;
}
