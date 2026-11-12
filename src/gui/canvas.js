// The canvas (FR-GUI-067 to FR-GUI-076): roadmap frames, milestone columns, task cards and dependency arrows,
// drawn with the browser's own HTML and SVG (FR-GUI-082). Moving things only changes layout.json.
import {
  api,
  confirmAction,
  element,
  MODE_LABELS,
  money,
  notify,
  remember,
  remembered,
  ROLE_LABELS,
  runJob,
  STATUS_LABELS,
  timer,
} from "./api.js";

const ZOOM = { min: 0.25, max: 2, step: 1.2, wheelStep: 1.1 };
/** A pointer must move this far before a press becomes a drag, so a click still selects. */
const DRAG_THRESHOLD_PX = 4;
const FIT_MARGIN_PX = 40;
/** Firefox reports wheel steps in lines, not pixels. */
const WHEEL_LINE_PX = 16;
const WHEEL_DELTA_LINES = 1;
/** An arrow key moves the focused card this far (FR-GUI-080). */
const KEY_STEP_PX = 20;
/** Session nodes beside a card (FR-GUI-070). */
const SESSION_NODE = { gap: 8, height: 22, spacing: 6 };
const ARROW_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const state = {
  canvas: undefined,
  layout: undefined,
  sizes: undefined,
  frameWidths: undefined,
  /** FR-GUI-080: the server's card order, as positions by card key. */
  order: new Map(),
  /** Lookups rebuilt with each canvas, so drawing stays linear for big roadmaps (FR-GUI-081). */
  index: { tasks: new Map(), changes: new Map(), frameOf: new Map() },
  /** FR-GUI-070: session nodes beside the cards, remembered in the browser. */
  showSessions: remembered("sessions", "off") === "on",
  view: { x: FIT_MARGIN_PX, y: FIT_MARGIN_PX, scale: 1 },
  selected: undefined,
  /** A payload that arrived during a drag, applied once it ends, so the dragged item doesn't jump. */
  pending: undefined,
  isDragging: false,
  /** A layout save is on its way; updates wait for it, as they do for a drag, so a drop never jumps back. */
  savesInFlight: 0,
  /** A save ended during a press, so the update held meanwhile is older than it and the canvas is read again. */
  isPendingStale: false,
  /** `cclinic tasks` changes running now, so a second click doesn't run the same one twice (FR-GUI-020). */
  running: new Set(),
  hasFitted: false,
};

const listeners = { open: () => undefined, change: () => undefined, drawn: () => undefined };

const area = () => document.getElementById("canvas-area");
const board = () => document.getElementById("board");

export function onOpenTask(listener) {
  listeners.open = listener;
}

/** Called after each redraw, so filters and markers are applied to the new cards. */
export function onDraw(listener) {
  listeners.drawn = listener;
}

/** Called with each new canvas, so other views (List, panel) stay in step. */
export function onCanvasChange(listener) {
  listeners.change = listener;
}

export function currentCanvas() {
  return state.canvas;
}

/** FR-GUI-059: tool results longer than this are folded. */
export function foldLines() {
  return state.foldLines;
}

/** The roadmap a task is in, if any. */
export function roadmapById(id) {
  return state.canvas?.roadmaps.find((roadmap) => roadmap.id === id);
}

export function taskById(id) {
  return state.index.tasks.get(`task-${id}`);
}

/** The frames the canvas shows, each with its key, title and columns of card keys (FR-GUI-067). */
function frames(canvas) {
  return [
    ...canvas.roadmaps.map((roadmap) => ({
      key: `roadmap-${roadmap.id}`,
      roadmap,
      title: roadmap.title,
      columns: roadmap.milestones.map((milestone) => ({
        milestone,
        cards: milestone.taskIds.map((id) => `task-${id}`),
      })),
    })),
    ...(canvas.unassigned.length === 0
      ? []
      : [
          {
            key: "unassigned",
            title: "Unassigned tasks",
            columns: [{ cards: canvas.unassigned.map((id) => `task-${id}`) }],
          },
        ]),
    ...(canvas.changes.length === 0
      ? []
      : [
          {
            key: "changes",
            title: "Changes without a task",
            columns: [{ cards: canvas.changes.map((change) => `change-${change.key}`) }],
          },
        ]),
  ];
}

/**
 * A frame is as wide as its columns, as the server lays frames out (FR-GUI-074), so frames never overlap; cards
 * can't be dropped past that width. It grows downwards to hold cards moved below its columns.
 */
