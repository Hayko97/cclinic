/** Runs Claude with limited tools in the target folder, to set up its local environment (FR-ENV-008). */
import {
  ENVIRONMENT_AGENT_ALLOWED_TOOLS,
  ENVIRONMENT_AGENT_DENIED_TOOLS,
  ENVIRONMENT_AGENT_TOOLS,
  ENVIRONMENT_TIMEOUT_MS,
} from "../../core/constants/environment.js";
import { LIMITS, MS_PER_MINUTE } from "../../core/constants/limits.js";
import { BUDGET_DECIMAL_PLACES } from "../../core/constants/llm.js";
import type { Effort, ModelChoice } from "../../core/models.js";
import { claudeEnvironment, requireSuccessfulResult, resultMessage, runProcess } from "./claude-cli.js";

export interface EnvironmentAgentRequest {
  readonly target: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly maxBudgetUsd: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export interface EnvironmentAgentResult {
  readonly costUsd: number | null;
  readonly finalMessage: string;
}

export function buildEnvironmentAgentArgs(input: { model: string; effort: string; maxBudgetUsd: number }): string[] {
  return [
    "-p",
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    ...ENVIRONMENT_AGENT_TOOLS,
    "--allowedTools",
    ...ENVIRONMENT_AGENT_ALLOWED_TOOLS,
    "--disallowedTools",
    ...ENVIRONMENT_AGENT_DENIED_TOOLS,
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    // Keeps the login, and stops the project's own hooks and settings from running.
    "--safe-mode",
    "--max-budget-usd",
    input.maxBudgetUsd.toFixed(BUDGET_DECIMAL_PLACES),
  ];
}

export async function runEnvironmentAgent(request: EnvironmentAgentRequest): Promise<EnvironmentAgentResult> {
  const timeoutMs = request.timeoutMs ?? ENVIRONMENT_TIMEOUT_MS;
  const { events, exitCode } = await runProcess(
    buildEnvironmentAgentArgs({
      model: request.model,
      effort: request.effort,
      maxBudgetUsd: request.maxBudgetUsd,
    }),
    request.prompt,
    {
      cwd: request.target,
      environment: claudeEnvironment(request.environment, LIMITS.maxRetries.default),
      timeoutMs,
      timeoutMessage: `Setting up the environment stopped at its limit of ${timeoutMs / MS_PER_MINUTE} minutes.`,
      signal: request.signal,
      onEvent: () => undefined,
    },
  );
  const result = requireSuccessfulResult(events, exitCode, request.model);
  return { costUsd: result.total_cost_usd ?? null, finalMessage: resultMessage(result) };
}
