// Run with AI on a roadmap (FR-GUI-027, FR-GUI-028) and Stop (FR-GUI-031): the plan first, then the run as a job.
import { api, confirmAction, element, JOBS_CHANGED, notify } from "./api.js";
import { ensureModels, numberOrText } from "./setup.js";

/**
 * `previewed` is the options the shown plan was made from, so the run starts with exactly those. `asking` is the
 * plan request in flight; a change to the form drops it, so an older plan is never shown for newer options.
 */
const state = { roadmap: undefined, previewed: undefined, asking: undefined };

const byId = (id) => document.getElementById(id);

function options() {
  const form = byId("auto-form");
  const value = (name) => form.elements.namedItem(name).value;
  const chosen = (name) => (value(name) === "" ? undefined : value(name));
  return {
    roadmap: state.roadmap.id,
    developers: numberOrText(value("developers")),
    model: chosen("model"),
    effort: chosen("effort"),
    timeoutMinutes: numberOrText(value("timeoutMinutes")),
  };
}

/** Selects `value`, adding it when the menu doesn't list it, so a stopped run's setting is never dropped (FR-GUI-084). */
function choose(select, value) {
  if (value === undefined) return;
  if (![...select.options].some((option) => option.value === value)) select.append(element("option", { value }, value));
  select.value = value;
}

/** Any change to the form needs a new plan, so the run can't start with options the user didn't see planned. */
function clearPlan() {
  state.previewed = undefined;
  state.asking = undefined;
  byId("auto-plan").hidden = true;
  byId("auto-start").hidden = true;
  byId("auto-show-plan").hidden = false;
}

function showError(message) {
  byId("auto-error").textContent = message;
}

/**
 * FR-GUI-027: opens the form with this roadmap chosen. The defaults come from the CLI, through the server. With
 * `settings`, it continues a stopped run with the settings that run used (FR-GUI-084).
 */
export async function openAutoDialog(roadmap, settings = undefined) {
  state.roadmap = roadmap;
  const form = byId("auto-form");
  form.reset();
  clearPlan();
  showError("");
  byId("auto-title").textContent = settings === undefined ? "Run with AI" : "Continue the run";
  byId("auto-roadmap").textContent = `Roadmap #${roadmap.id}: ${roadmap.title}`;
  byId("auto-dialog").showModal();
  try {
    const [{ defaults }] = await Promise.all([api("/api/setup"), ensureModels()]);
    form.elements.namedItem("developers").placeholder = `Default: ${defaults.autoDevelopers}`;
    form.elements.namedItem("timeoutMinutes").placeholder = `Default: ${defaults.limits.timeoutMinutes}`;
    if (settings !== undefined) {
      // Set once the choices are loaded, so the model and reasoning menus hold them.
      form.elements.namedItem("developers").value = String(settings.developers);
      choose(form.elements.namedItem("model"), settings.model);
      choose(form.elements.namedItem("effort"), settings.effort);
      if (settings.timeoutMinutes !== undefined)
        form.elements.namedItem("timeoutMinutes").value = String(settings.timeoutMinutes);
    }
  } catch (error) {
    showError(error.message);
  }
}

/** FR-GUI-027, FR-GUI-028: the plan from `cclinic auto --dry-run`, or the CLI's reason it won't run. */
async function showPlan() {
  const asked = options();
  state.asking = asked;
  showError("");
  byId("auto-show-plan").disabled = true;
  try {
    const { plan } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ command: "auto", options: asked }),
    });
    // The form changed while the plan was made, so this plan is for options no longer shown.
    if (state.asking !== asked) return;
    state.previewed = asked;
    const shown = byId("auto-plan");
    shown.textContent = plan.plan;
    shown.hidden = false;
    byId("auto-show-plan").hidden = true;
    byId("auto-start").hidden = false;
    byId("auto-start").focus();
  } catch (error) {
    if (state.asking === asked) showError(error.message);
  } finally {
    byId("auto-show-plan").disabled = false;
  }
}

async function startRun() {
  if (state.previewed === undefined) return;
  byId("auto-start").disabled = true;
  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ command: "auto", confirmed: true, options: state.previewed }),
    });
    // FR-GUI-062: the job count and the notice when the run ends follow it.
    document.dispatchEvent(new Event(JOBS_CHANGED));
    byId("auto-dialog").close();
    notify(`Started an automated run of roadmap #${state.roadmap.id}.`);
  } catch (error) {
    showError(error.message);
  } finally {
    byId("auto-start").disabled = false;
  }
}

/**
 * FR-GUI-031, FR-GUI-061: asks first, then stops the run the GUI started, as Ctrl+C does; for one started elsewhere,
 * says which process to stop.
 */
export async function stopRun(roadmap) {
  const isSure = await confirmAction(
    `Stop run ${roadmap.run.runId} of roadmap #${roadmap.id} "${roadmap.title}"? Its tasks in progress go back to open, and work that isn't approved isn't merged.`,
    "Stop run",
  );
  if (!isSure) return;
  try {
    await api("/api/run/stop", { method: "POST" });
    notify("Stopping the run. Its tasks in progress go back to open.");
  } catch (error) {
    notify(error.message, true);
  }
}

export function startAuto() {
  const form = byId("auto-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void showPlan();
  });
  form.addEventListener("input", clearPlan);
  form.addEventListener("change", clearPlan);
  byId("auto-start").addEventListener("click", () => void startRun());
  byId("auto-cancel").addEventListener("click", () => byId("auto-dialog").close());
}

/** The buttons a roadmap offers for its run, on its frame and its panel (FR-GUI-078). */
export function runButtons(roadmap, className = "small") {
  // FR-GUI-084: a stopped run, or one that reached a plan limit, is continued with the same settings.
  if (roadmap.run === null && roadmap.continueWith !== null)
    return element(
      "button",
      {
        type: "button",
        className: `${className} primary`,
        "data-action": "continue-run",
        "aria-label": `Continue the run of ${roadmap.title}`,
        onClick: () => void openAutoDialog(roadmap, roadmap.continueWith),
      },
      "Continue",
    );
  return roadmap.run === null
    ? element(
        "button",
        {
          type: "button",
          className: `${className} primary`,
          "data-action": "run-ai",
          "aria-label": `Run ${roadmap.title} with AI`,
          onClick: () => void openAutoDialog(roadmap),
        },
        "Run with AI",
      )
    : element(
        "button",
        {
          type: "button",
          className: `${className} danger`,
          "data-action": "stop-run",
          "aria-label": `Stop the run of ${roadmap.title}`,
          onClick: () => void stopRun(roadmap),
        },
        "Stop",
      );
}