function frameSize(frame) {
  const { sizes, layout } = state;
  // The server's width for the frame, so drawing, drops and the automatic layout agree (FR-GUI-074).
  const width = state.frameWidths[frame.key];
  const rows = Math.max(1, ...frame.columns.map((column) => column.cards.length));
  let height = sizes.frameHeader + rows * (sizes.cardHeight + sizes.rowGap) - sizes.rowGap + sizes.framePadding;
  for (const key of frame.columns.flatMap((column) => column.cards)) {
    const point = layout.cards[key];
    if (point === undefined) continue;
    height = Math.max(height, point.y + sizes.cardHeight + sizes.framePadding);
  }
  return { width, height };
}

function badge(text, className) {
  return element("span", { className: `badge ${className}` }, text);
}

function liveAgents(task) {
  return task.sessions.filter((session) => session.isLive);
}

/** FR-GUI-080: the card's accessible name holds its ID, title, status and mode. */
function taskLabel(task) {
  const mode = task.mode === null ? "no mode" : MODE_LABELS[task.mode];
  return `Task #${task.id}: ${task.title}. ${STATUS_LABELS[task.status] ?? task.status}, ${mode}`;
}

/** FR-GUI-068: what a task card shows. */
function taskCard(task) {
  const live = liveAgents(task);
  return element(
    "div",
    {
      className: `card task-card status-${task.status}`,
      role: "button",
      tabindex: 0,
      "aria-label": taskLabel(task),
      "data-key": `task-${task.id}`,
      "data-task": task.id,
    },
    element(
      "div",
      { className: "card-head" },
      element("span", { className: "card-id" }, `#${task.id}`),
      badge(STATUS_LABELS[task.status] ?? task.status, `status status-${task.status}`),
      task.mode === null ? null : badge(MODE_LABELS[task.mode], `mode mode-${task.mode}`),
      task.needsYou ? badge("Needs you", "needs-you") : null,
    ),
    element("div", { className: "card-title" }, task.title),
    task.description === null || task.description === ""
      ? null
      : element("div", { className: "card-description" }, task.description),
    element(
      "div",
      { className: "card-meta" },
      task.spec === null ? null : element("span", { className: "spec" }, task.spec),
      task.step === null ? null : element("span", { className: "card-step" }, task.step),
      task.waitingOn.length === 0
        ? null
        : element("span", { className: "waiting" }, `Waiting on ${task.waitingOn.map((id) => `#${id}`).join(", ")}`),
    ),
    element(
      "div",
      { className: "card-foot" },
      element(
        "span",
        { className: "agents" },
        live.map((session) => badge(ROLE_LABELS[session.role] ?? session.role, `agent role-${session.role}`)),
      ),
      element(
        "span",
        { className: "sessions", title: "Claude Code sessions" },
        live.length > 0 ? element("span", { className: "live-dot", "aria-hidden": "true" }) : null,
        `${task.sessions.length} session${task.sessions.length === 1 ? "" : "s"}`,
      ),
      element("span", { className: "cost" }, money(task.costUsd)),
    ),
  );
}

function changeCard(change) {
  return element(
    "div",
    {
      className: "card change-card",
      role: "button",
      tabindex: 0,
      "aria-label": `Change ${change.key}: ${change.spec}, ${change.status}`,
      "data-key": `change-${change.key}`,
      "data-change": change.key,
    },
    element(
      "div",
      { className: "card-head" },
      element("span", { className: "card-id" }, change.key),
      badge(change.status, `status status-${change.status}`),
      change.pendingQuestion === null ? null : badge("Needs you", "needs-you"),
    ),
    element("div", { className: "card-title" }, change.spec),
    element("div", { className: "card-meta" }, element("span", { className: "card-step" }, change.step)),
  );
}

const ROADMAP_STATUS_LABELS = { planned: "Planned", "in-progress": "In progress", done: "Done" };

/** FR-GUI-056: how long a roadmap's live run has been going, and its budget used as a bar with the amount. */
export function runProgress(roadmap) {
  if (roadmap.runStartedAt === null) return null;
  const budget =
    roadmap.budgetUsd === null
      ? null
      : element(
          "span",
          { className: "budget" },
          element("progress", {
            max: roadmap.budgetUsd,
            value: Math.min(roadmap.spentUsd ?? 0, roadmap.budgetUsd),
            "aria-label": "Budget used",
          }),
          `${money(roadmap.spentUsd ?? 0)} of ${money(roadmap.budgetUsd)}`,
        );
  return element("span", { className: "run-progress" }, timer(roadmap.runStartedAt, "Running for "), budget);
}

/** FR-GUI-067: the frame's title and actions, then its status, mode and progress, then its goal. */
function frameHeader(frame) {
  const { roadmap } = frame;
  const actions = element(
    "span",
    { className: "frame-actions" },
    element(
      "button",
      { type: "button", className: "small", "data-action": "tidy", "aria-label": `Tidy up ${frame.title}` },
      "Tidy up",
    ),
    roadmap === undefined
      ? null
      : element(
          "button",
          {
            type: "button",
            className: "small danger",
            "data-action": "remove-roadmap",
            "aria-label": `Remove roadmap ${roadmap.title}`,
          },
          "Remove",
        ),
  );
  const top = element("div", { className: "frame-top" }, element("h2", { title: frame.title }, frame.title), actions);
  if (roadmap === undefined) {
    const count = frame.columns[0].cards.length;
    const noun = frame.key === "changes" ? "change" : "task";
    const note = frame.key === "changes" ? "in a workflow, not a task" : "not in a roadmap";
    return element(
      "header",
      { className: "frame-head" },
      top,
      element("div", { className: "frame-meta" }, `${count} ${noun}${count === 1 ? "" : "s"} · ${note}`),
    );
  }
  return element(
    "header",
    { className: "frame-head" },
    top,
    element(
      "div",
      { className: "frame-meta" },
      badge(ROADMAP_STATUS_LABELS[roadmap.status] ?? roadmap.status, `status status-${roadmap.status}`),
      roadmap.mode === null ? null : badge(`${MODE_LABELS[roadmap.mode]} · ${roadmap.runId}`, "mode mode-ai"),
      element("span", { className: "progress" }, `${roadmap.done} / ${roadmap.total} done`),
      runProgress(roadmap),
    ),
    roadmap.goal === null ? null : element("p", { className: "frame-goal", title: roadmap.goal }, roadmap.goal),
  );
}

function columnLabel(column, index) {
  const { sizes } = state;
  const label = element(
    "div",
    { className: "column-label" },
    element("span", {}, column.milestone?.title ?? ""),
    column.milestone === undefined
      ? null
      : element(
          "button",
          {
            type: "button",
            className: "icon danger",
            "data-action": "remove-milestone",
            "data-milestone": column.milestone.id,
            "aria-label": `Remove milestone ${column.milestone.title}`,
          },
          "×",
        ),
  );
  label.style.left = `${sizes.framePadding + index * (sizes.cardWidth + sizes.columnGap)}px`;
  label.style.width = `${sizes.cardWidth}px`;
  return label;
}

function drawFrame(frame) {
  const { layout } = state;
  const point = layout.frames[frame.key];
  const size = frameSize(frame);
  const node = element(
    "section",
    {
      className: `frame${frame.roadmap?.mode === "ai" ? " is-ai" : ""}`,
      "data-frame": frame.key,
      "aria-label": frame.title,
    },
    frameHeader(frame),
    frame.roadmap === undefined ? [] : frame.columns.map(columnLabel),
  );
  node.style.left = `${point.x}px`;
  node.style.top = `${point.y}px`;
  node.style.width = `${size.width}px`;
  node.style.height = `${size.height}px`;
  // FR-GUI-080: the page's order is the keyboard's, so Tab follows roadmaps and dependencies.
  const keys = frame.columns.flatMap((column) => column.cards);
  keys.sort((a, b) => (state.order.get(a) ?? 0) - (state.order.get(b) ?? 0));
  for (const key of keys) {
    const task = state.index.tasks.get(key);
    const card = task === undefined ? changeCard(state.index.changes.get(key)) : taskCard(task);
    placeCard(card, layout.cards[key]);
    node.append(card);
    if (state.showSessions && task !== undefined) node.append(...sessionNodes(task, layout.cards[key]));
  }
  return node;
}

/** FR-GUI-070: a task's sessions as small nodes beside its card, each with its role and whether it's live. */
/** As many nodes as fit beside the card and the gap below it, so they never reach the next card. */
function sessionNodeLimit() {
  return Math.floor((state.sizes.cardHeight + state.sizes.rowGap) / (SESSION_NODE.height + SESSION_NODE.spacing));
}

function sessionNodes(task, point) {
  const limit = sessionNodeLimit();
  const shown = task.sessions.length > limit ? task.sessions.slice(0, limit - 1) : task.sessions;
  const nodes = shown.map((session, index) => {
    const role = ROLE_LABELS[session.role] ?? session.role;
    const status = session.isLive ? "live" : "ended";
    const node = element(
      "button",
      {
        type: "button",
        className: `session-node${session.isLive ? " is-live" : ""}`,
        "data-action": "open-session",
        "data-task": task.id,
        "data-session": session.id,
        "aria-label": `Task #${task.id} session: ${role}, ${status}`,
      },
      element("span", { className: session.isLive ? "live-dot" : "ended-dot", "aria-hidden": "true" }),
      `${role} (${status})`,
    );
    placeSessionNode(node, point, index);
    return node;
  });
  const hidden = task.sessions.length - shown.length;
  if (hidden > 0) {
    // The rest are one click away, in the task's panel.
    const more = element(
      "button",
      {
        type: "button",
        className: "session-node",
        "data-action": "more-sessions",
        "data-task": task.id,
        "aria-label": `Task #${task.id}: ${hidden} more sessions`,
      },
      `+${hidden} more`,
    );
    placeSessionNode(more, point, shown.length);
    nodes.push(more);
  }
  return nodes;
}

function sessionNodePoint(point, index) {
  return {
    x: point.x + state.sizes.cardWidth + SESSION_NODE.gap,
    y: point.y + index * (SESSION_NODE.height + SESSION_NODE.spacing),
  };
}

function placeSessionNode(node, point, index) {
  const at = sessionNodePoint(point, index);
  node.style.left = `${at.x}px`;
  node.style.top = `${at.y}px`;
  node.style.maxWidth = `${state.sizes.columnGap - SESSION_NODE.gap * 2}px`;
}

/** Keeps a card's session nodes beside it while it's dragged. */
function moveSessionNodes(card, point) {
  const frame = card.parentElement;
  frame.querySelectorAll(`.session-node[data-task="${card.dataset.task}"]`).forEach((node, index) => {
    placeSessionNode(node, point, index);
  });
}

export function setShowSessions(isOn) {
  state.showSessions = isOn;
  remember("sessions", isOn ? "on" : "off");
  if (state.canvas !== undefined) draw();
}

export function isShowingSessions() {
  return state.showSessions;
}

function placeCard(card, point) {
  card.style.left = `${point.x}px`;
  card.style.top = `${point.y}px`;
  card.style.width = `${state.sizes.cardWidth}px`;
  card.style.height = `${state.sizes.cardHeight}px`;
}

/** A card's box on the board: its frame's position plus its own. */
function cardBox(key) {
  const frameKey = frameOf(key);
  const frame = state.layout.frames[frameKey];
  const card = state.layout.cards[key];
  if (frame === undefined || card === undefined) return undefined;
  return { x: frame.x + card.x, y: frame.y + card.y, width: state.sizes.cardWidth, height: state.sizes.cardHeight };
}

function frameOf(key) {
  return state.index.frameOf.get(key);
}

/** FR-GUI-069: an arrow from the task depended on to the one that depends on it, solid once done. */
function arrowPath(from, to) {
  const isBeside = to.x >= from.x + from.width || to.x + to.width <= from.x;
  if (isBeside) {
    const goesRight = to.x >= from.x + from.width;
    const start = { x: goesRight ? from.x + from.width : from.x, y: from.y + from.height / 2 };
    const end = { x: goesRight ? to.x : to.x + to.width, y: to.y + to.height / 2 };
    const bend = (end.x - start.x) / 2;
    return `M${start.x},${start.y} C${start.x + bend},${start.y} ${end.x - bend},${end.y} ${end.x},${end.y}`;
  }
  const goesDown = to.y >= from.y;
  const start = { x: from.x + from.width / 2, y: goesDown ? from.y + from.height : from.y };
  const end = { x: to.x + to.width / 2, y: goesDown ? to.y : to.y + to.height };
  const bend = (end.y - start.y) / 2;
  return `M${start.x},${start.y} C${start.x},${start.y + bend} ${end.x},${end.y - bend} ${end.x},${end.y}`;
}

function drawArrows() {
  const svg = document.getElementById("arrows");
  const statusOf = new Map(state.canvas.tasks.map((task) => [task.id, task.status]));
  const paths = [];
  for (const task of state.canvas.tasks)
    for (const parent of task.dependsOn) {
      const from = cardBox(`task-${parent}`);
      const to = cardBox(`task-${task.id}`);
      if (from === undefined || to === undefined) continue;
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", arrowPath(from, to));
      path.setAttribute("class", `arrow ${statusOf.get(parent) === "done" ? "is-done" : "is-open"}`);
      path.setAttribute("marker-end", "url(#arrow-head)");
      path.dataset.from = String(parent);
      path.dataset.to = String(task.id);
      paths.push(path);
    }
  // FR-GUI-070: a line from each card to its session nodes.
  if (state.showSessions)
    for (const task of state.canvas.tasks) {
      const key = `task-${task.id}`;
      const box = cardBox(key);
      const frame = state.layout.frames[frameOf(key)];
      if (box === undefined || frame === undefined) continue;
      const count = Math.min(task.sessions.length, sessionNodeLimit());
      Array.from({ length: count }).forEach((_unused, index) => {
        const at = sessionNodePoint(state.layout.cards[key], index);
        const path = document.createElementNS(svg.namespaceURI, "path");
        const end = { x: frame.x + at.x, y: frame.y + at.y + SESSION_NODE.height / 2 };
        path.setAttribute("d", `M${box.x + box.width},${box.y + box.height / 2} L${end.x},${end.y}`);
        path.setAttribute("class", "session-link");
        paths.push(path);
      });
    }
  svg.querySelectorAll("path.arrow, path.session-link").forEach((path) => path.remove());
  svg.append(...paths);
}

/** FR-GUI-069: a selected card's arrows and the cards they connect stand out, and the rest is dimmed. */
function highlight() {
  const root = board();
  const id = state.selected;
  root.classList.toggle("has-selection", id !== undefined);
  const task = id === undefined ? undefined : taskById(id);
  const linked = new Set(
    task === undefined
      ? []
      : [id, ...task.dependsOn, ...state.canvas.tasks.filter((other) => other.dependsOn.includes(id)).map((t) => t.id)],
  );
  root.querySelectorAll(".task-card").forEach((card) => {
    const cardId = Number(card.dataset.task);
    card.classList.toggle("is-selected", cardId === id);
    card.classList.toggle("is-linked", linked.has(cardId));
  });
  root.querySelectorAll("path.arrow").forEach((path) => {
    path.classList.toggle("is-linked", Number(path.dataset.from) === id || Number(path.dataset.to) === id);
  });
}

function applyView() {
  const { x, y, scale } = state.view;
  board().style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  document.getElementById("zoom-level").textContent = `${Math.round(scale * 100)} %`;
}

function draw() {
  const { canvas } = state;
  const empty = document.getElementById("canvas-empty");
  const all = frames(canvas);
  empty.hidden = all.length > 0;
  const layer = document.getElementById("frames");
  // A redraw replaces the cards, so keyboard focus goes back to the same card or button (FR-GUI-080).
  const focused = document.activeElement?.closest?.("#frames [data-key], #frames button[data-action]");
  const focusKey = focused === null || focused === undefined ? undefined : focusSelector(focused);
  layer.replaceChildren(...all.map(drawFrame));
  if (focusKey !== undefined) layer.querySelector(focusKey)?.focus({ preventScroll: true });
  drawArrows();
  highlight();
  applyView();
  listeners.drawn();
  const problems = document.getElementById("canvas-problems");
  problems.replaceChildren(...canvas.problems.map((problem) => element("li", {}, problem)));
  problems.hidden = canvas.problems.length === 0;
}

/** A selector that finds the same card or button again after a redraw. */
function focusSelector(node) {
  if (node.dataset.key !== undefined) return `[data-key="${CSS.escape(node.dataset.key)}"]`;
  const frame = node.closest("[data-frame]")?.dataset.frame ?? "";
  let selector = `[data-frame="${CSS.escape(frame)}"] button[data-action="${CSS.escape(node.dataset.action)}"]`;
  for (const name of ["task", "session", "milestone"])
    if (node.dataset[name] !== undefined) selector += `[data-${name}="${CSS.escape(node.dataset[name])}"]`;
  return selector;
}

function indexOf(payload) {
  const tasks = new Map(payload.canvas.tasks.map((task) => [`task-${task.id}`, task]));
  const changes = new Map(payload.canvas.changes.map((change) => [`change-${change.key}`, change]));
  const frameOfCard = new Map();
  for (const frame of frames(payload.canvas))
    for (const column of frame.columns) for (const key of column.cards) frameOfCard.set(key, frame.key);
  return { tasks, changes, frameOf: frameOfCard };
}

function receive(payload) {
  if (state.isDragging || state.savesInFlight > 0) {
    state.pending = payload;
    return;
  }
  state.canvas = payload.canvas;
  state.index = indexOf(payload);
  state.order = new Map(payload.cardOrder.map((key, position) => [key, position]));
  state.layout = payload.layout;
  state.sizes = payload.sizes;
  state.foldLines = payload.foldLines;
  state.frameWidths = payload.frameWidths;
  if (state.selected !== undefined && taskById(state.selected) === undefined) state.selected = undefined;
  draw();
  // The banner and filters follow the canvas first, so the first Fit uses the canvas's final size.
  listeners.change(payload.canvas, payload);
  if (!state.hasFitted && frames(payload.canvas).length > 0 && area().clientWidth > 0) {
    state.hasFitted = true;
    fit();
  }
}

/**
 * FR-GUI-073: saved once a drag ends. Only positions moved by hand are sent, so everything else is still
 * placed automatically (FR-GUI-074); the server keeps only what's still on the canvas.
 */
async function saveLayout(change) {
  state.savesInFlight += 1;
  try {
    // Only what moved: the server adds it to what's saved, so another tab's moves aren't undone.
    await api("/api/layout", {
      method: "PUT",
      body: JSON.stringify({ version: state.layout.version, frames: {}, cards: {}, ...change }),
    });
  } catch (error) {
    notify(`The layout wasn't saved: ${error.message}`, true);
  } finally {
    state.savesInFlight -= 1;
  }
  // Updates held during the saves are older than them, so once the last one ends the canvas is read again,
  // whether or not it worked, so no update is lost (FR-GUI-075).
  if (state.savesInFlight > 0 || state.pending === undefined) return;
  if (state.isDragging) {
    state.isPendingStale = true;
    return;
  }
  state.pending = undefined;
  await refresh().catch((error) => notify(error.message, true));
}

function zoomAt(scale, clientX, clientY) {
  const next = Math.min(ZOOM.max, Math.max(ZOOM.min, scale));
  const rect = area().getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const { view } = state;
  // The point under the pointer stays under it (FR-GUI-072).
  view.x = px - ((px - view.x) * next) / view.scale;
  view.y = py - ((py - view.y) * next) / view.scale;
  view.scale = next;
  applyView();
}

function zoomCentre(factor) {
  const rect = area().getBoundingClientRect();
  zoomAt(state.view.scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/** FR-GUI-072: every frame in view. */
export function fit() {
  // A hidden canvas has no size to fit to.
  if (state.canvas === undefined || area().clientWidth === 0) return;
  const all = frames(state.canvas);
  if (all.length === 0) return;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const frame of all) {
    const point = state.layout.frames[frame.key];
    const size = frameSize(frame);
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x + size.width);
    bottom = Math.max(bottom, point.y + size.height);
  }
  const width = area().clientWidth - FIT_MARGIN_PX * 2;
  const height = area().clientHeight - FIT_MARGIN_PX * 2;
  const scale = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.min(width / (right - left), height / (bottom - top))));
  // Centred, unless the board is still bigger than the view at the smallest zoom: then it starts at its
  // top-left, so every frame is at least partly in view (FR-GUI-072). Whole pixels keep text sharp.
  const offset = (room, size) => Math.max(0, (room - size * scale) / 2);
  state.view = {
    scale,
    x: Math.round(FIT_MARGIN_PX + offset(width, right - left) - left * scale),
    y: Math.round(FIT_MARGIN_PX + offset(height, bottom - top) - top * scale),
  };
  applyView();
}

