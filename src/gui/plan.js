// Plan with the PM (FR-GUI-023 to FR-GUI-026): the same session as `cclinic plan`, followed live, one at a time.
import { api, element, notify } from "./api.js";
import { setPlan } from "./attention.js";
import { ensureModels, numberOrText } from "./setup.js";

/** `plan` is the session as the server last sent it; `target` is what the form will plan if started. */
const state = { plan: null, target: { kind: "new-roadmap" }, feedback: "", answer: "", isRefining: false };

const byId = (id) => document.getElementById(id);
const FINAL_STEPS = new Set(["saved", "cancelled", "failed"]);
const isGoing = (plan) => plan !== null && !FINAL_STEPS.has(plan.step);

function targetText(target) {
  if (target.kind === "new-roadmap") return "A new roadmap.";
  if (target.kind === "extend-roadmap") return `More milestones and tasks for roadmap #${target.roadmapId}.`;
  return target.roadmapId === null ? "One standalone task." : `One task in roadmap #${target.roadmapId}.`;
}

function showError(message) {
  byId("plan-error").textContent = message;
}

/**
 * Sends a choice. The session's new state comes from the stream, never from this reply, which can arrive after a
 * newer update and would show an older step.
 */
async function post(path, body) {
  showError("");
  try {
    await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    return true;
  } catch (error) {
    showError(error.message);
    return false;
  }
}

function buttonRow(...buttons) {
  return element("div", { className: "actions" }, ...buttons);
}

function button(label, onClick, className) {
  return element("button", { type: "button", className, onClick }, label);
}

const cancelButton = () => button("Cancel planning", () => void post("/api/plan/cancel"));

/** FR-GUI-024: the PM's question as a form. What's typed survives a redraw. */
function questionForm(plan) {
  const text = element("textarea", { id: "plan-answer", rows: 4, "aria-label": "Your answer" });
  text.value = state.answer;
  text.addEventListener("input", () => {
    state.answer = text.value;
  });
  return element(
    "form",
    {
      className: "plan-question",
      onSubmit: async (event) => {
        event.preventDefault();
        if (await post("/api/plan/answer", { text: state.answer })) state.answer = "";
      },
    },
    element("p", { className: "plan-question-text" }, plan.question),
    element("label", { for: "plan-answer" }, "Your answer"),
    text,
    buttonRow(cancelButton(), element("button", { type: "submit", className: "primary" }, "Send answer")),
  );
}

/** FR-GUI-024: the proposal in full, with approve, refine with feedback, and cancel. */
function review(plan) {
  const parts = [element("pre", { className: "plan-proposal" }, plan.proposal)];
  if (state.isRefining) {
    const text = element("textarea", { id: "plan-feedback", rows: 3 });
    text.value = state.feedback;
    text.addEventListener("input", () => {
      state.feedback = text.value;
    });
    parts.push(
      element("label", { for: "plan-feedback" }, "Your feedback for the PM"),
      text,
      buttonRow(
        button("Back", () => {
          state.isRefining = false;
          draw();
        }),
        button(
          "Send feedback",
          async () => {
            if (await post("/api/plan/review", { choice: "refine", feedback: state.feedback })) {
              state.feedback = "";
              state.isRefining = false;
            }
          },
          "primary",
        ),
      ),
    );
  } else {
    parts.push(
      buttonRow(
        button("Cancel", () => void post("/api/plan/review", { choice: "cancel" })),
        button("Refine", () => {
          state.isRefining = true;
          draw();
          byId("plan-feedback")?.focus();
        }),
        button("Approve and save", () => void post("/api/plan/review", { choice: "approve" }), "primary"),
      ),
    );
  }
  return element("div", { className: "plan-review" }, ...parts);
}

function ended(plan) {
  return element(
    "div",
    { className: "plan-ended" },
    element("p", { className: plan.step === "failed" ? "error" : "", role: "status" }, plan.message),
    plan.proposal === null ? null : element("pre", { className: "plan-proposal" }, plan.proposal),
    buttonRow(button("Close", () => byId("plan-dialog").close())),
  );
}

