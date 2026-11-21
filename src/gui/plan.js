// Plan with the PM (roadmap-planning FR-PLAN-033 to FR-PLAN-043, gui FR-GUI-023 to FR-GUI-026): a chat in the side
// panel, on a planning session that may also be driven from a terminal or Claude Code, mirrored from its transcript.
import { api, element, notify, timer } from "./api.js";
import { setPlan } from "./attention.js";
import { currentCanvas } from "./canvas.js";
import { renderMarkdown } from "./markdown.js";
import { ensureModels, numberOrText } from "./setup.js";

/** FR-PLAN-036: the message box grows up to this share of the panel's height, then scrolls. */
const COMPOSER_MAX_SHARE = 0.4;
/** How long the bottom of the conversation counts as "at the bottom" for following new messages. */
const BOTTOM_TOLERANCE_PX = 24;
const THUMBNAIL_PX = 48;
/** This page, so the server counts only the files it holds (FR-PLAN-022). */
const PAGE_ID = [...crypto.getRandomValues(new Uint8Array(12))]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
const PLACE_NAMES = { terminal: "a terminal (luseen plan)", gui: "this GUI", "claude-code": "Claude Code" };

/**
 * `view` is the panel as the server last sent it; `items` the open session's conversation from its transcript;
 * `uploads` the files attached to the next message; `target` what a new session plans; `local` a problem found
 * here, such as a refused file (FR-PLAN-041).
 */
const state = {
  view: null,
  items: [],
  itemsPlanId: null,
  uploads: [],
  target: { kind: "new-roadmap" },
  /** Problems found on this page, such as refused files, each shown with its one action (FR-PLAN-041). */
  local: [],
  isFollowing: true,
  folded: new Set(),
  /** Thumbnails of images waiting to be sent, by upload ID, drawn without a URL (FR-GUI-012). */
  thumbnails: new Map(),
  isSending: false,
  /**
   * FR-PLAN-060: the message just sent, shown at once until the transcript has it: its text, its uploads, when it was
   * sent, the session it went to (null for a new one), and how many of the user's messages that session showed then.
   */
  pending: null,
  // FR-PLAN-036: a session being opened takes no message until it's open (DEF-38).
  isOpening: false,
};

const byId = (id) => document.getElementById(id);
const panel = () => byId("plan-panel");
const isOpen = () => !panel().hidden;

function targetText(target) {
  if (target.kind === "new-roadmap") return "New roadmap";
  if (target.kind === "new-project") return "New project";
  if (target.kind === "extend-roadmap") return `More milestones for roadmap #${target.roadmapId}`;
  return target.roadmapId === null ? "One standalone task" : `One task in roadmap #${target.roadmapId}`;
}

async function call(path, body) {
  try {
    const reply = await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    if (reply?.plan !== undefined) receive(reply.plan);
    return reply ?? {};
  } catch (error) {
    // Refused files stay listed; the failed action's problem is added after them.
    state.local = [
      ...state.local.filter((item) => item.action === "remove-file"),
      { message: error.message, action: null },
    ];
    draw();
    return undefined;
  }
}

function button(label, onClick, className = "small", extra = {}) {
  return element("button", { type: "button", className, onClick, ...extra }, label);
}

function copyButton(text, label = "Copy", className = "plan-ghost") {
  return button(
    label,
    () => {
      navigator.clipboard?.writeText(text).then(
        () => notify("Copied."),
        () => notify("Couldn't copy. Select the text instead.", true),
      );
    },
    className,
  );
}

/** FR-PLAN-036: an image's thumbnail, drawn from its bytes, since the GUI loads no image from a URL. */
async function drawThumbnail(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMBNAIL_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = element("canvas", {
      width: Math.max(1, Math.round(bitmap.width * scale)),
      height: Math.max(1, Math.round(bitmap.height * scale)),
      className: "plan-thumb",
      role: "img",
      "aria-label": file.name,
    });
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  }
}

function thumbnailOf(uploadId, name) {
  const source = state.thumbnails.get(uploadId);
  if (source === undefined) return null;
  const copy = element("canvas", {
    width: source.width,
    height: source.height,
    className: "plan-thumb",
    role: "img",
    "aria-label": name,
  });
  copy.getContext("2d")?.drawImage(source, 0, 0);
  return copy;
}

/** FR-PLAN-037: an image a session's message has, from the GUI's own server, which the page may load. */
function attachmentImage(planId, name, file) {
  return element("img", {
    src: `/api/plan/sessions/${planId}/attachments/${encodeURIComponent(file)}`,
    alt: name,
    className: "plan-thumb",
    loading: "lazy",
  });
}

/**
 * A file as a chip: a sent one's image comes from the server (`sent`), an unsent one's thumbnail is drawn here
 * (`uploadId`).
 */
function fileChip(name, kind, onRemove, { sent, uploadId } = {}) {
  const thumbnail =
    kind !== "image"
      ? null
      : sent === undefined
        ? thumbnailOf(uploadId, name)
        : attachmentImage(sent.planId, name, sent.file);
  return element(
    "span",
    { className: "plan-chip" },
    thumbnail,
    element("span", { className: "plan-chip-name" }, `${kind === "image" ? "Image" : "Document"}: ${name}`),
    onRemove === undefined ? null : button("×", onRemove, "plan-chip-remove", { "aria-label": `Remove ${name}` }),
  );
}

