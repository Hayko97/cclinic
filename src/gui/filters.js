// FR-GUI-079: search and filters on the canvas. Cards that don't pass are dimmed in place, never moved.
import { element, STATUS_LABELS } from "./api.js";
import { currentCanvas, isShowingSessions, setShowSessions, taskById, zoomToFrame } from "./canvas.js";

const byId = (id) => document.getElementById(id);

function choices() {
  return {
    query: byId("canvas-search").value.trim().toLowerCase(),
    status: byId("filter-status").value,
    mode: byId("filter-mode").value,
    spec: byId("filter-spec").value,
    hideDone: byId("hide-done").checked,
  };
}

/** A search matches a task's ID (with or without `#`), title or spec. */
function isTaskMatch(task, query) {
  const id = query.startsWith("#") ? query.slice(1) : query;
  return (
    String(task.id) === id ||
    task.title.toLowerCase().includes(query) ||
    (task.spec ?? "").toLowerCase().includes(query)
  );
}

function isTaskShown(task, chosen) {
  if (chosen.status !== "" && task.status !== chosen.status) return false;
  if (chosen.mode !== "" && (task.mode ?? "none") !== chosen.mode) return false;
  if (chosen.spec !== "" && task.spec !== chosen.spec) return false;
  return !(chosen.hideDone && task.status === "done");
}

/** Marks every card on the canvas: `is-match` for a search hit, `is-filtered` for a card the filters leave out. */
export function applyFilters() {
  const chosen = choices();
  const canvas = currentCanvas();
  if (canvas === undefined) return;
  const changes = new Map(canvas.changes.map((change) => [change.key, change]));
  for (const card of document.querySelectorAll("#frames .card")) {
    let isMatch;
    let isShown;
    if (card.dataset.task === undefined) {
      // A change has a spec and a status of its own, but no task status or mode to filter by.
      const change = changes.get(card.dataset.change);
      const text = `${change?.key ?? ""} ${change?.spec ?? ""}`.toLowerCase();
      isMatch = chosen.query !== "" && text.includes(chosen.query);
      isShown = chosen.status === "" && chosen.mode === "" && (chosen.spec === "" || change?.spec === chosen.spec);
    } else {
      const task = taskById(Number(card.dataset.task));
      isMatch = task !== undefined && chosen.query !== "" && isTaskMatch(task, chosen.query);
      isShown = task !== undefined && isTaskShown(task, chosen);
    }
    card.classList.toggle("is-match", isMatch);
    card.classList.toggle("is-filtered", !isShown);
    if (card.dataset.task !== undefined)
      for (const node of document.querySelectorAll(`#frames .session-node[data-task="${card.dataset.task}"]`))
        node.classList.toggle("is-filtered", !isShown);
  }
}

/** Fills a select with options, keeping what's chosen if it's still there. */
function fillSelect(select, first, options) {
  const wanted = JSON.stringify(options);
  if (select.dataset.options === wanted) return;
  const chosen = select.value;
  select.replaceChildren(
    element("option", { value: "" }, first),
    ...options.map(([value, label]) => element("option", { value }, label)),
  );
  select.dataset.options = wanted;
  select.value = options.some(([value]) => value === chosen) ? chosen : "";
}

/** The spec filter and roadmap picker follow what's on the canvas. */
export function updateFilterChoices(canvas) {
  const specs = [...new Set([...canvas.tasks.map((task) => task.spec), ...canvas.changes.map((change) => change.spec)])]
    .filter((spec) => spec !== null && spec !== "")
    .sort();
  fillSelect(
    byId("filter-spec"),
    "Any spec",
    specs.map((spec) => [spec, spec]),
  );
  fillSelect(
    byId("go-roadmap"),
    "Go to roadmap…",
    canvas.roadmaps.map((roadmap) => [String(roadmap.id), `#${roadmap.id} ${roadmap.title}`]),
  );
  // A spec that's gone resets its filter to "Any spec", so the cards are marked again to match.
  applyFilters();
}

export function startFilters() {
  fillSelect(
    byId("filter-status"),
    "Any status",
    Object.entries(STATUS_LABELS).map(([value, label]) => [value, label]),
  );
  for (const id of ["canvas-search", "filter-status", "filter-mode", "filter-spec", "hide-done"])
    byId(id).addEventListener(id === "canvas-search" ? "input" : "change", applyFilters);
  const sessions = byId("show-sessions");
  sessions.checked = isShowingSessions();
  sessions.addEventListener("change", () => setShowSessions(sessions.checked));
  const picker = byId("go-roadmap");
  picker.addEventListener("change", () => {
    if (picker.value === "") return;
    zoomToFrame(`roadmap-${picker.value}`);
    picker.value = "";
  });
}
