import { createHash } from "node:crypto";

import {
  DISPLAY_FONTS,
  DISPLAY_THEMES,
  isDisplayAccent,
  type DisplayAccent,
  type DisplayFont,
  type DisplayTheme,
} from "./types.ts";

export type DisplayStylesheetFont = DisplayFont | "all";
// Bump whenever the generated CSS changes shape, so browsers never pair a cached
// stylesheet with newer static CSS.
export const DISPLAY_STYLESHEET_VERSION = "3" as const;

type FontWeight = number | `${number} ${number}`;

const NAMED_ACCENTS: Readonly<Record<string, string>> = {
  amber: "#fbc02d",
  sky: "#38bdf8",
  rose: "#fb7185",
  cyan: "#00f0ff",
  tan: "#c5a880",
  orange: "#d97706",
  blue: "#2563eb",
};

type BundledFont = Exclude<DisplayFont, "system">;

/** Everything a theme may set. Accent roles are derived from these per chosen accent. */
export interface DisplayPalette {
  readonly background: string;
  readonly surface: string;
  readonly raised: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly secondary: string;
  /** The accent used while the operator's accent is "theme". */
  readonly accent: string;
  readonly shadow: string;
  readonly colorScheme: "dark" | "light";
  readonly danger: string;
  readonly warning: string;
  readonly success: string;
  /** Corner radii for the sm, md, lg and xl steps. */
  readonly radius: readonly [string, string, string, string];
  /** Multiplier applied to every --space-* step. */
  readonly density: number;
  /** Used for headings while the operator font is left on "system". */
  readonly headingFont?: BundledFont;
  /** The two Tap Wars meter colours; the accent and `secondary` unless the theme sets them. */
  readonly tapWarsSides?: readonly [string, string];
}

const STANDARD_RADIUS = [".5rem", ".75rem", "1rem", "1.5rem"] as const;
const DARK_STATUS = { danger: "#ef4444", warning: "#f59e0b", success: "#22c55e" } as const;
const LIGHT_STATUS = { danger: "#bb303d", warning: "#a15c00", success: "#147d4d" } as const;
/** Lighter status colours for dark themes whose grounds are not near-black. */
const SOFT_STATUS = { danger: "#ff8a80", warning: "#f6c453", success: "#7ddba3" } as const;

type NamedTheme = Exclude<DisplayTheme, "auto">;