/** FR-PLAN-022, FR-PLAN-033: uploads one file now, so a refused one is named before anything is sent. */
async function attach(file) {
  const refuse = (message) => {
    state.local = [...state.local.filter((item) => item.action === "remove-file"), { message, action: "remove-file" }];
    draw();
  };
  // FR-PLAN-022: checked by the server's own rules first, so a file too large to send is refused by name.
  try {
    const { problem } = await api("/api/plan/uploads/check", {
      method: "POST",
      body: JSON.stringify({ name: file.name, sizeBytes: file.size }),
    });
    if (problem !== null) {
      refuse(problem);
      return;
    }
  } catch (error) {
    refuse(`${file.name}: ${error.message}`);
    return;
  }
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  try {
    const { upload } = await api("/api/plan/uploads", {
      method: "POST",
      body: JSON.stringify({ name: file.name, contentBase64: base64, pageId: PAGE_ID }),
    });
    if (upload.kind === "image") {
      const thumbnail = await drawThumbnail(file);
      if (thumbnail !== null) state.thumbnails.set(upload.id, thumbnail);
    }
    state.uploads.push(upload);
  } catch (error) {
    refuse(error.message);
    return;
  }
  draw();
}

async function attachAll(files) {
  for (const file of files) await attach(file);
}

function removeUpload(upload) {
  state.uploads = state.uploads.filter((item) => item.id !== upload.id);
  state.thumbnails.delete(upload.id);
  draw();
  void api(`/api/plan/uploads/${upload.id}/remove`, { method: "POST", body: "{}" }).catch(() => undefined);
}

function options() {
  const field = (name) => byId("plan-options").querySelector(`[name="${name}"]`);
  const value = (name) => field(name).value;
  const chosen = (name) => (value(name) === "" ? undefined : value(name));
  return { model: chosen("model"), effort: chosen("effort"), timeoutMinutes: numberOrText(value("timeoutMinutes")) };
}

/** What a new session plans, chosen in the toolbar's target menu (FR-PLAN-036). */
function chosenTarget() {
  return state.target;
}

/** The target pill's short label. */
function targetPill(target) {
  if (target.kind === "new-roadmap") return "New roadmap";
  if (target.kind === "new-project") return "New project";
  if (target.kind === "extend-roadmap") return `Extend #${target.roadmapId}`;
  return target.roadmapId === null ? "Single task" : `Task in #${target.roadmapId}`;
}

const isSameTarget = (left, right) =>
  left.kind === right.kind && (left.roadmapId ?? null) === (right.roadmapId ?? null);

/** The model pill's label: the chosen model and reasoning, or the saved defaults. */
function modelPill() {
  const chosen = (name) => {
    const select = byId("plan-options").querySelector(`[name="${name}"]`);
    return select.value === "" ? null : (select.selectedOptions[0]?.textContent ?? select.value);
  };
  const model = chosen("model");
  const effort = chosen("effort");
  return [model ?? "Default model", effort].filter((part) => part !== null).join(" · ");
}

/** FR-PLAN-034, FR-PLAN-036: a menu by its button, which only one at a time is open. */
const MENUS = [
  ["plan-sessions-button", "plan-sessions-menu"],
  ["plan-more", "plan-more-menu"],
  ["plan-target", "plan-target-menu"],
  ["plan-model", "plan-model-menu"],
];

function closeMenus(except = null) {
  for (const [buttonId, menuId] of MENUS) {
    if (menuId === except) continue;
    byId(menuId).hidden = true;
    byId(buttonId).setAttribute("aria-expanded", "false");
  }
}

function isMenuOpen() {
  return MENUS.some(([, menuId]) => !byId(menuId).hidden);
}

function menuItems(menu) {
  return [...menu.querySelectorAll("button, select, input")].filter((item) => !item.hidden && !item.disabled);
}

function toggleMenu(buttonId, menuId) {
  const menu = byId(menuId);
  const willOpen = menu.hidden;
  closeMenus(menuId);
  menu.hidden = !willOpen;
  byId(buttonId).setAttribute("aria-expanded", String(willOpen));
  if (willOpen) menuItems(menu)[0]?.focus();
}

function menuItem(label, onClick, { detail, isCurrent = false, className = "" } = {}) {
  return element(
    "button",
    {
      type: "button",
      role: "menuitem",
      className: `plan-menu-item${isCurrent ? " is-current" : ""}${className === "" ? "" : ` ${className}`}`,
      "aria-current": isCurrent ? "true" : undefined,
      onClick: () => {
        closeMenus();
        onClick();
      },
    },
    element("span", { className: "plan-menu-label" }, label),
    detail === undefined ? null : element("span", { className: "plan-menu-detail" }, detail),
  );
}

/** FR-PLAN-036: New roadmap, Extend roadmap #N, Single task standalone or in roadmap #N. */
function drawTargetMenu() {
  const roadmaps = currentCanvas()?.roadmaps ?? [];
  const choose = (target) => () => {
    state.target = target;
    draw();
    byId("plan-text").focus();
  };
  const item = (target, label, detail) =>
    menuItem(label, choose(target), { detail, isCurrent: isSameTarget(target, state.target) });
  byId("plan-target-menu").replaceChildren(
    item({ kind: "new-roadmap" }, "New roadmap"),
    ...roadmaps.map((roadmap) =>
      item({ kind: "extend-roadmap", roadmapId: roadmap.id }, `Extend roadmap #${roadmap.id}`, roadmap.title),
    ),
    item({ kind: "task", roadmapId: null }, "Single task", "Standalone"),
    ...roadmaps.map((roadmap) =>
      item({ kind: "task", roadmapId: roadmap.id }, `Single task in #${roadmap.id}`, roadmap.title),
    ),
  );
}

/** The user's messages the session's conversation shows, to tell when the transcript has a new one (FR-PLAN-060). */
function userMessageCount(planId) {
  if (state.itemsPlanId !== planId) return 0;
  return state.items.filter((item) => item.kind === "user" || item.repeats).length;
}

function clearPending() {
  for (const upload of state.pending?.uploads ?? []) state.thumbnails.delete(upload.id);
  state.pending = null;
}

/**
 * FR-PLAN-021, FR-PLAN-036, FR-PLAN-060: sends the message, starting a session when none is open. It's shown at
 * once, and the box is cleared; a refused or failed message goes back in the box, with the problem and Retry.
 */
