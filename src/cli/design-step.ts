/** The design system step, shared by `luseen design` and the end of a generation run (spec: ui-design). */
import { runEnvironmentAgent, type AgentToolSet } from "../adapters/llm/environment-agent.js";
import {
  discardPreviousDesign,
  keepPreviousDesign,
  readDesignSystem,
  listDesignPaths,
  removeDesignPathsExcept,
  restoreInterruptedDesign,
  restorePreviousDesign,
  type DesignState,
} from "../adapters/storage/design-store.js";
import { readEnvironmentFile, snapshotFiles } from "../adapters/storage/environment-store.js";
import { relativeDocsPath } from "../adapters/storage/skill-installer.js";
import {
  DESIGN_AGENT_ALLOWED_TOOLS,
  DESIGN_AGENT_DENIED_TOOLS,
  DESIGN_AGENT_TOOLS,
  DESIGN_FOLDER,
  DESIGN_MAX_BUDGET_USD,
  DESIGN_TIMEOUT_MS,
} from "../core/constants/design.js";
import { ERROR_DETAIL_MAX_CHARS } from "../core/constants/llm.js";
import { USD_DECIMAL_PLACES } from "../core/constants/terminal.js";
import {
  buildDesignPrompt,
  DESIGN_CONSENT_MESSAGE,
  DESIGN_NEXT_STEP,
  DESIGN_NO_UI_MESSAGE,
  DESIGN_SYSTEM_PATH,
  formatDesignReview,
  formatNoUiFound,
  hasUserInterface,
  UI_DESIGN_SKILL,
  type DesignStatus,
} from "../core/design.js";
import { changedOutsideFolder } from "../core/environment.js";
import { DesignStepError, LlmError, ValidationFailedError } from "../core/errors.js";
import type { CommandContext } from "./command-context.js";
import type { AgentSettings } from "./environment-step.js";
import { askToConfirm, isInteractive } from "./menus.js";

export type DesignOutcome =
  | { readonly status: "skipped" }
  | { readonly status: "no-ui"; readonly message: string }
  | { readonly status: "not-started"; readonly nextStep: string }
  | { readonly status: "declined"; readonly nextStep: string }
  | { readonly status: "existing"; readonly designStatus: DesignStatus }
  | {
      readonly status: "ready";
      readonly designStatus: DesignStatus;
      readonly costUsd: number | null;
      readonly changedFiles: readonly string[];
    }
  | { readonly status: "failed"; readonly message: string };

const DESIGN_TOOL_SET: AgentToolSet = {
  tools: DESIGN_AGENT_TOOLS,
  allowed: DESIGN_AGENT_ALLOWED_TOOLS,
  denied: DESIGN_AGENT_DENIED_TOOLS,
  activity: "Creating the design system",
};

export const DESIGN_NOT_STARTED: DesignOutcome = { status: "not-started", nextStep: DESIGN_NEXT_STEP };

/** The design system as it is, after putting back one an interrupted `--force` run had set aside. */
export async function findExistingDesign(target: string, context: CommandContext): Promise<DesignState> {
  if (await restoreInterruptedDesign(target)) {
    context.reporter.warn(`Restored the design system in ${DESIGN_FOLDER} that an interrupted run had set aside.`);
  }
  return readDesignSystem(target);
}

/** FR-DSGN-032: an incomplete design system may hold hand edits, so only --force replaces it. */
export function incompleteDesignError(problems: readonly string[]): ValidationFailedError {
  return new ValidationFailedError(
    `${DESIGN_SYSTEM_PATH} isn't a complete design system. Fix it, or run "luseen design --force" to create it again.`,
    problems,
  );
}

/** FR-DSGN-024: a valid environment file with only command-line or library parts means there are no screens. */
export async function hasScreens(target: string): Promise<boolean> {
  const state = await readEnvironmentFile(target);
  return hasUserInterface(state.kind === "valid" ? state.file : undefined);
}