const THEMES: Readonly<Record<NamedTheme, DisplayPalette>> = {
  modern_dark: {
    background: "#0b0f19",
    accent: "#fbc02d",
    surface: "#111827",
    raised: "#192231",
    text: "#ffffff",
    muted: "#9ca3af",
    border: "rgba(255,255,255,.2)",
    secondary: "#38bdf8",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.25)",
    colorScheme: "dark",
    ...DARK_STATUS,
    radius: STANDARD_RADIUS,
    density: 1,
  },
  warm_pub: {
    background: "#1c0a00",
    accent: "#fbc02d",
    surface: "#2d1204",
    raised: "#3a1b0a",
    text: "#fdf6e2",
    muted: "#c5a880",
    border: "rgba(212,175,55,.3)",
    secondary: "#c5a880",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.3)",
    colorScheme: "dark",
    ...DARK_STATUS,
    radius: [".625rem", "1rem", "1.25rem", "2rem"],
    density: 1,
    headingFont: "bree_serif",
  },
  cyberpunk: {
    background: "#0d0221",
    accent: "#ff007f",
    surface: "#19053b",
    raised: "#26075a",
    text: "#00f0ff",
    // Lighter than the original #c52cff so it also reads on the raised and accent-tinted grounds.
    muted: "#d25aff",
    border: "#00f0ff",
    secondary: "#00f0ff",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.35)",
    colorScheme: "dark",
    ...DARK_STATUS,
    radius: ["0", "0", "0", "0"],
    density: 1,
  },
  light_minimal: {
    background: "#f8fafc",
    accent: "#d97706",
    surface: "#ffffff",
    raised: "#ffffff",
    text: "#0f172a",
    muted: "#64748b",
    border: "#cbd5e1",
    secondary: "#2563eb",
    shadow: "0 .5rem 1.5rem rgba(15,23,42,.12)",
    colorScheme: "light",
    ...LIGHT_STATUS,
    radius: STANDARD_RADIUS,
    density: 1,
  },
  chalkboard: {
    background: "#1d2724",
    accent: "#f2d58a",
    surface: "#25322e",
    raised: "#2e3d38",
    text: "#f4f1e8",
    muted: "#b9c6be",
    border: "rgba(244,241,232,.28)",
    secondary: "#9fd8cb",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.3)",
    colorScheme: "dark",
    ...SOFT_STATUS,
    radius: [".25rem", ".375rem", ".5rem", ".75rem"],
    density: 1,
    headingFont: "special_elite",
  },
  hop_garden: {
    background: "#0c1c12",
    accent: "#f5b942",
    surface: "#132b1c",
    raised: "#1a3a26",
    text: "#f1f7ec",
    muted: "#a9c4a6",
    border: "rgba(183,227,106,.28)",
    secondary: "#b7e36a",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.3)",
    colorScheme: "dark",
    ...SOFT_STATUS,
    radius: [".75rem", "1rem", "1.5rem", "2rem"],
    density: 1.1,
  },
  copper_kettle: {
    background: "#f6efe2",
    accent: "#b4571f",
    surface: "#fffaf0",
    raised: "#efe3cf",
    text: "#3b2314",
    muted: "#75553e",
    border: "#c9a27e",
    secondary: "#8f4317",
    shadow: "0 .5rem 1.5rem rgba(59,35,20,.14)",
    colorScheme: "light",
    danger: "#a8242f",
    warning: "#8a4d00",
    success: "#0f6b40",
    radius: STANDARD_RADIUS,
    density: 1,
    headingFont: "bree_serif",
  },
  steampunk: {
    background: "#17110c",
    accent: "#c9a24a",
    surface: "#231a12",
    raised: "#30241a",
    text: "#ecdcc0",
    muted: "#b8a283",
    border: "rgba(196,148,74,.45)",
    secondary: "#7cc4b4",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.4)",
    colorScheme: "dark",
    ...SOFT_STATUS,
    radius: [".125rem", ".25rem", ".375rem", ".5rem"],
    density: 1,
    headingFont: "rye",
  },
  monochrome: {
    background: "#0a0a0a",
    accent: "#e5e5e5",
    surface: "#161616",
    raised: "#222222",
    text: "#ffffff",
    muted: "#a3a3a3",
    border: "rgba(255,255,255,.3)",
    secondary: "#d4d4d4",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.5)",
    colorScheme: "dark",
    // Greyscale throughout, so the beer is the only colour on the display.
    danger: "#f5f5f5",
    warning: "#bdbdbd",
    success: "#8f8f8f",
    radius: [".125rem", ".25rem", ".25rem", ".375rem"],
    density: 0.9,
    // The vote split reads as pure white against pure black, whatever the accent.
    tapWarsSides: ["#ffffff", "#000000"],
  },
};

/** "auto" follows the device light or dark setting using two named themes. */
export const AUTO_THEME = { dark: "modern_dark", light: "light_minimal" } as const;

/** Admin follows the device light or dark setting, independent of the public theme. */
const ADMIN_PALETTES: Readonly<Record<"dark" | "light", DisplayPalette>> = {
  dark: {
    background: "#0d1726",
    accent: "#fbc02d",
    surface: "#152235",
    raised: "#1d2d43",
    text: "#f5f7fb",
    muted: "#a9b6c8",
    border: "rgba(217,229,243,.2)",
    secondary: "#8cc9ff",
    shadow: "0 .75rem 2rem rgba(1,8,18,.24)",
    colorScheme: "dark",
    danger: "#f07178",
    warning: "#f6bd4b",
    success: "#65d49a",
    radius: STANDARD_RADIUS,
    density: 1,
  },
  light: {
    background: "#f4f7fb",
    accent: "#fbc02d",
    surface: "#ffffff",
    raised: "#eaf0f7",
    text: "#132033",
    muted: "#53657a",
    border: "rgba(19,32,51,.18)",
    secondary: "#1769aa",
    shadow: "0 .75rem 2rem rgba(36,55,78,.12)",
    colorScheme: "light",
    ...LIGHT_STATUS,
    radius: STANDARD_RADIUS,
    density: 1,
  },
};

/** Every palette the generator can emit, for contrast tests. */
export const DISPLAY_PALETTES: Readonly<Record<string, DisplayPalette>> = {
  ...THEMES,
  admin_dark: ADMIN_PALETTES.dark,
  admin_light: ADMIN_PALETTES.light,
};

