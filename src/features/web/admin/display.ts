import { displayStylesheetHref } from "../../display/palette.ts";
import { invalidForm } from "./forms.ts";
import {
  displayAccentLabel,
  displayAccentOptions,
  displayFontLabel,
  displayFontOptions,
  displayThemeLabel,
  displayThemeOptions,
} from "./display-options.ts";
import type { PublicTapCardMetricSettings } from "../../story/service.ts";
import { safeDisplayResource, safeTapCardResource } from "../presenters/display.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
} from "./http.ts";
import { adminTabs, renderAdmin } from "./layout.ts";
import { previewSampleCard } from "./tap-presentation.ts";
import { actor, type AdminContext } from "./context.ts";
import type {
  RegisterDisplayPagesDependencies,
  RegisterDisplayMutationsDependencies,
} from "../contracts.ts";

export function registerDisplayPages(dependencies: RegisterDisplayPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/display", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display",
      "Display",
      "/admin/display",
      {
        tabs: adminTabs("display", "/admin/display"),
        sharedDisplay,
        defaultThemeSummary: {
          theme: displayThemeLabel(sharedDisplay.theme),
          accent: displayAccentLabel(sharedDisplay.accent),
          font: displayFontLabel(sharedDisplay.font),
        },
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display/shared", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    const tapCardSettings =
      typeof dependencies.displayService.getTapCardSettings === "function"
        ? dependencies.displayService.getTapCardSettings()
        : undefined;
    const previewSettings: PublicTapCardMetricSettings = tapCardSettings ?? {
      showAbv: true,
      showIbu: true,
      showOg: true,
      showFg: true,
      showSrm: false,
    };
    const previewTap = previewSampleCard(previewSettings);
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display-shared",
      "Default theme",
      "/admin/display/shared",
      {
        tabs: adminTabs("display", "/admin/display/shared"),
        sharedDisplay,
        themeOptions: displayThemeOptions(),
        fontOptions: displayFontOptions(),
        accentOptions: displayAccentOptions(),
        tapCardSettings,
        previewTap,
        displayStylesheetHref: displayStylesheetHref(
          sharedDisplay.theme,
          sharedDisplay.accent,
          "all",
        ),
        includeDashboardStyles: true,
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display/this-display", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display-this-display",
      "This display",
      "/admin/display/this-display",
      {
        tabs: adminTabs("display", "/admin/display/this-display"),
        themeOptions: displayThemeOptions(),
        fontOptions: displayFontOptions(),
        accentOptions: displayAccentOptions(),
        // "all" loads every font face so the font cards render in their own fonts.
        displayStylesheetHref: displayStylesheetHref(
          sharedDisplay.theme,
          sharedDisplay.accent,
          "all",
        ),
      },
    );
  });
}

