// The side panel over the canvas (FR-GUI-049): a task's details, actions, agents, sessions and the live
// transcript of one of them (FR-GUI-039 to FR-GUI-044, FR-GUI-071, FR-GUI-077), or a change's state (FR-GUI-037).
import {
  api,
  confirmAction,
  duration,
  element,
  MODE_LABELS,
  notify,
  ROLE_LABELS,
  STATUS_LABELS,
  timer,
  when,
} from "./api.js";
import {
  currentCanvas,
  foldLines,
  refresh,
  roadmapById,
  runAndReport,
  runProgress,
  selectTask,
  taskById,
} from "./canvas.js";
import { runButtons } from "./auto.js";
import { followView, viewTools } from "./follow.js";
import { resetText } from "./limits.js";
import { openPlan } from "./plan.js";
import { recordView, urls } from "./router.js";

const ENTRY_LABELS = { user: "User", assistant: "Assistant", "tool-call": "Tool call", "tool-result": "Tool result" };
const ENTRY_FILTERS = {
  user: "User",
  assistant: "Assistant",
  "tool-call": "Tool calls",
  "tool-result": "Tool results",
};
const STEP_LABELS = {
  spec: "Spec",
  "spec-review": "Spec review",
  implement: "Implement",
  qa: "QA",
  merge: "Merge",
  preview: "Preview",
  approval: "Approval",
  commit: "Commit",
};
const STEP_STATUS_LABELS = {
  "not-started": "Not started",
  running: "Running",
  waiting: "Waiting for you",
  passed: "Passed",
  "sent-back": "Sent back",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * `pickedSessionId` is only a session the user clicked; otherwise the panel follows the task's first session.
 * `transcript` is the open transcript's event stream and its follow view. `answering` is an answer whose notes are
 * being written, kept across redraws.
 */
const state = {
  open: undefined,
  pickedSessionId: undefined,
  transcript: undefined,
  shown: "",
  answering: undefined,
  /** FR-GUI-032: the past run whose report and logs are shown, with what was read. */
  pastRun: undefined,
};

const panel = () => document.getElementById("panel");
const body = () => document.getElementById("panel-body");

function row(label, value) {
  return value === null || value === undefined || value === ""
    ? null
    : element("div", { className: "row" }, element("dt", {}, label), element("dd", {}, value));
}

function stopTranscript() {
  state.transcript?.events.close();
  state.transcript?.follow.stop();
  state.transcript = undefined;
}

export function closePanel() {
  recordView(urls.view("canvas"));
  stopTranscript();
  state.open = undefined;
  state.pickedSessionId = undefined;
  panel().hidden = true;
  document.body.classList.remove("has-panel");
  selectTask(undefined);
}

/** FR-GUI-071: opens a task, or a change keyed by branch; `undefined` closes the panel. */
export function openPanel(target, sessionId) {
  if (target === undefined) {
    closePanel();
    return;
  }
  const isSame =
    state.open !== undefined &&
    state.open.kind === target.kind &&
    state.open.id === target.id &&
    state.open.key === target.key;
  state.open = target;
  if (!isSame) state.pastRun = undefined;
  if (!isSame || sessionId !== undefined) {
    stopTranscript();
    state.pickedSessionId = sessionId;
  }
  recordView(panelUrl());
  panel().hidden = false;
  document.body.classList.add("has-panel");
  render();
  document.getElementById("panel-close").focus({ preventScroll: true });
}

/** Called with each new canvas, so the open panel shows the task as it is now (FR-GUI-075). */
export function refreshPanel() {
  if (state.open === undefined) return;
  if (state.open.kind === "roadmap" && roadmapById(state.open.id) === undefined) {
    body().replaceChildren(element("p", { className: "muted" }, `Roadmap #${state.open.id} was removed.`));
    state.shown = "";
    return;
  }
  if (state.open.kind === "task" && taskById(state.open.id) === undefined) {
    body().replaceChildren(element("p", { className: "muted" }, `Task #${state.open.id} was removed.`));
    stopTranscript();
    state.shown = "";
    return;
  }
  // Only a change to what's shown redraws it, so a live run's updates elsewhere leave the panel alone.
  if (JSON.stringify(shownItem()) !== state.shown) render();
}

function shownItem() {
  const { open } = state;
  if (open.kind === "change") return currentCanvas().changes.find((change) => change.key === open.key);
  if (open.kind === "roadmap") {
    const roadmap = roadmapById(open.id);
    const ids = new Set(roadmap?.milestones.flatMap((milestone) => milestone.taskIds) ?? []);
    return { roadmap, tasks: currentCanvas().tasks.filter((task) => ids.has(task.id)), pastRun: state.pastRun };
  }
  return { task: taskById(open.id), pickedSessionId: state.pickedSessionId };
}

/** Redraws the panel, keeping what has focus and what's typed, so an update never loses the user's place. */
function render() {
  const { open } = state;
  const focused = document.activeElement?.closest?.("#panel-body [data-focus]")?.dataset.focus;
  const typed = document.querySelector('#panel-body [data-focus="depend-on"]')?.value ?? "";
  if (open.kind === "change") renderChange(currentCanvas().changes.find((change) => change.key === open.key));
  else if (open.kind === "roadmap") renderRoadmap(roadmapById(open.id));
  else renderTask(taskById(open.id));
  state.shown = JSON.stringify(shownItem());
  const input = document.querySelector('#panel-body [data-focus="depend-on"]');
  if (input !== null) input.value = typed;
  if (focused !== undefined) document.querySelector(`#panel-body [data-focus="${CSS.escape(focused)}"]`)?.focus();
}

function changeDetails(change) {
  return element(
    "dl",
    { className: "details" },
    row("Change", change.key),
    row("Spec", change.spec),
    row("Step", change.step),
    row("Status", element("span", { className: `badge status status-${change.status}` }, change.status)),
    row("Approved by", change.approverMode === "user" ? "You" : "PM agent"),
    row("QA runs", String(change.qaRuns)),
    row("Reviews", String(change.reviews)),
    row("Decisions", String(change.decisions)),
    row("Skips", String(change.skips)),
    row("Reason", change.reason),
    row("Updated", when(change.updatedAt)),
  );
}

/** FR-GUI-038: records an answer to the question the user saw, then shows the canvas as it is now. */
async function sendAnswer(change, answer, notes) {
  // One answer at a time: a second press would only be refused, as the question is answered by then.
  for (const button of document.querySelectorAll("#panel-body .waiting-question button")) button.disabled = true;
  try {
    const { message } = await api(`/api/changes/${encodeURIComponent(change.key)}/answer`, {
      method: "POST",
      body: JSON.stringify({ question: change.pendingQuestion, answer, notes }),
    });
    state.answering = undefined;
    notify(message);
  } catch (error) {
    notify(error.message, true);
  }
  await refresh().catch((error) => notify(error.message, true));
}

/**
 * FR-GUI-038: a change's waiting question, with one button per allowed answer. An answer that carries notes for
 * the agent asks for them first.
 */
function waiting(change) {
  if (change === null || change.pendingAnswers === null) return null;
  const draft =
    state.answering?.key === change.key && state.answering.question === change.pendingQuestion
      ? state.answering
      : undefined;
  const choose = (value, needsNotes) => {
    if (!needsNotes) {
      void sendAnswer(change, value, null);
      return;
    }
    state.answering = { key: change.key, question: change.pendingQuestion, answer: value, notes: draft?.notes ?? "" };
    render();
    document.querySelector('#panel-body [data-focus="answer-notes"]')?.focus();
  };
  const answers = element(
    "div",
    { className: "actions" },
    change.pendingAnswers.map(({ value, needsNotes }) =>
      element(
        "button",
        {
          type: "button",
          className: value === draft?.answer ? "primary" : undefined,
          "data-focus": `answer-${value}`,
          "data-answer": value,
          onClick: () => choose(value, needsNotes),
        },
        value,
      ),
    ),
  );
  let notes = null;
  if (draft !== undefined) {
    const text = element("textarea", { id: "answer-notes", "data-focus": "answer-notes", rows: 3 });
    text.value = draft.notes;
    text.addEventListener("input", () => {
      draft.notes = text.value;
    });
    notes = element(
      "form",
      {
        className: "answer-notes",
        onSubmit: (event) => {
          event.preventDefault();
          void sendAnswer(change, draft.answer, draft.notes);
        },
      },
      element("label", { for: "answer-notes" }, `Notes for the agent, for ${draft.answer} (optional)`),
      text,
      element(
        "div",
        { className: "actions" },
        element(
          "button",
          { type: "submit", className: "primary", "data-focus": "send-answer" },
          `Send ${draft.answer}`,
        ),
        element(
          "button",
          {
            type: "button",
            onClick: () => {
              state.answering = undefined;
              render();
            },
          },
          "Cancel",
        ),
      ),
    );
  }
  return element(
    "section",
    { className: "waiting-question", "aria-label": "Waiting for you" },
    element("h3", {}, "Waiting for you"),
    element("p", { className: "question" }, change.pendingQuestion),
    answers,
    notes,
  );
}

function renderChange(change) {
  document.getElementById("panel-title").textContent = change === undefined ? "Change" : `Change ${change.key}`;
  body().replaceChildren(
    ...(change === undefined
      ? [element("p", { className: "muted" }, "This change is gone.")]
      : [waiting(change), changeDetails(change)].filter((node) => node !== null)),
  );
}

function taskActions(task) {
  const actions = element("div", { className: "actions" });
  if (task.status !== "in-progress" && task.status !== "done")
    actions.append(
      element(
        "button",
        {
          type: "button",
          "data-focus": "start",
          onClick: () => runAndReport({ command: "tasks-start", id: task.id }, `Started task #${task.id}.`),
        },
        "Start",
      ),
    );
  if (task.status !== "done")
    actions.append(
      element(
        "button",
        {
          type: "button",
          "data-focus": "done",
          onClick: () => runAndReport({ command: "tasks-done", id: task.id }, `Task #${task.id} is done.`),
        },
        "Mark done",
      ),
    );
  actions.append(
    element(
      "button",
      {
        type: "button",
        className: "danger",
        "data-focus": "remove",
        onClick: async () => {
          // FR-GUI-020: removing asks first.
          if (
            !(await confirmAction(
              `Remove task #${task.id} "${task.title}"? Tasks that depend on it no longer wait for it. This can't be undone.`,
              "Remove task",
            ))
          )
            return;
          if ((await runAndReport({ command: "tasks-remove", id: task.id }, `Removed task #${task.id}.`)).isDone)
            closePanel();
        },
      },
      "Remove",
    ),
  );
  return actions;
}

function dependencies(task) {
  const input = element("input", {
    type: "number",
    min: 1,
    inputmode: "numeric",
    "aria-label": "Task ID to depend on",
    "data-focus": "depend-on",
    placeholder: "Task ID",
  });
  const form = element(
    "form",
    {
      className: "inline-form",
      onSubmit: (event) => {
        event.preventDefault();
        const on = Number(input.value);
        if (!Number.isInteger(on) || on < 1) return;
        void runAndReport({ command: "tasks-depend", id: task.id, on }, `Task #${task.id} now depends on #${on}.`);
      },
    },
    input,
    element("button", { type: "submit", "data-focus": "depend" }, "Add dependency"),
  );
  return element(
    "section",
    {},
    element("h3", {}, "Depends on"),
    task.dependsOn.length === 0
      ? element("p", { className: "muted" }, "No dependencies.")
      : element(
          "ul",
          { className: "plain" },
          task.dependsOn.map((id) =>
            element(
              "li",
              {},
              element(
                "button",
                {
                  type: "button",
                  className: "link",
                  "data-focus": `dependency-${id}`,
                  onClick: () => openPanel({ kind: "task", id }),
                },
                `#${id} ${taskById(id)?.title ?? ""}`,
              ),
              task.waitingOn.includes(id) ? element("span", { className: "waiting" }, " waiting") : null,
              element(
                "button",
                {
                  type: "button",
                  className: "icon danger",
                  "aria-label": `Remove the dependency on #${id}`,
                  "data-focus": `undepend-${id}`,
                  onClick: () =>
                    runAndReport(
                      { command: "tasks-undepend", id: task.id, on: id },
                      `Task #${task.id} no longer depends on #${id}.`,
                    ),
                },
                "×",
              ),
            ),
          ),
        ),
    form,
  );
}

/** FR-GUI-039: a session's role or source, step, whether it's live, and when it started. */
function sessionLabel(session) {
  const role = ROLE_LABELS[session.role] ?? session.role;
  return [
    `${role}${session.step === null ? "" : ` · ${session.step}`} · ${session.isLive ? "live" : "ended"} · started `,
    when(session.startedAt),
  ];
}

/** FR-GUI-077: who works on the task now, and who worked on it before. */
function agents(task) {
  const now = task.sessions.filter((session) => session.isLive);
  const before = task.sessions.filter((session) => !session.isLive);
  const name = (session) =>
    session.source === "interactive" ? "You · Claude Code" : (ROLE_LABELS[session.role] ?? session.role);
  return element(
    "section",
    {},
    element("h3", {}, "Agents"),
    element("p", {}, now.length === 0 ? "No agent is working on it now." : `Working now: ${now.map(name).join(", ")}`),
    before.length === 0
      ? null
      : element(
          "ul",
          { className: "plain muted" },
          before.map((session) =>
            element(
              "li",
              {},
              `${name(session)}${session.step === null ? "" : ` · ${session.step}`} · `,
              when(session.lastActivityAt),
            ),
          ),
        ),
  );
}

function sessions(task) {
  if (task.sessions.length === 0) {
    stopTranscript();
    return element(
      "section",
      {},
      element("h3", {}, "Sessions"),
      element("p", { className: "muted", "data-testid": "no-sessions" }, "No Claude Code sessions for this task yet."),
    );
  }
  // Its live session, or its newest when none is live: sessions come live first, then newest (FR-GUI-071).
  // Not written back, so a session that goes live later is followed unless the user picked another one.
  const chosen = task.sessions.find((session) => session.id === state.pickedSessionId) ?? task.sessions[0];
  return element(
    "section",
    {},
    element("h3", {}, "Sessions"),
    element(
      "ul",
      { className: "plain sessions-list" },
      task.sessions.map((session) =>
        element(
          "li",
          {},
          element(
            "button",
            {
              type: "button",
              className: "session",
              "data-focus": `session-${session.id}`,
              "aria-pressed": String(session.id === chosen.id),
              "data-session": session.id,
              onClick: () => openPanel({ kind: "task", id: task.id }, session.id),
            },
            element("span", { className: session.isLive ? "live-dot" : "ended-dot", "aria-hidden": "true" }),
            sessionLabel(session),
          ),
        ),
      ),
    ),
    transcriptBox(chosen),
  );
}

function entryNode(entry) {
  const label = ENTRY_LABELS[entry.kind];
  return element(
    "li",
    { className: `entry entry-${entry.kind}`, "data-kind": entry.kind },
    element("span", { className: "entry-kind" }, entry.tool === null ? label : `${label} · ${entry.tool}`),
    element("pre", { className: "text" }, entry.text),
  );
}

/**
 * FR-GUI-040, FR-GUI-042: the transcript, read-only (FR-GUI-044), followed while it grows. Kept open across
 * canvas updates, so it isn't read again each time the task changes.
 */
function transcriptBox(session) {
  let box = document.getElementById("transcript");
  if (state.transcript !== undefined && box !== null && box.dataset.session === session.id) return box;
  stopTranscript();
  // FR-GUI-066: the shape of entries until the transcript arrives.
  const list = element(
    "ol",
    { className: "entries", "aria-label": "Transcript", tabindex: 0 },
    [1, 2, 3].map(() => element("li", { className: "entry skeleton-entry", "aria-hidden": "true" })),
  );
  const clearPlaceholder = () => {
    for (const placeholder of list.querySelectorAll(".skeleton-entry")) placeholder.remove();
  };
  const follow = followView(list);
  const tools = viewTools(list, { kinds: ENTRY_FILTERS, foldLines: foldLines(), follow, label: "transcript" });
  box = element(
    "div",
    { id: "transcript", className: "transcript", "data-session": session.id },
    element("p", { className: "muted transcript-note", role: "status" }, "Loading the transcript…"),
    tools.bar,
    list,
  );
  const note = box.querySelector(".transcript-note");
  const addEntries = (part, isReplace) => {
    clearPlaceholder();
    const nodes = part.entries.map(entryNode);
    if (isReplace) list.replaceChildren(...nodes);
    else list.append(...nodes);
    tools.added(nodes);
    const notes = [];
    if (part.isTruncated) notes.push("Only the newest part of a large transcript is shown.");
    if (part.dropped > 0) notes.push(`${part.dropped} older entries are left out.`);
    if (part.skipped > 0) notes.push(`${part.skipped} lines couldn't be read and were skipped.`);
    if (isReplace || notes.length > 0) note.textContent = notes.join(" ");
    if (isReplace && part.entries.length === 0) note.textContent = "The transcript is empty so far.";
    if (isReplace) follow.reset();
    follow.added(isReplace ? 0 : nodes.length);
  };
  const events = new EventSource(`/api/sessions/${encodeURIComponent(session.id)}/events`);
  state.transcript = { events, follow };
  events.addEventListener("transcript", (message) => addEntries(JSON.parse(message.data), true));
  events.addEventListener("entries", (message) => addEntries(JSON.parse(message.data), false));
  events.addEventListener("missing", () => {
    clearPlaceholder();
    note.textContent = "The transcript file isn't there (yet).";
  });
  events.addEventListener("refused", () => {
    clearPlaceholder();
    note.textContent = "This transcript is outside Claude Code's projects folder, so it isn't shown.";
  });
  events.addEventListener("problem", (message) => {
    clearPlaceholder();
    note.textContent = JSON.parse(message.data).message;
  });
  return box;
}

function stepName(row, source) {
  const name =
    row.step === "review" ? (source === "run" ? "PM review" : "Code review") : (STEP_LABELS[row.step] ?? row.step);
  return row.round === null ? name : `${name} ${row.round}`;
}

/** FR-GUI-057: what a running step's session is doing now, and whether it has gone quiet. */
function nowDoing(row, task) {
  const session =
    task.sessions.find((item) => item.id === row.sessionId) ??
    (row.sessionId === null ? task.sessions.find((item) => item.isLive) : undefined);
  if (session === undefined || !session.isLive) return [];
  return [
    session.currentTool === null
      ? null
      : element(
          "div",
          { className: "step-tool" },
          element("span", { className: "tool-name" }, session.currentTool.name),
          element("code", {}, session.currentTool.input),
        ),
    session.quietMinutes === null
      ? null
      : element("div", { className: "step-stalled", role: "status" }, `No activity for ${session.quietMinutes} min`),
  ];
}

/** FR-GUI-056: the task's workflow steps in order, with each one's result, round, times and cost. */
function steps(task) {
  if (task.steps === null) return null;
  const { source, rows } = task.steps;
  return element(
    "section",
    {},
    element("h3", {}, "Steps"),
    element(
      "ol",
      { className: "plain steps", "aria-label": "Workflow steps" },
      rows.map((row) => {
        const taken =
          row.startedAt === null
            ? null
            : row.endedAt === null
              ? row.status === "running"
                ? timer(row.startedAt)
                : null
              : duration(Date.parse(row.endedAt) - Date.parse(row.startedAt));
        const times =
          row.startedAt !== null ? ["Started ", when(row.startedAt)] : row.endedAt !== null ? [when(row.endedAt)] : [];
        return element(
          "li",
          { className: `step step-${row.status}`, "data-step": `${row.step}-${row.round ?? 0}` },
          element(
            "div",
            { className: "step-head" },
            element("span", { className: "step-name" }, stepName(row, source)),
            element("span", { className: `badge step-status is-${row.status}` }, STEP_STATUS_LABELS[row.status]),
            taken === null ? null : element("span", { className: "step-time" }, taken),
          ),
          times.length === 0 ? null : element("div", { className: "muted step-when" }, ...times),
          row.status === "running" || row.status === "waiting" ? nowDoing(row, task) : null,
        );
      }),
    ),
  );
}

/** FR-GUI-056: the live run the task is in: done tasks against total, and the time since it started. */
function runSection(task) {
  if (task.runId === null || task.roadmapId === null) return null;
  const roadmap = roadmapById(task.roadmapId);
  if (roadmap === undefined || roadmap.runId !== task.runId) return null;
  return element(
    "section",
    { className: "run-section" },
    element("h3", {}, `Run ${roadmap.runId}`),
    element("p", {}, `${roadmap.done} / ${roadmap.total} tasks done in ${roadmap.title}`),
    runProgress(roadmap),
  );
}

function roundsText(rounds) {
  return `${rounds.specReviews} spec · ${rounds.qaRuns} QA · ${rounds.implementationReviews} review`;
}

/** FR-GUI-029: the live run, as `run.json` has it now: each task's status, branch, rounds and cost. */
function liveRun(roadmap) {
  const { run } = roadmap;
  if (run === null) return null;
  return element(
    "section",
    { className: "run-section" },
    element("h3", {}, `Run ${run.runId}`),
    runProgress(roadmap),
    element(
      "ul",
      { className: "plain run-tasks" },
      run.tasks.map((task) =>
        element(
          "li",
          { "data-run-task": task.taskId },
          element("span", { className: "run-task-title" }, `#${task.taskId} ${task.title}`),
          element("span", { className: `badge run-status is-${task.status}` }, task.status),
          element("span", { className: "muted" }, roundsText(task.rounds)),
          task.branch === null ? null : element("code", {}, task.branch),
          task.reason === null ? null : element("p", { className: "muted run-reason" }, task.reason),
        ),
      ),
    ),
  );
}

/** FR-GUI-019: the roadmap's milestones in order, each task with its status, dependencies, spec and run. */
function milestones(roadmap) {
  return element(
    "section",
    {},
    element("h3", {}, "Milestones"),
    roadmap.milestones.length === 0 ? element("p", { className: "muted" }, "No milestones.") : null,
    roadmap.milestones.map((milestone) =>
      element(
        "div",
        { className: "milestone", "data-milestone": milestone.id },
        element("h4", {}, milestone.title),
        element(
          "ul",
          { className: "plain" },
          milestone.taskIds.map((id) => {
            const task = taskById(id);
            if (task === undefined) return null;
            const facts = [
              STATUS_LABELS[task.status] ?? task.status,
              task.spec === null ? null : `spec ${task.spec}`,
              task.dependsOn.length === 0 ? null : `after ${task.dependsOn.map((other) => `#${other}`).join(", ")}`,
              task.runId === null ? null : `in run ${task.runId}`,
            ].filter((fact) => fact !== null);
            return element(
              "li",
              {},
              element(
                "button",
                {
                  type: "button",
                  className: "link",
                  "data-focus": `roadmap-task-${task.id}`,
                  onClick: () => {
                    selectTask(task.id);
                    openPanel({ kind: "task", id: task.id });
                  },
                },
                `#${task.id} ${task.title}`,
              ),
              element("span", { className: "muted" }, ` · ${facts.join(" · ")}`),
            );
          }),
        ),
      ),
    ),
  );
}

async function showPastRun(runId) {
  state.pastRun = { runId, files: undefined, problem: undefined };
  if (state.open?.kind === "roadmap") recordView(urls.roadmap(state.open.id, runId));
  render();
  try {
    state.pastRun = { runId, files: await api(`/api/runs/${encodeURIComponent(runId)}`), problem: undefined };
  } catch (error) {
    state.pastRun = { runId, files: undefined, problem: error.message };
  }
  if (state.open?.kind === "roadmap") render();
}

function togglePastRun(runId) {
  if (state.pastRun?.runId === runId) {
    state.pastRun = undefined;
    if (state.open?.kind === "roadmap") recordView(urls.roadmap(state.open.id));
    render();
  } else void showPastRun(runId);
}

/** FR-GUI-063: the open panel's URL, or undefined when no panel is open. */
export function panelUrl() {
  const { open } = state;
  if (open === undefined) return undefined;
  if (open.kind === "task") return urls.task(open.id, state.pickedSessionId);
  if (open.kind === "roadmap") return urls.roadmap(open.id, state.pastRun?.runId);
  return urls.change(open.key);
}

/** FR-GUI-063: opens a roadmap's panel on one of its past runs, as its URL names. */
export function openPastRun(roadmapId, runId) {
  openPanel({ kind: "roadmap", id: roadmapId });
  void showPastRun(runId);
}

/** FR-GUI-066: a few grey lines in the shape of text that's still loading. */
function skeletonLines() {
  return element(
    "div",
    { className: "skeleton-lines", "aria-hidden": "true" },
    [1, 2, 3].map(() => element("div", { className: "skeleton-line" })),
  );
}

/** FR-GUI-032: the report and every agent log of the past run that's open. */
function pastRunFiles(runId) {
  const shown = state.pastRun;
  if (shown?.runId !== runId) return null;
  // FR-GUI-066: a failed load says why, in place, with Retry.
  if (shown.problem !== undefined)
    return element(
      "div",
      {},
      element("p", { className: "error", role: "alert" }, shown.problem),
      element("button", { type: "button", onClick: () => void showPastRun(runId) }, "Retry"),
    );
  // FR-GUI-066: the shape of a report and logs while they load.
  if (shown.files === undefined)
    return element(
      "div",
      {},
      skeletonLines(),
      element("p", { className: "muted", role: "status" }, "Loading the run…"),
    );
  const { report, reportIsTruncated, logs } = shown.files;
  return element(
    "div",
    { className: "past-run-files" },
    element("h4", {}, "Report"),
    reportIsTruncated ? element("p", { className: "muted" }, "Only the newest part of this report is shown.") : null,
    element("pre", { className: "run-report" }, report ?? "This run has no report."),
    element("h4", {}, `Logs (${logs.length})`),
    logs.map((log) =>
      element(
        "details",
        { className: "run-log" },
        element("summary", {}, log.name),
        log.isTruncated ? element("p", { className: "muted" }, "Only the newest part of this log is shown.") : null,
        element("pre", {}, log.text),
      ),
    ),
  );
}

/** FR-GUI-032: the roadmap's finished runs, newest first. */
function pastRuns(roadmap) {
  return element(
    "section",
    {},
    element("h3", {}, "Past runs"),
    roadmap.pastRuns.length === 0
      ? element("p", { className: "muted" }, "No finished runs yet. Run with AI starts one.")
      : element(
          "ul",
          { className: "plain past-runs" },
          roadmap.pastRuns.map((run) =>
            element(
              "li",
              { "data-past-run": run.runId },
              element(
                "button",
                {
                  type: "button",
                  className: "link",
                  "data-focus": `past-run-${run.runId}`,
                  "aria-expanded": String(state.pastRun?.runId === run.runId),
                  onClick: () => togglePastRun(run.runId),
                },
                `${run.runId} · ${run.outcome ?? "ended"}${
                  run.outcome === "limit-reached" && run.limitResetsAt !== null
                    ? ` · resets ${resetText(run.limitResetsAt)}`
                    : ""
                }`,
              ),
              element("span", { className: "muted" }, " · ", when(run.startedAt)),
              pastRunFiles(run.runId),
            ),
          ),
        ),
  );
}

/** FR-GUI-019, FR-GUI-029, FR-GUI-031, FR-GUI-032: a roadmap's milestones, its live run and its past runs. */
function renderRoadmap(roadmap) {
  document.getElementById("panel-title").textContent = `Roadmap #${roadmap.id}`;
  // Parts a roadmap doesn't have, such as a live run, are left out, never shown as text.
  body().replaceChildren(
    ...[
      element("h2", { className: "panel-task-title" }, roadmap.title),
      roadmap.goal === null ? null : element("p", { className: "description" }, roadmap.goal),
      element(
        "dl",
        { className: "details" },
        row("Status", roadmap.status),
        row("Done", `${roadmap.done} / ${roadmap.total} tasks`),
      ),
      element(
        "div",
        { className: "actions" },
        runButtons(roadmap, ""),
        // FR-GUI-023: plan more into this roadmap with the PM.
        element(
          "button",
          { type: "button", onClick: () => void openPlan({ kind: "task", roadmapId: roadmap.id }) },
          "Plan a task",
        ),
        element(
          "button",
          { type: "button", onClick: () => void openPlan({ kind: "extend-roadmap", roadmapId: roadmap.id }) },
          "Extend with the PM",
        ),
      ),
      liveRun(roadmap),
      milestones(roadmap),
      pastRuns(roadmap),
    ].filter((part) => part !== null),
  );
}

function renderTask(task) {
  document.getElementById("panel-title").textContent = `Task #${task.id}`;
  const box = document.getElementById("transcript");
  const details = element(
    "div",
    {},
    element("h2", { className: "panel-task-title" }, task.title),
    task.description === null ? null : element("p", { className: "description" }, task.description),
    element(
      "dl",
      { className: "details" },
      row(
        "Status",
        element("span", { className: `badge status status-${task.status}` }, STATUS_LABELS[task.status] ?? task.status),
      ),
      row("Mode", task.mode === null ? "None" : MODE_LABELS[task.mode]),
      row("Run", task.runId),
      row("Step", task.step),
      row("Spec", task.spec),
    ),
    waiting(task.change),
    taskActions(task),
    runSection(task),
    steps(task),
    dependencies(task),
    agents(task),
    task.change === null ? null : element("section", {}, element("h3", {}, "Workflow"), changeDetails(task.change)),
  );
  // The open transcript is moved, not read again, so its entries and scroll position stay.
  const scrolled = box?.querySelector(".entries")?.scrollTop;
  body().replaceChildren(details, sessions(task));
  const list = document.querySelector("#transcript .entries");
  if (list !== null && scrolled !== undefined) list.scrollTop = scrolled;
}

export function startPanel() {
  document.getElementById("panel-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel().hidden && document.querySelector("dialog[open]") === null) closePanel();
  });
}

