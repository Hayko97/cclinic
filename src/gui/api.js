// Talks to the GUI's own server, which checks the token cookie set when the page first loaded.

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

export function jobStatus(job) {
  return job.isRunning ? "Running" : `${job.exitMeaning} (exit ${job.exitCode})`;
}

/** The message a failed `--json` command printed, or its last line of output. */
function failureOf(job, lines) {
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line.text);
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      // Not JSON: plain output, used below.
    }
  }
  return lines.at(-1)?.text ?? `${job.command}: ${jobStatus(job)}`;
}

/**
 * FR-GUI-020: runs a `cclinic tasks` change as a job and waits for it to end. Rejects with the CLI's own
 * message when it fails, so the GUI shows the same checks and messages as the terminal.
 */
/** Sent on `document` when a job starts or ends. */
export const JOBS_CHANGED = "cclinic:jobs";

export async function runJob(request) {
  const { job } = await api("/api/jobs", { method: "POST", body: JSON.stringify(request) });
  // The top bar's job count follows jobs started from anywhere on the page (FR-GUI-049).
  document.dispatchEvent(new Event(JOBS_CHANGED));
  return new Promise((resolve, reject) => {
    const lines = [];
    const events = new EventSource(`/api/jobs/${job.id}/events`);
    const finish = (ended) => {
      events.close();
      document.dispatchEvent(new Event(JOBS_CHANGED));
      if (ended.exitCode === 0) resolve(ended);
      else reject(new Error(failureOf(ended, lines)));
    };
    events.addEventListener("job", (message) => {
      const { job: current } = JSON.parse(message.data);
      lines.splice(0, lines.length, ...current.output.lines);
      if (!current.isRunning) finish(current);
    });
    events.addEventListener("output", (message) => lines.push(...JSON.parse(message.data).lines));
    events.addEventListener("end", (message) => finish(JSON.parse(message.data).job));
    events.addEventListener("error", () => {
      if (events.readyState === EventSource.CLOSED) reject(new Error("Lost the connection to the GUI."));
    });
  });
}

/** Builds an element with text and attributes; text is always set as text, never as HTML. */
export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "className") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

/** Asks before something that can't be undone, in the page's own dialog (FR-GUI-020, FR-GUI-074). */
export function confirmAction(message, confirmLabel) {
  const dialog = document.getElementById("confirm");
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-ok").textContent = confirmLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

/** How long a notice stays before it clears. */
const NOTICE_DURATION_MS = 8000;
let noticeTimer;
export function notify(text, isError = false) {
  const notice = document.getElementById("notice");
  notice.textContent = text;
  notice.classList.toggle("error", isError);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.textContent = ""), NOTICE_DURATION_MS);
}

export const STATUS_LABELS = { open: "Open", "in-progress": "In progress", done: "Done" };
export const MODE_LABELS = { ai: "AI run", manual: "Manual" };
export const ROLE_LABELS = { developer: "Developer", pm: "PM", qa: "QA", reviewer: "Reviewer", you: "You" };

export function money(value) {
  return `$${value.toFixed(2)}`;
}

export function when(iso) {
  return new Date(iso).toLocaleString();
}

/** A length of time, such as `45s`, `4m 05s` or `1h 02m`. */
export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (value) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

/** How often live timers are redrawn. */
const CLOCK_TICK_MS = 1000;

/** FR-GUI-056, FR-GUI-057: a time that counts up from `since`, kept current by `startClock`. */
export function timer(since, prefix = "") {
  return element(
    "span",
    { className: "timer", "data-since": since, "data-prefix": prefix },
    `${prefix}${duration(Date.now() - Date.parse(since))}`,
  );
}

export function startClock() {
  setInterval(() => {
    for (const node of document.querySelectorAll("[data-since]")) {
      node.textContent = `${node.dataset.prefix}${duration(Date.now() - Date.parse(node.dataset.since))}`;
    }
  }, CLOCK_TICK_MS);
}

/** What the browser remembers between visits (FR-GUI-054, FR-GUI-070); the page works without it. */
export function remembered(key, fallback) {
  try {
    return localStorage.getItem(`cclinic.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function remember(key, value) {
  try {
    localStorage.setItem(`cclinic.${key}`, value);
  } catch {
    // Private windows may refuse; the choice then lasts only for this visit.
  }
}