async function send(text) {
  const open = state.view?.open ?? null;
  const uploads = state.uploads;
  if ((text.trim() === "" && uploads.length === 0) || state.isOpening) return;
  const isNew = open === null || open.status !== "open";
  clearPending();
  state.pending = {
    text,
    uploads,
    at: new Date().toISOString(),
    planId: isNew ? null : open.id,
    shownCount: isNew ? 0 : userMessageCount(open.id),
  };
  state.isSending = true;
  state.isFollowing = true;
  state.uploads = [];
  byId("plan-text").value = "";
  draw();
  growComposer();
  const ids = uploads.map((upload) => upload.id);
  const reply = isNew
    ? await call("/api/plan", { target: chosenTarget(), ...options(), text, uploads: ids })
    : await call("/api/plan/message", { text, uploads: ids });
  state.isSending = false;
  if (reply === undefined) {
    state.pending = null;
    byId("plan-text").value = text;
    state.uploads = uploads;
    state.local = state.local.map((item) => (item.action === null ? { ...item, action: "resend" } : item));
  } else {
    state.local = [];
    if (state.pending !== null && state.pending.planId === null)
      state.pending = { ...state.pending, planId: state.view?.open?.id ?? null };
  }
  draw();
  growComposer();
  if (reply !== undefined) byId("plan-text").focus();
}

/** The open session's waiting proposal as a card, with Approve and Cancel (FR-PLAN-039). */
function proposalCard(open) {
  const proposal = open.proposal;
  const decide = (choice) => () => void call(`/api/plan/${choice}`, { planId: open.id }).then(reported);
  const chips = (spec, dependsOn) => [
    element("span", { className: "plan-tag" }, spec ?? "new spec"),
    ...dependsOn.map((dependency) => element("span", { className: "plan-tag" }, `after ${dependency}`)),
  ];
  const body =
    proposal.kind === "task"
      ? [
          element("p", { className: "plan-card-kind" }, "Task proposal"),
          element("h3", {}, proposal.task.title),
          element(
            "p",
            { className: "muted" },
            proposal.roadmapId === null
              ? "Standalone, in no roadmap"
              : `Milestone #${proposal.milestoneId} of roadmap #${proposal.roadmapId}`,
          ),
          element("div", { className: "plan-tags" }, ...chips(proposal.task.spec, proposal.task.dependsOn)),
          element("div", { className: "plan-md" }, ...renderMarkdown(proposal.task.description)),
        ]
      : [
          element(
            "p",
            { className: "plan-card-kind" },
            proposal.extending === null ? "New roadmap" : "More milestones",
          ),
          element(
            "h3",
            {},
            proposal.extending === null ? (proposal.roadmap?.title ?? "") : `Roadmap #${proposal.extending}`,
          ),
          proposal.roadmap === null ? null : element("p", { className: "muted" }, proposal.roadmap.goal),
          ...proposal.milestones.map((milestone, index) => {
            const key = `${open.id}:${index}`;
            const details = element(
              "details",
              { className: "plan-milestone", open: !state.folded.has(key) },
              element(
                "summary",
                {},
                element("strong", {}, `${index + 1}. ${milestone.title}`),
                milestone.goal === ""
                  ? null
                  : element("span", { className: "plan-milestone-goal" }, ` — ${milestone.goal}`),
              ),
              element(
                "ul",
                {},
                ...milestone.tasks.map((task) =>
                  element(
                    "li",
                    {},
                    element("span", {}, task.title),
                    element("span", { className: "plan-tags" }, ...chips(task.spec, task.dependsOn)),
                  ),
                ),
              ),
            );
            details.addEventListener("toggle", () => {
              if (details.open) state.folded.delete(key);
              else state.folded.add(key);
            });
            return details;
          }),
        ];
  const questions =
    proposal.openQuestions.length === 0
      ? null
      : element(
          "div",
          {},
          element("p", { className: "plan-card-kind" }, "Open questions"),
          element("ul", {}, ...proposal.openQuestions.map((question) => element("li", {}, question))),
        );
  // FR-PLAN-053: a new project's first roadmap was approved with its brief, so it's saved with nothing to decide.
  const isSetup = open.target.kind === "new-project";
  return element(
    "section",
    { className: "plan-card", "aria-label": "Proposal" },
    isSetup ? element("p", { className: "plan-card-kind" }, "First roadmap, saving") : null,
    ...body,
    questions,
    isSetup
      ? null
      : element(
          "div",
          { className: "actions" },
          button("Cancel", decide("cancel"), "", { "data-plan-decide": "cancel" }),
          button("Approve", decide("approve"), "primary", { "data-plan-decide": "approve" }),
          element("span", { className: "muted" }, "or reply below to change it"),
        ),
  );
}

/** FR-PLAN-053: a new project's first roadmap, saved by the setup. */
function savedRoadmapCard(outcome) {
  return element(
    "section",
    { className: "plan-card", "aria-label": "Roadmap saved", role: "status" },
    element("p", { className: "plan-card-kind" }, "Roadmap saved"),
    element("p", {}, outcome),
  );
}

/** FR-GUI-087: a new project's waiting brief, which becomes README.md, with the files that go to docs/. */
function briefCard(open) {
  const brief = open.project.brief;
  // Pressed once: a second approval would find the first's README.md (FR-PLAN-051).
  const decide = (choice) => (event) => {
    for (const control of event.currentTarget.parentElement.querySelectorAll("button")) control.disabled = true;
    void call(`/api/plan/${choice}`, { planId: open.id }).then(reported);
  };
  return element(
    "section",
    { className: "plan-card", "aria-label": "Brief" },
    element("p", { className: "plan-card-kind" }, "Brief, saved as README.md"),
    element("div", { className: "plan-md" }, ...renderMarkdown(brief.markdown)),
    brief.files.length === 0
      ? null
      : element(
          "div",
          {},
          element("p", { className: "plan-card-kind" }, "Copied to docs/"),
          element("ul", {}, ...brief.files.map((name) => element("li", {}, name))),
        ),
    element(
      "p",
      { className: "muted" },
      "Approving it sets up the project: luseen writes the specs and the agent setup, saves the first roadmap and, for a project with screens, makes the design system.",
    ),
    element(
      "div",
      { className: "actions" },
      button("Cancel", decide("cancel"), "", { "data-plan-decide": "cancel" }),
      button("Approve and set up", decide("approve"), "primary", { "data-plan-decide": "approve" }),
      element("span", { className: "muted" }, "or reply below to change it"),
    ),
  );
}