/** FR-GUI-079: one frame in view, as the roadmap picker asks. */
export function zoomToFrame(key) {
  const frame = state.canvas === undefined ? undefined : frames(state.canvas).find((item) => item.key === key);
  const point = state.layout?.frames[key];
  if (frame === undefined || point === undefined || area().clientWidth === 0) return;
  const size = frameSize(frame);
  const width = area().clientWidth - FIT_MARGIN_PX * 2;
  const height = area().clientHeight - FIT_MARGIN_PX * 2;
  const scale = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.min(width / size.width, height / size.height)));
  state.view = {
    scale,
    x: Math.round(FIT_MARGIN_PX + Math.max(0, (width - size.width * scale) / 2) - point.x * scale),
    y: Math.round(FIT_MARGIN_PX + Math.max(0, (height - size.height * scale) / 2) - point.y * scale),
  };
  applyView();
}

export function selectTask(id) {
  state.selected = id;
  highlight();
}

/**
 * Pointer handling: drag empty space to pan, a frame's header to move the frame, or a card to move it within
 * its frame (FR-GUI-072, FR-GUI-073). A press that doesn't move is a click.
 */
function startPointer(event) {
  if (event.button !== 0 || event.target.closest("button") !== null) return;
  const card = event.target.closest(".card");
  const frameHead = event.target.closest(".frame-head");
  const frameNode = event.target.closest(".frame");
  const start = { x: event.clientX, y: event.clientY };
  const { view } = state;
  let move;
  let end = () => undefined;
  let cancel = () => undefined;
  if (card !== null) {
    const key = card.dataset.key;
    const from = { ...state.layout.cards[key] };
    const frameKey = frameNode.dataset.frame;
    const frame = frames(state.canvas).find((item) => item.key === frameKey);
    const size = frameSize(frame);
    move = (dx, dy) => {
      const point = { x: from.x + dx / view.scale, y: from.y + dy / view.scale };
      state.layout.cards[key] = point;
      placeCard(card, point);
      moveSessionNodes(card, point);
      drawArrows();
      highlight();
    };
    cancel = () => {
      state.layout.cards[key] = from;
    };
    end = (isMoved) => {
      if (!isMoved) {
        click(card);
        return undefined;
      }
      const point = state.layout.cards[key];
      const centre = { x: point.x + state.sizes.cardWidth / 2, y: point.y + state.sizes.cardHeight / 2 };
      // FR-GUI-073: a card stays in its own frame; dropped outside it, it goes back, and nothing changed.
      const isInside = centre.x >= 0 && centre.y >= 0 && centre.x <= size.width && centre.y <= size.height;
      if (!isInside) {
        cancel();
        return undefined;
      }
      const dropped = clampToFrame(size, { x: Math.round(point.x), y: Math.round(point.y) });
      state.layout.cards[key] = dropped;
      return { cards: { [key]: dropped } };
    };
  } else if (frameHead !== null) {
    const key = frameNode.dataset.frame;
    const from = { ...state.layout.frames[key] };
    move = (dx, dy) => {
      const point = { x: from.x + dx / view.scale, y: from.y + dy / view.scale };
      state.layout.frames[key] = point;
      frameNode.style.left = `${point.x}px`;
      frameNode.style.top = `${point.y}px`;
      drawArrows();
      highlight();
    };
    cancel = () => {
      state.layout.frames[key] = from;
    };
    end = (isMoved) => {
      if (!isMoved) return undefined;
      const point = state.layout.frames[key];
      const dropped = { x: Math.round(point.x), y: Math.round(point.y) };
      state.layout.frames[key] = dropped;
      return { frames: { [key]: dropped } };
    };
  } else {
    const from = { x: view.x, y: view.y };
    move = (dx, dy) => {
      view.x = from.x + dx;
      view.y = from.y + dy;
      applyView();
    };
    cancel = () => {
      view.x = from.x;
      view.y = from.y;
    };
    end = (isMoved) => {
      if (!isMoved && frameNode === null) {
        selectTask(undefined);
        listeners.open(undefined);
      }
      return undefined;
    };
  }
  let isMoved = false;
  const target = area();
  target.setPointerCapture(event.pointerId);
  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - start.x;
    const dy = moveEvent.clientY - start.y;
    if (!isMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!isMoved) {
      isMoved = true;
      target.classList.add("is-dragging");
    }
    move(dx, dy);
  };
  const finish = (isCancelled) => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointercancel", onCancel);
    target.classList.remove("is-dragging");
    // A press the browser cancels, such as a gesture, puts things back and opens nothing.
    if (isCancelled) cancel();
    const change = isCancelled ? undefined : end(isMoved);
    state.isDragging = false;
    if (isCancelled || (isMoved && change === undefined)) draw();
    if (change !== undefined) {
      draw();
      // Nothing is written while dragging, only once it ends (FR-GUI-073). An update held meanwhile stays
      // held until the save ends.
      void saveLayout(change);
    } else if (state.pending !== undefined && state.savesInFlight === 0) {
      const pending = state.pending;
      state.pending = undefined;
      // An update held past the end of a save is older than it, so the canvas is read again instead
      // (FR-GUI-073, FR-GUI-075).
      if (state.isPendingStale) void refresh().catch((error) => notify(error.message, true));
      else receive(pending);
    }
    state.isPendingStale = false;
    applyView();
  };
  const onUp = () => finish(false);
  const onCancel = () => finish(true);
  // From the press on, updates wait, so the element being dragged is still the one on the page.
  if (card !== null || frameHead !== null) state.isDragging = true;
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onUp);
  target.addEventListener("pointercancel", onCancel);
}

