import {
  AUTO_THEME,
  DISPLAY_PALETTES,
  FONT_FILES,
  type DisplayPalette,
} from "../../display/palette.ts";
import {
  DISPLAY_ACCENTS,
  DISPLAY_FONTS,
  DISPLAY_THEMES,
  type DisplayAccent,
  type DisplayFont,
  type DisplayTheme,
} from "../../display/types.ts";

/** The colours one mini tap card in a theme card is drawn with (SVG fill attributes). */
export interface ThemeCardScene {
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly secondary: string;
}

export interface ThemeCardOption {
  readonly value: DisplayTheme;
  readonly label: string;
  /** Font class for the theme name: the theme's heading font, or system. */
  readonly font: DisplayFont;
  /** One scene, or a dark and a light scene for Auto. */
  readonly scenes: readonly ThemeCardScene[];
}

export interface DisplayChoice<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

const THEME_LABELS: Readonly<Record<DisplayTheme, string>> = {
  modern_dark: "Modern Dark",
  warm_pub: "Warm Pub",
  cyberpunk: "Cyberpunk",
  light_minimal: "Light Minimal",
  auto: "Auto (light or dark)",
  chalkboard: "Chalkboard",
  hop_garden: "Hop Garden",
  copper_kettle: "Copper Kettle",
  steampunk: "Steampunk",
  monochrome: "Monochrome",
};

const ACCENT_LABELS: Readonly<Record<(typeof DISPLAY_ACCENTS)[number], string>> = {
  theme: "Theme",
  amber: "Amber",
  sky: "Sky",
  rose: "Rose",
  cyan: "Cyan",
  tan: "Tan",
  orange: "Orange",
  blue: "Blue",
};

function scene(palette: DisplayPalette): ThemeCardScene {
  return {
    background: palette.background,
    surface: palette.surface,
    border: palette.border,
    text: palette.text,
    muted: palette.muted,
    accent: palette.accent,
    secondary: palette.secondary,
  };
}

function palette(theme: Exclude<DisplayTheme, "auto">): DisplayPalette {
  return DISPLAY_PALETTES[theme]!;
}

export function displayThemeOptions(): readonly ThemeCardOption[] {
  return DISPLAY_THEMES.map((value) => {
    const palettes =
      value === "auto" ? [palette(AUTO_THEME.dark), palette(AUTO_THEME.light)] : [palette(value)];
    return {
      value,
      label: THEME_LABELS[value],
      font: palettes[0]!.headingFont ?? "system",
      scenes: palettes.map(scene),
    };
  });
}

export function displayFontOptions(): readonly DisplayChoice<DisplayFont>[] {
  return DISPLAY_FONTS.map((value) => ({ value, label: displayFontLabel(value) }));
}

export function displayAccentOptions(): readonly DisplayChoice<(typeof DISPLAY_ACCENTS)[number]>[] {
  return DISPLAY_ACCENTS.map((value) => ({ value, label: ACCENT_LABELS[value] }));
}

export function displayThemeLabel(value: DisplayTheme): string {
  return THEME_LABELS[value];
}

export function displayFontLabel(value: DisplayFont): string {
  return value === "system" ? "System" : FONT_FILES[value].family;
}

/** A named accent's label, or the custom hex itself. */
export function displayAccentLabel(value: DisplayAccent): string {
  return (ACCENT_LABELS as Readonly<Record<string, string>>)[value] ?? value;
}
