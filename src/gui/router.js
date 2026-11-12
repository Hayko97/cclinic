// FR-GUI-063: every screen, roadmap, task, run, workflow change, session and job has its own URL, so reload, back,
// forward and a shared link in the same browser return to the same view. URLs are kept in the hash.

/** True while a URL is being shown, so showing it doesn't add another history entry. */
let isApplying = false;

const part = (value) => encodeURIComponent(String(value));

export const urls = {
  view: (name) => `#/${name}`,
  task: (id, sessionId) => `#/task/${id}${sessionId === undefined ? "" : `/session/${part(sessionId)}`}`,
  roadmap: (id, runId) => `#/roadmap/${id}${runId === undefined ? "" : `/run/${part(runId)}`}`,
  change: (key) => `#/change/${part(key)}`,
  job: (id) => `#/jobs/${part(id)}`,
};

/** True until the router starts: what the page shows while it loads replaces the entry, adding none. */
let isLoading = true;
/** True for the rest of a step that already added an entry, so a step adds one entry, for where it ends. */
let isInStep = false;

/**
 * Adds `hash` to the browser's history, unless it's already shown or a URL is being shown. A step that shows a view
 * and then opens something in it, such as Show output, records only where it ends (FR-GUI-063).
 */
export function recordView(hash) {
  if (isApplying || location.hash === hash) return;
  if (isLoading || isInStep) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
  isInStep = true;
  queueMicrotask(() => {
    isInStep = false;
  });
}

const ID = /^[1-9]\d{0,9}$/;
/** A job's ID, as the server makes them (FR-GUI-033). */
const JOB_ID = /^job-[1-9]\d{0,5}$/;

/** What a URL's hash names; anything it doesn't recognise is `{ view: undefined }`, which shows nothing new. */
export function parseRoute(hash) {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((item) => item !== "")
    .map((item) => {
      try {
        return decodeURIComponent(item);
      } catch {
        return "";
      }
    });
  const [first, second, third, fourth] = parts;
  // The page's first entry has no hash: going back to it shows the canvas with no panel.
  if (first === undefined) return { view: "canvas" };
  if (first === "canvas" || first === "setup") return { view: first };
  if (first === "jobs")
    return { view: "jobs", job: second, isJobKnownShape: second === undefined || JOB_ID.test(second) };
  if (first === "task" && ID.test(second ?? ""))
    return { view: "canvas", task: Number(second), session: third === "session" ? fourth : undefined };
  if (first === "roadmap" && ID.test(second ?? ""))
    return { view: "canvas", roadmap: Number(second), run: third === "run" ? fourth : undefined };
  if (first === "change" && second !== undefined) return { view: "canvas", change: second };
  return { view: undefined };
}

/** Shows the URL's view now, and again each time back or forward changes it. */
export function startRouter(apply) {
  const show = (isFirst) => {
    // On load with no hash, the page stays where it opened, such as Setup for a project that isn't generated.
    if (isFirst && location.hash === "") return;
    isApplying = true;
    try {
      apply(parseRoute(location.hash));
    } finally {
      isApplying = false;
    }
  };
  window.addEventListener("popstate", () => show(false));
  show(true);
  isLoading = false;
}
