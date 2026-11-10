/** Checks shared by `cclinic plan` and `cclinic auto`, which run Claude CLI agents. */
import { existsSync } from "node:fs";
import { probeClaude } from "../adapters/llm/select-provider.js";
import { UsageError } from "../core/errors.js";
import type { CommandContext } from "./command-context.js";
import { resolveProviderChoice } from "./generate-command.js";

/** FR-PLAN-003, FR-AUTO-003 */
export async function requireClaudeCli(command: string, context: CommandContext): Promise<void> {
  if (resolveProviderChoice(undefined, context.environment) === "anthropic-api") {
    throw new UsageError(
      `${command} runs Claude CLI agents, but the provider is set to anthropic-api. Unset CCLINIC_PROVIDER, or set it to claude-cli.`,
    );
  }
  const claude = await probeClaude(context.environment);
  if (!claude.isInstalled) {
    throw new UsageError(
      `${command} needs the Claude CLI, but "claude" isn't installed. Install Claude Code, then run "claude auth login".`,
    );
  }
}

export function requireDocuments(out: string): void {
  if (!existsSync(out)) {
    throw new UsageError(`${out} doesn't exist. Run cclinic in the project folder first to generate the documents.`);
  }
}
