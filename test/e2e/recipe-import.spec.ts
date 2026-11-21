import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

const BEERXML_PATH = new URL("../fixtures/recipe-files/pale-ale.beerxml.xml", import.meta.url);

async function signIn(browser: Browser, javaScriptEnabled: boolean): Promise<Page> {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  if (!javaScriptEnabled) await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
  return page;
}

async function newBeverage(page: Page, name: string): Promise<void> {
  await page.goto("/admin/beverages/new");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("button", { name: "Create beverage" }).click();
  await expect(page.getByRole("heading", { name: "Import recipe file" })).toBeVisible();
}

test("without JavaScript, pasting a BeerXML file imports it into a Custom beverage", async ({
  browser,
}) => {
  const page = await signIn(browser, false);
  await newBeverage(page, "Pasted BeerXML import");
  await expect(page.getByLabel("Recipe file", { exact: true })).toBeHidden();
  await page
    .getByRole("textbox", { name: "Recipe file contents" })
    .fill(readFileSync(BEERXML_PATH, "utf8"));
  await page.getByRole("button", { name: "Import recipe" }).click();
  await expect(page.getByText("Recipe imported (BeerXML).")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Imported recipe", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Imported BeerXML recipe" })).toBeVisible();
  await expect(page.getByText("Centennial").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Import recipe" })).toHaveCount(0);
});

test("with JavaScript, choosing a file fills the form, and a bad file is refused with a message", async ({
  browser,
}) => {
  const page = await signIn(browser, true);
  await newBeverage(page, "Picked BeerXML import");
  await page.getByRole("textbox", { name: "Recipe file contents" }).fill("<RECIPES><RECIPE>");
  await page.getByRole("button", { name: "Import recipe" }).click();
  await expect(page.getByText(/not well-formed XML/u)).toBeVisible();
  await page.getByLabel("Recipe file", { exact: true }).setInputFiles(BEERXML_PATH.pathname);
  await expect(page.getByText("pale-ale.beerxml.xml is ready to import.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Recipe file contents" })).toHaveValue(
    /Fixture Pale Ale/u,
  );
  await page.getByRole("button", { name: "Import recipe" }).click();
  await expect(page.getByText("Recipe imported (BeerXML).")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Imported BeerXML recipe" })).toBeVisible();
});
