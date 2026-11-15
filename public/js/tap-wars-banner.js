// The public Tap Wars banner and its results dialog (views/partials/tap-wars-banner.eta).
// Shared by the public dashboard and the Admin "What guests see" preview so both
// show exactly the same thing.

function setText(element, value) {
  if (element) element.textContent = value ?? "";
}

function headline(war) {
  if (war.status === "active") return "TAP WARS! Vote below";
  if (war.status === "paused") return "TAP WARS! Voting paused";
  if (war.isTie) return "TAP WARS — IT'S A TIE!";
  return `TAP WARS WINNER — ${war.winnerSide === 1 ? war.side1.title : war.side2.title}!`;
}

function meterLabel(war) {
  if (war.totalVotes === 0) return `${war.side1.title} versus ${war.side2.title}. No votes yet.`;
  return `Vote split: ${war.side1.title} ${war.side1.percentage} percent; ${war.side2.title} ${war.side2.percentage} percent.`;
}

function resultLabel(war) {
  if (war.totalVotes === 0)
    return war.status === "completed" ? "Final result: Tie. Total votes: 0." : "No votes yet.";
  if (war.status === "completed") {
    if (war.isTie) return `Final result: Tie. Total votes: ${war.totalVotes}.`;
    const winner = war.winnerSide === 1 ? war.side1.title : war.side2.title;
    return `Final result: ${winner} wins. Total votes: ${war.totalVotes}.`;
  }
  if (war.isTie) return `Tie. Total votes: ${war.totalVotes}.`;
  const leader = war.leaderSide === 1 ? war.side1.title : war.side2.title;
  return `${leader} is currently leading. Total votes: ${war.totalVotes}.`;
}

function patchMeter(meter, war, sideSelector) {
  if (!meter) return;
  const neutral = war.totalVotes === 0;
  meter.classList.toggle("is-neutral", neutral);
  meter.setAttribute("aria-label", meterLabel(war));
  // SVG geometry attributes, not inline styles: the CSP blocks style attributes.
  const width1 = neutral ? 0 : war.side1.percentage;
  const width2 = neutral ? 0 : war.side2.percentage;
  meter.querySelector(`[${sideSelector}="1"]`)?.setAttribute("width", String(width1));
  const segment2 = meter.querySelector(`[${sideSelector}="2"]`);
  segment2?.setAttribute("x", String(width1));
  segment2?.setAttribute("width", String(width2));
  const divider = meter.querySelector("[data-tap-wars-meter-divider]");
  divider?.setAttribute("x1", String(width1));
  divider?.setAttribute("x2", String(width1));
  divider?.setAttribute("visibility", width1 > 0 && width2 > 0 ? "visible" : "hidden");
}

function patchDialog(war) {
  const results = document.querySelector("[data-tap-wars-dialog-results]");
  setText(document.querySelector("[data-tap-wars-dialog-status]"), resultLabel(war));
  if (results) {
    results.replaceChildren(
      ...[war.side1, war.side2].map((side) => {
        const row = document.createElement("div");
        row.dataset.tapWarsDialogSide = String(side.side);
        const term = document.createElement("dt");
        setText(term, `Tap ${side.tapNumber} · ${side.title}`);
        const detail = document.createElement("dd");
        const votes = document.createElement("strong");
        setText(votes, `${side.voteCount} ${side.voteCount === 1 ? "vote" : "votes"}`);
        const percentage = document.createElement("span");
        setText(percentage, side.percentage === null ? "—" : `${side.percentage}%`);
        detail.append(votes, percentage);
        row.append(term, detail);
        return row;
      }),
    );
  }
  patchMeter(
    document.querySelector("[data-tap-wars-dialog-meter]"),
    war,
    "data-tap-wars-dialog-meter-side",
  );
}

/** Patch the banner and dialog to show `war` (a public Tap War view), or hide them for null. */
export function patchTapWarsBanner(banner, war) {
  banner.hidden = !war;
  if (!war) {
    const dialog = document.querySelector("[data-tap-wars-dialog]");
    if (dialog?.open) dialog.close();
    return;
  }
  setText(banner.querySelector("[data-tap-wars-status]"), headline(war));
  setText(banner.querySelector("[data-tap-wars-message]"), war.statusLabel);
  for (const side of [war.side1, war.side2]) {
    setText(banner.querySelector(`[data-tap-wars-side="${side.side}"]`), side.title);
    setText(banner.querySelector(`[data-tap-wars-tap="${side.side}"]`), `Tap ${side.tapNumber}`);
    setText(
      banner.querySelector(`[data-tap-wars-percent="${side.side}"]`),
      side.percentage === null ? "—" : `${side.percentage}%`,
    );
  }
  patchMeter(banner.querySelector("[data-tap-wars-meter]"), war, "data-tap-wars-meter-side");
  patchDialog(war);
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-tap-wars-results]")) return;
  const dialog = document.querySelector("[data-tap-wars-dialog]");
  if (dialog && !dialog.open) dialog.showModal();
});
