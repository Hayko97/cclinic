// Setup (FR-GUI-014 to FR-GUI-018): check, generate, skills, environment, the default model, MCP and clean.
// Each runs the same `cclinic` command as the terminal, as a job, after the same questions.
import { api, confirmAction, element, notify, runJob } from "./api.js";

const byId = (id) => document.getElementById(id);
const state = { openJob: () => undefined, mcpEntry: "", environmentConsent: "", choices: undefined };

/** The JSON a `--json` command printed as its result: its last stdout line that is an object. */
async function resultOf(id) {
  const { job } = await api(`/api/jobs/${id}`);
  for (const line of [...job.output.lines].reverse()) {
    if (line.stream !== "stdout") continue;
    try {
      const parsed = JSON.parse(line.text);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // Progress text, not the result.
    }
  }
  return undefined;
}

/** Starts a job and shows its output on the Jobs screen, for commands that take a while. */
async function startAndShow(request) {
  const { job } = await api("/api/jobs", { method: "POST", body: JSON.stringify(request) });
  state.openJob(job.id);
  return job;
}

const DOCTOR_STATES = { passed: "Passed", failed: "Failed", skipped: "Skipped" };

/** FR-GUI-015: the newest finished `cclinic doctor`, check by check. */
async function drawDoctor() {
  const list = byId("doctor-result");
  const { jobs } = await api("/api/jobs");
  // Jobs are listed oldest first, so the newest finished doctor is the last one.
  const doctor = jobs.findLast((job) => job.kind === "doctor" && !job.isRunning);
  if (doctor === undefined) {
    list.replaceChildren(element("li", { className: "muted" }, "Run doctor to check this project."));
    return;
  }
  const result = await resultOf(doctor.id);
  if (result === undefined || !Array.isArray(result.checks)) {
    list.replaceChildren(element("li", { className: "muted" }, `Doctor didn't finish: ${doctor.exitMeaning}.`));
    return;
  }
  list.replaceChildren(
    ...result.checks.map((check) =>
      element(
        "li",
        { className: "check" },
        element("span", { className: `job-status is-${check.state === "failed" ? "failed" : "ok"}` }),
        element(
          "span",
          {},
          element("strong", {}, check.name),
          ` ${DOCTOR_STATES[check.state] ?? check.state}: ${check.detail}`,
          check.fix === undefined ? null : element("span", { className: "muted" }, ` ${check.fix}`),
        ),
      ),
    ),
  );
}

/** FR-GUI-017: the options and the saved choice come from `cclinic model --list --json`. */
async function loadModels() {
  const job = await runJob({ command: "model-list" });
  const result = await resultOf(job.id);
  if (result === undefined) return;
  state.choices = result;
  for (const select of document.querySelectorAll("select[data-models]"))
    fill(
      select,
      result.models,
      select.hasAttribute("data-optional") || select.closest("#generate-form") !== null
        ? undefined
        : result.current.model,
    );
  for (const select of document.querySelectorAll("select[data-efforts]"))
    fill(select, result.efforts, select.closest("#model-form") === null ? undefined : result.current.effort);
  const model = result.models.find((option) => option.value === result.current.model);
  const effort = result.efforts.find((option) => option.value === result.current.effort);
  byId("model-current").textContent =
    `Now: ${model?.label ?? result.current.model} at ${effort?.label ?? result.current.effort} reasoning.`;
}

/** A select of the CLI's options; with no `chosen`, the first entry leaves it to the saved default. */
function fill(select, options, chosen) {
  select.replaceChildren(
    ...(chosen === undefined ? [element("option", { value: "" }, "Saved default")] : []),
    ...options.map((option) => element("option", { value: option.value }, option.label)),
  );
  select.value = chosen ?? "";
}

/** A typed number is sent as a number; anything else as typed, so the server names it in the CLI's words. */
export function numberOrText(value) {
  const text = value.trim();
  if (text === "") return undefined;
  // The CLI reads values with Number(), so anything Number() reads is sent as a number.
  return Number.isFinite(Number(text)) ? Number(text) : text;
}