async function runDesignAgent(settings: AgentSettings, context: CommandContext): Promise<DesignOutcome> {
  const { target, out, model, effort } = settings;
  const { environment, reporter, signal } = context;
  reporter.info("Claude is creating the design system. This can take several minutes...");
  const before = await snapshotFiles(target, DESIGN_FOLDER);
  let finalMessage: string;
  let costUsd: number | null;
  try {
    ({ finalMessage, costUsd } = await runEnvironmentAgent({
      target,
      prompt: buildDesignPrompt(UI_DESIGN_SKILL.body.replaceAll("{{DOCS}}", relativeDocsPath(target, out))),
      model,
      effort,
      maxBudgetUsd: settings.maxBudgetUsd ?? DESIGN_MAX_BUDGET_USD,
      environment,
      signal,
      timeoutMs: DESIGN_TIMEOUT_MS,
      toolSet: DESIGN_TOOL_SET,
    }));
  } catch (error) {
    if (error instanceof LlmError) throw new DesignStepError(error.message, { cause: error });
    throw error;
  }
  const changedFiles = changedOutsideFolder(DESIGN_FOLDER, before, await snapshotFiles(target, DESIGN_FOLDER));
  if (changedFiles.length > 0) {
    reporter.warn(`Creating the design system also changed: ${changedFiles.join(", ")}`);
  }
  const state = await readDesignSystem(target);
  if (state.kind === "valid") return { status: "ready", designStatus: state.status, costUsd, changedFiles };
  const said = finalMessage.slice(0, ERROR_DETAIL_MAX_CHARS);
  // FR-DSGN-041: the skill writes nothing when it finds no screens to design for (FR-DSGN-003).
  if (state.kind === "missing") return { status: "no-ui", message: formatNoUiFound(said) };
  throw new ValidationFailedError(
    `Claude finished without a complete design system in ${DESIGN_FOLDER}.${said === "" ? "" : ` It reported: ${said}`}`,
    state.problems,
  );
}

/** FR-DSGN-040: a first run that fails leaves nothing behind, so the next run doesn't take it for hand edits. */
export async function createDesign(settings: AgentSettings, context: CommandContext): Promise<DesignOutcome> {
  const before = await listDesignPaths(settings.target);
  try {
    return await runDesignAgent(settings, context);
  } catch (error) {
    await removeDesignPathsExcept(settings.target, before);
    throw error;
  }
}

/** FR-DSGN-032: a design system being replaced is kept until a new one passes the checks. */
export async function replaceDesign(settings: AgentSettings, context: CommandContext): Promise<DesignOutcome> {
  await keepPreviousDesign(settings.target);
  try {
    const outcome = await runDesignAgent(settings, context);
    if (outcome.status === "no-ui") await restorePreviousDesign(settings.target);
    else await discardPreviousDesign(settings.target);
    return outcome;
  } catch (error) {
    await restorePreviousDesign(settings.target);
    throw error;
  }
}

export function formatDesignOutcome(outcome: DesignOutcome): string | undefined {
  switch (outcome.status) {
    case "skipped":
    case "failed":
      return undefined;
    case "no-ui":
      return outcome.message;
    case "not-started":
    case "declined":
      return outcome.nextStep;
    case "existing":
      return formatDesignReview(outcome.designStatus);
    case "ready": {
      const cost =
        outcome.costUsd === null
          ? ""
          : `\nThis step used about $${outcome.costUsd.toFixed(USD_DECIMAL_PLACES)} (estimate).`;
      return `${formatDesignReview(outcome.designStatus)}${cost}`;
    }
  }
}

export interface DesignAfterGenerateInput extends AgentSettings {
  readonly isClaudeCli: boolean;
  readonly wereSkillsInstalled: boolean;
  /** true for --design, false for --no-design. */
  readonly requested: boolean | undefined;
  readonly mayAsk: boolean;
}

/** Runs after the environment step, whose file says whether there are screens. A failure only warns (FR-DSGN-030). */
export async function setUpDesignAfterGenerate(
  input: DesignAfterGenerateInput,
  context: CommandContext,
): Promise<DesignOutcome> {
  if (input.requested === false || !input.wereSkillsInstalled) return { status: "skipped" };
  const existing = await findExistingDesign(input.target, context);
  if (existing.kind === "valid") return { status: "existing", designStatus: existing.status };
  if (existing.kind === "invalid") {
    const error = incompleteDesignError(existing.problems);
    context.reporter.warn(`${error.message} ${existing.problems.join("; ")}`);
    return { status: "failed", message: error.message };
  }
  if (!(await hasScreens(input.target))) return { status: "no-ui", message: DESIGN_NO_UI_MESSAGE };
  if (!input.isClaudeCli) return DESIGN_NOT_STARTED;
  if (input.requested !== true) {
    if (!input.mayAsk || !isInteractive()) return DESIGN_NOT_STARTED;
    if (!(await askToConfirm(DESIGN_CONSENT_MESSAGE, true))) {
      return { status: "declined", nextStep: DESIGN_NEXT_STEP };
    }
  }
  try {
    return await createDesign(input, context);
  } catch (error) {
    if (!(error instanceof DesignStepError || error instanceof ValidationFailedError)) throw error;
    context.reporter.warn(`Couldn't create the design system: ${error.message}`);
    return { status: "failed", message: error.message };
  }
}