export function registerDisplayMutations(dependencies: RegisterDisplayMutationsDependencies): void {
  const sharedFields = [
    "expectedRevision",
    "tapboardName",
    "theme",
    "font",
    "accent",
    "accentCustom",
    "layoutMode",
  ];
  /** The Default theme form's save, shared by the form post and the live save. */
  const saveShared = (form: Readonly<Record<string, string>>, context: AdminContext) => {
    if (!form.tapboardName?.trim()) invalidForm("Enter a Tapboard name.", "tapboardName");
    // The Custom choice posts accent=custom plus the colour picker's #rrggbb.
    const accent = form.accent === "custom" ? form.accentCustom?.toLowerCase() : form.accent;
    if (form.accent === "custom" && !/^#[0-9a-f]{6}$/u.test(accent ?? ""))
      invalidForm("Choose a custom color as #rrggbb.", "accentCustom");
    // Units and serving temperature live on the System page; keep their current values.
    // expectedRevision still rejects the save if either changed meanwhile.
    const current = dependencies.displayService.getSettings();
    return dependencies.displayService.updateSettings(
      {
        expectedRevision: Number(form.expectedRevision),
        tapboardName: form.tapboardName,
        theme: form.theme,
        font: form.font,
        accent,
        unitSystem: current.unitSystem,
        showServingTemperature: current.showServingTemperature,
        layoutMode: form.layoutMode,
      },
      actor(context),
    );
  };
  registerAdminAction(
    dependencies,
    "/admin/display/shared",
    "/admin/display/shared",
    (form, context) => {
      saveShared(form, context);
    },
    "Default theme saved.",
    {},
    {
      // The display service checks the revision, so a stale one (a Units save on System
      // counts) answers 409.
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, sharedFields);
        requiredAutosaveField(fields, "expectedRevision");
        const updated = saveShared(fields, context);
        return { resource: safeDisplayResource(updated), revision: updated.revision };
      },
      current: () => {
        const current = dependencies.displayService.getSettings();
        return { current: safeDisplayResource(current), revision: current.revision };
      },
      validationFields: validationFieldsFor(sharedFields),
    },
  );
  // Units and serving temperature are edited on the System page but stored with the
  // display settings; every other field keeps its current value.
  const unitsFields = ["expectedDisplayRevision", "unitSystem", "showServingTemperature"];
  const saveUnits = (form: Readonly<Record<string, string>>, context: AdminContext) => {
    const current = dependencies.displayService.getSettings();
    return dependencies.displayService.updateSettings(
      {
        // Named apart from the System page's other expectedRevision fields.
        expectedRevision: Number(form.expectedDisplayRevision),
        tapboardName: current.tapboardName,
        theme: current.theme,
        font: current.font,
        accent: current.accent,
        unitSystem: form.unitSystem,
        showServingTemperature: form.showServingTemperature === "true",
        layoutMode: current.layoutMode,
      },
      actor(context),
    );
  };
  const unitsView = (settings: ReturnType<typeof dependencies.displayService.getSettings>) => ({
    unitSystem: settings.unitSystem,
    showServingTemperature: settings.showServingTemperature,
  });
  registerAdminAction(
    dependencies,
    "/admin/system/units",
    "/admin/system",
    (form, context) => {
      saveUnits(form, context);
    },
    "Units saved.",
    {},
    {
      // The display service checks the revision, so a stale one answers 409.
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, unitsFields);
        requiredAutosaveField(fields, "expectedDisplayRevision");
        const updated = saveUnits(fields, context);
        return { resource: unitsView(updated), revision: updated.revision };
      },
      current: () => {
        const current = dependencies.displayService.getSettings();
        return { current: unitsView(current), revision: current.revision };
      },
      validationFields: validationFieldsFor(unitsFields),
    },
  );
  const tapCardFields = [
    "expectedRevision",
    "showAbv",
    "showIbu",
    "showOg",
    "showFg",
    "showSrm",
    "remainingMode",
  ];
  /** The Tap-card metrics form's save; an unchecked switch posts nothing (or "false"). */
  const saveTapCard = (form: Readonly<Record<string, string>>, context: AdminContext) =>
    dependencies.displayService.updateTapCardSettings(
      {
        expectedRevision: Number(form.expectedRevision),
        showAbv: form.showAbv === "true",
        showIbu: form.showIbu === "true",
        showOg: form.showOg === "true",
        showFg: form.showFg === "true",
        showSrm: form.showSrm === "true",
        remainingMode: form.remainingMode,
      },
      actor(context),
    );
  registerAdminAction(
    dependencies,
    "/admin/display/tap-card",
    "/admin/display/shared",
    (form, context) => {
      saveTapCard(form, context);
    },
    "Shared Tap-card settings saved.",
    {},
    {
      // The display service checks this form's own revision, so a stale one answers 409.
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, tapCardFields);
        requiredAutosaveField(fields, "expectedRevision");
        const updated = saveTapCard(fields, context);
        return { resource: safeTapCardResource(updated), revision: updated.revision };
      },
      current: () => {
        const current = dependencies.displayService.getTapCardSettings();
        return { current: safeTapCardResource(current), revision: current.revision };
      },
      validationFields: validationFieldsFor(tapCardFields),
    },
  );
}
