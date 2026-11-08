/** The local environment step, shared by `cclinic environment` and the end of a generation run. */
import { runEnvironmentAgent } from "../adapters/llm/environment-agent.js";
import { readEnvironmentFile, snapshotFiles } from "../adapters/storage/environment-store.js";
import { relativeDocsPath } from "../adapters/storage/skill-installer.js";
import { AGENT_SKILLS } from "../core/agent-skills.js";
import { DEVOPS_SKILL_NAME, ENVIRONMENT_MAX_BUDGET_USD } from "../core/constants/environment.js";
import { ERROR_DETAIL_MAX_CHARS } from "../core/constants/llm.js";
import { USD_DECIMAL_PLACES } from "../core/constants/terminal.js";
import {
  buildEnvironmentPrompt,
  changedOutsideEnvironment,
  ENVIRONMENT_CONSENT_MESSAGE,
  ENVIRONMENT_FILE_PATH,
  ENVIRONMENT_NEXT_STEP,
  formatEnvironmentReview,
  type EnvironmentFile,
} from "../core/environment.js";
import { EnvironmentStepError, LlmError, ValidationFailedError } from "../core/errors.js";
import type { Effort, ModelChoice } from "../core/models.js";
import type { CommandContext } from "./command-context.js";
import { askToConfirm, isInteractive } from "./menus.js";

export type EnvironmentOutcome =
  | { readonly status: "skipped" }
  | { readonly status: "not-started"; readonly nextStep: string }
  | { readonly status: "declined"; readonly nextStep: string }
  | { readonly status: "existing"; readonly file: EnvironmentFile }
  | {
      readonly status: "ready";
      readonly file: EnvironmentFile;
      readonly costUsd: number | null;
      readonly changedFiles: readonly string[];
    }
  | { readonly status: "failed"; readonly message: string };

export interface AgentSettings {
  readonly target: string;
  readonly out: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly maxBudgetUsd?: number | undefined;
}

function devopsPrompt(docsPath: string): string {
  const body = AGENT_SKILLS.find((skill) => skill.name === DEVOPS_SKILL_NAME)?.body ?? "";
  return buildEnvironmentPrompt(body.replaceAll("{{DOCS}}", docsPath));
}

export async function findExisting(target: string, context: CommandContext): Promise<EnvironmentFile | undefined> {
  const state = await readEnvironmentFile(target);
  if (state.kind === "valid") return state.file;
  if (state.kind === "invalid") {
    context.reporter.warn(`${ENVIRONMENT_FILE_PATH} isn't valid, so it will be set up again.`);
  }
  return undefined;
}

export async function runAgentStep(settings: AgentSettings, context: CommandContext): Promise<EnvironmentOutcome> {
  const { target, out, model, effort } = settings;
  const { environment, reporter, signal } = context;
  reporter.info("Claude is setting up the local environment. This can take several minutes...");
  const before = await snapshotFiles(target);
  let finalMessage: string;
  let costUsd: number | null;
  try {
    ({ finalMessage, costUsd } = await runEnvironmentAgent({
      target,
      prompt: devopsPrompt(relativeDocsPath(target, out)),
      model,
      effort,
      maxBudgetUsd: settings.maxBudgetUsd ?? ENVIRONMENT_MAX_BUDGET_USD,
      environment,
      signal,
    }));
  } catch (error) {
    if (error instanceof LlmError) throw new EnvironmentStepError(error.message, { cause: error });
    throw error;
  }
  const changedFiles = changedOutsideEnvironment(before, await snapshotFiles(target));
  if (changedFiles.length > 0) {
    reporter.warn(`Setting up the environment also changed: ${changedFiles.join(", ")}`);
  }
  const state = await readEnvironmentFile(target);
  if (state.kind === "valid") return { status: "ready", file: state.file, costUsd, changedFiles };
  const said = finalMessage.slice(0, ERROR_DETAIL_MAX_CHARS);
  throw new ValidationFailedError(
    `Claude finished without a valid ${ENVIRONMENT_FILE_PATH}.${said === "" ? "" : ` It reported: ${said}`}`,
    state.kind === "invalid" ? state.problems : [],
  );
}

export function formatEnvironmentOutcome(outcome: EnvironmentOutcome): string | undefined {
  switch (outcome.status) {
    case "skipped":
    case "failed":
      return undefined;
    case "not-started":
    case "declined":
      return outcome.nextStep;
    case "existing":
      return formatEnvironmentReview(outcome.file);
    case "ready": {
      const cost =
        outcome.costUsd === null
          ? ""
          : `\nThis step used about $${outcome.costUsd.toFixed(USD_DECIMAL_PLACES)} (estimate).`;
      return `${formatEnvironmentReview(outcome.file)}${cost}`;
    }
  }
}

export interface AfterGenerateInput {
  readonly target: string;
  readonly out: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly maxBudgetUsd?: number | undefined;
  readonly isClaudeCli: boolean;
  readonly wereSkillsInstalled: boolean;
  /** true for --environment, false for --no-environment. */
  readonly requested: boolean | undefined;
  readonly mayAsk: boolean;
}

/** The documents are already saved here, so a failure only warns (FR-ENV-010). */
export async function setUpAfterGenerate(
  input: AfterGenerateInput,
  context: CommandContext,
): Promise<EnvironmentOutcome> {
  if (input.requested === false || !input.wereSkillsInstalled) return { status: "skipped" };
  const existing = await findExisting(input.target, context);
  if (existing !== undefined) return { status: "existing", file: existing };
  const notStarted: EnvironmentOutcome = { status: "not-started", nextStep: ENVIRONMENT_NEXT_STEP };
  if (!input.isClaudeCli) return notStarted;
  if (input.requested !== true) {
    // --yes only accepts the analysis cost, so it doesn't agree to running project code (FR-ENV-004).
    if (!input.mayAsk || !isInteractive()) return notStarted;
    if (!(await askToConfirm(ENVIRONMENT_CONSENT_MESSAGE, true))) {
      return { status: "declined", nextStep: ENVIRONMENT_NEXT_STEP };
    }
  }
  try {
    return await runAgentStep(input, context);
  } catch (error) {
    if (!(error instanceof EnvironmentStepError || error instanceof ValidationFailedError)) throw error;
    context.reporter.warn(`Couldn't set up the local environment: ${error.message}`);
    return { status: "failed", message: error.message };
  }
}
