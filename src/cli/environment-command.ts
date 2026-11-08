/** The `cclinic environment` command. */
import { probeClaude } from "../adapters/llm/select-provider.js";
import { acquireLock, projectPaths } from "../adapters/storage/document-store.js";
import { installSkills, summarizeInstall } from "../adapters/storage/skill-installer.js";
import { ENVIRONMENT_CONSENT_MESSAGE, ENVIRONMENT_NEXT_STEP } from "../core/environment.js";
import { UsageError } from "../core/errors.js";
import type { CommandContext } from "./command-context.js";
import {
  findExisting,
  formatEnvironmentOutcome,
  runAgentStep,
  type AgentSettings,
  type EnvironmentOutcome,
} from "./environment-step.js";
import {
  resolveAmbiguousValues,
  resolveModelAndEffort,
  resolveProviderChoice,
  resolveTarget,
} from "./generate-command.js";
import { askToConfirm, isInteractive } from "./menus.js";

export interface EnvironmentCommandOptions {
  readonly out?: string;
  readonly model?: string | true;
  readonly effort?: string | true;
  readonly maxBudgetUsd?: number;
  readonly yes?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly allowBroadTarget?: boolean;
}

async function chooseOutcome(
  settings: AgentSettings,
  options: EnvironmentCommandOptions,
  context: CommandContext,
): Promise<EnvironmentOutcome> {
  if (options.force !== true) {
    const existing = await findExisting(settings.target, context);
    if (existing !== undefined) return { status: "existing", file: existing };
  }
  const notStarted: EnvironmentOutcome = { status: "not-started", nextStep: ENVIRONMENT_NEXT_STEP };
  if (resolveProviderChoice(undefined, context.environment) === "anthropic-api") return notStarted;
  const claude = await probeClaude(context.environment);
  if (!claude.isInstalled || !claude.isLoggedIn) return notStarted;
  if (options.yes !== true) {
    if (!isInteractive()) {
      throw new UsageError("Confirmation needs an interactive terminal. Use --yes to run without asking.");
    }
    if (!(await askToConfirm(ENVIRONMENT_CONSENT_MESSAGE, true))) {
      return { status: "declined", nextStep: ENVIRONMENT_NEXT_STEP };
    }
  }
  const releaseLock = await acquireLock(projectPaths(settings.target, settings.out).lock);
  try {
    return await runAgentStep(settings, context);
  } finally {
    await releaseLock();
  }
}

export async function runEnvironmentCommand(
  given: string | undefined,
  options: EnvironmentCommandOptions,
  context: CommandContext,
): Promise<void> {
  const ambiguous = await resolveAmbiguousValues(given, options);
  const target = await resolveTarget(ambiguous.path, options.allowBroadTarget === true);
  const { model, effort } = await resolveModelAndEffort(ambiguous, context);
  const { out } = projectPaths(target, options.out);
  // --force here means "set up the environment again". It must not replace skills someone edited.
  const installed = await installSkills({ target, out, isForced: false });
  context.reporter.info(summarizeInstall(installed));
  const outcome = await chooseOutcome(
    { target, out, model, effort, maxBudgetUsd: options.maxBudgetUsd },
    options,
    context,
  );
  if (options.json === true) {
    context.reporter.result(JSON.stringify({ environment: outcome }));
    return;
  }
  const text = formatEnvironmentOutcome(outcome);
  if (text !== undefined) context.reporter.result(text);
}
