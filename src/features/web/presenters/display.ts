import type {
  DisplaySettings,
  TapCardDisplaySettings,
  EffectiveTapCardDisplaySettings,
} from "../../display/types.ts";

type OverrideChoice = "inherit" | "show" | "hide";
type TapOverrideResource = Readonly<
  Record<"showAbv" | "showIbu" | "showOg" | "showFg" | "showSrm", OverrideChoice>
>;
function overrideChoice(value: boolean | null | undefined): OverrideChoice {
  return value === null || value === undefined ? "inherit" : value ? "show" : "hide";
}
/**
 * The Default theme form's fields: a custom accent is the Custom choice plus its colour.
 * Units and serving temperature are System's form, so they stay out.
 */
export function safeDisplayResource(settings: DisplaySettings): {
  readonly tapboardName: string;
  readonly theme: DisplaySettings["theme"];
  readonly font: DisplaySettings["font"];
  readonly accent: string;
  readonly accentCustom?: string;
  readonly layoutMode: DisplaySettings["layoutMode"];
} {
  const custom = settings.accent.startsWith("#");
  return {
    tapboardName: settings.tapboardName,
    theme: settings.theme,
    font: settings.font,
    ...(custom ? { accent: "custom", accentCustom: settings.accent } : { accent: settings.accent }),
    layoutMode: settings.layoutMode,
  };
}

export function safeTapCardResource(
  settings: TapCardDisplaySettings,
): Omit<TapCardDisplaySettings, "revision" | "updatedAt"> {
  return {
    showAbv: settings.showAbv,
    showIbu: settings.showIbu,
    showOg: settings.showOg,
    showFg: settings.showFg,
    showSrm: settings.showSrm,
    remainingMode: settings.remainingMode,
  };
}

export function safeTapOverrideResource(
  settings: EffectiveTapCardDisplaySettings,
): TapOverrideResource {
  return {
    showAbv: overrideChoice(settings.override?.showAbv),
    showIbu: overrideChoice(settings.override?.showIbu),
    showOg: overrideChoice(settings.override?.showOg),
    showFg: overrideChoice(settings.override?.showFg),
    showSrm: overrideChoice(settings.override?.showSrm),
  };
}