/**
 * FR-GUI-080: an arrow key moves the focused card one step within its frame, saved as a drop is (FR-GUI-073).
 * Updates wait while it saves, as they do for a drag.
 */
/**
 * FR-GUI-073: a card stays in its frame: below the header, and from the first column to the last, never in the
 * room beside the last column that's kept for session nodes (FR-GUI-070).
 */
function clampToFrame(size, point) {
  const { framePadding, columnGap, cardWidth, frameHeader } = state.sizes;
  return {
    x: Math.min(size.width - framePadding - columnGap - cardWidth, Math.max(framePadding, point.x)),
    y: Math.max(frameHeader, point.y),
  };
}

function nudge(card, [dx, dy]) {
  const key = card.dataset.key;
  const frame = frames(state.canvas).find((item) => item.key === frameOf(key));
  const size = frameSize(frame);
  const from = state.layout.cards[key];
  const point = clampToFrame(size, { x: from.x + dx * KEY_STEP_PX, y: from.y + dy * KEY_STEP_PX });
  if (point.x === from.x && point.y === from.y) return;
  state.layout.cards[key] = point;
  draw();
  void saveLayout({ cards: { [key]: point } });
}

function click(card) {
  if (card.dataset.task !== undefined) {
    const id = Number(card.dataset.task);
    selectTask(id);
    listeners.open({ kind: "task", id });
  } else listeners.open({ kind: "change", key: card.dataset.change });
}

