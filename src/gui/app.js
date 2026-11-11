// The GUI's page: a top bar, a rail with Canvas, Setup and Jobs, and a side panel (FR-GUI-049).
import { api, money, notify } from "./api.js";
import { addIcons } from "./icons.js";
import { onCanvasChange, onOpenTask, refresh, selectTask, showCanvas, startCanvas } from "./canvas.js";
import { refreshJobs, startJobs } from "./jobs.js";
import { drawList } from "./list.js";
import { openPanel, refreshPanel, startAddTask, startPanel } from "./panel.js";

// The token was only needed to load the page; keep it out of the address bar and history.
if (location.search !== "") history.replaceState(null, "", location.pathname);

/** What the browser remembers between visits (FR-GUI-054); the page works without it. */
function remembered(key, fallback) {
  try {
    return localStorage.getItem(`cclinic.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(`cclinic.${key}`, value);
  } catch {
    // Private windows may refuse; the choice then lasts only for this visit.
  }
}

function showView(name) {
  for (const view of ["canvas", "setup", "jobs"]) {
    document.getElementById(`view-${view}`).hidden = view !== name;
    document.querySelector(`[data-view="${view}"]`).setAttribute("aria-current", String(view === name));
  }
  if (name === "canvas") showCanvas();
  if (name === "jobs") refreshJobs().catch((error) => notify(error.message, true));
}

/** FR-GUI-054: Canvas or List, remembered in the browser. */
function showLayout(name) {
  const isList = name === "list";
  document.getElementById("canvas-area").hidden = isList;
  document.getElementById("list").hidden = !isList;
  document.getElementById("canvas-tools").hidden = isList;
  for (const button of document.querySelectorAll("[data-layout]"))
    button.setAttribute("aria-pressed", String(button.dataset.layout === name));
  remember("layout", name);
  if (!isList) showCanvas();
}

function openTask(id) {
  selectTask(id);
  openPanel({ kind: "task", id });
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
onOpenTask((target) => openPanel(target));
onCanvasChange((canvas) => {
  drawList(canvas, openTask);
  refreshPanel();
  const spent = canvas.roadmaps.filter((roadmap) => roadmap.spentUsd !== null);
  document.getElementById("budget").textContent =
    spent.length === 0
      ? ""
      : spent.map((roadmap) => `${money(roadmap.spentUsd)} of ${money(roadmap.budgetUsd)}`).join(" · ");
});
startPanel();
startAddTask();
startJobs();
startCanvas();
// An unknown remembered layout falls back to the Canvas, as an unknown theme falls back to Auto.
const LAYOUTS = ["canvas", "list"];
showLayout(LAYOUTS.includes(remembered("layout", "canvas")) ? remembered("layout", "canvas") : "canvas");

try {
  const project = await api("/api/project");
  document.getElementById("project-name").textContent = project.name;
  document.getElementById("project-folder").textContent = project.folder;
  document.title = `cclinic · ${project.name}`;
  await refresh();
  await refreshJobs();
} catch (error) {
  notify(error.message, true);
}
