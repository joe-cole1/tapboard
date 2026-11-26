import type { IncomingMessage } from "node:http";
import {
  BEVERAGE_SENSORY_AXES,
  BEVERAGE_TYPES,
  type UpdateCustomBeverageInput,
} from "../../beverages/types.ts";
import type { BeverageDetailResult } from "../../beverages/service.ts";
import { SAFE_DISPLAY_COLOR } from "../../story/vessels.ts";
import { MAX_BATCH_JSON_BODY_BYTES } from "../../../infrastructure/http/security/body.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
  type AdminAutosaveSpec,
} from "./http.ts";
import { renderAdmin } from "./layout.ts";
import { numberedPageNavigation } from "./presentation.ts";
import {
  adminBeverageListItem,
  adminBrewfatherCandidate,
  colourPickerResource,
  displayColourPicker,
  fillGlassOptions,
  sensoryOverridesFromForm,
  vesselFromForm,
  recipeFromForm,
  withPickedSrm,
} from "./beverage-presentation.ts";
import {
  BEVERAGE_TABS,
  PRESENTATION_TAB_FIELDS,
  beveragePagePath,
  renderBeverageDetail,
  type BeverageTab,
} from "./beverage-detail.ts";
import { presentationOverridesFromForm } from "./presentation-overrides.ts";
import {
  MAX_RECIPE_FILE_BYTES,
  RECIPE_FILE_FORMAT_NAMES,
} from "../../beverages/recipe-files/import.ts";
import { actor, requestUrl, type AdminContext } from "./context.ts";
import { nullable, optionalNumber, invalidForm } from "./forms.ts";
import type {
  RegisterBeveragePagesDependencies,
  RegisterBeverageMutationsDependencies,
} from "../contracts.ts";

export function registerBeveragePages(dependencies: RegisterBeveragePagesDependencies): void {
  registerAdminGet(dependencies, "/admin/beverages", (request, response, context) => {
    const query = listQueryFromRequest(request);
    const index = dependencies.beverageService.listBeveragePage(query);
    const previousPage = index.page > 1 ? beveragePageHref(index.query, index.page - 1) : null;
    const nextPage =
      index.page < index.pageCount ? beveragePageHref(index.query, index.page + 1) : null;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverages",
      "Beverages",
      "/admin/beverages",
      {
        beverages: index.items.map(adminBeverageListItem),
        brewfatherCandidates: dependencies.beverageService
          .listCandidates()
          .map(adminBrewfatherCandidate),
        query: index.query,
        empty: index.query
          ? {
              title: "No matching beverages",
              text: "Try a different search or clear the filter.",
              actions: [{ label: "Add a beverage", href: "/admin/beverages/new", primary: true }],
            }
          : {
              title: "Your beverage library is empty",
              text: "Create a custom beverage to start building the library.",
              actions: [
                { label: "Create the first beverage", href: "/admin/beverages/new", primary: true },
              ],
            },
        pageNavigation: numberedPageNavigation(
          "Beverage pages",
          index.page,
          index.pageCount,
          previousPage,
          nextPage,
        ),
        pagination: {
          page: index.page,
          pageCount: index.pageCount,
          total: index.total,
          previousHref: previousPage,
          nextHref: nextPage,
        },
      },
    );
  });

  // Keep the static create path ahead of /:id so "new" can never be treated
  // as a beverage identifier by the small path router.
  registerAdminGet(dependencies, "/admin/beverages/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverage-new",
      "New Beverage",
      "/admin/beverages/new",
      {
        beverageTypes: BEVERAGE_TYPES,
        fillGlassOptions: fillGlassOptions(),
        // SRM and colour start unset: a new beer's colour matches its SRM.
        colourPicker: displayColourPicker({
          beverageType: "beer",
          srm: null,
          resolvedColor: SAFE_DISPLAY_COLOR,
          colourOverridden: false,
          linked: false,
          srmOverridden: false,
        }),
      },
    );
  });

  for (const tab of BEVERAGE_TABS) {
    registerAdminGet(
      dependencies,
      `/admin/beverages/:id${tab.path}`,
      (request, response, context, params) => {
        renderBeverageDetail(dependencies, request, response, context, params, tab.id);
      },
    );
  }
}

/**
 * The picker posts SRM and colour without a mode: a value overrides Brewfather's, and an empty
 * SRM clears it. Its reset buttons post the mode ("inherit") alone.
 */