export const FONT_FILES: Readonly<
  Record<
    BundledFont,
    {
      readonly family: string;
      readonly file: string;
      readonly weight: FontWeight;
    }
  >
> = {
  outfit: { family: "Outfit", file: "outfit-6c18d579.woff2", weight: "100 900" },
  inter: { family: "Inter", file: "inter-3100e775.woff2", weight: "100 900" },
  roboto: { family: "Roboto", file: "roboto-1404ca34.woff2", weight: "100 900" },
  fredoka: { family: "Fredoka", file: "fredoka-99d6c78e.woff2", weight: "400 700" },
  montserrat: { family: "Montserrat", file: "montserrat-06b16db7.woff2", weight: "100 900" },
  barlow_condensed: {
    family: "Barlow Condensed",
    file: "barlow_condensed-7fff1bb2.woff2",
    weight: 400,
  },
  bree_serif: { family: "Bree Serif", file: "bree_serif-ca092b41.woff2", weight: 400 },
  bungee: { family: "Bungee", file: "bungee-126eec70.woff2", weight: 400 },
  rye: { family: "Rye", file: "rye-00de26ff.woff2", weight: 400 },
  special_elite: {
    family: "Special Elite",
    file: "special_elite-770493d8.woff2",
    weight: 400,
  },
};