const lines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** FR-GUI-015: the generate form as the API's options; only what's set is sent. */
function generateOptions(form) {
  const data = new FormData(form);
  const value = (name) => (data.get(name) ?? "").toString();
  const options = { include: lines(value("include")), exclude: lines(value("exclude")) };
  for (const name of ["provider", "model", "effort"]) if (value(name) !== "") options[name] = value(name);
  const numbers = ["maxBudgetUsd", "maxFiles", "maxInputTokens", "maxFileSizeMib", "concurrency", "timeoutMinutes"];
  for (const name of [...numbers, "maxRetries"]) {
    const number = numberOrText(value(name));
    if (number !== undefined) options[name] = number;
  }
  for (const name of ["dryRun", "noSkills", "noCache", "noGit", "allowBroadTarget", "force"])
    options[name] = data.get(name) === "on";
  if (value("environment") !== "") options.environment = value("environment") === "yes";
  return options;
}

/** FR-GUI-016: the CLI's questions in one dialog; resolves with the answers, or undefined when cancelled. */
function askQuestions(questions) {
  const dialog = byId("generate-questions");
  byId("generate-question-list").replaceChildren(
    ...questions.map((question) =>
      element(
        "fieldset",
        { className: "question", "data-question": question.id },
        element("legend", {}, question.text),
        question.answers.map((answer, index) =>
          element(
            "label",
            { className: "switch" },
            element("input", { type: "radio", name: question.id, value: answer.value, checked: index === 0 }),
            ` ${answer.label}`,
          ),
        ),
      ),
    ),
  );
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "confirm") return resolve(undefined);
        resolve(
          Object.fromEntries(
            questions.map((question) => [
              question.id,
              dialog.querySelector(`input[name="${question.id}"]:checked`)?.value,
            ]),
          ),
        );
      },
      { once: true },
    );
  });
}

/** The answers as options, or undefined when one of them stops the run. */
function answeredOptions(options, answers) {
  if (answers.cost === "cancel" || answers.force === "cancel") return undefined;
  return {
    ...options,
    ...(answers.git === "no-git" ? { noGit: true } : {}),
    ...(answers.environment === undefined ? {} : { environment: answers.environment === "yes" }),
  };
}

async function generate(event) {
  event.preventDefault();
  const error = byId("generate-error");
  const button = byId("generate-start");
  error.textContent = "";
  const options = generateOptions(byId("generate-form"));
  button.disabled = true;
  try {
    // A dry run sends nothing and costs nothing, so it isn't asked about, as in the terminal.
    if (options.dryRun) {
      await startAndShow({ command: "generate", confirmed: true, options });
      return;
    }
    button.textContent = "Checking…";
    const { questions } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ command: "generate", options }),
    });
    const answers = await askQuestions(questions);
    const answered = answers === undefined ? undefined : answeredOptions(options, answers);
    if (answered === undefined) {
      notify("Nothing was sent.");
      return;
    }
    await startAndShow({ command: "generate", confirmed: true, options: answered });
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    button.disabled = false;
    button.textContent = "Generate…";
    // The button was disabled while the dialog was open, so focus is put back on it (FR-GUI-064).
    button.focus();
  }
}

async function runReported(request, success) {
  try {
    await runJob(request);
    notify(success);
    return true;
  } catch (error) {
    notify(error.message, true);
    return false;
  }
}

async function saveModel() {
  const data = new FormData(byId("model-form"));
  const request = { command: "model-set", model: data.get("model"), effort: data.get("effort") };
  if (await runReported(request, "Saved the default model.")) await loadModels();
}

async function resetModel() {
  if (await runReported({ command: "model-reset" }, "Reset to the built-in default.")) await loadModels();
}