function withPickerModes(form: Readonly<Record<string, string>>): Record<string, string> {
  const fields = withPickedSrm(form);
  for (const field of ["srm", "displayColor"]) {
    if (fields[field] !== undefined && fields[`${field}Mode`] === undefined)
      fields[`${field}Mode`] = fields[field] === "" ? "clear" : "value";
  }
  return fields;
}

export function registerBeverageMutations(
  dependencies: RegisterBeverageMutationsDependencies,
): void {
  type BeverageForm = Readonly<Record<string, string>>;
  type BeverageParams = Readonly<Record<string, string>>;
  const tabPath = (tab: BeverageTab) => (params: BeverageParams) =>
    beveragePagePath(params.id ?? "", tab);
  /**
   * Live save for a Beverage form whose service checks no revision: runs the form post's own
   * `save` on the posted fields, then answers with the Beverage's current revision, so every
   * live form on the page keeps the newest one.
   */
  const beverageAutosave = (
    fields: readonly string[],
    save: (form: BeverageForm, context: AdminContext, params: BeverageParams) => void,
    maxBytes?: number,
  ): AdminAutosaveSpec => ({
    handle: (body, context, params) => {
      save(autosaveFieldStrings(body, fields), context, params);
      return {
        resource: {},
        revision: dependencies.beverageService.getBeverage(params.id!).beverage.updatedAt,
      };
    },
    current: (params) => {
      const detail = dependencies.beverageService.getBeverage(params.id!);
      return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
    },
    validationFields: validationFieldsFor(fields),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  const saveSensory = (form: BeverageForm, context: AdminContext, params: BeverageParams) => {
    dependencies.beverageService.updateSensoryOverrides(
      params.id!,
      sensoryOverridesFromForm(form) ?? {},
      actor(context),
    );
  };
  const saveRecipe = (form: BeverageForm, context: AdminContext, params: BeverageParams) => {
    dependencies.beverageService.updateCustomBeverage(
      params.id!,
      { recipe: recipeFromForm(form) },
      actor(context),
    );
  };

  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/presentation",
    tabPath("presentation"),
    (form, context, params) => {
      dependencies.beverageService.updatePresentationOverrides(
        params.id!,
        presentationOverridesFromForm(withPickerModes(form)),
        actor(context),
      );
    },
    "Brewfather presentation overrides saved.",
    {},
    {
      handle: (body, context, params) => {
        const fields = withPickerModes(
          autosaveFieldStrings(body, [...AUTOSAVE_OVERRIDE_FIELDS, "srmExact"]),
        );
        const updated = dependencies.beverageService.autosavePresentationOverrides(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          presentationOverridesFromForm(fields),
          actor(context),
        );
        return {
          resource: { ...safeBrewfatherResource(updated), ...colourPickerResource(updated) },
          revision: updated.beverage.updatedAt,
        };
      },
      current: (params) => {
        const detail = dependencies.beverageService.getBeverage(params.id!);
        return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
      },
      validationFields: validationFieldsFor(AUTOSAVE_OVERRIDE_FIELDS),
    },
  );

  registerAdminAction(
    dependencies,
    "/admin/beverages/create",
    "/admin/beverages",
    (posted, context) => {
      const form = withPickedSrm(posted);
      const sensoryOverrides = sensoryOverridesFromForm(form);
      const created = dependencies.beverageService.createCustomBeverage(
        {
          name: form.name,
          beverageType: form.beverageType || "beer",
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          ibu: optionalNumber(form.ibu),
          og: optionalNumber(form.og),
          fg: optionalNumber(form.fg),
          srm: optionalNumber(form.srm),
          // A colour input always has a value, so it counts only once its switch is on.
          displayColor:
            form.displayColorCustom === "true" ? nullable(form.displayColor) : undefined,
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
          manualDensityOverride: optionalNumber(form.manualDensityOverride),
          ...(form.recipeJson !== undefined ? { recipe: recipeFromForm(form) } : {}),
          ...(sensoryOverrides !== undefined ? { sensoryOverrides } : {}),
        },
        actor(context),
      );
      return `/admin/beverages/${created.beverage.id}`;
    },
    "Beverage created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/create-fill",
    tabPath("usage"),
    (form, context, params) => {
      dependencies.fillService.createFill(
        {
          beverageId: params.id!,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/update",
    // Info and Presentation both post here; each form returns to its own tab.
    (params, form) =>
      beveragePagePath(
        params.id ?? "",
        PRESENTATION_TAB_FIELDS.some((field) => form[field] !== undefined)
          ? "presentation"
          : "info",
      ),
    (posted, context, params) => {
      // Each form posts only its own fields; the rest of the Beverage stays as it is.
      const form = withPickedSrm(posted);
      const sensoryOverrides = sensoryOverridesFromForm(form);
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        {
          ...customBeverageAutosaveInput(form),
          ...(form.recipeJson !== undefined ? { recipe: recipeFromForm(form) } : {}),
          ...(sensoryOverrides !== undefined ? { sensoryOverrides } : {}),
        },
        actor(context),
      );
    },
    "Beverage updated.",
    {},
    {
      handle: (body, context, params) => {
        const fields = withPickedSrm(
          autosaveFieldStrings(body, ["updatedAt", ...AUTOSAVE_BEVERAGE_FIELDS, "srmExact"]),
        );
        const updated = dependencies.beverageService.autosaveCustomPresentation(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          customBeverageAutosaveInput(fields),
          actor(context),
        );
        return {
          resource: { ...safeCustomBeverageResource(updated), ...colourPickerResource(updated) },
          revision: updated.beverage.updatedAt,
        };
      },
      current: (params) => {
        const detail = dependencies.beverageService.getBeverage(params.id!);
        return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
      },
      validationFields: validationFieldsFor(["updatedAt", ...AUTOSAVE_BEVERAGE_FIELDS, "srmExact"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/delete",
    // A refused deletion stays on the Delete tab; a deleted Beverage returns to the list.
    tabPath("delete"),
    (form, context, params) => {
      if (form.confirmationName === undefined || form.confirmationName.trim() === "") {
        invalidForm("Type the exact current beverage name to confirm permanent deletion.");
      }
      const reason = nullable(form.reason);
      dependencies.beverageService.deleteBeverage(
        params.id!,
        {
          confirmationName: form.confirmationName,
          ...(reason === undefined ? {} : { reason }),
        },
        actor(context),
      );
      return "/admin/beverages";
    },
    "Beverage deleted.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/sensory",
    tabPath("sensory"),
    saveSensory,
    "Sensory guidance saved.",
    {},
    beverageAutosave(BEVERAGE_SENSORY_AXES, saveSensory),
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/recipe",
    tabPath("recipe"),
    saveRecipe,
    "Custom recipe saved.",
    { maxFields: 3, maxBytes: 3_000_000 },
    // JSON escaping grows the recipe text, so its live save takes the largest JSON body.
    beverageAutosave(["recipeJson"], saveRecipe, MAX_BATCH_JSON_BODY_BYTES),
  );
  // URL-encoding can triple the file text, so the body allows 3 × 1 MiB plus the CSRF field.
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/recipe-import",
    tabPath("recipe"),
    (form, context, params) => {
      const { format } = dependencies.beverageService.importRecipeFile(
        params.id!,
        form.recipeFile ?? "",
        actor(context),
      );
      return { notice: `Recipe imported (${RECIPE_FILE_FORMAT_NAMES[format]}).` };
    },
    "Recipe imported.",
    { maxFields: 2, maxBytes: 3 * MAX_RECIPE_FILE_BYTES + 1_024 },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/unlink",
    tabPath("info"),
    (_form, context, params) => {
      dependencies.beverageService.unlinkBeverage(params.id!, actor(context));
    },
    "Beverage unlinked from Brewfather and retained as a Custom Beverage.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/brewfather/link",
    "/admin/beverages",
    (form, context) => {
      const linked = dependencies.beverageService.linkBrewfatherCandidate(
        { sourceBatchId: form.sourceBatchId },
        actor(context),
      );
      return `/admin/beverages/${linked.beverage.id}`;
    },
    "Brewfather batch linked.",
  );
}

export function listQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 80);
  const parsedPage = Number(params.get("page") ?? "1");
  return {
    q,
    page:
      Number.isInteger(parsedPage) && Number.isFinite(parsedPage)
        ? Math.min(10_000, Math.max(1, parsedPage))
        : 1,
  };
}

export function beveragePageHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query.length > 0) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? "/admin/beverages" : `/admin/beverages?${encoded}`;
}

export const AUTOSAVE_BEVERAGE_FIELDS = [
  "name",
  "beverageType",
  "style",
  "abv",
  "ibu",
  "og",
  "fg",
  "srm",
  "displayColor",
  "description",
  "fillGlass",
  "manualDensityOverride",
] as const;

/** The Brewfather override form's autosave fields: a mode and a value per field. */
const AUTOSAVE_OVERRIDE_FIELDS = [
  "updatedAt",
  ...AUTOSAVE_BEVERAGE_FIELDS.flatMap((field) => [`${field}Mode`, field]),
];

export function customBeverageAutosaveInput(
  body: Readonly<Record<string, unknown>>,
): UpdateCustomBeverageInput {
  const values = autosaveFieldStrings(body, AUTOSAVE_BEVERAGE_FIELDS);
  return {
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.beverageType === undefined
      ? {}
      : {
          beverageType: values.beverageType as NonNullable<
            UpdateCustomBeverageInput["beverageType"]
          >,
        }),
    ...(values.style === undefined ? {} : { style: nullable(values.style)! }),
    ...(values.abv === undefined ? {} : { abv: optionalNumber(values.abv) ?? null }),
    ...(values.ibu === undefined ? {} : { ibu: optionalNumber(values.ibu) ?? null }),
    ...(values.og === undefined ? {} : { og: optionalNumber(values.og) ?? null }),
    ...(values.fg === undefined ? {} : { fg: optionalNumber(values.fg) ?? null }),
    ...(values.srm === undefined ? {} : { srm: optionalNumber(values.srm) ?? null }),
    ...(values.displayColor === undefined ? {} : { displayColor: nullable(values.displayColor)! }),
    ...(values.description === undefined ? {} : { description: nullable(values.description)! }),
    ...(values.fillGlass === undefined ? {} : { fillGlass: vesselFromForm(values.fillGlass)! }),
    ...(values.manualDensityOverride === undefined
      ? {}
      : { manualDensityOverride: optionalNumber(values.manualDensityOverride) ?? null }),
  };
}