async function frameAction(button) {
  const frameKey = button.closest(".frame").dataset.frame;
  const action = button.dataset.action;
  const frame = frames(state.canvas).find((item) => item.key === frameKey);
  if (action === "tidy") {
    // FR-GUI-074: asks first, as it forgets where this frame's cards were put by hand.
    const isSure = await confirmAction(
      `Tidy up "${frame.title}"? Its cards go back to their automatic places.`,
      "Tidy up",
    );
    if (!isSure) return;
    try {
      await api("/api/layout/tidy", { method: "POST", body: JSON.stringify({ frame: frameKey }) });
      await refresh();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (action === "remove-roadmap") {
    const { roadmap } = frame;
    if (!(await confirmAction(`Remove roadmap "${roadmap.title}" and its milestones?`, "Remove roadmap"))) return;
    await runAndReport({ command: "roadmap-remove", id: roadmap.id }, `Removed roadmap ${roadmap.id}.`);
    return;
  }
  if (action === "remove-milestone") {
    const id = Number(button.dataset.milestone);
    const milestone = frame.columns.find((column) => column.milestone?.id === id)?.milestone;
    if (!(await confirmAction(`Remove milestone "${milestone.title}"?`, "Remove milestone"))) return;
    await runAndReport({ command: "milestone-remove", id }, `Removed milestone ${id}.`);
  }
}

/** Runs a `cclinic tasks` change and says how it went; the canvas stream shows the result (FR-GUI-020). */
export async function runAndReport(request, success) {
  const key = JSON.stringify(request);
  if (state.running.has(key)) {
    notify("That's already running.");
    return { isDone: false, message: "That's already running." };
  }
  state.running.add(key);
  try {
    await runJob(request);
    notify(success);
    await refresh();
    return { isDone: true, message: success };
  } catch (error) {
    notify(error.message, true);
    return { isDone: false, message: error.message };
  } finally {
    state.running.delete(key);
  }
}

export async function refresh() {
  receive(await api("/api/canvas"));
}

function isTyping(event) {
  return event.target.closest("input, textarea, select, [contenteditable]") !== null;
}

export function startCanvas() {
  const target = area();
  target.addEventListener("pointerdown", startPointer);
  target.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button === null) return;
    if (button.dataset.action === "open-session" || button.dataset.action === "more-sessions") {
      // FR-GUI-071: a session node opens its task's panel on that session; "+N more" on its newest.
      const id = Number(button.dataset.task);
      selectTask(id);
      listeners.open({ kind: "task", id }, button.dataset.session);
    } else void frameAction(button);
  });
  target.addEventListener("keydown", (event) => {
    const card = event.target.closest(".card");
    if (card === null) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      click(card);
    } else if (event.key in ARROW_KEYS && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      nudge(card, ARROW_KEYS[event.key]);
    }
  });
  target.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      // A pinch arrives as Ctrl+wheel (FR-GUI-072).
      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaY < 0 ? ZOOM.wheelStep : 1 / ZOOM.wheelStep;
        zoomAt(state.view.scale * factor, event.clientX, event.clientY);
      } else {
        const unit = event.deltaMode === WHEEL_DELTA_LINES ? WHEEL_LINE_PX : 1;
        state.view.x -= event.deltaX * unit;
        state.view.y -= event.deltaY * unit;
        applyView();
      }
    },
    { passive: false },
  );
  document.addEventListener("keydown", (event) => {
    // Only while the canvas itself is shown, not the List.
    if (area().offsetParent === null || isTyping(event) || event.ctrlKey || event.metaKey) return;
    if (document.querySelector("dialog[open]") !== null) return;
    if (event.key === "+" || event.key === "=") zoomCentre(ZOOM.step);
    else if (event.key === "-") zoomCentre(1 / ZOOM.step);
    else if (event.key === "0") fit();
  });
  document.getElementById("zoom-in").addEventListener("click", () => zoomCentre(ZOOM.step));
  document.getElementById("zoom-out").addEventListener("click", () => zoomCentre(1 / ZOOM.step));
  document.getElementById("zoom-fit").addEventListener("click", fit);

  const events = new EventSource("/api/canvas/events");
  events.addEventListener("canvas", (message) => receive(JSON.parse(message.data)));
  events.addEventListener("problem", (message) => notify(JSON.parse(message.data).message, true));
}

/** Called when the canvas is shown again, since a hidden canvas has no size to fit to. */
export function showCanvas() {
  if (!state.hasFitted && state.canvas !== undefined && frames(state.canvas).length > 0) {
    state.hasFitted = true;
    fit();
  }
}
