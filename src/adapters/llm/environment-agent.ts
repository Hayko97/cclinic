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

/** The tools a step's agent may use: the local environment by default, or the design system (FR-DSGN-028). */
export interface AgentToolSet {
  readonly tools: readonly string[];
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
  /** What the step does, as in "Setting up the environment stopped at its limit". */
  readonly activity: string;
}

export const ENVIRONMENT_TOOL_SET: AgentToolSet = {
  tools: ENVIRONMENT_AGENT_TOOLS,
  allowed: ENVIRONMENT_AGENT_ALLOWED_TOOLS,
  denied: ENVIRONMENT_AGENT_DENIED_TOOLS,
  activity: "Setting up the environment",
};

export interface EnvironmentAgentRequest {
  readonly target: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly maxBudgetUsd: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly toolSet?: AgentToolSet;
}

export interface EnvironmentAgentResult {
  readonly costUsd: number | null;
  readonly finalMessage: string;
}

export function buildEnvironmentAgentArgs(input: {
  model: string;
  effort: string;
  maxBudgetUsd: number;
  toolSet?: AgentToolSet;
}): string[] {
  const toolSet = input.toolSet ?? ENVIRONMENT_TOOL_SET;
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
    ...toolSet.tools,
    "--allowedTools",
    ...toolSet.allowed,
    "--disallowedTools",
    ...toolSet.denied,
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
  const toolSet = request.toolSet ?? ENVIRONMENT_TOOL_SET;
  const { events, exitCode } = await runProcess(
    buildEnvironmentAgentArgs({
      model: request.model,
      effort: request.effort,
      maxBudgetUsd: request.maxBudgetUsd,
      toolSet,
    }),
    request.prompt,
    {
      cwd: request.target,
      environment: claudeEnvironment(request.environment, LIMITS.maxRetries.default),
      timeoutMs,
      timeoutMessage: `${toolSet.activity} stopped at its limit of ${timeoutMs / MS_PER_MINUTE} minutes.`,
      signal: request.signal,
      onEvent: () => undefined,
    },
  );
  const result = requireSuccessfulResult(events, exitCode, request.model);
  return { costUsd: result.total_cost_usd ?? null, finalMessage: resultMessage(result) };
}
