/** Runs Claude through the `claude` command. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { MS_PER_MINUTE } from "../../core/constants/limits.js";
import {
  BUDGET_DECIMAL_PLACES,
  CLAUDE_CLI_MAX_TURNS,
  CLAUDE_COMMAND,
  ENV_VARS,
  ERROR_DETAIL_MAX_CHARS,
  HTTP_STATUS,
  MAX_OUTPUT_TOKENS,
  PROCESS_KILL_GRACE_MS,
} from "../../core/constants/llm.js";
import { CLAUDE_MODELS } from "../../core/constants/models.js";
import {
  AuthError,
  BudgetError,
  CancelledError,
  ProviderError,
  RateLimitError,
  RefusalError,
  RESUME_HINT,
  SchemaError,
  TruncatedError,
} from "../../core/errors.js";
import { estimateTokensFromChars, labelForModel, type ModelChoice } from "../../core/models.js";
import type { Logger, LlmProvider, LlmRequest, LlmResult } from "../../core/ports.js";
import { BackoffGate, parseValidated, toJsonSchemaObject, withSchemaRetry } from "./retry.js";

/** Applied to every `claude` process (FR-LLM-028). */
export function claudeEnvironment(environment: NodeJS.ProcessEnv, maxRetries: number): NodeJS.ProcessEnv {
  const removed: readonly string[] = [ENV_VARS.ANTHROPIC_API_KEY, ENV_VARS.ANTHROPIC_AUTH_TOKEN];
  const cleaned: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !removed.includes(name)),
  );
  return {
    ...cleaned,
    [ENV_VARS.CLAUDE_MAX_RETRIES]: String(maxRetries),
    [ENV_VARS.CLAUDE_MAX_OUTPUT_TOKENS]: String(MAX_OUTPUT_TOKENS),
    [ENV_VARS.CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "1",
  };
}

const resultEventSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  stop_reason: z.string().nullish(),
  result: z.string().nullish(),
  errors: z.array(z.unknown()).nullish(),
  api_error_status: z.number().nullish(),
  // The docs say this field is absent when a run ends without valid output.
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().nullish(),
  modelUsage: z.record(z.string(), z.unknown()).nullish(),
  usage: z
    .looseObject({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .nullish(),
});
type ResultEvent = z.infer<typeof resultEventSchema>;

const retryEventSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number().optional(),
  max_retries: z.number().optional(),
  retry_delay_ms: z.number().optional(),
  error: z.string().optional(),
});

/** Splits raw stream text into parsed JSON events, ignoring anything that isn't JSON. */
export function parseStreamLines(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partial or non-JSON line carries no result.
    }
  }
  return events;
}

