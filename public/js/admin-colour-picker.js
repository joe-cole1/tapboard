// The display colour picker (views/partials/display-colour-picker.eta). On a Beverage page its
// forms are one-click live saves (admin-autosave.js): a chosen swatch, exact SRM or colour saves
// at once, and the page redraws the picker from the server's answer. In the New Beverage form,
// picking a colour turns on the switch that makes it count.

/** Redraw one picker from a live-save answer, keeping focus on a control that stays. */
function redraw(picker, resource) {
  if (typeof resource.resolvedColor !== "string") return;
  const colour = picker.querySelector('input[type="color"][name="displayColor"]');
  if (colour instanceof HTMLInputElement) colour.value = resource.resolvedColor;
  for (const cue of document.querySelectorAll("[data-beverage-colour-cue] circle"))
    cue.setAttribute("fill", resource.resolvedColor);

  for (const radio of picker.querySelectorAll('input[type="radio"][name="srm"]'))
    radio.checked = radio.value === resource.srm;
  const exact = picker.querySelector('input[name="srmExact"]');
  if (exact instanceof HTMLInputElement && document.activeElement !== exact)
    exact.value = String(resource.srmExact ?? "");

  const parts = [
    ["[data-colour-reset]", "[data-colour-source]", resource.colourOverridden === true, colour],
    [
      "[data-srm-reset]",
      "[data-srm-source]",
      resource.srmOverridden === true,
      picker.querySelector('input[name="srm"]:checked') ?? exact,
    ],
  ];
  for (const [resetSelector, sourceSelector, overridden, fallback] of parts) {
    const source = picker.querySelector(sourceSelector);
    if (source instanceof HTMLElement)
      source.textContent = overridden
        ? source.dataset.labelOverridden
        : source.dataset.labelInherited;
    const reset = picker.querySelector(resetSelector);
    if (!(reset instanceof HTMLElement)) continue;
    const hadFocus = reset.contains(document.activeElement);
    reset.hidden = !overridden;
    if (hadFocus && reset.hidden && fallback instanceof HTMLElement) fallback.focus();
  }
}

for (const picker of document.querySelectorAll("[data-colour-picker]")) {
  const exactChoice = picker.querySelector('input[name="srm"][value="exact"]');
  const exactValue = picker.querySelector('input[name="srmExact"]');
  // Typing an exact SRM selects "Exact value", whose number is the one the server reads.
  exactValue?.addEventListener("input", () => {
    if (exactChoice instanceof HTMLInputElement) exactChoice.checked = true;
  });
  const colour = picker.querySelector('input[type="color"][name="displayColor"]');

  if (!picker.hasAttribute("data-colour-picker-live")) {
    const custom = picker.querySelector("[data-colour-custom]");
    colour?.addEventListener("input", () => {
      if (custom instanceof HTMLInputElement) custom.checked = true;
    });
    continue;
  }

  const srmForm = picker.querySelector("[data-srm-form]");
  srmForm?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    // "Exact value" alone waits for its number; a swatch or a typed number saves.
    if (target === exactChoice && exactValue instanceof HTMLInputElement) {
      if (exactValue.value === "") {
        exactValue.focus();
        return;
      }
    }
    srmForm.requestSubmit();
  });
  const colourForm = picker.querySelector("[data-colour-form]");
  // "change" fires once the colour is chosen, not on every step of the native picker.
  colour?.addEventListener("change", () => colourForm?.requestSubmit());
  picker.addEventListener("tapboard:autosave-saved", (event) =>
    redraw(picker, event.detail?.resource ?? {}),
  );
}