function hexRgb(hex: string): readonly [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  return hexRgb(hex)
    .map((value) => value / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
}

export function contrastRatio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function mix(hex: string, other: string, amount: number): string {
  const [r, g, b] = hexRgb(hex);
  const [or, og, ob] = hexRgb(other);
  return `#${[r, g, b]
    .map((value, index) =>
      Math.round(value + ([or, og, ob][index]! - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function meetsContrast(candidate: string, surfaces: readonly string[], minimum: number): boolean {
  return surfaces.every((surface) => contrastRatio(candidate, surface) >= minimum);
}

/** Black or white, whichever reads better on the given fill. */
function onFill(fill: string): string {
  return contrastRatio(fill, "#ffffff") >= contrastRatio(fill, "#000000") ? "#ffffff" : "#000000";
}

function nearestContrastRole(accent: string, surfaces: readonly string[], minimum: number): string {
  if (meetsContrast(accent, surfaces, minimum)) return accent;
  const candidates = (["#000000", "#ffffff"] as const).flatMap((toward) => {
    if (!meetsContrast(toward, surfaces, minimum)) return [];
    let low = 0;
    let high = 1;
    for (let index = 0; index < 32; index += 1) {
      const amount = (low + high) / 2;
      if (meetsContrast(mix(accent, toward, amount), surfaces, minimum)) high = amount;
      else low = amount;
    }
    return [{ amount: high, color: mix(accent, toward, high) }];
  });
  return (
    candidates.sort((first, second) => first.amount - second.amount)[0]?.color ??
    (luminance(surfaces[0] ?? "#ffffff") > 0.5 ? "#000000" : "#ffffff")
  );
}

function shiftedContrastRole(accent: string, surfaces: readonly string[], minimum: number): string {
  const minimumVisibleShift = 0.08;
  const candidates = (["#000000", "#ffffff"] as const).flatMap((toward) => {
    const atMinimum = mix(accent, toward, minimumVisibleShift);
    if (meetsContrast(atMinimum, surfaces, minimum)) {
      return [{ amount: minimumVisibleShift, color: atMinimum }];
    }
    if (!meetsContrast(mix(accent, toward, 1), surfaces, minimum)) return [];
    let low = minimumVisibleShift;
    let high = 1;
    for (let index = 0; index < 32; index += 1) {
      const amount = (low + high) / 2;
      if (meetsContrast(mix(accent, toward, amount), surfaces, minimum)) high = amount;
      else low = amount;
    }
    return [{ amount: high, color: mix(accent, toward, high) }];
  });
  const selected = candidates.sort((first, second) => first.amount - second.amount)[0];
  if (selected !== undefined && selected.color !== accent) return selected.color;
  const fallback = mix(accent, luminance(accent) > 0.5 ? "#000000" : "#ffffff", 0.08);
  return meetsContrast(fallback, surfaces, minimum)
    ? fallback
    : nearestContrastRole(accent, surfaces, minimum);
}

/** A hex colour, or an rgba() border painted over the given opaque ground. */
function opaqueOn(color: string, ground: string): string {
  if (/^#[0-9a-f]{6}$/u.test(color)) return color;
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/u.exec(color);
  if (rgba === null) throw new Error(`Unsupported palette border colour: ${color}`);
  const [, r, g, b, alpha] = rgba;
  const solid = `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`;
  return mix(ground, solid, Number(alpha));
}

export interface DisplayPaletteRoles {
  readonly accent: string;
  readonly accentReadable: string;
  readonly accentStrong: string;
  readonly accentHover: string;
  readonly onAccent: string;
  readonly onAccentHover: string;
  /** The raised surface tinted toward the accent: the Tap Wars banner and accent badges. */
  readonly surfaceAccent: string;
  readonly muted: string;
  /** The border of text fields and selects: the theme's border, strengthened to 3:1. */
  readonly controlBorder: string;
}

export function resolveDisplayPaletteRoles(
  palette: DisplayPalette,
  accent: DisplayAccent,
): DisplayPaletteRoles {
  const accentHex = resolveAccent(accent, palette);
  const surfaceAccent = mix(palette.raised, accentHex, 0.09);
  // Text roles must read on every ground a palette paints, including the accent tint.
  const grounds = [palette.background, palette.surface, palette.raised, surfaceAccent] as const;
  const accentReadable = nearestContrastRole(accentHex, grounds, 4.5);
  const accentStrong = nearestContrastRole(accentHex, grounds, 3);
  const accentHover = shiftedContrastRole(accentHex, grounds, 3);
  const controlGrounds = [palette.background, palette.surface, palette.raised] as const;
  return {
    accent: accentHex,
    accentReadable,
    accentStrong,
    accentHover,
    onAccent: onFill(accentHex),
    onAccentHover: onFill(accentHover),
    surfaceAccent,
    muted: nearestContrastRole(palette.muted, grounds, 4.5),
    controlBorder: nearestContrastRole(
      opaqueOn(palette.border, palette.surface),
      controlGrounds,
      3,
    ),
  };
}

export function resolveAccent(accent: DisplayAccent, palette: DisplayPalette): string {
  return accent === "theme" ? palette.accent : (NAMED_ACCENTS[accent] ?? accent);
}

function fontFace(font: BundledFont): string {
  const source = FONT_FILES[font];
  return `@font-face{font-family:"${source.family}";font-style:normal;font-weight:${source.weight};font-display:swap;src:url("/assets/fonts/${source.file}") format("woff2");}`;
}

function fontFamily(font: DisplayFont): string {
  if (font === "system") return 'system-ui,-apple-system,"Segoe UI",sans-serif';
  return `"${FONT_FILES[font].family}",system-ui,sans-serif`;
}

export function validateStylesheetParams(
  theme: unknown,
  accent: unknown,
  font: unknown,
):
  | {
      readonly theme: DisplayTheme;
      readonly accent: DisplayAccent;
      readonly font: DisplayStylesheetFont;
    }
  | undefined {
  if (!DISPLAY_THEMES.includes(theme as DisplayTheme) || !isDisplayAccent(accent)) return undefined;
  if (font !== "all" && !DISPLAY_FONTS.includes(font as DisplayFont)) return undefined;
  return {
    theme: theme as DisplayTheme,
    accent,
    font: font as DisplayStylesheetFont,
  };
}

export interface GeneratedDisplayStylesheet {
  readonly css: string;
  readonly etag: string;
}

function accentDeclarations(roles: DisplayPaletteRoles): string {
  return `--accent:${roles.accent};--accent-readable:${roles.accentReadable};--accent-strong:${roles.accentStrong};--accent-hover:${roles.accentHover};--on-accent:${roles.onAccent};--on-accent-hover:${roles.onAccentHover}`;
}

/** Every custom property one palette sets, in a fixed order. */
function paletteDeclarations(
  palette: DisplayPalette,
  roles: DisplayPaletteRoles,
  family: string,
  headingFamily: string,
): string {
  const [radiusSm, radiusMd, radiusLg, radiusXl] = palette.radius;
  return `--background:${palette.background};--surface:${palette.surface};--surface-raised:${palette.raised};--surface-accent:${roles.surfaceAccent};--text:${palette.text};--muted:${roles.muted};--border:${palette.border};--control-border:${roles.controlBorder};${accentDeclarations(roles)};--secondary:${palette.secondary};--tap-wars-side-1:${palette.tapWarsSides?.[0] ?? roles.accent};--tap-wars-side-2:${palette.tapWarsSides?.[1] ?? palette.secondary};--shadow:${palette.shadow};--font-family:${family};--font-heading:${headingFamily};color-scheme:${palette.colorScheme};--danger:${palette.danger};--on-danger:${onFill(palette.danger)};--warning:${palette.warning};--success:${palette.success};--radius-sm:${radiusSm};--radius-md:${radiusMd};--radius-lg:${radiusLg};--radius-xl:${radiusXl};--density:${palette.density}`;
}

export function generateDisplayStylesheet(
  theme: DisplayTheme,
  accent: DisplayAccent,
  font: DisplayStylesheetFont,
): GeneratedDisplayStylesheet {
  // "auto" emits its dark theme first and its light theme under a media query.
  const palettes: readonly DisplayPalette[] =
    theme === "auto" ? [THEMES[AUTO_THEME.dark], THEMES[AUTO_THEME.light]] : [THEMES[theme]];
  // A theme heading font applies only while the operator font is "system".
  const headingFontOf = (palette: DisplayPalette): BundledFont | undefined =>
    font === "system" || font === "all" ? palette.headingFont : undefined;
  const headingFonts = [
    ...new Set(palettes.map(headingFontOf).filter((heading) => heading !== undefined)),
  ];
  const faces =
    font === "all"
      ? (Object.keys(FONT_FILES) as BundledFont[]).map(fontFace).join("")
      : `${font === "system" ? "" : fontFace(font)}${headingFonts.map(fontFace).join("")}`;
  const selectedFamily = font === "all" ? fontFamily("system") : fontFamily(font);
  const previewFonts =
    font === "all"
      ? Object.entries(FONT_FILES)
          .map(
            ([name, value]) =>
              `.display-preview[data-preview-font="${name}"]{--preview-font:"${value.family}",system-ui,sans-serif;--font-heading:var(--preview-font)}`,
          )
          .join("")
      : "";
  const block = (selector: ":root" | ".display-preview", palette: DisplayPalette): string => {
    const roles = resolveDisplayPaletteRoles(palette, accent);
    const headingFont = headingFontOf(palette);
    const declarations = paletteDeclarations(
      palette,
      roles,
      selectedFamily,
      headingFont === undefined ? "var(--font-family)" : fontFamily(headingFont),
    );
    return selector === ":root"
      ? `:root{${declarations}}`
      : `.display-preview{${declarations};--preview-accent:${roles.accent};--preview-accent-readable:${roles.accentReadable};--preview-accent-strong:${roles.accentStrong};--preview-accent-hover:${roles.accentHover};--preview-on-accent:${roles.onAccent};--preview-on-accent-hover:${roles.onAccentHover};--preview-font:${selectedFamily}}`;
  };
  const themed = (selector: ":root" | ".display-preview"): string =>
    palettes
      .map((palette, index) =>
        index === 0
          ? block(selector, palette)
          : `@media (prefers-color-scheme:light){${block(selector, palette)}}`,
      )
      .join("");
  // Admin keeps its own grounds but shares the display's accent colour.
  const adminAccent = resolveAccent(accent, palettes[0]!) as DisplayAccent;
  const adminBlock = (scheme: "dark" | "light"): string =>
    `.admin-shell{${paletteDeclarations(
      ADMIN_PALETTES[scheme],
      resolveDisplayPaletteRoles(ADMIN_PALETTES[scheme], adminAccent),
      fontFamily("system"),
      "var(--font-family)",
    )}}`;
  const css = `${faces}${themed(":root")}${adminBlock("dark")}@media (prefers-color-scheme:light){${adminBlock("light")}}${themed(".display-preview")}${previewFonts}`;
  return { css, etag: `"${createHash("sha256").update(css).digest("hex")}"` };
}

export function displayStylesheetHref(
  theme: DisplayTheme,
  accent: DisplayAccent,
  font: DisplayStylesheetFont,
): string {
  return `/assets/css/display.css?v=${DISPLAY_STYLESHEET_VERSION}&theme=${encodeURIComponent(theme)}&accent=${encodeURIComponent(accent)}&font=${encodeURIComponent(font)}`;
}