/**
 * FR-GUI-089: shown only when a new project's design step failed: Retry is in the problem shown, and this finishes the
 * setup without a design system.
 */
function designCard(open) {
  const skip = (event) => {
    event.currentTarget.disabled = true;
    void call("/api/plan/design", { planId: open.id }).then(reported);
  };
  return element(
    "section",
    { className: "plan-card", "aria-label": "Design system" },
    element("p", { className: "plan-card-kind" }, "Design system"),
    element(
      "p",
      { className: "muted" },
      "The design step didn't finish. Retry it, or continue without a design system.",
    ),
    element(
      "div",
      { className: "actions" },
      button("Continue without design", skip, "", { "data-plan-design": "skip" }),
    ),
  );
}

/** FR-PLAN-055, FR-GUI-090: what the setup made, and the first task to work on. */
function summaryCard(summary, hasDesign) {
  const task = /work on task \d+/.exec(summary)?.[0];
  return element(
    "section",
    { className: "plan-card", "aria-label": "Project set up", role: "status" },
    element("p", { className: "plan-card-kind" }, "Ready"),
    element("div", { className: "plan-md" }, ...renderMarkdown(summary)),
    // FR-GUI-089: the design system made by the setup, to look at.
    hasDesign
      ? element(
          "p",
          {},
          element(
            "a",
            { href: "/api/design/style-guide", target: "_blank", rel: "noopener noreferrer" },
            "Open the style guide",
          ),
        )
      : null,
    task === undefined ? null : element("div", { className: "actions" }, copyButton(task, `Copy "${task}"`, "")),
  );
}

const STEP_LABELS = { specs: "Writing the specs", design: "Drafting the design system" };

/** FR-GUI-086: Brief, Specs, Roadmap, Design (with screens) and Ready, each done, current or waiting. */
function drawProgress(open) {
  const list = byId("plan-progress");
  const project = open?.project ?? null;
  list.hidden = project === null && state.target.kind !== "new-project";
  if (list.hidden) return;
  const phase = project?.phase ?? "brief";
  const steps = [
    ["brief", "Brief"],
    ["specs", "Specs"],
    ["roadmap", "Roadmap"],
    ...(project?.hasScreens === false ? [] : [["design", "Design"]]),
    ["done", "Ready"],
  ];
  const at = steps.findIndex(([name]) => name === phase);
  list.replaceChildren(
    ...steps.map(([, label], index) => {
      const status = index < at || phase === "done" ? "done" : index === at ? "current" : "waiting";
      const word = { done: "done", current: "now", waiting: "next" }[status];
      return element(
        "li",
        { className: `plan-step is-${status}`, "aria-current": status === "current" ? "step" : undefined },
        element(
          "span",
          { className: "plan-step-mark", "aria-hidden": "true" },
          status === "done" ? "✓" : String(index + 1),
        ),
        element("span", {}, label),
        element("span", { className: "visually-hidden" }, ` (${word})`),
      );
    }),
  );
}

function reported(reply) {
  if (reply?.message !== undefined) notify(reply.message);
}

function siteOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** FR-PLAN-037, FR-PLAN-042: one entry of the conversation. */
function itemNode(item, { open, isReplaced, result, sources = [] }) {
  if (item.kind === "user")
    return element(
      "div",
      { className: "plan-msg plan-user" },
      element("p", { className: "plan-who" }, "You"),
      element("div", { className: "plan-bubble" }, item.text === "" ? null : element("p", {}, item.text)),
      item.attachments.length === 0
        ? null
        : element(
            "div",
            { className: "plan-chips" },
            ...item.attachments.map((file) =>
              fileChip(file.name, file.kind, undefined, { sent: { planId: open.id, file: file.file } }),
            ),
          ),
    );
  if (item.kind === "pm")
    return element(
      "div",
      { className: "plan-msg plan-pm" },
      element(
        "p",
        { className: "plan-who" },
        element("span", { className: "plan-pm-label" }, "PM"),
        copyButton(item.text),
      ),
      element("div", { className: "plan-md" }, ...renderMarkdown(item.text)),
      sources.length > 0
        ? element(
            "div",
            { className: "plan-sources" },
            ...sources.map((source) =>
              element(
                "a",
                { href: source.url, target: "_blank", rel: "noopener noreferrer", className: "plan-tag" },
                `${siteOf(source.url)} · ${source.title}`,
              ),
            ),
          )
        : null,
    );
  if (item.kind === "note") return element("p", { className: "plan-note muted" }, item.text);
  if (item.kind === "result")
    return element(
      "details",
      { className: "plan-result" },
      element("summary", {}, "Result"),
      element("pre", {}, item.text),
    );
  // FR-PLAN-038: one muted line, a dot then the tool and its short input, opening to show its folded result.
  const isProposal = item.tool !== null && /plan_propose$/.test(item.tool);
  const text = isProposal ? (isReplaced ? "Proposed a plan (replaced)" : "Proposed a plan") : item.text;
  const line = [element("span", { className: "plan-dot", "aria-hidden": "true" }), element("span", {}, text)];
  if (result === undefined) return element("p", { className: "plan-activity" }, ...line);
  return element(
    "details",
    { className: "plan-activity" },
    element("summary", {}, ...line),
    element("pre", { className: "plan-result" }, result.text),
  );
}