/** FR-GUI-020: adds a task with the same checks as `cclinic tasks add`. */
export function startAddTask() {
  const dialog = document.getElementById("add-task");
  const form = document.getElementById("add-task-form");
  document.getElementById("add-task-open").addEventListener("click", () => {
    form.reset();
    document.getElementById("add-task-error").textContent = "";
    dialog.showModal();
  });
  document.getElementById("add-task-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const text = (name) => String(data.get(name) ?? "").trim();
    const given = text("dependsOn")
      .split(/[\s,]+/)
      .filter(Boolean);
    // The same check and message as `cclinic tasks add --depends-on` (`parseId`, FR-GUI-020).
    const isTaskId = (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1;
    const wrong = given.find((value) => !isTaskId(value));
    if (wrong !== undefined) {
      document.getElementById("add-task-error").textContent = `"${wrong}" isn't a valid task ID.`;
      return;
    }
    const dependsOn = given.map(Number);
    const request = {
      command: "tasks-add",
      title: text("title"),
      ...(text("description") === "" ? {} : { description: text("description") }),
      ...(text("spec") === "" ? {} : { spec: text("spec") }),
      dependsOn,
    };
    // One add at a time: a second click while it runs would add the task twice.
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const result = await runAndReport(request, `Added "${request.title}".`);
      if (result.isDone) dialog.close();
      else document.getElementById("add-task-error").textContent = result.message;
    } finally {
      submit.disabled = false;
    }
  });
}
