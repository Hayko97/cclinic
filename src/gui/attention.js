// FR-GUI-052 and FR-GUI-053: what's waiting for the user, and the one step the canvas suggests next.
import { element, notify } from "./api.js";
import { openAutoDialog } from "./auto.js";
import { zoomToFrame } from "./canvas.js";

const state = {
  /** The last canvas and planning session, so either can redraw the Needs you list. */
  canvas: undefined,
  plan: null,
  openPlan: () => undefined,
  titleBase: "luseen",
  count: 0,
  open: () => undefined,
  showCanvas: () => undefined,
  showSetup: () => undefined,
  banner: "",
  items: "",
};

/** Every waiting workflow gate: on a task's change, or on a change with no task (FR-GUI-052). */
function itemsOf(canvas) {
  const items = canvas.tasks
    .filter((task) => task.needsYou)
    .map((task) => ({
      title: `Task #${task.id}: ${task.title}`,
      detail: task.change?.pendingQuestion ?? null,
      target: { kind: "task", id: task.id },
    }));
  for (const change of canvas.changes)
    if (change.pendingQuestion !== null && change.taskId === null)
      items.push({
        title: `Change ${change.key}`,
        detail: change.pendingQuestion,
        target: { kind: "change", key: change.key },
      });
  return items;
}

function updateTitle() {
  document.title = state.count === 0 ? state.titleBase : `(${state.count}) ${state.titleBase}`;
}

export function setTitleBase(title) {
  state.titleBase = title;
  updateTitle();
}

function closeList() {
  document.getElementById("needs-list").hidden = true;
  document.getElementById("needs-you").setAttribute("aria-expanded", "false");
}

/**
 * FR-GUI-052, FR-PLAN-045: each planning session with a proposal waiting, wherever it's driven, and the session this
 * GUI drives while the PM waits for the user's reply.
 */
function planItems(plan) {
  if (plan === null) return [];
  const items = plan.sessions
    .filter((session) => session.hasProposal)
    .map((session) => ({
      title: `Planning session ${session.id}`,
      detail: "A proposal is waiting for your approval.",
      target: { kind: "plan", id: session.id },
    }));
  const open = plan.open;
  const isWaitingForReply =
    open !== null &&
    open.status === "open" &&
    open.isHeldHere &&
    plan.turn === null &&
    !open.isAwaitingReply &&
    !open.hasProposal;
  if (isWaitingForReply)
    items.push({ title: "The PM", detail: "The PM is waiting for your reply.", target: { kind: "plan", id: open.id } });
  return items;
}

function drawNeeds(canvas) {
  state.canvas = canvas;
  const items = [...planItems(state.plan), ...itemsOf(canvas)];
  const text = JSON.stringify(items);
  if (text === state.items) return;
  state.items = text;
  state.count = items.length;
  document.getElementById("needs-count").textContent = String(items.length);
  document.getElementById("needs-you").classList.toggle("has-items", items.length > 0);
  updateTitle();
  const list = document.getElementById("needs-list");
  list.replaceChildren(
    items.length === 0
      ? element("p", { className: "muted" }, "Nothing needs you right now. Questions from your agents show up here.")
      : element(
          "ul",
          { className: "plain" },
          items.map((item) =>
            element(
              "li",
              { className: "needs-item" },
              element(
                "div",
                {},
                element("strong", {}, item.title),
                item.detail === null ? null : element("p", { className: "muted" }, item.detail),
              ),
              element(
                "button",
                {
                  type: "button",
                  className: "small",
                  onClick: () => {
                    closeList();
                    if (item.target.kind === "plan") void state.openPlan(item.target.id);
                    else state.open(item.target);
                  },
                },
                "Open",
              ),
            ),
          ),
        ),
  );
}

/** FR-GUI-053: the banner's words, and its one action. */
function bannerOf(step, canvas) {
  const roadmap = step.roadmapId === undefined ? undefined : canvas.roadmaps.find((item) => item.id === step.roadmapId);
  if (step.kind === "new-project")
    return {
      text: "This folder is empty. Start a new project: the PM interviews you, then luseen writes the specs and the first roadmap.",
      button: { label: "Start a new project", run: () => void state.openPlan({ kind: "new-project" }) },
    };
  if (step.kind === "first-task")
    return {
      text: `The project is set up. Open a coding agent in this folder, such as Claude Code, and say "work on task ${step.taskId}".`,
      button: {
        label: "Copy",
        run: () =>
          void navigator.clipboard?.writeText(`work on task ${step.taskId}`).then(
            () => notify("Copied."),
            () => notify("Couldn't copy. Select the text instead.", true),
          ),
      },
    };
  if (step.kind === "generate")
    return {
      text: "This project has no spec-driven documents yet. Generating them is the first step.",
      button: { label: "Open Setup", run: () => state.showSetup() },
    };
  if (step.kind === "plan")
    return {
      text: "There's no roadmap yet. Plan one with the PM agent.",
      button: { label: "Plan a roadmap", run: () => void state.openPlan({ kind: "new-roadmap" }) },
    };
  if (step.kind === "run" && roadmap !== undefined)
    return {
      text: `Roadmap "${roadmap.title}" has open tasks and no run.`,
      button: { label: "Run with AI", run: () => void openAutoDialog(roadmap) },
    };
  return {
    text: `An AI run (${step.runId}) is going on roadmap "${roadmap?.title ?? step.roadmapId}".`,
    button: {
      label: "Open its roadmap",
      run: () => {
        // The List has no frames to zoom to, so the Canvas is shown first.
        state.showCanvas();
        zoomToFrame(`roadmap-${step.roadmapId}`);
      },
    },
  };
}

function drawBanner(step, canvas) {
  const banner = document.getElementById("next-step");
  const text = JSON.stringify(step);
  if (text === state.banner) return;
  state.banner = text;
  banner.hidden = step === null;
  if (step === null) {
    banner.replaceChildren();
    return;
  }
  const shown = bannerOf(step, canvas);
  banner.replaceChildren(
    element("span", { className: "next-step-label" }, "Next step"),
    element("span", { className: "next-step-text" }, shown.text),
    element("button", { type: "button", className: "small primary", onClick: shown.button.run }, shown.button.label),
  );
}

/** Called with each update of the Plan panel (FR-GUI-052), and once with what opens it. */
export function setPlan(plan) {
  state.plan = plan;
  if (state.canvas !== undefined) drawNeeds(state.canvas);
}

export function onOpenPlan(open) {
  state.openPlan = open;
}

/** Called with each canvas: the Needs you count and list, the tab title, and the banner. */
export function showAttention(canvas, step) {
  drawNeeds(canvas);
  drawBanner(step ?? null, canvas);
}

/**
 * `open` shows an item where it lives, the task or change panel; `showCanvas` switches to the Canvas layout, and
 * `showSetup` to Setup.
 */
export function startAttention(open, showCanvas, showSetup) {
  state.open = open;
  state.showCanvas = showCanvas;
  state.showSetup = showSetup;
  const button = document.getElementById("needs-you");
  const list = document.getElementById("needs-list");
  button.addEventListener("click", () => {
    const isOpen = list.hidden;
    list.hidden = !isOpen;
    button.setAttribute("aria-expanded", String(isOpen));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !list.hidden) {
      closeList();
      button.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!list.hidden && !list.contains(event.target) && !button.contains(event.target)) closeList();
  });
}