/**
 * FR-PLAN-037: the answers offered by the newest turn's plan_suggest call, from the transcript; none once a newer
 * message has been sent to the PM, so suggestions never outlive their turn.
 */
function newestSuggestions(open) {
  const items = state.itemsPlanId === open.id ? state.items : [];
  // A newer message the transcript hasn't got yet, shown from the record, ends the older turn's offer too.
  if (unansweredShown(open, items) !== null) return [];
  const accepted = acceptedSuggestCalls(items);
  let suggestions = [];
  for (const item of items) {
    if (item.kind === "user" || item.kind === "note") suggestions = [];
    // Like the server, each accepted call replaces what an earlier one offered.
    if (accepted.has(item)) suggestions = item.suggestions;
  }
  return suggestions;
}

/** FR-PLAN-007: the plan_suggest calls whose result came back without an error; a refused call offers nothing. */
function acceptedSuggestCalls(items) {
  const refused = new Set();
  for (const item of items) {
    if (item.kind !== "result" || item.toolUseId === null) continue;
    if (item.isError) refused.add(item.toolUseId);
  }
  return new Set(
    items.filter(
      (item) =>
        item.kind === "activity" &&
        /plan_suggest$/.test(item.tool ?? "") &&
        !item.isError &&
        // A call whose result isn't written yet counts, as Claude Code writes the result right after it.
        (item.toolUseId === null || !refused.has(item.toolUseId)),
    ),
  );
}

/**
 * FR-PLAN-038: the user's message the PM hasn't answered, from the record, when the conversation doesn't show it yet,
 * so it's shown once, as theirs. Its time is when the turn started: any message of theirs shown since then, written
 * by Claude or repeated by luseen, is it. With no time, the newest message shown must be it, with no finished reply
 * after it. The terminal does the same with isWaitingMessageWritten in the core.
 */
function unansweredShown(open, items) {
  if (open.unanswered === null || open.unanswered === undefined) return null;
  const start = Date.parse(open.unanswered.at ?? "");
  const shown = items.flatMap((item) => (item.kind === "user" ? [item] : item.repeats ? [item.repeats] : []));
  const isWritten = Number.isNaN(start)
    ? shown.at(-1)?.text === open.unanswered.text && items.at(-1)?.kind !== "pm"
    : shown.some((item) => item.at !== null && Date.parse(item.at) >= start);
  return isWritten ? null : open.unanswered;
}

function conversation(open) {
  const items = state.itemsPlanId === open.id ? state.items : [];
  const proposals = items.filter((item) => item.kind === "activity" && /plan_propose$/.test(item.tool ?? ""));
  const lastProposal = proposals.at(-1);
  const nodes = [];
  // FR-PLAN-037: a turn runs from one message sent to the PM to the next; its PM messages show the sources its
  // plan_suggest call gave, wherever the call sits in the turn, and only those.
  const sourcesByTurn = [];
  const accepted = acceptedSuggestCalls(items);
  let turnIndex = 0;
  const turnOf = items.map((item) => {
    // Every message sent to the PM, the user's or luseen's own, starts a turn.
    if (item.kind === "user" || item.kind === "note") turnIndex += 1;
    // Each accepted call replaces the turn's sources, as it replaces them on the server.
    if (accepted.has(item)) sourcesByTurn[turnIndex] = item.sources;
    return turnIndex;
  });
  items.forEach((item, index) => {
    const turnSources = sourcesByTurn[turnOf[index]] ?? [];
    // FR-PLAN-014: a message repeated for the PM is one Claude hadn't written, so it shows as the user's.
    if (item.kind === "note" && item.repeats) nodes.push(itemNode(item.repeats, { open, isReplaced: false }));
    // FR-PLAN-038: a tool's result is folded into its activity row. Suggestions show as buttons, not as a row.
    if (item.kind === "result" && items[index - 1]?.kind === "activity") return;
    if (item.kind === "activity" && /plan_suggest$/.test(item.tool ?? "")) return;
    const result = item.kind === "activity" && items[index + 1]?.kind === "result" ? items[index + 1] : undefined;
    nodes.push(
      itemNode(item, {
        open,
        isReplaced: item.kind === "activity" && item !== lastProposal,
        result,
        sources: item.kind === "pm" ? turnSources : [],
      }),
    );
  });
  if (open.proposal !== null && open.status === "open") nodes.push(proposalCard(open));
  const project = open.project ?? null;
  if (project?.brief != null && open.status === "open") nodes.push(briefCard(open));
  const step = state.view?.step ?? null;
  if (step !== null)
    nodes.push(
      element(
        "p",
        { className: "plan-working", role: "status" },
        element("span", { className: "plan-spinner", "aria-hidden": "true" }),
        element("span", {}, `${STEP_LABELS[step.kind]} · `),
        timer(step.startedAt),
      ),
    );
  else if (project?.phase === "design" && open.status === "open" && state.view?.notice != null)
    nodes.push(designCard(open));
  if (project?.phase === "design" && open.outcome !== null) nodes.push(savedRoadmapCard(open.outcome));
  if (project?.summary != null) nodes.push(summaryCard(project.summary, project.hasDesign));
  // FR-PLAN-038: a message a stopped turn left unanswered shows until the transcript has it.
  const unanswered = unansweredShown(open, items);
  if (unanswered !== null) nodes.push(itemNode(unanswered, { open, isReplaced: false }));
  const pending = unanswered === null ? pendingShown(open) : null;
  if (pending !== null) nodes.push(pendingNode(pending));
  const turn = state.view?.turn;
  if (turn !== null && turn !== undefined) {
    const activity = items.filter((item) => item.kind === "activity" && (item.at ?? "") >= turn.startedAt).at(-1);
    nodes.push(workingRow(pending === null ? "Working" : "Starting the PM", turn.startedAt, activity?.text));
  } else if (pending !== null && state.isSending) nodes.push(workingRow("Starting the PM", pending.at));
  if (open.status !== "open" && open.outcome !== null && project?.summary == null)
    nodes.push(element("p", { className: "plan-outcome", role: "status" }, open.outcome));
  return nodes;
}

