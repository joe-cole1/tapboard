import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  contrastRatio,
  DISPLAY_PALETTES,
  FONT_FILES,
  displayStylesheetHref,
  generateDisplayStylesheet,
  resolveDisplayPaletteRoles,
  validateStylesheetParams,
} from "../src/features/display/palette.ts";
import {
  DISPLAY_ACCENTS,
  DISPLAY_THEMES,
  type DisplayFont,
} from "../src/features/display/types.ts";

void test("display stylesheet params accept only bounded themes, accents, and preview fonts", () => {
  assert.deepEqual(validateStylesheetParams("light_minimal", "#abcdef", "all"), {
    theme: "light_minimal",
    accent: "#abcdef",
    font: "all",
  });
  assert.equal(validateStylesheetParams("light_minimal", "#ABCDEF", "system"), undefined);
  assert.equal(validateStylesheetParams("unknown", "amber", "system"), undefined);
  assert.equal(validateStylesheetParams("light_minimal", "amber", "comic-sans"), undefined);
  assert.equal(
    displayStylesheetHref("light_minimal", "#abcdef", "system"),
    "/assets/css/display.css?v=4&theme=light_minimal&accent=%23abcdef&font=system",
  );
});

void test("display stylesheet output is deterministic, same-origin, and font-selective", () => {
  const selected = generateDisplayStylesheet("modern_dark", "#777777", "outfit");
  const selectedAgain = generateDisplayStylesheet("modern_dark", "#777777", "outfit");
  assert.equal(selected.css, selectedAgain.css);
  assert.equal(selected.etag, selectedAgain.etag);
  assert.match(selected.css, /@font-face/u);
  assert.match(selected.css, /assets\/fonts\/outfit-[0-9a-f]+\.woff2/u);
  for (const font of Object.keys(FONT_FILES).filter((font) => font !== "outfit")) {
    assert.doesNotMatch(selected.css, new RegExp(`assets/fonts/${font}-`, "u"));
  }
  assert.doesNotMatch(selected.css, /https?:/u);
  assert.match(selected.css, /--on-accent:/u);
  assert.match(selected.css, /--accent-readable:#[0-9a-f]{6}/u);
  assert.doesNotMatch(selected.css, /color-mix\(/u);
  assert.ok(contrastRatio("#777777", "#ffffff") >= 3 || contrastRatio("#777777", "#000000") >= 3);

  const all = generateDisplayStylesheet("light_minimal", "amber", "all");
  const rootPalette = all.css.match(/:root\{([^}]+)\}/u)?.[1];
  const previewPalette = all.css.match(/\.display-preview\{([^}]+)\}/u)?.[1];
  assert.ok(rootPalette);
  assert.ok(previewPalette);
  assert.ok(previewPalette.startsWith(`${rootPalette};`));
  assert.match(previewPalette, /--surface:#ffffff;/u);
  assert.match(previewPalette, /--text:#0f172a;/u);
  for (const font of Object.keys(FONT_FILES)) {
    assert.match(all.css, new RegExp(`assets/fonts/${font}-[0-9a-f]+\\.woff2`, "u"));
    assert.ok(all.css.includes(`data-preview-font="${font}"`));
  }

  for (const font of Object.keys(FONT_FILES) as Array<Exclude<DisplayFont, "system">>) {
    const css = generateDisplayStylesheet("modern_dark", "amber", font).css;
    assert.match(css, new RegExp(`assets/fonts/${font}-[0-9a-f]+\\.woff2`, "u"));
    for (const other of Object.keys(FONT_FILES).filter((candidate) => candidate !== font)) {
      assert.doesNotMatch(css, new RegExp(`assets/fonts/${other}-`, "u"));
    }
  }

  assert.match(
    generateDisplayStylesheet("modern_dark", "amber", "bungee").css,
    /font-weight:400;/u,
  );
});

void test("tokens.css holds only the default fallback, matching the generated default palette", () => {
  const tokens = readFileSync(new URL("../public/css/tokens.css", import.meta.url), "utf8");
  assert.doesNotMatch(tokens, /\[data-(?:theme|accent|font)[=\]]/u);

  const declarations = (block: string | undefined): Map<string, string> => {
    assert.ok(block);
    return new Map(
      block
        .split(";")
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration !== "")
        .map((declaration) => {
          const separator = declaration.indexOf(":");
          return [
            declaration.slice(0, separator).trim(),
            // Formatting only: spacing around commas and leading zeros differ.
            declaration
              .slice(separator + 1)
              .trim()
              .replace(/\s*,\s*/gu, ",")
              .replace(/\s+/gu, " ")
              .replace(/(^|[^0-9.])0\./gu, "$1."),
          ];
        }),
    );
  };
  const fallback = declarations(tokens.match(/:root\s*\{([^}]+)\}/u)?.[1]);
  const generated = declarations(
    generateDisplayStylesheet("modern_dark", "amber", "system").css.match(/:root\{([^}]+)\}/u)?.[1],
  );
  assert.ok(generated.size > 0);
  for (const [name, value] of generated) {
    assert.equal(fallback.get(name), value, `tokens.css fallback ${name}`);
  }
});