async function setUpEnvironment(consent) {
  const error = byId("environment-error");
  error.textContent = "";
  // Never asked without the CLI's own words, so agreeing always means agreeing to them.
  if (consent === "") {
    error.textContent = "Setup hasn't loaded yet. Open Setup again, then try once more.";
    return;
  }
  const data = new FormData(byId("environment-form"));
  const options = {
    force: byId("environment-force").checked,
    allowBroadTarget: byId("environment-broad").checked,
  };
  for (const name of ["model", "effort"]) if ((data.get(name) ?? "") !== "") options[name] = data.get(name);
  const budget = numberOrText((data.get("maxBudgetUsd") ?? "").toString());
  if (budget !== undefined) options.maxBudgetUsd = budget;
  // FR-GUI-017: the same consent the terminal asks for, before anything runs.
  if (!(await confirmAction(consent, "Set it up", { isDanger: false }))) return;
  try {
    await startAndShow({ command: "environment", confirmed: true, options });
  } catch (failure) {
    error.textContent = failure.message;
  }
}

async function clean() {
  if (
    !(await confirmAction(
      `Delete the cache and failed drafts? Generated documents aren't touched. This can't be undone.`,
      "Clean",
    ))
  )
    return;
  await runReported({ command: "clean" }, "Cleaned the cache and failed drafts.");
}

const MCP_STATUS = {
  installed: "Installed: your coding agent can start cclinic mcp.",
  missing: "Not installed. Add this entry to .mcp.json, or install the skills.",
  changed: "cclinic's entry in .mcp.json was changed by hand, so it's left as it is.",
  unreadable: ".mcp.json can't be read, or isn't valid JSON, so cclinic can't tell whether it's connected.",
};

/** FR-GUI-014, FR-GUI-018: whether the project is set up, and how a host agent connects. */
async function drawSetup() {
  const setup = await api("/api/setup");
  byId("setup-status").textContent = setup.hasDocuments
    ? "This project's documents are generated. Run any step again here."
    : "This project isn't set up yet. Generating its documents is the first step.";
  byId("setup-status").classList.toggle("is-first-step", !setup.hasDocuments);
  const status = byId("mcp-status");
  status.textContent = MCP_STATUS[setup.mcp.status] ?? setup.mcp.status;
  status.className = setup.mcp.status === "installed" ? "ok" : "muted";
  byId("mcp-entry").textContent = setup.mcp.entry;
  drawDefaults(setup.defaults);
  state.mcpEntry = setup.mcp.entry;
  state.environmentConsent = setup.environmentConsent;
  // Usable only once the consent text the terminal shows has arrived (FR-GUI-017).
  byId("environment-run").disabled = state.environmentConsent === "";
}

/** The CLI's defaults as placeholders, and its providers as choices, from the server (FR-GUI-015). */
function drawDefaults(defaults) {
  for (const [name, value] of Object.entries(defaults.limits)) {
    const input = document.querySelector(`#generate-form input[name="${name}"]`);
    if (input !== null) input.placeholder = String(value);
  }
  document.querySelector('#environment-form input[name="maxBudgetUsd"]').placeholder =
    `Default: ${defaults.environmentBudgetUsd}`;
  const provider = document.querySelector('#generate-form select[name="provider"]');
  if (provider.options.length === 1)
    provider.append(...defaults.providers.map((value) => element("option", { value }, value)));
}

/** The model and reasoning choices, loaded once, for any form that offers them (FR-GUI-017, FR-GUI-027). */
export async function ensureModels() {
  if (state.choices === undefined) await loadModels();
}

/** Called each time Setup is shown. */
export async function refreshSetup() {
  await Promise.all([drawSetup(), drawDoctor(), state.choices === undefined ? loadModels() : undefined]);
}

/** `openJob` shows a job's output on the Jobs screen. */
export function startSetup(openJob) {
  state.openJob = openJob;
  byId("generate-form").addEventListener("submit", (event) => void generate(event));
  byId("model-save").addEventListener("click", () => void saveModel());
  byId("model-reset").addEventListener("click", () => void resetModel());
  byId("skills-run").addEventListener("click", () => {
    void startAndShow({ command: "skills", force: byId("skills-force").checked }).catch((error) =>
      notify(error.message, true),
    );
  });
  byId("environment-run").addEventListener("click", () => void setUpEnvironment(state.environmentConsent));
  byId("clean-run").addEventListener("click", () => void clean());
  byId("mcp-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.mcpEntry);
      notify("Copied the .mcp.json entry.");
    } catch {
      notify("The browser didn't allow copying. Select the entry and copy it yourself.", true);
    }
  });
}
