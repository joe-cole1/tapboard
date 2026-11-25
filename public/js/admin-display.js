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
const CUSTOM_ACCENT = /^#[0-9a-f]{6}$/u;

/** The preview frame, looked up each time: a server redraw replaces it. */
function previewFrame() {
  return document.querySelector("[data-display-preview], .display-preview");
}

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
  const preview = previewFrame();
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

// Default theme choices apply to the preview as they change; the card itself is redrawn
// from the server after each save (refreshTapPreview below).
document.addEventListener("tapboard:autosave-values-applied", syncPreviewFromForm);

// A Tap's Public card tab: its switches save live (admin-autosave.js). Redraw each metric
// from the server's answer, then the preview card from the server, so Mystery redaction and
// metric values stay server-side.
const cardMetrics = document.querySelector("[data-card-metrics]");
if (cardMetrics instanceof HTMLElement) {
  cardMetrics.addEventListener("tapboard:autosave-saved", (event) => {
    const resource = event.detail?.resource ?? {};
    for (const row of cardMetrics.querySelectorAll("[data-metric-field]")) {
      const field = row.dataset.metricField;
      const choice = resource[field];
      if (!["inherit", "show", "hide"].includes(choice)) continue;
      const shown =
        choice === "show" || (choice === "inherit" && row.dataset.displayDefault === "true");
      const toggle = row.querySelector("[data-metric-toggle]");
      const button = toggle?.querySelector('[role="switch"]');
      button?.setAttribute("aria-checked", String(shown));
      const next = toggle?.querySelector(`input[name="${field}"]`);
      if (next instanceof HTMLInputElement) next.value = shown ? "hide" : "show";
      const source = row.querySelector("[data-metric-source]");
      if (source) source.textContent = choice === "inherit" ? "Display default" : "This Tap only";
      const reset = row.querySelector("[data-metric-reset]");
      if (reset instanceof HTMLElement) {
        const hadFocus = reset.contains(document.activeElement);
        reset.hidden = choice === "inherit";
        if (hadFocus && reset.hidden && button instanceof HTMLElement) button.focus();
      }
    }
  });
}

let previewRequest = 0;
let previewDrawn = 0;

/**
 * Swap in the server's current preview card after a setting saves (a Tap's Public card
 * tab, or Display's Default theme), so the card is drawn by the same projection guests see.
 */
async function refreshTapPreview() {
  const frame = document.querySelector("[data-tap-preview]");
  if (!(frame instanceof HTMLElement)) return;
  const request = ++previewRequest;
  try {
    const response = await fetch(window.location.pathname, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return;
    const html = await response.text();
    // Redraws can answer out of order; never draw over a newer one already shown.
    if (request < previewDrawn) return;
    previewDrawn = request;
    const fresh = new window.DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("[data-tap-preview]");
    if (fresh) frame.replaceChildren(...fresh.childNodes);
    // A theme choice made after this save still shows until it saves too.
    syncPreviewFromForm();
  } catch {
    // The saved setting is already shown; the preview catches up on the next load.
  }
}
if (document.querySelector("[data-tap-preview]")) {
  document.addEventListener("tapboard:autosave-saved", () => void refreshTapPreview());
}

if (form instanceof HTMLFormElement && !(previewFrame() instanceof HTMLElement)) apply(read());