/** FR-PLAN-038: a spinner, what's happening and for how long, and the newest activity. */
function workingRow(label, startedAt, activity) {
  return element(
    "p",
    { className: "plan-working", role: "status" },
    element("span", { className: "plan-spinner", "aria-hidden": "true" }),
    element("span", {}, `${label} · `),
    timer(startedAt),
    activity === undefined ? null : element("span", { className: "plan-working-activity" }, ` · ${activity}`),
  );
}

/** FR-PLAN-060: the message just sent, while the open session's transcript doesn't have it yet. */
function pendingShown(open) {
  const pending = state.pending;
  if (pending === null || (pending.planId !== null && pending.planId !== open.id)) return null;
  return userMessageCount(open.id) > pending.shownCount ? null : pending;
}

function pendingNode(pending) {
  return element(
    "div",
    { className: "plan-msg plan-user" },
    element("p", { className: "plan-who" }, "You"),
    element("div", { className: "plan-bubble" }, pending.text === "" ? null : element("p", {}, pending.text)),
    pending.uploads.length === 0
      ? null
      : element(
          "div",
          { className: "plan-chips" },
          ...pending.uploads.map((upload) => fileChip(upload.name, upload.kind, undefined, { uploadId: upload.id })),
        ),
  );
}

/** FR-PLAN-041: a problem where it happened, with the one action that helps. */
function noticeNodes() {
  // FR-PLAN-041: this page's problems, then the server's, each with its own action.
  const notices = [...state.local, ...(state.view?.notice ? [state.view.notice] : [])];
  const forget = (notice) => () => {
    state.local = state.local.filter((item) => item !== notice);
    draw();
  };
  // Pressed once, so a double-click asks the PM once (DEF-33).
  const retry = (event) => {
    event.currentTarget.disabled = true;
    void call("/api/plan/retry");
  };
  return notices.map((notice) => {
    const action =
      notice.action === "remove-file"
        ? button("Remove file", forget(notice))
        : notice.action === "retry"
          ? button("Retry", retry)
          : notice.action === "resume"
            ? button("Resume", retry)
            : notice.action === "resend"
              ? button("Retry", () => {
                  forget(notice)();
                  void send(byId("plan-text").value);
                })
              : button("Dismiss", forget(notice));
    return element("div", { className: "plan-error", role: "alert" }, element("p", {}, notice.message), action);
  });
}

/** FR-PLAN-034: New session first, then the open sessions, newest first, the open one marked. */
function drawSessions() {
  const view = state.view;
  const openId = view?.open?.id ?? null;
  const held = (session) =>
    session.heldBy === null ? "" : ` · held by ${session.isHeldHere ? "this GUI" : PLACE_NAMES[session.heldBy]}`;
  const sessions = [...(view?.sessions ?? [])];
  // A closed session stays shown with its outcome until another is chosen.
  if (view?.open !== null && view?.open !== undefined && view.open.status !== "open") sessions.unshift(view.open);
  byId("plan-sessions-menu").replaceChildren(
    menuItem("New session", () => void call("/api/plan/new"), { isCurrent: openId === null }),
    ...sessions.map((session) =>
      element(
        "div",
        { "data-plan-id": session.id },
        menuItem(`${session.id} · ${targetText(session.target)}`, () => void openSession(session.id), {
          detail: `"${session.summary}"${held(session)}${session.status === "open" || session.status === undefined ? "" : ` · ${session.status}`}`,
          isCurrent: session.id === openId,
        }),
      ),
    ),
  );
}

async function openSession(planId) {
  if (planId === state.view?.open?.id) return;
  state.isOpening = true;
  draw();
  try {
    await call("/api/plan/open", { planId, ...options() });
  } finally {
    state.isOpening = false;
    draw();
  }
}

/** FR-PLAN-035: centred in the conversation area, with no form. */
function emptyState() {
  if (state.target.kind === "new-project")
    return element(
      "div",
      { className: "plan-empty" },
      element("h2", { id: "plan-start-heading" }, "What are you building?"),
      element(
        "p",
        { className: "muted" },
        "The PM will ask a few questions, then write the brief. Attach a brief, requirements or mockups with +, or drop or paste files.",
      ),
    );
  const isTask = state.target.kind === "task";
  return element(
    "div",
    { className: "plan-empty" },
    element("h2", { id: "plan-start-heading" }, isTask ? "What's the change?" : "What do you want to build?"),
    element(
      "p",
      { className: "muted" },
      "Describe it in your own words. Attach a brief, a mockup or a screenshot with +, or drop or paste files.",
    ),
  );
}

function isAtBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < BOTTOM_TOLERANCE_PX;
}

function drawLog() {
  const log = byId("plan-log");
  const open = state.view?.open ?? null;
  const top = log.scrollTop;
  // FR-PLAN-060: a first message being sent replaces the empty state at once.
  const starting = state.pending !== null && state.pending.planId === null && state.isSending;
  const nodes =
    open !== null
      ? conversation(open)
      : starting
        ? [pendingNode(state.pending), workingRow("Starting the PM", state.pending.at)]
        : [emptyState()];
  const jump = state.isFollowing
    ? null
    : button(
        "Jump to latest",
        () => {
          state.isFollowing = true;
          log.scrollTop = log.scrollHeight;
          drawLog();
        },
        "small jump-latest",
      );
  log.classList.toggle("is-empty", open === null && !starting);
  log.replaceChildren(...nodes, ...noticeNodes(), jump ?? []);
  // FR-PLAN-040: new messages are followed only while the conversation is at its bottom.
  if (state.isFollowing) log.scrollTop = log.scrollHeight;
  else log.scrollTop = top;
}