void test("all theme accent combinations receive concrete accessible palette roles", () => {
  // DISPLAY_ACCENTS includes "theme", so every palette's own accent is checked too.
  const accents = [...DISPLAY_ACCENTS, "#000000", "#ffffff", "#808080", "#fbc02d"] as const;
  // Public themes and both Admin palettes: Admin accent text is derived for Admin's own grounds.
  for (const [theme, palette] of Object.entries(DISPLAY_PALETTES)) {
    for (const accent of accents) {
      const roles = resolveDisplayPaletteRoles(palette, accent);
      assert.ok(contrastRatio(roles.onAccent, roles.accent) >= 4.5, `${theme}/${accent} on-accent`);
      assert.ok(
        contrastRatio(roles.onAccentHover, roles.accentHover) >= 4.5,
        `${theme}/${accent} hover text`,
      );
      assert.notEqual(roles.accentHover, roles.accent, `${theme}/${accent} hover shift`);
      for (const surface of [palette.background, palette.surface]) {
        assert.ok(
          contrastRatio(roles.accentReadable, surface) >= 4.5,
          `${theme}/${accent} readable`,
        );
        assert.ok(contrastRatio(roles.accentStrong, surface) >= 3, `${theme}/${accent} strong`);
        assert.ok(contrastRatio(roles.accentHover, surface) >= 3, `${theme}/${accent} hover`);
      }
    }
  }
  for (const theme of DISPLAY_THEMES) {
    for (const accent of accents) {
      const css = generateDisplayStylesheet(theme, accent, "system").css;
      assert.doesNotMatch(css, /color-mix\(/u);
      assert.match(css, /--accent-hover:#[0-9a-f]{6}/u);
    }
  }
});

void test("status colours are readable as text on every palette's grounds", () => {
  for (const [theme, palette] of Object.entries(DISPLAY_PALETTES)) {
    for (const status of [palette.danger, palette.warning, palette.success]) {
      for (const surface of [palette.background, palette.surface]) {
        assert.ok(contrastRatio(status, surface) >= 4.5, `${theme} ${status} against ${surface}`);
      }
    }
  }
  const light = generateDisplayStylesheet("light_minimal", "amber", "system").css;
  assert.match(light, /:root\{[^}]*--danger:#bb303d;--on-danger:#ffffff;/u);
  assert.match(
    generateDisplayStylesheet("modern_dark", "amber", "system").css,
    /:root\{[^}]*--danger:#ef4444;--on-danger:#000000;/u,
  );
});

void test("a theme sets radius, density and a heading font the operator's font overrides", () => {
  const root = (css: string): string => css.match(/:root\{([^}]+)\}/u)?.[1] ?? "";
  const warm = generateDisplayStylesheet("warm_pub", "amber", "system").css;
  assert.match(root(warm), /--radius-md:1rem;/u);
  assert.match(root(warm), /--density:1(?:;|$)/u);
  assert.match(root(warm), /--font-heading:"Bree Serif",system-ui,sans-serif;/u);
  assert.match(warm, /assets\/fonts\/bree_serif-[0-9a-f]+\.woff2/u);
  assert.match(
    root(generateDisplayStylesheet("cyberpunk", "amber", "system").css),
    /--radius-xl:0;/u,
  );

  const overridden = generateDisplayStylesheet("warm_pub", "amber", "inter").css;
  assert.match(root(overridden), /--font-heading:var\(--font-family\);/u);
  assert.doesNotMatch(overridden, /assets\/fonts\/bree_serif-/u);

  // In the Admin preview a previewed font also drives the headings.
  assert.ok(
    generateDisplayStylesheet("warm_pub", "amber", "all").css.includes(
      '.display-preview[data-preview-font="bungee"]{--preview-font:"Bungee",system-ui,sans-serif;--font-heading:var(--preview-font)}',
    ),
  );
});

void test("the theme accent uses each theme's own colour and Monochrome stays greyscale", () => {
  const root = (css: string): string => css.match(/:root\{([^}]+)\}/u)?.[1] ?? "";
  assert.match(
    root(generateDisplayStylesheet("cyberpunk", "theme", "system").css),
    /--accent:#ff007f;/u,
  );
  assert.match(
    root(generateDisplayStylesheet("modern_dark", "theme", "system").css),
    /--accent:#fbc02d;/u,
  );
  // An explicit operator accent still wins over the theme's.
  assert.match(
    root(generateDisplayStylesheet("cyberpunk", "sky", "system").css),
    /--accent:#38bdf8;/u,
  );
  // Admin shares the display's accent colour.
  assert.match(
    generateDisplayStylesheet("cyberpunk", "theme", "system").css,
    /\.admin-shell\{[^}]*--accent:#ff007f;/u,
  );

  const monochrome = root(generateDisplayStylesheet("monochrome", "theme", "system").css);
  const colours = monochrome.match(/#[0-9a-f]{6}\b/gu) ?? [];
  assert.ok(colours.length > 10);
  for (const colour of colours) {
    assert.ok(
      colour.slice(1, 3) === colour.slice(3, 5) && colour.slice(3, 5) === colour.slice(5, 7),
      `monochrome uses a non-grey colour: ${colour}`,
    );
  }
});

void test("Tap Wars sides are pure white and black on Monochrome, and accent and secondary elsewhere", () => {
  for (const accent of ["theme", "amber"] as const) {
    for (const [scope, block] of paletteBlocks(
      generateDisplayStylesheet("monochrome", accent, "system").css,
    ).filter(([scope]) => scope.startsWith(":root"))) {
      assert.equal(block.get("--tap-wars-side-1"), "#ffffff", `${accent} ${scope}`);
      assert.equal(block.get("--tap-wars-side-2"), "#000000", `${accent} ${scope}`);
    }
  }
  const root = paletteBlocks(generateDisplayStylesheet("hop_garden", "sky", "system").css)[0]![1];
  assert.equal(root.get("--tap-wars-side-1"), root.get("--accent"));
  assert.equal(root.get("--tap-wars-side-2"), root.get("--secondary"));
  // Admin keeps its own palette: the Monochrome override does not leak into it.
  const admin = paletteBlocks(generateDisplayStylesheet("monochrome", "theme", "system").css).find(
    ([scope]) => scope.startsWith(".admin-shell"),
  )![1];
  assert.equal(admin.get("--tap-wars-side-1"), admin.get("--accent"));
  assert.equal(admin.get("--tap-wars-side-2"), admin.get("--secondary"));
});

void test("the auto theme is Modern Dark by default and Light Minimal under a light device setting", () => {
  const root = (css: string): string => css.match(/:root\{([^}]+)\}/u)?.[1] ?? "";
  const auto = generateDisplayStylesheet("auto", "amber", "system").css;
  assert.equal(root(auto), root(generateDisplayStylesheet("modern_dark", "amber", "system").css));
  const light = root(generateDisplayStylesheet("light_minimal", "amber", "system").css);
  assert.ok(auto.includes(`@media (prefers-color-scheme:light){:root{${light}}}`));
  assert.ok(auto.includes(`@media (prefers-color-scheme:light){.display-preview{${light};`));
  assert.deepEqual(validateStylesheetParams("auto", "amber", "system"), {
    theme: "auto",
    accent: "amber",
    font: "system",
  });
});

void test("Admin gets its own generated light and dark palettes, independent of the public theme", () => {
  const css = generateDisplayStylesheet("cyberpunk", "amber", "bungee").css;
  const dark = css.match(/\.admin-shell\{([^}]+)\}/u)?.[1] ?? "";
  const light =
    css.match(/@media \(prefers-color-scheme:light\)\{\.admin-shell\{([^}]+)\}\}/u)?.[1] ?? "";
  assert.match(dark, /--background:#0d1726;/u);
  assert.match(dark, /color-scheme:dark;/u);
  assert.match(light, /--background:#f4f7fb;/u);
  assert.match(light, /color-scheme:light;/u);
  for (const block of [dark, light]) {
    assert.match(block, /--font-family:system-ui,-apple-system,"Segoe UI",sans-serif;/u);
    assert.match(block, /--radius-md:\.75rem;/u);
  }
  // Regression: amber derived for a dark public theme used to land on Admin's white surface.
  const readable = light.match(/--accent-readable:(#[0-9a-f]{6})/u)?.[1];
  assert.ok(readable);
  assert.ok(contrastRatio(readable, "#ffffff") >= 4.5);
});

void test("theme body, muted, and secondary roles are readable on both surfaces", () => {
  // The original four keep fixed expectations; later themes are read from their palettes.
  const fixedSurfaces: Record<string, readonly [string, string]> = {
    modern_dark: ["#0b0f19", "#111827"],
    warm_pub: ["#1c0a00", "#2d1204"],
    cyberpunk: ["#0d0221", "#19053b"],
    light_minimal: ["#f8fafc", "#ffffff"],
    // The first :root block of the auto theme is its dark half.
    auto: ["#0b0f19", "#111827"],
  };
  const surfacesOf = (theme: string): readonly [string, string] => {
    const palette = DISPLAY_PALETTES[theme];
    assert.ok(fixedSurfaces[theme] ?? palette, `no surfaces for ${theme}`);
    return fixedSurfaces[theme] ?? [palette!.background, palette!.surface];
  };
  const variable = (css: string, name: string): string => {
    const match = css.match(new RegExp(`${name}:([^;}]*)`, "u"));
    assert.ok(match?.[1], `missing ${name}`);
    return match[1].trim();
  };
  for (const theme of DISPLAY_THEMES) {
    const css = generateDisplayStylesheet(theme, "amber", "system").css;
    for (const name of ["--text", "--muted", "--secondary"]) {
      const color = variable(css, name);
      for (const surface of surfacesOf(theme)) {
        assert.ok(contrastRatio(color, surface) >= 4.5, `${theme}/${name} against ${surface}`);
      }
    }
  }
  assert.match(generateDisplayStylesheet("cyberpunk", "amber", "system").css, /--muted:#d25aff/u);
});

/** Every palette block one stylesheet emits: the public :root block(s) and both Admin schemes. */
function paletteBlocks(css: string): ReadonlyArray<readonly [string, Map<string, string>]> {
  const blocks = [...css.matchAll(/(:root|\.admin-shell)\{([^}]+)\}/gu)];
  assert.ok(blocks.length >= 3, "expected public and both Admin palette blocks");
  return blocks.map(([, selector, body], index) => [
    `${selector}#${index}`,
    new Map(
      body!.split(";").map((declaration) => {
        const separator = declaration.indexOf(":");
        return [declaration.slice(0, separator), declaration.slice(separator + 1)] as const;
      }),
    ),
  ]);
}

function role(block: Map<string, string>, name: string): string {
  const value = block.get(name);
  assert.match(value ?? "", /^#[0-9a-f]{6}$/u, `${name} is a concrete colour`);
  return value!;
}

const EVERY_ACCENT = [...DISPLAY_ACCENTS, "#000000", "#ffffff", "#808080", "#2563eb"] as const;

void test("text roles are readable on every ground, including surface-raised and the Tap Wars banner tint", () => {
  for (const theme of DISPLAY_THEMES) {
    for (const accent of EVERY_ACCENT) {
      for (const [scope, block] of paletteBlocks(
        generateDisplayStylesheet(theme, accent, "system").css,
      )) {
        const grounds = ["--background", "--surface", "--surface-raised", "--surface-accent"];
        for (const text of ["--text", "--muted", "--accent-readable"]) {
          for (const ground of grounds) {
            const ratio = contrastRatio(role(block, text), role(block, ground));
            assert.ok(
              ratio >= 4.5,
              `${theme}/${accent} ${scope} ${text} on ${ground}: ${ratio.toFixed(2)}`,
            );
          }
        }
        // The banner ground is the raised surface tinted toward the accent, not a new colour.
        const raised = role(block, "--surface-raised");
        const tint = role(block, "--surface-accent");
        assert.ok(
          contrastRatio(tint, raised) < 1.5,
          `${theme}/${accent} ${scope} tint stays subtle`,
        );
      }
    }
  }
});

void test("form controls have a 3:1 boundary and a 4.5:1 placeholder in every palette", () => {
  const components = readFileSync(new URL("../public/css/components.css", import.meta.url), "utf8");
  const placeholderRule = components.match(/::placeholder\s*\{([^}]+)\}/u)?.[1] ?? "";
  const placeholderRole = placeholderRule.match(/color:\s*var\((--[a-z-]+)\)/u)?.[1];
  assert.ok(placeholderRole, "components.css sets the placeholder colour from a palette role");
  assert.match(placeholderRule, /opacity:\s*1\b/u, "the placeholder is not faded further");
  assert.match(components, /border:\s*1px solid var\(--control-border\)/u);

  for (const theme of DISPLAY_THEMES) {
    for (const accent of EVERY_ACCENT) {
      for (const [scope, block] of paletteBlocks(
        generateDisplayStylesheet(theme, accent, "system").css,
      )) {
        // Controls sit on, and are filled with, the page, card and raised grounds.
        for (const ground of ["--background", "--surface", "--surface-raised"]) {
          const boundary = contrastRatio(role(block, "--control-border"), role(block, ground));
          assert.ok(
            boundary >= 3,
            `${theme}/${accent} ${scope} control border on ${ground}: ${boundary.toFixed(2)}`,
          );
          const placeholder = contrastRatio(role(block, placeholderRole), role(block, ground));
          assert.ok(
            placeholder >= 4.5,
            `${theme}/${accent} ${scope} placeholder on ${ground}: ${placeholder.toFixed(2)}`,
          );
        }
      }
    }
  }
});

void test("every theme's own muted colour is readable on its raised surface", () => {
  for (const [theme, palette] of Object.entries(DISPLAY_PALETTES)) {
    for (const ground of [palette.background, palette.surface, palette.raised]) {
      const ratio = contrastRatio(palette.muted, ground);
      assert.ok(ratio >= 4.5, `${theme} muted ${palette.muted} on ${ground}: ${ratio.toFixed(2)}`);
    }
  }
});

void test("the unknown-health dot has 3:1 on the card's grounds in every palette and is grey in Monochrome", () => {
  for (const theme of DISPLAY_THEMES) {
    for (const accent of EVERY_ACCENT) {
      for (const [scope, block] of paletteBlocks(
        generateDisplayStylesheet(theme, accent, "system").css,
      )) {
        // A Tap card is the surface at 88% over the background.
        for (const ground of ["--background", "--surface"]) {
          const ratio = contrastRatio(role(block, "--unknown"), role(block, ground));
          assert.ok(
            ratio >= 3,
            `${theme}/${accent} ${scope} unknown on ${ground}: ${ratio.toFixed(2)}`,
          );
        }
      }
    }
  }
  const monochrome = paletteBlocks(
    generateDisplayStylesheet("monochrome", "amber", "system").css,
  )[0]![1];
  const unknown = role(monochrome, "--unknown");
  assert.ok(
    unknown.slice(1, 3) === unknown.slice(3, 5) && unknown.slice(3, 5) === unknown.slice(5, 7),
  );
  // It stays distinguishable from the degraded dot.
  assert.notEqual(unknown, monochrome.get("--warning"));
});

void test("the On Deck shadow colour follows the theme", () => {
  const shadowOf = (theme: (typeof DISPLAY_THEMES)[number]): string | undefined =>
    paletteBlocks(generateDisplayStylesheet(theme, "amber", "system").css)[0]![1].get(
      "--shadow-color",
    );
  assert.equal(shadowOf("modern_dark"), "rgba(0,0,0,.22)");
  assert.equal(shadowOf("copper_kettle"), "rgba(59,35,20,.22)");
  for (const [theme, palette] of Object.entries(DISPLAY_PALETTES))
    assert.match(palette.shadowColor, /^rgba\(\d+,\d+,\d+,\.\d+\)$/u, theme);
});

void test("the generated stylesheet sets custom properties in the tokens layer only", () => {
  for (const font of ["system", "all"] as const) {
    const css = generateDisplayStylesheet("auto", "amber", font).css;
    const layered = css.slice(css.indexOf("@layer tokens{"));
    // Font faces come first; everything after them is one tokens layer block.
    assert.match(layered, /^@layer tokens\{[\s\S]*\}$/u);
    assert.doesNotMatch(css.slice(0, css.indexOf("@layer tokens{")), /[:.][\w-]+\{/u);
    // Every declaration in the layer is a custom property, apart from each palette's color-scheme.
    const declarations = [...layered.matchAll(/[{;]([\w-]+):/gu)].map((match) => match[1]!);
    assert.ok(declarations.length > 0);
    for (const name of declarations)
      assert.ok(name.startsWith("--") || name === "color-scheme", `${font}: ${name}`);
  }
});

void test("named accent swatches are generated from the palette, only for the Admin pickers", () => {
  const pickers = generateDisplayStylesheet("auto", "theme", "all").css;
  for (const accent of DISPLAY_ACCENTS.filter((accent) => accent !== "theme")) {
    const hex = resolveDisplayPaletteRoles(DISPLAY_PALETTES.modern_dark!, accent).accent;
    assert.ok(
      pickers.includes(`.display-accent-swatch--${accent}{--accent-swatch:${hex}}`),
      accent,
    );
  }
  assert.doesNotMatch(
    generateDisplayStylesheet("auto", "theme", "system").css,
    /display-accent-swatch/u,
  );
});
