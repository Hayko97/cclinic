/** The `luseen design` command (FR-DSGN-026). */
import { probeClaude } from "../adapters/llm/select-provider.js";
import { acquireLock, projectPaths } from "../adapters/storage/document-store.js";
import { installSkills, summarizeInstall } from "../adapters/storage/skill-installer.js";
import { DESIGN_CONSENT_MESSAGE, DESIGN_NEXT_STEP, DESIGN_NO_UI_MESSAGE } from "../core/design.js";
import { UsageError } from "../core/errors.js";
import type { CommandContext } from "./command-context.js";
import {
  createDesign,
  DESIGN_NOT_STARTED,
  findExistingDesign,
  formatDesignOutcome,
  incompleteDesignError,
  hasScreens,
  replaceDesign,
  type DesignOutcome,
} from "./design-step.js";
import type { EnvironmentCommandOptions } from "./environment-command.js";
import type { AgentSettings } from "./environment-step.js";
import {
  resolveAmbiguousValues,
  resolveModelAndEffort,
  resolveProviderChoice,
  resolveTarget,
} from "./generate-command.js";
import { askToConfirm, isInteractive } from "./menus.js";

export type DesignCommandOptions = EnvironmentCommandOptions;

/** Runs under the project lock, so a second run can't restore or replace files a `--force` run set aside. */
async function chooseOutcome(
  settings: AgentSettings,
  options: DesignCommandOptions,
  context: CommandContext,
): Promise<DesignOutcome> {
  const existing = await findExistingDesign(settings.target, context);
  if (options.force !== true) {
    if (existing.kind === "valid") return { status: "existing", designStatus: existing.status };
    if (existing.kind === "invalid") throw incompleteDesignError(existing.problems);
  }
  if (!(await hasScreens(settings.target))) return { status: "no-ui", message: DESIGN_NO_UI_MESSAGE };
  if (resolveProviderChoice(undefined, context.environment) === "anthropic-api") return DESIGN_NOT_STARTED;
  const claude = await probeClaude(context.environment);
  if (!claude.isInstalled || !claude.isLoggedIn) return DESIGN_NOT_STARTED;
  if (options.yes !== true) {
    if (!isInteractive()) {
      throw new UsageError("Confirmation needs an interactive terminal. Use --yes to run without asking.");
    }
    if (!(await askToConfirm(DESIGN_CONSENT_MESSAGE, true))) {
      return { status: "declined", nextStep: DESIGN_NEXT_STEP };
    }
  }
  return existing.kind === "missing" ? createDesign(settings, context) : replaceDesign(settings, context);
}

export async function runDesignCommand(
  given: string | undefined,
  options: DesignCommandOptions,
  context: CommandContext,
): Promise<void> {
  const ambiguous = await resolveAmbiguousValues(given, options);
  const target = await resolveTarget(ambiguous.path, options.allowBroadTarget === true);
  const { model, effort } = await resolveModelAndEffort(ambiguous, context);
  const { out } = projectPaths(target, options.out);
  // --force here means "create the design system again". It must not replace skills someone edited.
  const installed = await installSkills({ target, out, isForced: false });
  context.reporter.info(summarizeInstall(installed));
  const releaseLock = await acquireLock(projectPaths(target, out).lock);
  let outcome: DesignOutcome;
  try {
    outcome = await chooseOutcome({ target, out, model, effort, maxBudgetUsd: options.maxBudgetUsd }, options, context);
  } finally {
    await releaseLock();
  }
  if (options.json === true) {
    context.reporter.result(JSON.stringify({ design: outcome }));
    return;
  }
  const text = formatDesignOutcome(outcome);
  if (text !== undefined) context.reporter.result(text);
}