function growComposer() {
  const text = byId("plan-text");
  text.style.height = "auto";
  const most = Math.round(panel().clientHeight * COMPOSER_MAX_SHARE);
  text.style.height = `${Math.min(text.scrollHeight, most)}px`;
  text.style.overflowY = text.scrollHeight > most ? "auto" : "hidden";
}

/** Shows the panel as the server and this page see it now. */
function draw() {
  const view = state.view;
  const open = view?.open ?? null;
  const isStart = open === null;
  const isRunning = view?.turn !== null && view?.turn !== undefined;
  const isHeldElsewhere = open !== null && open.heldBy !== null && !open.isHeldHere;
  const isClosed = open !== null && open.status !== "open";
  const isUnavailable = open !== null && open.unavailable !== null;
  byId("plan-subtitle").textContent =
    open === null ? targetText(chosenTarget()) : `${targetText(open.target)} · ${open.id}`;
  drawSessions();

  const resume = byId("plan-resume");
  resume.hidden = open === null || isClosed || isUnavailable;
  resume.replaceChildren(
    ...(resume.hidden
      ? []
      : [
          element("p", { className: "plan-menu-heading" }, "Continue elsewhere"),
          ...open.resumeCommands.map((command) =>
            element("div", { className: "plan-command" }, element("code", {}, command), copyButton(command)),
          ),
        ]),
  );

  // FR-GUI-024: a session open here can be ended at any time, with nothing saved.
  byId("plan-cancel-session").hidden = open === null || isClosed || (isHeldElsewhere && !isUnavailable);
  byId("plan-more").disabled = byId("plan-cancel-session").hidden && resume.hidden;

  // FR-PLAN-036: what to plan is fixed once the session has started.
  byId("plan-target-label").textContent = targetPill(isStart ? state.target : open.target);
  byId("plan-target").disabled = !isStart;
  byId("plan-model").disabled = open !== null && (isHeldElsewhere || isClosed || isUnavailable);
  byId("plan-composer").classList.toggle("is-blocked", isHeldElsewhere || isClosed || isUnavailable);
  if (isStart) drawTargetMenu();
  byId("plan-model-label").textContent = modelPill();

  const banner = byId("plan-banner");
  banner.hidden = !isHeldElsewhere && !isUnavailable;
  // FR-PLAN-041: an unavailable session's banner has the one action that helps.
  banner.replaceChildren(
    ...(isUnavailable
      ? [
          element("span", {}, open.unavailable),
          button("Cancel session", () => void call("/api/plan/cancel", { planId: open.id }).then(reported)),
        ]
      : isHeldElsewhere
        ? [`Held by ${PLACE_NAMES[open.heldBy]}. This panel follows it live; close it there to continue here.`]
        : []),
  );

  drawProgress(open);
  drawLog();

  const suggestions = byId("plan-suggestions");
  const shown = open !== null && !isRunning && !isHeldElsewhere && !isClosed ? newestSuggestions(open) : [];
  suggestions.hidden = shown.length === 0;
  suggestions.replaceChildren(
    ...shown.map((suggestion) => button(suggestion, () => void send(suggestion), "plan-suggestion")),
  );

  const isBlocked = isHeldElsewhere || isClosed || isUnavailable;
  const text = byId("plan-text");
  text.disabled = isBlocked;
  text.placeholder = isUnavailable
    ? "This session can't continue."
    : isHeldElsewhere
      ? "Reply where the session is open."
      : isClosed
        ? "Session closed. Choose New session."
        : open === null
          ? "Describe your idea…"
          : "Reply to the PM…";
  byId("plan-chips").replaceChildren(
    ...state.uploads.map((upload) =>
      fileChip(upload.name, upload.kind, () => removeUpload(upload), { uploadId: upload.id }),
    ),
  );
  byId("plan-attach").disabled = isBlocked;
  byId("plan-propose").hidden = open === null || isBlocked || isRunning;
  byId("plan-propose").disabled = isRunning || state.isOpening;
  byId("plan-send").hidden = isRunning && (open?.isHeldHere ?? false);
  byId("plan-send").disabled =
    isBlocked || state.isSending || state.isOpening || (text.value.trim() === "" && state.uploads.length === 0);
  byId("plan-stop").hidden = !isRunning || !(open?.isHeldHere ?? false);
  // FR-PLAN-040: followed to the end once everything below the log, such as the suggestions, is laid out.
  if (state.isFollowing) byId("plan-log").scrollTop = byId("plan-log").scrollHeight;
}

/** Each update of the panel from the server (FR-GUI-026, FR-PLAN-042). */
function receive(view) {
  const previous = state.view;
  // FR-PLAN-038: an action's reply can arrive after a newer update from the stream; the newest view wins.
  if (previous !== null && view.version < previous.version) return;
  state.view = view;
  setPlan(view);
  if (view.open?.id !== previous?.open?.id) {
    state.folded.clear();
    if (state.pending?.planId != null && state.pending.planId !== view.open?.id) clearPending();
    // This page's problems belong to the session they happened in.
    if (previous !== null) state.local = [];
  }
  if (isOpen()) draw();
  const wasRunning = previous?.turn !== null && previous?.turn !== undefined;
  if (wasRunning && view.turn === null && !isOpen() && view.open !== null)
    notify(view.notice?.message ?? "The PM replied.", view.notice !== null, {
      label: "Open",
      run: () => void openPlanSession(view.open.id),
    });
}

function receiveItems(planId, items, isReplacing) {
  const log = byId("plan-log");
  const wasAtBottom = isAtBottom(log);
  if (isReplacing || state.itemsPlanId !== planId) state.items = items;
  else state.items = [...state.items, ...items];
  state.itemsPlanId = planId;
  if (state.pending !== null && pendingShown({ id: planId }) === null && state.pending.planId !== null) clearPending();
  if (!wasAtBottom && !isReplacing && items.length > 0) state.isFollowing = false;
  if (isOpen()) draw();
}

