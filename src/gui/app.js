// The GUI's page: a top bar, a rail with Canvas, Setup and Jobs, and a side panel (FR-GUI-049).
import { api, element, notify, remember, remembered, startClock } from "./api.js";
import { drawLimits } from "./limits.js";
import { addIcons } from "./icons.js";
import { startAuto } from "./auto.js";
import { openPlan, openPlanSession, startPlan } from "./plan.js";
import { onOpenPlan, setTitleBase, showAttention, startAttention } from "./attention.js";
import {
  currentCanvas,
  onCanvasChange,
  onDraw,
  onOpenTask,
  onPlan,
  refresh,
  selectTask,
  showCanvas,
  startCanvas,
} from "./canvas.js";
import { applyFilters, startFilters, updateFilterChoices } from "./filters.js";
import { refreshJobs, show as showJob, startJobs } from "./jobs.js";
import { refreshSetup, startSetup } from "./setup.js";
import { drawList } from "./list.js";
import { openPanel, openPastRun, panelUrl, refreshPanel, startAddTask, startPanel } from "./panel.js";
import { recordView, startRouter, urls } from "./router.js";

// The token was only needed to load the page; keep it out of the address bar and history.
if (location.search !== "") history.replaceState(null, "", `${location.pathname}${location.hash}`);

function showView(name) {
  // The canvas shows its open panel too, so the URL names that panel (FR-GUI-063).
  recordView((name === "canvas" ? panelUrl() : undefined) ?? urls.view(name));
  for (const view of ["canvas", "setup", "jobs"]) {
    document.getElementById(`view-${view}`).hidden = view !== name;
    document.querySelector(`[data-view="${view}"]`).setAttribute("aria-current", String(view === name));
  }
  if (name === "canvas") showCanvas();
  if (name === "jobs") refreshJobs().catch((error) => notify(error.message, true));
  if (name === "setup") refreshSetup().catch((error) => notify(error.message, true));
}

/** FR-GUI-054: Canvas or List, remembered in the browser. */
function showLayout(name) {
  const isList = name === "list";
  document.getElementById("canvas-area").hidden = isList;
  document.getElementById("list").hidden = !isList;
  document.getElementById("canvas-tools").hidden = isList;
  document.getElementById("canvas-filters").hidden = isList;
  for (const button of document.querySelectorAll("[data-layout]"))
    button.setAttribute("aria-pressed", String(button.dataset.layout === name));
  remember("layout", name);
  if (!isList) showCanvas();
}

function openTask(id, sessionId) {
  selectTask(id);
  openPanel({ kind: "task", id }, sessionId);
}

/** FR-GUI-063: a URL for something that isn't there says so, and the URL then names what's shown instead. */
function notFound(message, shown) {
  notify(message, true);
  history.replaceState(null, "", shown);
}

/** FR-GUI-063: shows what a URL names; one for something that's gone says so and shows the canvas. */
function showRoute(route) {
  if (route.view === undefined) return;
  showView(route.view);
  if (route.view === "jobs" && route.job !== undefined) {
    const missing = () => notFound(`Job ${route.job} isn't one of this GUI's jobs.`, urls.view("jobs"));
    if (!route.isJobKnownShape) missing();
    else
      api(`/api/jobs/${encodeURIComponent(route.job)}`)
        .then(() => showJob(route.job))
        .catch(missing);
  }
  if (route.view !== "canvas") return;
  const canvas = currentCanvas();
  if (route.task !== undefined) {
    if (canvas.tasks.some((task) => task.id === route.task)) openTask(route.task, route.session);
    else notFound(`Task #${route.task} isn't in this project.`, urls.view("canvas"));
  } else if (route.roadmap !== undefined) {
    const roadmap = canvas.roadmaps.find((item) => item.id === route.roadmap);
    if (roadmap === undefined) notFound(`Roadmap #${route.roadmap} isn't in this project.`, urls.view("canvas"));
    else if (route.run === undefined) openPanel({ kind: "roadmap", id: roadmap.id });
    else if (roadmap.pastRuns.some((run) => run.runId === route.run)) openPastRun(roadmap.id, route.run);
    else {
      openPanel({ kind: "roadmap", id: roadmap.id });
      notFound(`Run ${route.run} isn't one of roadmap #${roadmap.id}'s finished runs.`, urls.roadmap(roadmap.id));
    }
  } else if (route.change !== undefined) {
    if (canvas.changes.some((change) => change.key === route.change)) openPanel({ kind: "change", key: route.change });
    else notFound(`The change ${route.change} isn't in this project.`, urls.view("canvas"));
  } else openPanel(undefined);
}

