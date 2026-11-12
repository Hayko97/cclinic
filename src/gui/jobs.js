// The Jobs screen: every command the GUI ran, with its output as it comes (FR-GUI-033, FR-GUI-034).
import { api, element, JOBS_CHANGED, jobStatus, notify, REPORTED_JOBS } from "./api.js";
import { followView, viewTools } from "./follow.js";
import { recordView, urls } from "./router.js";

/** `view` is the output's follow view and search, made once the Jobs screen starts. */
const state = { selected: undefined, events: undefined, view: undefined, watched: new Set(), watching: undefined };

/** FR-GUI-062: how often running jobs are checked, so each one's end is announced even if nothing else asks. */
const JOB_WATCH_MS = 2000;

/** FR-GUI-062: a notice for a job that ended, with its result and a link to its output. */
function announce(job) {
  notify(`${job.command}: ${jobStatus(job)}`, job.exitCode !== 0, {
    label: "Show output",
    run: () => {
      document.querySelector('[data-view="jobs"]').click();
      show(job.id);
    },
  });
}

/** Jobs the page runs in the background to fill a form, which nobody waits on. */
const QUIET_KINDS = new Set(["generate-preview", "auto-preview", "model-list"]);

/** Notes the jobs running now, and announces each one seen running before that has ended since. */
function watch(jobs) {
  for (const job of jobs) {
    if (job.isRunning) state.watched.add(job.id);
    else if (state.watched.delete(job.id) && !REPORTED_JOBS.has(job.id) && !QUIET_KINDS.has(job.kind)) announce(job);
  }
  if (state.watched.size > 0 && state.watching === undefined)
    state.watching = setInterval(() => {
      refreshJobs().catch((error) => {
        // The GUI's server is gone or failing: watching stops, saying why once, instead of polling for ever.
        clearInterval(state.watching);
        state.watching = undefined;
        state.watched.clear();
        notify(`Stopped following running jobs: ${error.message}`, true);
      });
    }, JOB_WATCH_MS);
  if (state.watched.size === 0 && state.watching !== undefined) {
    clearInterval(state.watching);
    state.watching = undefined;
  }
}

/** FR-GUI-055: the class that gives a job's status its icon. */
function statusClass(job) {
  const result = job.isRunning ? "is-running" : job.exitCode === 0 ? "is-ok" : "is-failed";
  return `job-status ${result}`;
}

function showTitle(job) {
  const title = document.getElementById("output-title");
  title.textContent = `${job.command} · ${jobStatus(job)}`;
  title.className = statusClass(job);
}

export async function refreshJobs() {
  const { jobs } = await api("/api/jobs");
  watch(jobs);
  // FR-GUI-053: an empty list says why, and offers the one action that fills it.
  if (jobs.length === 0) {
    document
      .getElementById("job-list")
      .replaceChildren(
        element(
          "li",
          { className: "muted" },
          element("p", {}, "No jobs yet. Everything the GUI runs shows here, with its output."),
          element(
            "button",
            { type: "button", onClick: () => document.getElementById("run-doctor").click() },
            "Run doctor",
          ),
        ),
      );
  } else
    document.getElementById("job-list").replaceChildren(
      ...jobs.map((job) =>
        element(
          "li",
          {},
          element(
            "button",
            {
              type: "button",
              className: statusClass(job),
              "aria-current": String(job.id === state.selected),
              onClick: () => show(job.id),
            },
            `${job.command} · ${jobStatus(job)}`,
          ),
        ),
      ),
    );
  const running = jobs.filter((job) => job.isRunning).length;
  const count = document.getElementById("job-count");
  count.textContent = running === 0 ? "No jobs running" : `${running} running`;
  count.classList.toggle("is-busy", running > 0);
}

/** FR-GUI-058, FR-GUI-059: each line is its own item, so it can be searched and followed. */
function addLines(lines) {
  const items = lines.map((line) =>
    element("span", { className: `line ${line.stream}` }, element("span", { className: "text" }, line.text), "\n"),
  );
  document.getElementById("output").append(...items);
  state.view.tools.added(items);
  state.view.follow.added(items.length);
}

export function show(id) {
  recordView(urls.job(id));
  const output = document.getElementById("output");
  const cancel = document.getElementById("cancel-job");
  state.selected = id;
  state.events?.close();
  output.replaceChildren();
  state.view.follow.reset();
  const events = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.events = events;
  events.addEventListener("job", (message) => {
    const { job } = JSON.parse(message.data);
    // Sent again after a reconnect, so it replaces what's shown instead of adding to it.
    output.replaceChildren();
    state.view.follow.reset();
    showTitle(job);
    cancel.hidden = !job.isRunning;
    if (job.output.dropped > 0) addLines([{ stream: "stderr", text: `(${job.output.dropped} older lines dropped)` }]);
    addLines(job.output.lines);
    if (!job.isRunning) events.close();
  });
  events.addEventListener("output", (message) => addLines(JSON.parse(message.data).lines));
  events.addEventListener("end", (message) => {
    const { job } = JSON.parse(message.data);
    showTitle(job);
    cancel.hidden = true;
    events.close();
    refreshJobs().catch((error) => notify(error.message, true));
  });
  refreshJobs().catch((error) => notify(error.message, true));
}

export function startJobs() {
  const output = document.getElementById("output");
  const follow = followView(output);
  const tools = viewTools(output, { follow, label: "output" });
  state.view = { follow, tools };
  output.before(tools.bar);
  document.addEventListener(JOBS_CHANGED, () => {
    refreshJobs().catch((error) => notify(error.message, true));
  });
  document.getElementById("run-doctor").addEventListener("click", async () => {
    try {
      const { job } = await api("/api/jobs", { method: "POST", body: JSON.stringify({ command: "doctor" }) });
      document.querySelector('[data-view="jobs"]').click();
      show(job.id);
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.getElementById("cancel-job").addEventListener("click", async () => {
    if (state.selected === undefined) return;
    try {
      await api(`/api/jobs/${state.selected}/cancel`, { method: "POST" });
    } catch (error) {
      notify(error.message, true);
    }
  });
}
