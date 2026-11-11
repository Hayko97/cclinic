// The GUI's page. It talks only to its own server, which checks the token cookie set on first load.

// The token was only needed to load the page; keep it out of the address bar and history.
if (location.search !== "") history.replaceState(null, "", location.pathname);

const elements = {
  name: document.getElementById("project-name"),
  folder: document.getElementById("project-folder"),
  list: document.getElementById("job-list"),
  title: document.getElementById("output-title"),
  output: document.getElementById("output"),
  cancel: document.getElementById("cancel-job"),
  notice: document.getElementById("notice"),
  runDoctor: document.getElementById("run-doctor"),
};

let selected;

function showError(error) {
  elements.notice.textContent = error.message;
}
let events;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

function status(job) {
  return job.isRunning ? "Running" : `${job.exitMeaning} (exit ${job.exitCode})`;
}

async function refreshJobs() {
  const { jobs } = await api("/api/jobs");
  elements.list.replaceChildren(
    ...jobs.map((job) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${job.command} · ${status(job)}`;
      button.setAttribute("aria-current", String(job.id === selected));
      button.addEventListener("click", () => show(job.id));
      item.append(button);
      return item;
    }),
  );
}

function addLines(lines) {
  for (const line of lines) {
    const span = document.createElement("span");
    span.className = line.stream;
    span.textContent = `${line.text}\n`;
    elements.output.append(span);
  }
}

function show(id) {
  selected = id;
  events?.close();
  elements.output.replaceChildren();
  events = new EventSource(`/api/jobs/${id}/events`);
  events.addEventListener("job", (message) => {
    const { job } = JSON.parse(message.data);
    // Sent again after a reconnect, so it replaces what's shown instead of adding to it.
    elements.output.replaceChildren();
    elements.title.textContent = `${job.command} · ${status(job)}`;
    elements.cancel.hidden = !job.isRunning;
    if (job.output.dropped > 0) addLines([{ stream: "stderr", text: `(${job.output.dropped} older lines dropped)` }]);
    addLines(job.output.lines);
    if (!job.isRunning) events.close();
  });
  events.addEventListener("output", (message) => addLines(JSON.parse(message.data).lines));
  events.addEventListener("end", (message) => {
    const { job } = JSON.parse(message.data);
    elements.title.textContent = `${job.command} · ${status(job)}`;
    elements.cancel.hidden = true;
    elements.notice.textContent = `${job.command}: ${status(job)}`;
    events.close();
    refreshJobs().catch(showError);
  });
  refreshJobs().catch(showError);
}

elements.runDoctor.addEventListener("click", async () => {
  try {
    const { job } = await api("/api/jobs", { method: "POST", body: JSON.stringify({ command: "doctor" }) });
    show(job.id);
  } catch (error) {
    showError(error);
  }
});

elements.cancel.addEventListener("click", async () => {
  if (selected === undefined) return;
  try {
    await api(`/api/jobs/${selected}/cancel`, { method: "POST" });
  } catch (error) {
    showError(error);
  }
});

try {
  const project = await api("/api/project");
  elements.name.textContent = project.name;
  elements.folder.textContent = project.folder;
  await refreshJobs();
} catch (error) {
  showError(error);
}
