// FR-GUI-054: the same tasks as the canvas, as a list: roadmaps, milestones in order, then their tasks.
import { element, MODE_LABELS, ROLE_LABELS, STATUS_LABELS } from "./api.js";

function taskRow(task, open) {
  const live = task.sessions.filter((session) => session.isLive);
  return element(
    "tr",
    { "data-task": task.id, className: task.waitingOn.length > 0 ? "is-waiting" : undefined },
    element(
      "td",
      {},
      element(
        "button",
        { type: "button", className: "link", onClick: () => open(task.id) },
        `#${task.id} ${task.title}`,
      ),
    ),
    element(
      "td",
      {},
      element("span", { className: `badge status status-${task.status}` }, STATUS_LABELS[task.status] ?? task.status),
    ),
    element(
      "td",
      {},
      task.mode === null ? "" : element("span", { className: `badge mode mode-${task.mode}` }, MODE_LABELS[task.mode]),
    ),
    element("td", {}, live.map((session) => ROLE_LABELS[session.role] ?? session.role).join(", ")),
    element(
      "td",
      {},
      task.dependsOn.map((id) =>
        element(
          "button",
          {
            type: "button",
            className: `link${task.waitingOn.includes(id) ? " waiting" : ""}`,
            onClick: () => open(id),
          },
          `after #${id}`,
        ),
      ),
      task.waitingOn.length > 0 ? element("span", { className: "waiting" }, " waiting") : null,
    ),
    element(
      "td",
      {},
      // FR-GUI-055: the sessions' status has an icon as well as its words.
      task.sessions.length === 0
        ? null
        : element("span", { className: live.length > 0 ? "live-dot" : "ended-dot", "aria-hidden": "true" }),
      task.sessions.length === 0 ? "0" : `${task.sessions.length} · ${live.length > 0 ? "live" : "ended"}`,
    ),
  );
}

/** Wide tables scroll inside their own box, so the page never scrolls sideways (FR-GUI-049). */
function table(tasks, open) {
  return element("div", { className: "table-box" }, tableOf(tasks, open));
}

function tableOf(tasks, open) {
  return element(
    "table",
    { className: "task-table" },
    element(
      "thead",
      {},
      element(
        "tr",
        {},
        ["Task", "Status", "Mode", "Agents now", "Dependencies", "Sessions"].map((name) =>
          element("th", { scope: "col" }, name),
        ),
      ),
    ),
    element(
      "tbody",
      {},
      tasks.map((task) => taskRow(task, open)),
    ),
  );
}

export function drawList(canvas, open) {
  const byId = new Map(canvas.tasks.map((task) => [task.id, task]));
  const list = document.getElementById("list");
  if (canvas.roadmaps.length === 0 && canvas.unassigned.length === 0) {
    list.replaceChildren(
      element("p", { className: "muted" }, "There are no roadmaps or tasks yet. Add a task, or plan a roadmap."),
    );
    return;
  }
  list.replaceChildren(
    ...canvas.roadmaps.map((roadmap) =>
      element(
        "section",
        { className: "list-roadmap" },
        element(
          "h2",
          {},
          roadmap.title,
          element("span", { className: "muted" }, ` · ${roadmap.done} / ${roadmap.total} done`),
        ),
        roadmap.milestones.map((milestone) =>
          element(
            "div",
            { className: "list-milestone" },
            element("h3", {}, milestone.title),
            milestone.taskIds.length === 0
              ? element("p", { className: "muted" }, "No tasks in this milestone.")
              : table(milestone.taskIds.map((id) => byId.get(id)).filter(Boolean), open),
          ),
        ),
      ),
    ),
    canvas.unassigned.length === 0
      ? null
      : element(
          "section",
          { className: "list-roadmap" },
          element("h2", {}, "Unassigned tasks"),
          table(canvas.unassigned.map((id) => byId.get(id)).filter(Boolean), open),
        ),
  );
}
