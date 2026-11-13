/** Runs one PM, developer or QA agent as a `claude -p` process with limited tools (FR-PLAN-005, FR-AUTO-016). */
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMITS } from "../../core/constants/limits.js";
import { AgentCallError, LlmError, RateLimitError } from "../../core/errors.js";
import { isLimitReached, limitsFromEvent, type PlanLimits } from "../../core/limits.js";
import type { Effort, ModelChoice } from "../../core/models.js";
import {
  claudeEnvironment,
  findResult,
  isUsageLimitMessage,
  requireSuccessfulResult,
  resultMessage,
  runProcess,
} from "./claude-cli.js";

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
  /** When given, the agent must end with JSON in this shape. */
  readonly jsonSchema?: Record<string, unknown>;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** FR-AUTO-016: keeps the session under this ID. Without it, no session is saved (FR-PLAN-005). */
  readonly sessionId?: string;
  /** FR-AUTO-041: called with each plan-limits report Claude Code makes during the call. */
  readonly onLimits?: (limits: PlanLimits) => void;
}

export interface AgentResult {
  readonly costUsd: number | null;
  readonly finalMessage: string;
  readonly structuredOutput: unknown;
  /** FR-AUTO-025: Claude reported during the call that a plan usage limit is reached, with when it resets. */
  readonly limitReached: { readonly resetsAt: string | null } | null;
}

export function buildAgentArgs(
  input: AgentToolSettings & {
    model: string;
    effort: string;
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
    // Keeps the login, and stops the project's own hooks and settings from running. No dollar limit is passed: the
    // plan's own usage limits stop the work (FR-AUTO-025).
    "--safe-mode",
  ];
}

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  let limits: PlanLimits | undefined;
  const { events, exitCode } = await runProcess(buildAgentArgs(request), request.prompt, {
    cwd: request.cwd,
    environment: claudeEnvironment(request.environment, LIMITS.maxRetries.default),
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onEvent: (event) => {
      const reported = limitsFromEvent(event, new Date());
      if (reported === undefined) return;
      limits = reported;
      request.onLimits?.(reported);
    },
  });
  try {
    const result = requireSuccessfulResult(events, exitCode, request.model);
    return {
      costUsd: result.total_cost_usd ?? null,
      finalMessage: resultMessage(result),
      structuredOutput: result.structured_output ?? null,
      limitReached: limits !== undefined && isLimitReached(limits) ? { resetsAt: limits.resetsAt } : null,
    };
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    const isUsageLimit =
      (error instanceof RateLimitError && isUsageLimitMessage(error.message)) ||
      (limits !== undefined && isLimitReached(limits));
    throw new AgentCallError(error.message, findResult(events)?.total_cost_usd ?? null, {
      cause: error,
      exitCode,
      isUsageLimit,
      resetsAt: limits?.resetsAt ?? null,
    });
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