function show() {
  // The task panel shares this place, so it's closed the way its own button closes it (panel.js imports this file).
  if (!byId("panel").hidden) byId("panel-close").click();
  panel().hidden = false;
  document.body.classList.add("has-panel");
  draw();
  growComposer();
  void ensureModels().catch(() => undefined);
}

/**
 * FR-GUI-023, FR-GUI-078, FR-PLAN-035: opens Plan. With a target, a new session for it starts from the start state;
 * the session the panel has open is let go first, unless the PM is working on it.
 */
export async function openPlan(target) {
  // FR-PLAN-034, FR-PLAN-040: an open session stays shown; New session in its menu starts another, for `target`.
  if (target !== undefined) state.target = target;
  const open = state.view?.open ?? null;
  if (open !== null && open.status !== "open") await call("/api/plan/new");
  show();
  byId("plan-text").focus();
}

/** FR-PLAN-034, FR-PLAN-045: opens a saved session, such as one with a proposal waiting in Needs you. */
export async function openPlanSession(planId) {
  await openSession(planId);
  show();
}

export function closePlan() {
  closeMenus();
  panel().hidden = true;
  if (byId("panel").hidden) document.body.classList.remove("has-panel");
}

export function startPlan() {
  const log = byId("plan-log");
  log.addEventListener("scroll", () => {
    const isFollowing = isAtBottom(log);
    if (isFollowing !== state.isFollowing) {
      state.isFollowing = isFollowing;
      drawLog();
    }
  });
  byId("plan-close").addEventListener("click", closePlan);
  // The log grows or shrinks as the suggestions bar or the message box changes; its end stays in view.
  new ResizeObserver(() => {
    if (state.isFollowing) log.scrollTop = log.scrollHeight;
  }).observe(log);
  byId("plan-cancel-session").addEventListener("click", () => {
    closeMenus();
    const planId = state.view?.open?.id;
    if (planId !== undefined) void call("/api/plan/cancel", { planId }).then(reported);
  });
  // The task panel and the Plan panel share one place, so opening the task panel closes this one.
  new MutationObserver(() => {
    if (!byId("panel").hidden && isOpen()) closePlan();
  }).observe(byId("panel"), { attributes: true, attributeFilter: ["hidden"] });
  // FR-PLAN-040: Escape closes an open menu, else the panel; the session stays open, and held.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen() || document.querySelector("dialog[open]") !== null) return;
    if (isMenuOpen()) {
      const open = MENUS.find(([, menuId]) => !byId(menuId).hidden);
      closeMenus();
      if (open !== undefined) byId(open[0]).focus();
      event.stopPropagation();
      return;
    }
    closePlan();
  });
  for (const [buttonId, menuId] of MENUS) {
    byId(buttonId).addEventListener("click", () => toggleMenu(buttonId, menuId));
    // Arrow keys move through a menu's items.
    byId(menuId).addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (event.target.tagName === "SELECT") return;
      const items = menuItems(byId(menuId));
      const index = items.indexOf(document.activeElement);
      const next = items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
      event.preventDefault();
      next?.focus();
    });
  }
  document.addEventListener("click", (event) => {
    if (!isMenuOpen() || event.target.closest?.(".plan-menu-wrap")) return;
    closeMenus();
  });
  byId("plan-options").addEventListener("change", () => {
    byId("plan-model-label").textContent = modelPill();
  });
  byId("plan-open").addEventListener("click", () => void openPlan({ kind: "new-roadmap" }));
  // FR-GUI-053: the empty canvas and List offer New roadmap too.
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-new-roadmap]")) void openPlan({ kind: "new-roadmap" });
  });
  // FR-GUI-085: Setup's Start a new project, with the model chosen there, or its setup continued.
  document.addEventListener("click", (event) => {
    const start = event.target.closest?.("[data-new-project]");
    if (!start) return;
    for (const [from, name] of [
      ["new-project-model", "model"],
      ["new-project-effort", "effort"],
    ]) {
      const chosen = byId(from)?.value ?? "";
      if (chosen !== "") byId("plan-options").querySelector(`[name="${name}"]`).value = chosen;
    }
    if (start.dataset.planId) void openPlanSession(start.dataset.planId);
    else void openPlan({ kind: "new-project" });
  });

  const composer = byId("plan-composer");
  const text = byId("plan-text");
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void send(text.value);
  });
  // FR-PLAN-036: Enter sends, and Shift+Enter starts a new line.
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!byId("plan-send").disabled) void send(text.value);
    }
  });
  text.addEventListener("input", () => {
    growComposer();
    byId("plan-send").disabled =
      text.disabled || state.isSending || state.isOpening || (text.value.trim() === "" && state.uploads.length === 0);
  });
  text.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    void attachAll(files);
  });
  byId("plan-attach").addEventListener("click", () => byId("plan-files").click());
  byId("plan-files").addEventListener("change", (event) => {
    void attachAll([...event.target.files]);
    event.target.value = "";
  });
  byId("plan-propose").addEventListener("click", () => void call("/api/plan/propose"));
  byId("plan-stop").addEventListener("click", () => void call("/api/plan/stop"));

  // FR-PLAN-036: files dropped anywhere on the panel are attached; the drop area shows while dragging.
  const drop = byId("plan-drop");
  let depth = 0;
  panel().addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files") || text.disabled) return;
    depth += 1;
    drop.hidden = false;
  });
  panel().addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  panel().addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) drop.hidden = true;
  });
  panel().addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    drop.hidden = true;
    if (!text.disabled) void attachAll([...(event.dataTransfer?.files ?? [])]);
  });

  const events = new EventSource("/api/plan/events");
  events.addEventListener("plan", (message) => receive(JSON.parse(message.data).plan));
  events.addEventListener("plan-transcript", (message) => {
    const data = JSON.parse(message.data);
    receiveItems(data.planId, data.items, true);
  });
  events.addEventListener("plan-entries", (message) => {
    const data = JSON.parse(message.data);
    receiveItems(data.planId, data.items, false);
  });
}
