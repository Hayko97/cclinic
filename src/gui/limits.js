// FR-GUI-083: the top bar mirrors the Claude plan's usage limits, as luseen last read them. No dollars.
import { element, when } from "./api.js";

const PERCENT = 100;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;

/** When a window resets: the time today or tomorrow, else the day and time, in the user's own locale. */
export function resetText(iso) {
  if (iso === null) return "later";
  const at = new Date(iso);
  const isSoon = at.getTime() - Date.now() < HOURS_PER_DAY * MS_PER_HOUR;
  return at.toLocaleString(
    undefined,
    isSoon ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" },
  );
}

function windowItem(label, window, highUse) {
  if (window === null) return null;
  // Its reset time has passed: the saved use is old, so only when it reset is shown.
  if (window.hasReset) {
    return element(
      "span",
      { className: "limit", "data-limit": label.toLowerCase() },
      `${label} · reset at ${new Date(window.resetsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    );
  }
  const used = Math.round(window.used * PERCENT);
  return element(
    "span",
    {
      className: `limit${window.used >= highUse ? " is-high" : ""}`,
      "data-limit": label.toLowerCase(),
      title: `${label}: ${used} % of the limit used.${
        window.resetsAt === null ? "" : ` It resets ${new Date(window.resetsAt).toLocaleString()}.`
      }`,
    },
    `${label} ${used} % · resets ${resetText(window.resetsAt)}`,
  );
}

/** Draws the limits, or nothing when none are known yet. */
export function drawLimits(limits) {
  const box = document.getElementById("limits");
  if (limits === null || limits === undefined) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    ...[
      limits.isReached
        ? element(
            "span",
            { className: "limit is-reached", role: "status" },
            `Limit reached · resets ${resetText(limits.resetsAt)}`,
          )
        : null,
      windowItem("Session", limits.session, limits.highUse),
      windowItem("Week", limits.week, limits.highUse),
      element("span", { className: "muted limit-read" }, "as of ", when(limits.readAt)),
    ].filter((part) => part !== null),
  );
}
