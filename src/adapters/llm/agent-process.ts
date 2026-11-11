/** Runs one PM, developer or QA agent as a `claude -p` process with limited tools (FR-PLAN-005, FR-AUTO-016). */
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUDGET_DECIMAL_PLACES } from "../../core/constants/llm.js";
import { LIMITS } from "../../core/constants/limits.js";
import { AgentCallError, LlmError } from "../../core/errors.js";
import type { Effort, ModelChoice } from "../../core/models.js";
import { claudeEnvironment, findResult, requireSuccessfulResult, resultMessage, runProcess } from "./claude-cli.js";

export interface AgentToolSettings {
  readonly tools: readonly string[];
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
}

export interface AgentRequest extends AgentToolSettings {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: ModelChoice;
  readonly effort: Effort;
  readonly maxBudgetUsd: number;
  /** When given, the agent must end with JSON in this shape. */
  readonly jsonSchema?: Record<string, unknown>;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** FR-AUTO-016: keeps the session under this ID. Without it, no session is saved (FR-PLAN-005). */
  readonly sessionId?: string;
}

export interface AgentResult {
  readonly costUsd: number | null;
  readonly finalMessage: string;
  readonly structuredOutput: unknown;
}

export function buildAgentArgs(
  input: AgentToolSettings & {
    model: string;
    effort: string;
    maxBudgetUsd: number;
    jsonSchema?: Record<string, unknown>;
    sessionId?: string;
  },
): string[] {
  return [
    "-p",
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    ...(input.jsonSchema === undefined ? [] : ["--json-schema", JSON.stringify(input.jsonSchema)]),
    "--tools",
    ...input.tools,
    "--allowedTools",
    ...input.allowedTools,
    "--disallowedTools",
    ...input.deniedTools,
    "--permission-mode",
    "dontAsk",
    ...(input.sessionId === undefined ? ["--no-session-persistence"] : ["--session-id", input.sessionId]),
    // Keeps the login, and stops the project's own hooks and settings from running.
    "--safe-mode",
    "--max-budget-usd",
    input.maxBudgetUsd.toFixed(BUDGET_DECIMAL_PLACES),
  ];
}

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const { events, exitCode } = await runProcess(buildAgentArgs(request), request.prompt, {
    cwd: request.cwd,
    environment: claudeEnvironment(request.environment, LIMITS.maxRetries.default),
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onEvent: () => undefined,
  });
  try {
    const result = requireSuccessfulResult(events, exitCode, request.model);
    return {
      costUsd: result.total_cost_usd ?? null,
      finalMessage: resultMessage(result),
      structuredOutput: result.structured_output ?? null,
    };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    throw new AgentCallError(error.message, findResult(events)?.total_cost_usd ?? null, { cause: error, exitCode });
  }
}

/** Where Claude Code keeps its settings and sessions: `CLAUDE_CONFIG_DIR`, or `.claude` in the home folder. */
export function claudeConfigFolder(environment: NodeJS.ProcessEnv): string {
  const given = environment["CLAUDE_CONFIG_DIR"];
  return given !== undefined && given !== "" ? given : path.join(environment["HOME"] ?? os.homedir(), ".claude");
}

/**
 * Where Claude Code writes a session's transcript: its config folder, then the working folder with every
 * character other than a letter or digit turned into "-" (FR-AUTO-039).
 */
export function claudeTranscriptPath(environment: NodeJS.ProcessEnv, cwd: string, sessionId: string): string {
  const configFolder = claudeConfigFolder(environment);
  const projectFolder = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(configFolder, "projects", projectFolder, `${sessionId}.jsonl`);
}
