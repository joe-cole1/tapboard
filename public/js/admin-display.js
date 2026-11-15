import {
  apply,
  fields,
  read,
  reset,
  syncStylesheet,
  validateOverrides,
  write,
} from "/assets/js/display-preferences.js";

const form = document.querySelector("[data-display-preferences]");
const status = document.querySelector("[data-display-preference-status]");
const sharedForm = document.querySelector("[data-shared-display-form]");
const preview = document.querySelector("[data-display-preview], .display-preview");
const CUSTOM_ACCENT = /^#[0-9a-f]{6}$/u;

function setStatus(message) {
  if (status) status.textContent = message;
}

/** The accent a form chooses: a named accent, the custom colour, or "" (use default). */
function chosenAccent(target) {
  const data = new FormData(target);
  const accent = String(data.get("accent") ?? "");
  return accent === "custom" ? String(data.get("accentCustom") ?? "").toLowerCase() : accent;
}

// Picking a custom colour selects the Custom choice next to it.
for (const color of document.querySelectorAll("[data-accent-custom-color]")) {
  color.addEventListener("input", () => {
    const choice = color.closest("fieldset")?.querySelector("[data-accent-custom-choice]");
    if (choice instanceof HTMLInputElement && !choice.checked) {
      choice.checked = true;
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

function syncPreviewFromForm() {
  if (!(sharedForm instanceof HTMLFormElement)) return;
  const data = new FormData(sharedForm);
  const theme = String(data.get("theme") ?? "modern_dark");
  const accent = chosenAccent(sharedForm);
  const font = String(data.get("font") ?? "system");
  if (preview instanceof HTMLElement) {
    preview.dataset.previewTheme = theme;
    preview.dataset.previewAccent = accent;
    preview.dataset.previewFont = font;
  }
  syncStylesheet({ theme, accent, font: "all" });
}

if (sharedForm instanceof HTMLFormElement) {
  sharedForm.addEventListener("input", syncPreviewFromForm);
  sharedForm.addEventListener("change", syncPreviewFromForm);
  syncPreviewFromForm();
}

function readFormOverrides() {
  if (!(form instanceof HTMLFormElement)) return {};
  const data = new FormData(form);
  const overrides = {};
  for (const [name, contract] of Object.entries(fields)) {
    const value = name === "accent" ? chosenAccent(form) : String(data.get(name) ?? "");
    if (value === "") continue;
    overrides[name] = contract === "boolean" ? value === "true" : value;
  }
  return overrides;
}

/** Check the controls that match this browser's stored overrides ("" means use default). */
function showOverrides(current) {
  if (!(form instanceof HTMLFormElement)) return;
  for (const name of Object.keys(fields)) {
    let value = current[name] === undefined ? "" : String(current[name]);
    if (name === "accent" && CUSTOM_ACCENT.test(value)) {
      const color = form.querySelector("[data-accent-custom-color]");
      if (color instanceof HTMLInputElement) color.value = value;
      value = "custom";
    }
    // Radios are checked one by one: a radio group's value setter ignores "" (Use default).
    for (const control of form.querySelectorAll(`[name="${name}"]`)) {
      if (control instanceof HTMLInputElement && control.type === "radio")
        control.checked = control.value === value;
      else if ("value" in control) control.value = value;
    }
  }
}

function commitLocal() {
  const overrides = readFormOverrides();
  if (validateOverrides(overrides) === undefined) {
    setStatus("Accent must be a named accent or lowercase #rrggbb.");
    return;
  }
  const persisted = write(overrides);
  setStatus(
    persisted
      ? "This display saved locally."
      : "Applied for this visit; browser storage is unavailable.",
  );
}

if (form instanceof HTMLFormElement) {
  showOverrides(read());
  // The controls only work with JavaScript (they write browser storage), so they stay
  // hidden until this script runs.
  form.hidden = false;
  form.addEventListener("change", commitLocal);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    commitLocal();
  });
}

document.querySelector("[data-reset-preferences]")?.addEventListener("click", () => {
  reset();
  showOverrides({});
  setStatus("This display now uses the default theme.");
});

const metricNames = {
  abv: ["showAbv", "ABV"],
  ibu: ["showIbu", "IBU"],
  og: ["showOg", "OG"],
  fg: ["showFg", "FG"],
  srm: ["showSrm", "SRM"],
};

function metricEnabled(control) {
  if (control instanceof HTMLInputElement) return control.checked;
  if (!(control instanceof HTMLElement) || control.tagName !== "SELECT") return false;
  if (control.value === "show") return true;
  if (control.value === "hide") return false;
  return control.dataset.inheritedValue === "true";
}

function syncTapCardPreview() {
  const card = document.querySelector(
    "[data-display-preview] .tap-card, .display-preview .tap-card",
  );
  if (!(card instanceof HTMLElement)) return;
  const metricForm =
    document.querySelector('form[action="/admin/display/tap-card"]') ??
    document.querySelector('form[action$="/display"]');
  const styleLine = card.querySelector('[data-field="style-line"]');
  const metrics = card.querySelector('[data-field="metrics"]');
  if (metricForm instanceof HTMLFormElement) {
    const abvControl = metricForm.querySelector('[name="showAbv"]');
    const abv = metricEnabled(abvControl) ? card.dataset.previewMetricAbv : undefined;
    if (styleLine instanceof HTMLElement) {
      styleLine.textContent = [abv, styleLine.dataset.previewStyle].filter(Boolean).join(" · ");
      styleLine.hidden = styleLine.textContent === "";
    }
    if (metrics instanceof HTMLElement) {
      const rows = [];
      for (const key of ["ibu", "og", "fg", "srm"]) {
        const [name, label] = metricNames[key];
        const value = card.dataset[`previewMetric${key[0].toUpperCase()}${key.slice(1)}`];
        if (!value || !metricEnabled(metricForm.querySelector(`[name="${name}"]`))) continue;
        const row = document.createElement("div");
        row.dataset.metricKey = key;
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        row.append(term, detail);
        rows.push(row);
      }
      metrics.replaceChildren(...rows);
      metrics.hidden = rows.length === 0;
    }
  }
  // Units and serving temperature are set on the System page; the preview frame
  // carries their saved values.
  const previewUnit =
    preview instanceof HTMLElement ? preview.dataset.previewUnitSystem : undefined;
  const previewShowsTemperature =
    preview instanceof HTMLElement
      ? preview.dataset.previewShowServingTemperature !== "false"
      : true;
  const remaining =
    metricForm instanceof HTMLFormElement
      ? metricForm.querySelector('[name="remainingMode"]')
      : null;
  const mode =
    remaining instanceof HTMLElement && remaining.tagName === "SELECT" ? remaining.value : null;
  const readout = card.querySelector('[data-field="remaining-readout"]');
  if (mode && readout) {
    const remainingMl = Number(card.dataset.remainingVolumeMl);
    const capacityMl = Number(card.dataset.capacityMl);
    const servings = Number(card.dataset.servingsRemaining);
    const percent = Number(card.dataset.fillPercent);
    const waiting = card.dataset.waitingForMeasurement === "true";
    if (waiting) readout.textContent = "Waiting for measurement";
    else if (mode === "percent" && Number.isFinite(percent))
      readout.textContent = `${Math.round(percent)}% remaining`;
    else if (mode === "pints" && Number.isFinite(remainingMl))
      readout.textContent = `${(remainingMl / 473.176473).toFixed(1)} pints remaining`;
    else if (mode === "pours" && Number.isFinite(servings))
      readout.textContent = `${Math.max(0, Math.floor(servings))} pours remaining`;
    else if (mode === "volume" && Number.isFinite(remainingMl) && Number.isFinite(capacityMl)) {
      const metric = previewUnit === "metric";
      const divisor = metric ? 1000 : 3785.411784;
      const suffix = metric ? " L" : " gal";
      readout.textContent = `${(remainingMl / divisor).toFixed(1)}${suffix} / ${(capacityMl / divisor).toFixed(1)}${suffix}`;
    } else readout.textContent = "Measurement unavailable";
  }
  const temperature = card.querySelector('[data-field="temperature"]');
  if (temperature instanceof HTMLElement) {
    const hasTemperature = Number.isFinite(Number(card.dataset.temperatureC));
    temperature.hidden = !hasTemperature || !previewShowsTemperature;
  }
}

for (const previewForm of document.querySelectorAll(
  'form[action="/admin/display/tap-card"], form[action$="/display"], [data-shared-display-form]',
)) {
  previewForm.addEventListener("input", syncTapCardPreview);
  previewForm.addEventListener("change", syncTapCardPreview);
}
document.addEventListener("tapboard:autosave-values-applied", () => {
  syncPreviewFromForm();
  syncTapCardPreview();
});
syncTapCardPreview();

if (form instanceof HTMLFormElement && !(preview instanceof HTMLElement)) apply(read());
