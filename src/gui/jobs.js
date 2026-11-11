// The Jobs screen: every command the GUI ran, with its output as it comes (FR-GUI-033, FR-GUI-034).
import { api, element, JOBS_CHANGED, jobStatus, notify } from "./api.js";

const state = { selected: undefined, events: undefined };

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

function addLines(lines) {
  document
    .getElementById("output")
    .append(...lines.map((line) => element("span", { className: line.stream }, `${line.text}\n`)));
}

export function show(id) {
  const output = document.getElementById("output");
  const cancel = document.getElementById("cancel-job");
  state.selected = id;
  state.events?.close();
  output.replaceChildren();
  const events = new EventSource(`/api/jobs/${id}/events`);
  state.events = events;
  events.addEventListener("job", (message) => {
    const { job } = JSON.parse(message.data);
    // Sent again after a reconnect, so it replaces what's shown instead of adding to it.
    output.replaceChildren();
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