function applyTheme(chosen) {
  if (chosen === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = chosen;
  const label = chosen === "dark" ? "Dark" : chosen === "light" ? "Light" : "Auto";
  document.getElementById("theme").textContent = `Theme: ${label}`;
}

for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => showView(button.dataset.view));
for (const button of document.querySelectorAll("[data-layout]"))
  button.addEventListener("click", () => showLayout(button.dataset.layout));
// Kept here, so the toggle works for this visit even when the browser won't store it.
const THEMES = ["system", "light", "dark"];
let theme = THEMES.includes(remembered("theme", "system")) ? remembered("theme", "system") : "system";
document.getElementById("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  remember("theme", theme);
  applyTheme(theme);
});

applyTheme(theme);
addIcons();
onOpenTask((target, sessionId) => openPanel(target, sessionId));
onDraw(applyFilters);
onCanvasChange((canvas, payload) => {
  updateFilterChoices(canvas);
  showAttention(canvas, payload.nextStep);
  drawList(canvas, openTask);
  refreshPanel();
  // FR-GUI-083: the Claude plan's limits, not dollars.
  drawLimits(payload.limits);
});
startPanel();
startAuto();
startPlan();
// A Needs you item opens its planning session; the banner opens a new one.
onOpenPlan((target) => (typeof target === "string" ? openPlanSession(target) : openPlan(target)));
onPlan((target) => void openPlan(target));
startClock();
startAddTask();
startJobs();
startCanvas();
startFilters();
// FR-GUI-052: a waiting item opens where it lives, from any screen.
startAttention(
  (target) => {
    showView("canvas");
    if (target.kind === "task") openTask(target.id);
    else openPanel(target);
  },
  () => {
    showView("canvas");
    showLayout("canvas");
  },
  () => showView("setup"),
);
startSetup((id) => {
  showView("jobs");
  showJob(id);
});
// An unknown remembered layout falls back to the Canvas, as an unknown theme falls back to Auto.
const LAYOUTS = ["canvas", "list"];
showLayout(LAYOUTS.includes(remembered("layout", "canvas")) ? remembered("layout", "canvas") : "canvas");

/** FR-GUI-066: data slower than this shows a placeholder of its shape instead of a blank area. */
const SKELETON_DELAY_MS = 300;
let isRouting = false;

/**
 * FR-GUI-066: loads the canvas, with a placeholder while it's slow and its reason with Retry in place when it
 * fails. Once it's loaded, the URL's task, roadmap or change can be found (FR-GUI-063).
 */
async function loadCanvas() {
  const loading = document.getElementById("canvas-loading");
  const timer = setTimeout(() => {
    loading.replaceChildren(
      ...[1, 2].map(() => element("div", { className: "skeleton-frame", "aria-hidden": "true" })),
      element("p", { className: "muted", role: "status" }, "Loading the canvas…"),
    );
    loading.hidden = false;
  }, SKELETON_DELAY_MS);
  try {
    await refresh();
    loading.hidden = true;
    loading.replaceChildren();
    if (!isRouting) {
      isRouting = true;
      startRouter(showRoute);
    }
  } catch (error) {
    loading.replaceChildren(
      element("p", { className: "error", role: "alert" }, `Couldn't load the canvas: ${error.message}`),
      element("button", { type: "button", onClick: () => void loadCanvas() }, "Retry"),
    );
    loading.hidden = false;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const project = await api("/api/project");
  document.getElementById("project-name").textContent = project.name;
  document.getElementById("project-folder").textContent = project.folder;
  setTitleBase(`luseen · ${project.name}`);
  // FR-GUI-014: a project that isn't set up opens on Setup, where generating is the first step.
  // A shared link names its own view, which wins (FR-GUI-063).
  if (!project.hasDocuments && location.hash === "") showView("setup");
  await loadCanvas();
  await refreshJobs();
} catch (error) {
  notify(error.message, true);
}
