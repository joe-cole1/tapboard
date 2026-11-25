import { connect } from "/assets/js/sse.js";
import { patchTapWarsBanner } from "/assets/js/tap-wars-banner.js";

const root = document.querySelector("[data-admin-tap-wars]");

if (root) {
  const status = root.querySelector("[data-tap-wars-live-status]");
  const pairForm = root.querySelector("[data-tap-wars-pair]");
  const startForm = root.querySelector("[data-tap-wars-start]");
  const guestFrame = root.querySelector("[data-tap-wars-guest-preview]");
  const guestBanner = guestFrame?.querySelector("[data-tap-wars]");
  const guestEmpty = root.querySelector("[data-tap-wars-guest-preview-empty]");
  let mutationNavigationPending = false;
  // What guests see now (from /api/admin/tap-wars); undefined until the first refresh.
  let guestsSee;

  // A live-save form (admin-autosave.js) stays on the page, so it never stops refreshes.
  const navigatingForms = 'form[method="post"][action^="/admin/tap-wars"]:not([data-autosave])';
  root.querySelectorAll(navigatingForms).forEach((form) => {
    form.addEventListener("submit", () => {
      mutationNavigationPending = true;
    });
  });

  /** Show `war` in "What guests see"; `kind` says whether it is live or a matchup preview. */
  const showGuest = (war, kind) => {
    if (!(guestBanner instanceof HTMLElement)) return;
    patchTapWarsBanner(guestBanner, war);
    if (guestFrame instanceof HTMLElement) guestFrame.hidden = !war;
    if (guestEmpty instanceof HTMLElement) guestEmpty.hidden = Boolean(war);
    for (const caption of root.querySelectorAll("[data-tap-wars-caption]")) {
      caption.hidden = caption.dataset.tapWarsCaption !== kind;
    }
  };

  const selectors = pairForm ? [...pairForm.querySelectorAll("[data-tap-wars-selector]")] : [];
  /** The opening banner for the chosen pair, built like the server's previewMatchup. */
  const selectedMatchup = () => {
    const options = selectors.map((select) => (select.value ? select.selectedOptions[0] : null));
    if (options.some((option) => !option) || selectors[0].value === selectors[1].value) return null;
    const side = (number, option) => ({
      side: number,
      tapNumber: Number(option.dataset.tapNumber),
      title: option.dataset.title || "Mystery Tap",
      voteCount: 0,
      percentage: null,
    });
    return {
      status: "active",
      side1: side(1, options[0]),
      side2: side(2, options[1]),
      totalVotes: 0,
      isTie: false,
      winnerSide: null,
      leaderSide: null,
      statusLabel: "No votes yet",
    };
  };

  const renderPair = () => {
    if (selectors.length !== 2) return;
    const matchup = selectedMatchup();
    const duplicate = Boolean(selectors[0].value && selectors[0].value === selectors[1].value);
    const pairStatus = pairForm.querySelector("[data-tap-wars-pair-status]");
    if (pairStatus instanceof HTMLElement) pairStatus.hidden = !duplicate;
    if (startForm instanceof HTMLFormElement) {
      for (const [index, select] of selectors.entries()) {
        const competitor = startForm.querySelector(`[data-tap-wars-competitor="${index + 1}"]`);
        if (competitor instanceof HTMLInputElement) competitor.value = matchup ? select.value : "";
      }
      const submit = startForm.querySelector("[data-tap-wars-start-submit]");
      if (submit instanceof HTMLElement && "disabled" in submit) submit.disabled = !matchup;
    }
    if (matchup) showGuest(matchup, "matchup");
    else if (guestsSee !== undefined) showGuest(guestsSee, "live");
    // refresh() learns what guests see now and calls back here.
    else void refresh(false);
  };

  if (pairForm instanceof HTMLFormElement) {
    // The preview follows the selects, so the no-JavaScript reload button (and its row) goes.
    const update = pairForm.querySelector("[data-tap-wars-preview-update]");
    if (update instanceof HTMLElement) update.hidden = true;
    pairForm.addEventListener("submit", (event) => event.preventDefault());
    selectors.forEach((select) => select.addEventListener("change", renderPair));
  }

  const currentSignature = () =>
    `${root.dataset.currentId ?? ""}:${root.dataset.currentStatus ?? ""}:${root.dataset.publishedId ?? ""}`;
  const text = (selector, value) => {
    const node = root.querySelector(selector);
    if (node && value !== undefined) node.textContent = String(value);
  };
  const displayPercentage = (value) => (typeof value === "number" ? `${value}%` : "—");
  const patchCurrent = (current, publicVisible) => {
    const competitors = Array.isArray(current?.competitors) ? current.competitors : [];
    if (competitors.length !== 2) return false;
    const total = Number.isFinite(current.totalVotes)
      ? current.totalVotes
      : competitors.reduce((sum, side) => sum + (Number(side.voteCount) || 0), 0);
    for (const side of competitors) {
      const sideNumber = Number(side.side);
      text(`[data-war-count="${sideNumber}"]`, side.voteCount);
      text(`[data-war-percentage="${sideNumber}"]`, displayPercentage(side.percentage));
      const meter = root.querySelector(`[data-war-meter="${sideNumber}"]`);
      meter?.setAttribute(
        "width",
        String(Math.max(0, Math.min(100, Number(side.percentage) || 0))),
      );
      const publicSide =
        publicVisible?.id === current.id ? publicVisible[`side${sideNumber}`] : null;
      if (typeof publicSide?.title === "string")
        text(`[data-war-public-title="${sideNumber}"]`, publicSide.title);
    }
    text("[data-war-total]", total);
    text(
      "[data-war-leader]",
      current.isTie
        ? "Tied"
        : current.leaderSide
          ? `Side ${current.leaderSide} leads`
          : "No leader yet",
    );
    return true;
  };
  const refresh = async (announced = false) => {
    if (mutationNavigationPending) return;
    try {
      const response = await fetch("/api/admin/tap-wars", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        window.location.reload();
        return;
      }
      const next = await response.json();
      const nextSignature = `${next.current?.id ?? ""}:${next.current?.status ?? ""}:${next.published?.id ?? ""}`;
      if (
        nextSignature !== currentSignature() ||
        (next.current != null && !patchCurrent(next.current, next.publicVisible))
      ) {
        window.location.reload();
        return;
      }
      if (next.current != null) showGuest(next.publicVisible ?? null, "live");
      else {
        // Before a war starts the chosen matchup stays in the preview; without one, show what
        // guests see now.
        guestsSee = next.publicVisible ?? null;
        renderPair();
      }
      if (announced && status instanceof HTMLElement)
        status.textContent = "Tap War vote totals updated.";
    } catch {
      // A reconnect or later dirty event will safely retry; the rendered page remains useful.
    }
  };

  connect(
    "/api/admin/events",
    (name) => {
      if (name === "tap_wars.updated") void refresh(true);
    },
    () => refresh(false),
  );
  // The Mystery Tap switch saves live. Take its description from the server, then refresh
  // the public titles and "What guests see", so redaction stays server-side.
  const mysteryForm = root.querySelector("[data-tap-wars-mystery]");
  mysteryForm?.addEventListener("tapboard:autosave-saved", async () => {
    void refresh(false);
    try {
      const response = await fetch(window.location.pathname, {
        credentials: "same-origin",
        headers: { accept: "text/html" },
      });
      if (!response.ok) return;
      const fresh = new window.DOMParser()
        .parseFromString(await response.text(), "text/html")
        .querySelector("#tap-wars-mystery-status");
      const description = mysteryForm.querySelector("#tap-wars-mystery-status");
      if (fresh && description) description.textContent = fresh.textContent;
    } catch {
      // The switch already shows the saved value; the description catches up on reload.
    }
  });
  // A browser can restore the selects on Back, so sync the Start form at once.
  if (pairForm instanceof HTMLFormElement) renderPair();
}