export function safeBeverageCurrent(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  return {
    name: detail.effectivePresentation.name,
    beverageType: detail.effectivePresentation.beverageType,
    style: detail.effectivePresentation.style,
    abv: detail.effectivePresentation.abv,
    ibu: detail.effectivePresentation.ibu,
    og: detail.effectivePresentation.og,
    fg: detail.effectivePresentation.fg,
    srm: detail.effectivePresentation.srm,
    displayColor: detail.effectivePresentation.displayColor,
    description: detail.effectivePresentation.description,
    fillGlass: detail.effectivePresentation.fillGlass,
    manualDensityOverride: detail.effectivePresentation.manualDensityOverride,
    updatedAt: detail.beverage.updatedAt,
  };
}

export function safeCustomBeverageResource(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  return {
    name: detail.effectivePresentation.name,
    beverageType: detail.effectivePresentation.beverageType,
    style: detail.effectivePresentation.style ?? "",
    abv: detail.effectivePresentation.abv ?? "",
    ibu: detail.effectivePresentation.ibu ?? "",
    og: detail.effectivePresentation.og ?? "",
    fg: detail.effectivePresentation.fg ?? "",
    srm: detail.effectivePresentation.srm ?? "",
    displayColor: detail.effectivePresentation.displayColor ?? "",
    description: detail.effectivePresentation.description ?? "",
    fillGlass: detail.effectivePresentation.fillGlass ?? "",
    manualDensityOverride: detail.effectivePresentation.manualDensityOverride ?? "",
  };
}

export function safeBrewfatherResource(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  const overrides = detail.presentationOverrides;
  const effective = detail.effectivePresentation;
  const result: Record<string, unknown> = {};
  for (const field of AUTOSAVE_BEVERAGE_FIELDS) {
    const capitalized = `${field[0]!.toUpperCase()}${field.slice(1)}`;
    const present = Boolean(overrides?.[`override${capitalized}Present` as keyof typeof overrides]);
    const overrideValue = overrides?.[field as keyof typeof overrides];
    const canClear = field !== "name" && field !== "beverageType";
    const value = effective[field];
    result[`${field}Mode`] = !present
      ? "inherit"
      : canClear && overrideValue === null
        ? "clear"
        : "value";
    result[field] = value ?? "";
  }
  return result;
}