export function findResult(events: readonly unknown[]): ResultEvent | undefined {
  for (const event of [...events].reverse()) {
    const parsed = resultEventSchema.safeParse(event);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function resultMessage(result: ResultEvent): string {
  const errors = (result.errors ?? []).filter((item): item is string => typeof item === "string");
  return [result.result ?? "", ...errors].join(" ").trim();
}

const USAGE_LIMIT = /hit your (.{0,40}?)limit/i;
const MODEL_NAMES = Object.values(CLAUDE_MODELS)
  .map((model) => model.value)
  .join("|");
const MODEL_LIMIT = new RegExp(`hit your (${MODEL_NAMES}) limit`, "i");

function classifyFailure(result: ResultEvent, exitCode: number | null, model: ModelChoice): Error {
  const message = resultMessage(result);
  const status = result.api_error_status;
  if (result.subtype === "error_max_budget_usd") return new BudgetError("Reached the budget for this run.");
  if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) {
    return new AuthError(
      `The Claude CLI couldn't authenticate. Run "claude auth login", or use --provider anthropic-api with ANTHROPIC_API_KEY set. If you are logged in, a newer Claude Code release may have changed how -p uses logins.`,
    );
  }
  if (status === HTTP_STATUS.NOT_FOUND || /issue with the selected model/i.test(message)) {
    return new ProviderError(
      `${labelForModel(model)} isn't available to this account. Run "cclinic model" to choose another model.`,
    );
  }
  if (status === HTTP_STATUS.TOO_MANY_REQUESTS || USAGE_LIMIT.test(message)) {
    const advice = MODEL_LIMIT.test(message) ? ` Run "cclinic model" to choose another model, or wait.` : "";
    const detail = message === "" ? "Claude's rate or usage limit was reached." : message;
    return new RateLimitError(`${detail}${advice} ${RESUME_HINT}`);
  }
  if (/max_output_tokens|output token/i.test(message) || result.stop_reason === "max_tokens") {
    return new TruncatedError("Claude's response was cut off by the output limit.");
  }
  if (result.stop_reason === "refusal") return new RefusalError("Claude declined this request.");
  const detail = message === "" ? `exit code ${exitCode ?? "unknown"}` : message.slice(0, ERROR_DETAIL_MAX_CHARS);
  return new ProviderError(`The Claude CLI failed: ${detail}`);
}

export interface ClaudeOutcome {
  readonly data: unknown;
  readonly actualModel: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Decides success from the result event (FR-LLM-008). `subtype` and `stop_reason` aren't reliable:
 * an invalid model reports subtype "success", and a good structured call reports stop_reason "tool_use".
 */
export function requireSuccessfulResult(
  events: readonly unknown[],
  exitCode: number | null,
  model: ModelChoice,
): ResultEvent {
  const result = findResult(events);
  if (result === undefined) {
    throw new ProviderError(`The Claude CLI ended without a result (exit code ${exitCode ?? "unknown"}).`);
  }
  if (exitCode !== 0 || result.is_error === true) throw classifyFailure(result, exitCode, model);
  return result;
}

export function interpretOutcome(
  events: readonly unknown[],
  exitCode: number | null,
  model: ModelChoice,
): ClaudeOutcome {
  const result = requireSuccessfulResult(events, exitCode, model);
  if (result.structured_output === undefined || result.structured_output === null) {
    if (result.stop_reason === "refusal") throw new RefusalError("Claude declined this request.");
    if (result.stop_reason === "max_tokens") throw new TruncatedError("Claude's response was cut off.");
    throw new SchemaError("The Claude CLI returned no structured output.");
  }
  const usage = result.usage;
  return {
    data: result.structured_output,
    actualModel: Object.keys(result.modelUsage ?? {}).sort()[0] ?? model,
    costUsd: result.total_cost_usd ?? null,
    inputTokens:
      (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
  };
}

export function buildClaudeArgs(input: {
  model: string;
  effort: string;
  systemPromptFile: string;
  schema: string;
  maxBudgetUsd?: number;
}): string[] {
  return [
    "-p",
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--system-prompt-file",
    input.systemPromptFile,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    input.schema,
    "--tools",
    "",
    "--no-session-persistence",
    "--safe-mode",
    "--max-turns",
    String(CLAUDE_CLI_MAX_TURNS),
    ...(input.maxBudgetUsd === undefined
      ? []
      : ["--max-budget-usd", input.maxBudgetUsd.toFixed(BUDGET_DECIMAL_PLACES)]),
  ];
}

export interface ClaudeCliOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly maxRetries: number;
  readonly timeoutMinutes: number;
  readonly authMethod: string;
  readonly logger: Logger;
}

export function createClaudeCliProvider(options: ClaudeCliOptions): LlmProvider {
  const gate = new BackoffGate();
  const environment = claudeEnvironment(options.environment, options.maxRetries);

  const run = async <T>(request: LlmRequest<T>): Promise<LlmResult<T>> => {
    await gate.wait(request.signal);
    if (request.signal?.aborted === true) throw new CancelledError("Cancelled.");
    const workFolder = await mkdtemp(path.join(tmpdir(), "cclinic-claude-"));
    const promptFolder = await mkdtemp(path.join(tmpdir(), "cclinic-prompt-"));
    try {
      const systemPromptFile = path.join(promptFolder, "system.txt");
      await writeFile(systemPromptFile, request.system);
      const args = buildClaudeArgs({
        model: request.model,
        effort: request.effort,
        systemPromptFile,
        schema: JSON.stringify(toJsonSchemaObject(request.schema)),
        ...(request.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: request.maxBudgetUsd }),
      });
      options.logger.debug(`Running claude with ${args.length} arguments, for model ${request.model}`);
      const { events, exitCode } = await runProcess(args, request.prompt, {
        cwd: workFolder,
        environment,
        timeoutMs: options.timeoutMinutes * MS_PER_MINUTE,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onEvent: (event) => {
          const retry = retryEventSchema.safeParse(event);
          if (!retry.success) return;
          const { attempt, max_retries: maxRetries, retry_delay_ms: delay, error } = retry.data;
          options.logger.info(
            `  Claude is retrying (attempt ${attempt ?? "?"} of ${maxRetries ?? "?"}): ${error ?? "unknown cause"}`,
          );
          if (error === "rate_limit" && delay !== undefined) gate.pause(delay);
        },
      });
      const outcome = interpretOutcome(events, exitCode, request.model);
      return {
        data: parseValidated(outcome.data, request.schema),
        actualModel: outcome.actualModel,
        costUsd: outcome.costUsd,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
      };
    } finally {
      await rm(workFolder, { recursive: true, force: true });
      await rm(promptFolder, { recursive: true, force: true });
    }
  };

  return {
    name: "claude-cli",
    isSubscription: options.authMethod === "claude.ai" || options.authMethod === "oauth_token",
    describeAuth: () => Promise.resolve(`Claude CLI (${options.authMethod})`),
    estimateTokens: (text) => Promise.resolve(estimateTokensFromChars(text)),
    generate: (request) => withSchemaRetry(() => run(request)),
  };
}

interface ProcessOptions {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly timeoutMessage?: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: unknown) => void;
}

export function runProcess(
  args: readonly string[],
  stdin: string,
  options: ProcessOptions,
): Promise<{ events: unknown[]; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_COMMAND, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events: unknown[] = [];
    let buffer = "";
    let stopReason: Error | undefined;
    let isSettled = false;

    const stop = (reason: Error): void => {
      stopReason ??= reason;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS).unref();
    };
    const onAbort = (): void => {
      stop(new CancelledError("Cancelled."));
    };
    const timer = setTimeout(() => {
      stop(
        new ProviderError(
          options.timeoutMessage ??
            `The Claude CLI call timed out after ${options.timeoutMs / MS_PER_MINUTE} minutes. Use --timeout-minutes to allow longer.`,
        ),
      );
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    const finish = (action: () => void): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const event of parseStreamLines(lines.join("\n"))) {
        events.push(event);
        options.onEvent(event);
      }
    });
    // stderr is drained so the process can't block on a full pipe. Its text may echo content, so it isn't shown.
    child.stderr.resume();
    child.stdin.on("error", () => {
      // The process can exit before reading all of stdin. The exit code reports the real failure.
    });
    child.stdin.end(stdin);
    child.on("error", (error) => {
      finish(() => {
        reject(
          new ProviderError('Couldn\'t start the Claude CLI. Run "cclinic doctor" to check your setup.', {
            cause: error,
          }),
        );
      });
    });
    child.on("close", (exitCode) => {
      finish(() => {
        if (stopReason !== undefined) {
          reject(stopReason);
          return;
        }
        events.push(...parseStreamLines(buffer));
        resolve({ events, exitCode });
      });
    });
  });
}
