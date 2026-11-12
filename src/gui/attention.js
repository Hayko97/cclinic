// FR-GUI-052 and FR-GUI-053: what's waiting for the user, and the one step the canvas suggests next.
import { element, notify } from "./api.js";
import { zoomToFrame } from "./canvas.js";

const state = {
  titleBase: "cclinic",
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

function drawNeeds(canvas) {
  const items = itemsOf(canvas);
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
                    state.open(item.target);
                  },
                },
                "Open",
              ),
            ),
          ),
        ),
  );
}

async function copy(command) {
  try {
    await navigator.clipboard.writeText(command);
    notify(`Copied: ${command}`);
  } catch {
    notify("The browser didn't allow copying. Select the command and copy it yourself.", true);
  }
}

/** FR-GUI-053: the banner's words, and its one action. Until the GUI's own forms exist, the action is a command. */
function bannerOf(step, canvas) {
  const roadmap = step.roadmapId === undefined ? undefined : canvas.roadmaps.find((item) => item.id === step.roadmapId);
  if (step.kind === "generate")
    return {
      text: "This project has no spec-driven documents yet. Generating them is the first step.",
      button: { label: "Open Setup", run: () => state.showSetup() },
    };
  if (step.kind === "plan")
    return { text: "There's no roadmap yet. Plan one with the PM agent:", command: "cclinic plan" };
  if (step.kind === "run")
    return {
      text: `Roadmap "${roadmap?.title ?? step.roadmapId}" has open tasks and no run. Run it with AI, with AMOUNT as your budget in US dollars:`,
      command: `cclinic auto --roadmap ${step.roadmapId} --max-budget-usd AMOUNT`,
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
  const action =
    shown.command === undefined
      ? [
          element(
            "button",
            { type: "button", className: "small primary", onClick: shown.button.run },
            shown.button.label,
          ),
        ]
      : [
          element("code", {}, shown.command),
          element("button", { type: "button", className: "small", onClick: () => void copy(shown.command) }, "Copy"),
        ];
  banner.replaceChildren(
    element("span", { className: "next-step-label" }, "Next step"),
    element("span", { className: "next-step-text" }, shown.text),
    ...action,
  );
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