/** Shows the form to start, or the session as it is now. */
function draw() {
  const { plan } = state;
  const isShowingSession = plan !== null && (isGoing(plan) || !byId("plan-form").dataset.fresh);
  byId("plan-form").hidden = isShowingSession;
  const session = byId("plan-session");
  session.hidden = !isShowingSession;
  byId("plan-target").textContent = targetText(isShowingSession ? plan.target : state.target);
  // FR-GUI-023: from New roadmap, the choice `cclinic plan` offers between a roadmap and a standalone task.
  const { kind, roadmapId } = state.target;
  byId("plan-what").hidden = !(kind === "new-roadmap" || (kind === "task" && roadmapId === null));
  if (!isShowingSession) return;
  const focused = document.activeElement?.id;
  session.replaceChildren(
    plan.step === "thinking"
      ? element(
          "div",
          {},
          element("p", { className: "muted", role: "status" }, "The PM is thinking…"),
          buttonRow(cancelButton()),
        )
      : plan.step === "question"
        ? questionForm(plan)
        : plan.step === "review"
          ? review(plan)
          : ended(plan),
  );
  if (focused !== undefined && focused !== "") byId(focused)?.focus();
}

/** Each update of the session, from the stream or a reply (FR-GUI-026). */
function receive(plan) {
  const previous = state.plan;
  state.plan = plan;
  setPlan(plan);
  if (previous?.step !== plan?.step) state.isRefining = false;
  if (byId("plan-dialog").open) draw();
  if (plan !== null && FINAL_STEPS.has(plan.step) && previous !== null && isGoing(previous))
    notify(plan.message ?? "The planning session ended.", plan.step === "failed");
}

/**
 * FR-GUI-023, FR-GUI-078: opens Plan. While a session is going it's shown at its current step (FR-GUI-026);
 * otherwise the form starts one for `target`.
 */
export async function openPlan(target) {
  const dialog = byId("plan-dialog");
  if (!isGoing(state.plan)) {
    state.target = target ?? state.target;
    byId("plan-form").reset();
    byId("plan-form").dataset.fresh = "true";
  }
  showError("");
  draw();
  if (!dialog.open) dialog.showModal();
  try {
    const [{ defaults }] = await Promise.all([api("/api/setup"), ensureModels()]);
    const form = byId("plan-form");
    form.elements.namedItem("maxBudgetUsd").placeholder = `Default: ${defaults.planBudgetUsd}`;
    form.elements.namedItem("timeoutMinutes").placeholder = `Default: ${defaults.limits.timeoutMinutes}`;
  } catch (error) {
    showError(error.message);
  }
}

async function start() {
  const form = byId("plan-form");
  const value = (name) => form.elements.namedItem(name).value;
  const chosen = (name) => (value(name) === "" ? undefined : value(name));
  const started = await post("/api/plan", {
    target: state.target,
    model: chosen("model"),
    effort: chosen("effort"),
    maxBudgetUsd: numberOrText(value("maxBudgetUsd")),
    timeoutMinutes: numberOrText(value("timeoutMinutes")),
  });
  if (started) {
    delete form.dataset.fresh;
    draw();
  }
}

export function startPlan() {
  byId("plan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void start();
  });
  byId("plan-dialog")
    .querySelector("[data-plan-close]")
    .addEventListener("click", () => byId("plan-dialog").close());
  byId("plan-open").addEventListener("click", () => void openPlan({ kind: "new-roadmap" }));
  byId("plan-form")
    .elements.namedItem("what")
    .addEventListener("change", (event) => {
      state.target = event.target.value === "task" ? { kind: "task", roadmapId: null } : { kind: "new-roadmap" };
      draw();
    });
  const events = new EventSource("/api/plan/events");
  events.addEventListener("plan", (message) => receive(JSON.parse(message.data).plan));
}
